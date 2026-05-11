/**
 * C2.0 transcript-window prototype (API 0, DB 0).
 *
 * Builds OpenClaw-style transcript windows from pi / Claude JSONL sessions:
 *   JSONL messages -> sanitized `User:` / `Assistant:` lines + lineMap
 *   -> 400-token / 80-overlap window chunks with original JSONL line ranges.
 *
 * This module is read-only prototype code. It does not embed, write LanceDB,
 * mutate manifests, or change the production session-indexer path.
 *
 * Reference:
 *   OpenClaw packages/memory-host-sdk/src/host/session-files.ts buildSessionEntry()
 *   OpenClaw packages/memory-host-sdk/src/host/internal.ts chunkMarkdown()/remapChunkLines()
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  detectSource,
  extractProjectName,
  isNoise,
  passesLengthFilter,
  type SessionSource,
} from "./session-indexer.js";
import { sanitizeSessionChunkText } from "./session-sanitize.js";

export type TranscriptRole = "user" | "assistant" | "compaction";
export type CompactionMode = "skip" | "inline";

export interface TranscriptLine {
  text: string;
  sourceLine: number;
  role: TranscriptRole;
  timestamp: string;
}

export interface TranscriptEntry {
  sessionFile: string;
  project: string;
  source: SessionSource;
  content: string;
  lines: TranscriptLine[];
  lineMap: number[];
  skipped: Record<string, number>;
  compactionLines: number;
}

export interface WindowChunk {
  id: string;
  text: string;
  sessionFile: string;
  project: string;
  source: SessionSource;
  startLine: number;
  endLine: number;
  timestamp: string;
  roles: TranscriptRole[];
  messageCount: number;
  windowIndex: number;
  estimatedTokens: number;
  hash: string;
}

export interface BuildTranscriptOptions {
  compactionMode?: CompactionMode;
}

export interface ChunkOptions {
  tokens?: number;
  overlap?: number;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;
const NON_LATIN_RE = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu;
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

function addCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function estimateStringChars(text: string): number {
  if (text.length === 0) return 0;
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  if (nonLatinCount === 0) return text.length;
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  const codePointLength = text.length - cjkSurrogates;
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

export function estimateTokens(text: string): number {
  return Math.ceil(estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE);
}

function timestampToIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") return value;
  return "";
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function renderLabel(role: TranscriptRole): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return "Compaction";
}

function pushTranscriptLine(
  lines: TranscriptLine[],
  role: TranscriptRole,
  text: string,
  sourceLine: number,
  timestamp: string,
): void {
  const label = renderLabel(role);
  const physicalLines = text.split(/\r?\n/);
  for (let i = 0; i < physicalLines.length; i++) {
    const segment = physicalLines[i] ?? "";
    lines.push({
      text: i === 0 ? `${label}: ${segment}` : segment,
      sourceLine,
      role,
      timestamp,
    });
  }
}

export async function buildSessionTranscriptEntry(
  sessionFile: string,
  options: BuildTranscriptOptions = {},
): Promise<TranscriptEntry> {
  const compactionMode = options.compactionMode ?? "skip";
  const source = detectSource(sessionFile);
  const project = extractProjectName(sessionFile);
  const lines: TranscriptLine[] = [];
  const skipped: Record<string, number> = {};
  let compactionLines = 0;

  const fileStream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      addCount(skipped, "invalid_json");
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const p = parsed as Record<string, unknown>;

    if (source === "pi" && p.type === "compaction") {
      const compaction = p.compaction as { summary?: unknown } | undefined;
      if (compactionMode === "inline" && typeof compaction?.summary === "string") {
        const text = compaction.summary.trim();
        if (text) {
          pushTranscriptLine(lines, "compaction", text, lineNumber, timestampToIso(p.timestamp));
          compactionLines++;
        }
      }
      continue;
    }

    let role: unknown;
    let content: unknown;
    let timestamp: string;

    if (source === "claude") {
      if (p.type !== "user" && p.type !== "assistant") continue;
      const msg = p.message as { content?: unknown } | undefined;
      if (!msg) continue;
      role = p.type;
      content = msg.content;
      timestamp = timestampToIso(p.timestamp);
    } else {
      if (p.type !== "message") continue;
      const msg = p.message as { role?: unknown; content?: unknown } | undefined;
      if (!msg) continue;
      role = msg.role;
      content = msg.content;
      timestamp = timestampToIso(p.timestamp);
    }

    if (role !== "user" && role !== "assistant") continue;
    const rawText = extractTextContent(content);
    if (!rawText) {
      addCount(skipped, "empty_text");
      continue;
    }

    const sanitized = sanitizeSessionChunkText(rawText, role, source);
    if (!sanitized.ok) {
      addCount(skipped, `sanitize.${sanitized.dropReason}`);
      continue;
    }
    const text = sanitized.text;
    if (!passesLengthFilter(text, role)) {
      addCount(skipped, "under_length");
      continue;
    }
    if (isNoise(text)) {
      addCount(skipped, "noise");
      continue;
    }
    pushTranscriptLine(lines, role, text, lineNumber, timestamp);
  }

  return {
    sessionFile,
    project,
    source,
    content: lines.map((l) => l.text).join("\n"),
    lines,
    lineMap: lines.map((l) => l.sourceLine),
    skipped,
    compactionLines,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

interface ContentChunk {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

export function chunkTranscriptContent(
  content: string,
  chunking: Required<ChunkOptions>,
): ContentChunk[] {
  const lines = content.split("\n");
  if (content.length === 0 || lines.length === 0) return [];

  const maxChars = Math.max(32, chunking.tokens * CHARS_PER_TOKEN_ESTIMATE);
  const overlapChars = Math.max(0, chunking.overlap * CHARS_PER_TOKEN_ESTIMATE);
  const chunks: ContentChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const text = current.map((entry) => entry.line).join("\n");
    chunks.push({ startLine: first.lineNo, endLine: last.lineNo, text, hash: hashText(text) });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i--) {
      const entry = current[i];
      if (!entry) continue;
      acc += estimateStringChars(entry.line) + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = acc;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        const coarse = line.slice(start, start + maxChars);
        if (estimateStringChars(coarse) > maxChars) {
          const fineStep = Math.max(1, chunking.tokens);
          for (let j = 0; j < coarse.length;) {
            let end = Math.min(j + fineStep, coarse.length);
            if (
              end < coarse.length &&
              isHighSurrogate(coarse.charCodeAt(end - 1)) &&
              isLowSurrogate(coarse.charCodeAt(end))
            ) {
              end += 1;
            }
            segments.push(coarse.slice(j, end));
            j = end;
          }
        } else {
          segments.push(coarse);
        }
      }
    }

    for (const segment of segments) {
      const lineSize = estimateStringChars(segment) + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

export function remapContentLineToSourceLine(contentLine: number, lineMap: number[]): number {
  return lineMap[contentLine - 1] ?? contentLine;
}

function transcriptLinesForRange(
  lines: TranscriptLine[],
  startContentLine: number,
  endContentLine: number,
): TranscriptLine[] {
  const selected: TranscriptLine[] = [];
  for (let i = startContentLine; i <= endContentLine; i++) {
    const line = lines[i - 1];
    if (line) selected.push(line);
  }
  return selected;
}

function rolesForLines(lines: TranscriptLine[]): TranscriptRole[] {
  const roles = new Set<TranscriptRole>();
  for (const line of lines) roles.add(line.role);
  return [...roles];
}

function firstTimestampForLines(lines: TranscriptLine[]): string {
  for (const line of lines) {
    if (line.timestamp) return line.timestamp;
  }
  return "";
}

function messageCountForLines(lines: TranscriptLine[]): number {
  return new Set(lines.map((line) => line.sourceLine)).size;
}

export function buildWindowChunks(
  entry: TranscriptEntry,
  options: ChunkOptions = {},
): WindowChunk[] {
  const chunking = { tokens: options.tokens ?? 400, overlap: options.overlap ?? 80 };
  const contentChunks = chunkTranscriptContent(entry.content, chunking);
  return contentChunks.map((chunk, index) => {
    const startLine = remapContentLineToSourceLine(chunk.startLine, entry.lineMap);
    const endLine = remapContentLineToSourceLine(chunk.endLine, entry.lineMap);
    const selectedLines = transcriptLinesForRange(entry.lines, chunk.startLine, chunk.endLine);
    const roles = rolesForLines(selectedLines);
    const timestamp = firstTimestampForLines(selectedLines);
    return {
      id: `${entry.sessionFile}:${startLine}-${endLine}:${index + 1}`,
      text: chunk.text,
      sessionFile: entry.sessionFile,
      project: entry.project,
      source: entry.source,
      startLine,
      endLine,
      timestamp,
      roles,
      messageCount: messageCountForLines(selectedLines),
      windowIndex: index + 1,
      estimatedTokens: estimateTokens(chunk.text),
      hash: chunk.hash,
    };
  });
}

export async function extractSessionWindowChunks(
  sessionFile: string,
  options: BuildTranscriptOptions & ChunkOptions = {},
): Promise<WindowChunk[]> {
  const entry = await buildSessionTranscriptEntry(sessionFile, options);
  return buildWindowChunks(entry, options);
}
