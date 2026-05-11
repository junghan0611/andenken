/**
 * C2.1a session excerpt — read-only readback for search hits.
 *
 * Given a session JSONL file and a centerLine (the lineNumber surfaced by
 * `session_search` results), reconstruct the surrounding user/assistant flow
 * by reading neighboring JSONL lines and rendering them with role labels.
 *
 * Tuned for our actual corpus rather than OpenClaw defaults:
 *   - toolResult is ~54% of pi message lines; rendered as one-line summary
 *     with toolName + isError flag instead of being silently skipped.
 *   - entwurf-message lives in `custom_message` (display=true) and currently
 *     escapes indexing; rendered in full as inter-agent dialogue.
 *   - assistant tool-only turns (no text block) render as `Assistant: [tool: ...]`.
 *   - center-preserving truncation: centerLine is never dropped; far lines go
 *     first, balanced from both edges.
 *   - skipped lines (invalid JSON, display=false, etc) are NOT interleaved
 *     into the excerpt text — counts are returned in `skippedCounts`.
 *
 * API 0. DB 0. network 0. No store / manifest / embedding side-effects.
 *
 * Reuses `sanitizeSessionChunkText` from session-sanitize.ts (A3 C1).
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import { detectSource, extractProjectName, type SessionSource } from "./session-indexer.js";
import { sanitizeSessionChunkText } from "./session-sanitize.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExcerptKind =
  | "user"
  | "assistant"
  | "assistant-tool"
  | "tool-result"
  | "entwurf"
  | "compaction";

export interface ExcerptLine {
  /** 1-indexed JSONL line where this entry came from. */
  sourceLine: number;
  kind: ExcerptKind;
  /** Display text (already prefixed with role label, sanitized, summarized). */
  text: string;
  /** Original raw character count before any truncation/summarization. */
  rawChars?: number;
  /** True if this line was dropped during center-preserving truncation. */
  truncated?: boolean;
}

export interface SessionExcerpt {
  sessionFile: string;
  project: string;
  source: SessionSource;
  centerLine: number;
  /** Total number of lines in the underlying JSONL file. Useful for callers
   *  that need to detect out-of-bounds centerLine without re-reading. */
  totalLines: number;
  /** First JSONL line included in the excerpt window (may differ from
   *  `centerLine - beforeLines` if EOF/BOF clamps applied). */
  startLine: number;
  /** Last JSONL line included in the excerpt window. */
  endLine: number;
  /** Joined display text — only kept (non-truncated) lines. */
  text: string;
  /** All considered lines (kept + truncated). */
  lines: ExcerptLine[];
  /** True if maxChars caused at least one line to be dropped. */
  truncated: boolean;
  /** Total chars across rendered (kept) lines, BEFORE truncation. */
  totalCharsBeforeTruncation: number;
  /** Reasons we silently dropped JSONL lines (invalid_json, display_false, ...). */
  skippedCounts: Record<string, number>;
}

export interface ExcerptOptions {
  beforeLines?: number;
  afterLines?: number;
  maxChars?: number;
  includeToolResults?: boolean;
  /** Include custom_message entries that are inter-agent dialogue. */
  includeSessionMessages?: boolean;
  /** Truncate per-line tool result preview (chars). */
  toolResultPreviewChars?: number;
}

const DEFAULTS = {
  beforeLines: 3,
  afterLines: 3,
  maxChars: 4000,
  includeToolResults: true,
  includeSessionMessages: true,
  toolResultPreviewChars: 200,
} as const;

// customType allow-list for inter-agent / cross-session dialogue.
// session-info (display=false) and skill_loaded etc. are excluded.
const SESSION_MESSAGE_CUSTOM_TYPES = new Set<string>([
  "entwurf-message",
  "session-message",
  "delegate-complete",
]);

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read entire JSONL file as raw lines (1-indexed). Small files (<10MB typical
 * session) fit comfortably in memory; this keeps the lookup O(1) for any
 * centerLine.
 */
async function readJsonlLines(sessionFile: string): Promise<string[]> {
  const out: string[] = [];
  const stream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) out.push(line);
  return out;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

interface RenderContext {
  source: SessionSource;
  options: Required<ExcerptOptions>;
}

interface RenderResult {
  /** null = silently skipped (counted via reason). */
  line: ExcerptLine | null;
  /** Reason string when line === null. */
  skipReason?: string;
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

interface ToolCallLite {
  name: string;
  argSummary: string;
}

/**
 * Pull tool call summaries from an assistant content array.
 * Supports both pi (`type: "toolCall"`, `name`, `arguments`) and claude
 * (`type: "tool_use"`, `name`, `input`).
 */
function extractToolCalls(content: unknown): ToolCallLite[] {
  if (!Array.isArray(content)) return [];
  const out: ToolCallLite[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const isPi = b.type === "toolCall";
    const isClaude = b.type === "tool_use";
    if (!isPi && !isClaude) continue;
    const name = typeof b.name === "string" ? b.name : "?";
    const args = isPi ? b.arguments : b.input;
    out.push({ name, argSummary: summarizeToolArgs(args) });
  }
  return out;
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  // Prefer the most informative single field for compact display.
  const PREFERRED = [
    "path",
    "file_path",
    "command",
    "pattern",
    "query",
    "url",
    "task",
    "description",
  ];
  for (const key of PREFERRED) {
    const v = a[key];
    if (typeof v === "string" && v.length > 0) {
      const trimmed = v.length > 80 ? v.slice(0, 80) + "…" : v;
      return `${key}=${trimmed}`;
    }
  }
  // Fallback: list keys
  const keys = Object.keys(a);
  if (keys.length === 0) return "";
  return keys.slice(0, 3).join(",");
}

function renderToolCallsLine(calls: ToolCallLite[]): string {
  return calls
    .map((c) => `[tool: ${c.name}(${c.argSummary})]`)
    .join(" ");
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

interface ClaudeToolResultBlock {
  toolUseId: string;
  isError: boolean;
  text: string;
  totalChars: number;
}

/**
 * Extract Claude Code-format tool_result blocks from a user message content
 * array. Returns empty array if no tool_result blocks present (or content is
 * not an array). Each block.content may itself be a string OR an array of
 * `{type: "text", text}` blocks per Anthropic content spec.
 */
function extractClaudeToolResultBlocks(content: unknown): ClaudeToolResultBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ClaudeToolResultBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;
    const text = extractToolResultText(b.content);
    out.push({
      toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
      isError: b.is_error === true,
      text,
      totalChars: text.length,
    });
  }
  return out;
}

function shortToolUseId(toolUseId: string): string {
  if (!toolUseId) return "?";
  // Format e.g. "toolu_01CEHoNpWNCSiPcMJGbgXqJZ" → strip prefix, keep 8.
  const stripped = toolUseId.replace(/^toolu_/, "");
  return stripped.slice(0, 8) || toolUseId.slice(0, 8);
}

function renderClaudeToolResultLine(
  sourceLine: number,
  blocks: ClaudeToolResultBlock[],
  previewChars: number,
): ExcerptLine {
  // Most claude messages carry a single tool_result block; render multiple as
  // semicolon-separated entries within one line so excerpt order matches JSONL.
  const parts = blocks.map((b) => {
    const preview = b.text.replace(/\s+/g, " ").trim().slice(0, previewChars);
    const ellipsis = b.totalChars > preview.length ? "…" : "";
    const idShort = shortToolUseId(b.toolUseId);
    const errFlag = b.isError ? " ERROR" : "";
    return `[${idShort}${errFlag}]: ${preview}${ellipsis} [${b.totalChars} chars total]`;
  });
  const totalChars = blocks.reduce((s, b) => s + b.totalChars, 0);
  const text = `→ tool result ${parts.join("; ")}`;
  return {
    sourceLine,
    kind: "tool-result",
    text,
    rawChars: totalChars,
  };
}

function shortId(value: unknown): string {
  if (typeof value !== "string" || !value) return "?";
  // Strip provider/agent prefixes for compact display.
  const tail = value.includes("/") ? value.split("/").pop()! : value;
  return tail.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Per-line dispatcher
// ---------------------------------------------------------------------------

function renderJsonlLine(
  rawLine: string,
  sourceLine: number,
  ctx: RenderContext,
): RenderResult {
  if (!rawLine.trim()) return { line: null, skipReason: "blank" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return { line: null, skipReason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { line: null, skipReason: "non_object" };
  }
  const p = parsed as Record<string, unknown>;
  const type = p.type;

  // ---- compaction (pi only) ----
  if (ctx.source === "pi" && type === "compaction") {
    const c = p.compaction as { summary?: unknown } | undefined;
    if (typeof c?.summary === "string" && c.summary.trim()) {
      const text = c.summary.trim();
      return {
        line: {
          sourceLine,
          kind: "compaction",
          text: `[Compaction summary] ${text}`,
          rawChars: text.length,
        },
      };
    }
    return { line: null, skipReason: "compaction_empty" };
  }

  // ---- custom_message — inter-agent dialogue ----
  if (type === "custom_message") {
    if (!ctx.options.includeSessionMessages) {
      return { line: null, skipReason: "session_messages_disabled" };
    }
    if (p.display === false) return { line: null, skipReason: "display_false" };
    const customType = typeof p.customType === "string" ? p.customType : "";
    if (!SESSION_MESSAGE_CUSTOM_TYPES.has(customType)) {
      return { line: null, skipReason: `custom_message_other:${customType || "?"}` };
    }
    const content = typeof p.content === "string" ? p.content : "";
    if (!content.trim()) return { line: null, skipReason: "session_message_empty" };

    // Best-effort extraction of sender/receiver short ids from sender_info /
    // receiver_info tags that the entwurf bridge embeds.
    const sender = matchTaggedAgentId(content, "sender_info");
    const receiver = matchTaggedAgentId(content, "receiver_info");
    const direction = `${shortId(sender)}→${shortId(receiver)}`;
    return {
      line: {
        sourceLine,
        kind: "entwurf",
        text: `Entwurf[${direction}]: ${content}`,
        rawChars: content.length,
      },
    };
  }

  // ---- pi/claude format divergence ----
  //
  // pi format:    .type === "message",  .message.role ∈ {user, assistant, toolResult}
  // claude format: .type ∈ {user, assistant},  .message.role ∈ {user, assistant}
  //                 (claude flattens tool results into user-role messages whose
  //                  content array carries tool_result blocks; we still treat
  //                  .message.role as authoritative.)
  let role: string;
  let content: unknown;
  let toolName: unknown;
  let isError: unknown;

  if (ctx.source === "claude") {
    if (type !== "user" && type !== "assistant") {
      return { line: null, skipReason: `type:${String(type)}` };
    }
    const msg = p.message as Record<string, unknown> | undefined;
    if (!msg) return { line: null, skipReason: "claude_no_message" };
    role = typeof msg.role === "string" ? msg.role : (type as string);
    content = msg.content;
    toolName = msg.toolName;
    isError = msg.isError;

    // Claude Code flattens tool results into user-role messages whose content
    // array carries `{type: "tool_result", tool_use_id, is_error, content}`
    // blocks. The current pi-style toolResult branch (role==="toolResult")
    // wouldn't catch this, and length-filter would drop the message as
    // empty:user. Handle it inline here.
    if (role === "user") {
      const blocks = extractClaudeToolResultBlocks(content);
      if (blocks.length > 0) {
        if (!ctx.options.includeToolResults) {
          return { line: null, skipReason: "tool_results_disabled" };
        }
        return {
          line: renderClaudeToolResultLine(sourceLine, blocks, ctx.options.toolResultPreviewChars),
        };
      }
    }
  } else {
    if (type !== "message") return { line: null, skipReason: `type:${String(type)}` };
    const msg = p.message as Record<string, unknown> | undefined;
    if (!msg) return { line: null, skipReason: "pi_no_message" };
    role = typeof msg.role === "string" ? msg.role : "";
    content = msg.content;
    toolName = msg.toolName;
    isError = msg.isError;
  }

  // ---- toolResult ----
  if (role === "toolResult") {
    if (!ctx.options.includeToolResults) {
      return { line: null, skipReason: "tool_results_disabled" };
    }
    const text = extractToolResultText(content);
    const total = text.length;
    const preview = text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, ctx.options.toolResultPreviewChars);
    const errFlag = isError === true ? " ERROR" : "";
    const tn = typeof toolName === "string" && toolName ? toolName : "?";
    const ellipsis = total > preview.length ? "…" : "";
    return {
      line: {
        sourceLine,
        kind: "tool-result",
        text: `→ tool result [${tn}${errFlag}]: ${preview}${ellipsis} [${total} chars total]`,
        rawChars: total,
      },
    };
  }

  // ---- user / assistant ----
  if (role !== "user" && role !== "assistant") {
    return { line: null, skipReason: `role:${role || "?"}` };
  }

  const rawText = extractTextContent(content);
  const toolCalls = extractToolCalls(content);

  // assistant tool-only: no text but has toolCall(s). Render compact.
  if (role === "assistant" && !rawText && toolCalls.length > 0) {
    const text = `Assistant: ${renderToolCallsLine(toolCalls)}`;
    return {
      line: {
        sourceLine,
        kind: "assistant-tool",
        text,
        rawChars: text.length,
      },
    };
  }

  // user/assistant with text: sanitize via A3 C1
  if (rawText) {
    const sanitized = sanitizeSessionChunkText(rawText, role as "user" | "assistant", ctx.source);
    if (!sanitized.ok) {
      return { line: null, skipReason: `sanitize:${sanitized.dropReason}` };
    }
    const text = sanitized.text;
    const label = role === "user" ? "User" : "Assistant";

    // assistant turn that has BOTH text and tool calls: append a compact tail.
    const tail =
      role === "assistant" && toolCalls.length > 0
        ? `\n${renderToolCallsLine(toolCalls)}`
        : "";

    return {
      line: {
        sourceLine,
        kind: role === "user" ? "user" : "assistant",
        text: `${label}: ${text}${tail}`,
        rawChars: text.length,
      },
    };
  }

  // empty user/assistant (no text, no tool calls)
  return { line: null, skipReason: `empty:${role}` };
}

function matchTaggedAgentId(content: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(content);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && typeof obj === "object" && typeof obj.agentId === "string") {
      return obj.agentId;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Center-preserving truncation
// ---------------------------------------------------------------------------

/**
 * Drop lines from the edges (alternating start/end) until total chars fit
 * `maxChars`. centerLine is never dropped.
 *
 * Returns the same array with `truncated:true` set on dropped lines and
 * mutates nothing else. Order is preserved.
 */
function applyCenterPreservingTruncation(
  rendered: ExcerptLine[],
  centerLine: number,
  maxChars: number,
): { kept: ExcerptLine[]; truncated: boolean; totalBefore: number } {
  const totalBefore = rendered.reduce((s, l) => s + l.text.length + 1, 0);
  if (totalBefore <= maxChars) {
    return { kept: rendered, truncated: false, totalBefore };
  }

  // Work with indices. Find center index (closest sourceLine to centerLine).
  const centerIdx = findCenterIndex(rendered, centerLine);
  const dropped = new Set<number>();
  let runningChars = totalBefore;

  // Distance map: prefer dropping farthest-from-center first.
  const order = rendered
    .map((line, i) => ({ i, distance: Math.abs(i - centerIdx) }))
    .filter((x) => x.i !== centerIdx) // protect center
    .sort((a, b) => b.distance - a.distance); // farthest first

  for (const { i } of order) {
    if (runningChars <= maxChars) break;
    dropped.add(i);
    runningChars -= rendered[i]!.text.length + 1;
  }

  const kept: ExcerptLine[] = [];
  for (let i = 0; i < rendered.length; i++) {
    if (dropped.has(i)) {
      // Mark the dropped entry but do NOT include in `kept` array; caller
      // joins `kept` for `text`. We still expose dropped lines via
      // `lines[]` (with truncated flag) so callers can inspect.
      rendered[i]!.truncated = true;
      continue;
    }
    kept.push(rendered[i]!);
  }
  return { kept, truncated: dropped.size > 0, totalBefore };
}

function findCenterIndex(lines: ExcerptLine[], centerLine: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const d = Math.abs(lines[i]!.sourceLine - centerLine);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function readSessionExcerpt(
  sessionFile: string,
  centerLine: number,
  options: ExcerptOptions = {},
): Promise<SessionExcerpt> {
  const opts: Required<ExcerptOptions> = {
    beforeLines: options.beforeLines ?? DEFAULTS.beforeLines,
    afterLines: options.afterLines ?? DEFAULTS.afterLines,
    maxChars: options.maxChars ?? DEFAULTS.maxChars,
    includeToolResults: options.includeToolResults ?? DEFAULTS.includeToolResults,
    includeSessionMessages: options.includeSessionMessages ?? DEFAULTS.includeSessionMessages,
    toolResultPreviewChars: options.toolResultPreviewChars ?? DEFAULTS.toolResultPreviewChars,
  };

  const source = detectSource(sessionFile);
  const project = extractProjectName(sessionFile);
  const allLines = await readJsonlLines(sessionFile);
  const totalLines = allLines.length;

  if (totalLines === 0) {
    return {
      sessionFile,
      project,
      source,
      centerLine,
      totalLines: 0,
      startLine: 0,
      endLine: 0,
      text: "",
      lines: [],
      truncated: false,
      totalCharsBeforeTruncation: 0,
      skippedCounts: { empty_file: 1 },
    };
  }

  // Clamp window to file bounds.
  const startLine = Math.max(1, centerLine - opts.beforeLines);
  const endLine = Math.min(totalLines, centerLine + opts.afterLines);

  const ctx: RenderContext = { source, options: opts };
  const rendered: ExcerptLine[] = [];
  const skippedCounts: Record<string, number> = {};

  for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
    const raw = allLines[lineNo - 1] ?? "";
    const result = renderJsonlLine(raw, lineNo, ctx);
    if (result.line) {
      rendered.push(result.line);
    } else if (result.skipReason) {
      skippedCounts[result.skipReason] = (skippedCounts[result.skipReason] ?? 0) + 1;
    }
  }

  const trunc = applyCenterPreservingTruncation(rendered, centerLine, opts.maxChars);
  const text = trunc.kept.map((l) => l.text).join("\n");

  return {
    sessionFile,
    project,
    source,
    centerLine,
    totalLines,
    startLine,
    endLine,
    text,
    lines: rendered, // includes truncated entries with .truncated flag
    truncated: trunc.truncated,
    totalCharsBeforeTruncation: trunc.totalBefore,
    skippedCounts,
  };
}

// ---------------------------------------------------------------------------
// Test-only export (kept undocumented for production callers)
// ---------------------------------------------------------------------------

export const __test = {
  applyCenterPreservingTruncation,
  renderJsonlLine,
  extractToolCalls,
  summarizeToolArgs,
  matchTaggedAgentId,
  SESSION_MESSAGE_CUSTOM_TYPES,
};
