/**
 * Session JSONL Indexer
 *
 * Extracts searchable chunks from session JSONL files.
 * Supports two runtimes:
 *
 * - pi:    ~/.pi/agent/sessions/--project--/*.jsonl
 *          type="message" + message.role
 *
 * - claude: ~/.claude/projects/-project/*.jsonl
 *           type="user" | type="assistant" (role merged into type)
 *
 * Indexing exclusions (both runtimes):
 * - tmp/test/probe project dirs (pi `--tmp…--`, claude `-tmp…`) — never indexed.
 * - sessions at or below MIN_SESSION_SIZE_BYTES (300KB floor, `size > MIN`).
 * - pi only: admission is the current native id suffix `_<UUIDv7>.jsonl`. Retired
 *   species (garden-id `_YYYYMMDDTHHMMSS-<6hex>`, UUIDv4, `_entwurf-…`,
 *   `_delegate-…`) are not OR'd back in — no backward compatibility.
 *   Claude filenames are always UUIDs → no filename filter (tmp + size only).
 *
 * Chunks extracted:
 * - USER messages (what the user asked/instructed)
 * - Compaction summaries (session-level context)
 * - Assistant text responses (key conclusions)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { sanitizeSessionChunkText } from "./session-sanitize.js";

export type SessionSource = "pi" | "claude";
export type SourceFilter = SessionSource | "all";

/**
 * Normalize a `--source` argument for SEARCH paths.
 *
 * Search treats `"all"` and an omitted value as "no filter" — both collapse to
 * `undefined`, which downstream callers pass to LanceDB push-down (no WHERE
 * clause). Invalid values throw with a usable error message.
 *
 * @example
 *   normalizeSourceFilter("pi")      // "pi"
 *   normalizeSourceFilter("all")     // undefined (no filter)
 *   normalizeSourceFilter(undefined) // undefined (no filter)
 *   normalizeSourceFilter("PI")      // throws
 */
export function normalizeSourceFilter(raw: string | undefined): SessionSource | undefined {
  if (raw === undefined || raw === "all") return undefined;
  if (raw === "pi" || raw === "claude") return raw;
  throw new Error(`invalid source: ${raw}. Valid: pi | claude | all`);
}

/**
 * Parse a `--source` argument for INDEXING / DRYRUN paths.
 *
 * Indexing-side scripts (sanitize-dryrun, window-dryrun) treat `"all"` as a
 * concrete value — it means "iterate both pi and claude session files",
 * which is distinct from "filter to pi or claude only". This variant keeps
 * the `"all"` literal in the return type. Invalid values throw the same
 * message family as `normalizeSourceFilter`.
 */
export function parseSourceArg(raw: string | undefined): SourceFilter {
  if (raw === undefined || raw === "all") return "all";
  if (raw === "pi" || raw === "claude") return raw;
  throw new Error(`invalid source: ${raw}. Valid: pi | claude | all`);
}

export interface SessionChunk {
  id: string; // unique: sessionFile:lineNumber
  text: string; // chunk text for embedding
  sessionFile: string; // path to JSONL file
  project: string; // extracted from session dir name
  lineNumber: number;
  timestamp: string; // ISO timestamp
  role: "user" | "compaction" | "assistant";
  source: SessionSource; // which runtime produced this session
  metadata: Record<string, string>;
}

// --- Quality Filters ---
// Session file size floor. Real working sessions run tens to hundreds of KB
// (pi non-tmp median ≈ 300KB); test/probe sessions are a few KB. Keep only
// strictly-larger sessions ("아주 핵심만"): GLG policy is "300KB 이하 제외", so
// the filter is `size > MIN` (300KB exactly is excluded) on both runtimes.
const MIN_SESSION_SIZE_BYTES = 300 * 1024;

// Patterns that indicate noise (tool errors, delegate failures, smoke tests).
// Exported for sanitize-dryrun and any other parity-checking caller; if you
// edit this list, dryrun emit/noise counts shift automatically.
export const NOISE_PATTERNS: readonly RegExp[] = [
  /^error: .{0,50}connection refused/i,
  /^error: .{0,50}ECONNREFUSED/i,
  /^error: .{0,50}timeout/i,
  /^\s*\{?\s*"type"\s*:\s*"tool_/,  // raw tool JSON leaked into text
  /^Running .{0,30} tests?\.\.\./i,  // smoke test output
  /^Tests? passed/i,
  /^✅ \d+ tests? passed/,
  /^PASS |^FAIL /,  // test runner output
];

/**
 * Returns true if `text` matches any noise pattern.
 * Same function used by parseMessageContent in production indexing.
 */
export function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(text));
}

/**
 * Minimum text length to emit, by role. Production constants.
 * user: > 20, assistant: > 100.
 */
export function passesLengthFilter(text: string, role: "user" | "assistant"): boolean {
  if (role === "user") return text.length > 20;
  return text.length > 100;
}

// --- Pi format ---

interface PiJsonlMessage {
  type: string;
  timestamp?: number;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }> | string;
  };
  compaction?: {
    summary: string;
  };
}

// --- Claude Code format ---

interface ClaudeJsonlMessage {
  type: string; // "user" | "assistant" | "system" | "progress" | ...
  timestamp?: string; // ISO string (not epoch ms)
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }> | string;
  };
}

// --- Directory discovery ---

function getPiSessionsDir(): string {
  return path.join(process.env.HOME ?? "", ".pi", "agent", "sessions");
}

function getClaudeProjectsDir(): string {
  return path.join(process.env.HOME ?? "", ".claude", "projects");
}

/**
 * Throwaway project dirs, excluded from indexing on both runtimes. Match is
 * tmp-prefix only: pi `--tmp…--` and claude `-tmp…` normalize to a name
 * starting with "tmp" once wrapping hyphens are stripped. In practice every
 * probe/release-gate/v2matrix scratch dir is itself named `tmp-*`, so the
 * tmp-prefix rule already captures them — no separate test/probe predicate.
 */
function isExcludedProjectDir(subdir: string): boolean {
  return subdir.replace(/^-+|-+$/g, "").startsWith("tmp");
}

/**
 * Corpus admission for pi, by filename suffix: `_<UUIDv7>.jsonl`, where the native
 * session id is a **UUIDv7** — RFC 9562 version nibble `7`, variant `[89ab]`.
 *
 * **Suffix only, by design.** The written form is `<created-at>_<native id>.jsonl`,
 * but the created-at prefix is deliberately *not* validated. Filenames do not carry
 * identity: the `garden id ↔ nativeSessionId ↔ transcriptPath` join is owned by the
 * entwurf meta-record, and this indexer does not reimplement it. The filename decides
 * corpus membership and nothing else, so the predicate pins only the part that is a
 * stable contract — the native id species.
 *
 * **No backward compatibility** (GLG ruling 2026-08-10). Retired species — the older
 * garden-id form (`_YYYYMMDDTHHMMSS-<6hex>`), UUIDv4, `_entwurf-…`, `_delegate-…` —
 * are not OR'd back in. Corpus admission is one current spec.
 *
 * History, measured 2026-08-10 (non-tmp dirs, created-at prefix):
 * - UUIDv7 native ids have been written since **2026-04-15**; they are not new.
 * - The garden-id form **coexisted** with them from 2026-06-03 to 2026-08-06.
 * - From **2026-08-07** pi emits UUIDv7 only; the garden-id species ceased.
 *
 * So this is a corrected premise, not a tightening: a filter that demanded the
 * garden-id suffix admitted **zero** new pi sessions from 8/07 onward, and the pi
 * half of the corpus went dark silently — here and in `session-recap` alike.
 *
 * Anchored to the full id so a future naming drift fails fast (drop) rather than
 * silently false-including. Claude is exempt (always UUIDs).
 */
function isNativePiSessionFile(file: string): boolean {
  return /_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/.test(file);
}

/**
 * Find all JSONL session files from both runtimes.
 * Filters out trivial sessions below MIN_SESSION_SIZE_BYTES.
 */
export function findSessionFiles(baseDir?: string): string[] {
  const raw = baseDir
    ? scanDir(baseDir)
    : [...scanDir(getPiSessionsDir()), ...scanClaudeDir(getClaudeProjectsDir())];
  return raw.filter(f => {
    try { return fs.statSync(f).size > MIN_SESSION_SIZE_BYTES; } catch { return false; }
  }).sort();
}

/**
 * Find session files from a specific source only
 */
export function findSessionFilesBySource(source: SessionSource): string[] {
  const raw = source === "pi" ? scanDir(getPiSessionsDir()) : scanClaudeDir(getClaudeProjectsDir());
  return raw.filter(f => {
    try { return fs.statSync(f).size > MIN_SESSION_SIZE_BYTES; } catch { return false; }
  });
}

function scanDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const subdir of fs.readdirSync(dir)) {
    if (isExcludedProjectDir(subdir)) continue;
    const subdirPath = path.join(dir, subdir);
    if (!fs.statSync(subdirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(subdirPath)) {
      if (file.endsWith(".jsonl") && isNativePiSessionFile(file)) {
        files.push(path.join(subdirPath, file));
      }
    }
  }
  return files;
}

function scanClaudeDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const subdir of fs.readdirSync(dir)) {
    if (isExcludedProjectDir(subdir)) continue;
    const subdirPath = path.join(dir, subdir);
    if (!fs.statSync(subdirPath).isDirectory()) continue;
    // Top-level .jsonl files (main sessions)
    for (const file of fs.readdirSync(subdirPath)) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(subdirPath, file));
      }
    }
    // Also check UUID subdirs (session-id folders)
    for (const entry of fs.readdirSync(subdirPath)) {
      const entryPath = path.join(subdirPath, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      if (entry === "subagents") continue; // skip subagent sessions
      for (const file of fs.readdirSync(entryPath)) {
        if (file.endsWith(".jsonl")) {
          files.push(path.join(entryPath, file));
        }
      }
    }
  }
  return files;
}

// --- Project name extraction ---

/**
 * Extract project name from session directory path.
 *
 * Pi:    --home-junghan-repos-gh-agent-config-- → agent-config
 * Claude: -home-junghan-repos-gh-agent-config   → agent-config
 */
export function extractProjectName(sessionFile: string): string {
  // Walk up to find the project directory
  const parts = sessionFile.split("/");
  let dirName: string;

  if (sessionFile.includes("/.claude/projects/")) {
    // Claude: ~/.claude/projects/-home-junghan-repos-gh-X/...
    const projIdx = parts.indexOf("projects");
    dirName = parts[projIdx + 1] ?? "unknown";
  } else if (sessionFile.includes("/.pi/agent/sessions/")) {
    // Pi: ~/.pi/agent/sessions/--home-junghan-repos-gh-X--/...
    const sessIdx = parts.indexOf("sessions");
    dirName = parts[sessIdx + 1] ?? "unknown";
  } else {
    dirName = path.basename(path.dirname(sessionFile));
  }

  // Normalize: strip leading/trailing hyphens
  const cleaned = dirName.replace(/^-+|-+$/g, "");

  // Pattern: home-<user>-repos-{gh,work,3rd}-<project>
  const reposMatch = cleaned.match(
    /^home-[^-]+-repos-(?:gh|work|3rd)-(.+)$/,
  );
  if (reposMatch) return reposMatch[1];

  // Pattern: home-<user>-<project> (projects directly under ~/)
  const homeMatch = cleaned.match(/^home-[^-]+-(.+)$/);
  if (homeMatch) return homeMatch[1];

  // Pattern: home-<user> (home dir itself)
  if (/^home-[^-]+$/.test(cleaned)) return "home";

  return cleaned || "unknown";
}

/**
 * Detect which runtime produced this session file
 */
export function detectSource(sessionFile: string): SessionSource {
  if (sessionFile.includes("/.claude/")) return "claude";
  return "pi";
}

// --- Chunk extraction ---

/**
 * Extract chunks from a single session JSONL file.
 * Auto-detects pi vs claude format.
 */
export async function extractSessionChunks(
  sessionFile: string,
): Promise<SessionChunk[]> {
  const chunks: SessionChunk[] = [];
  const project = extractProjectName(sessionFile);
  const source = detectSource(sessionFile);

  const fileStream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const chunk =
      source === "claude"
        ? parseClaudeLine(parsed as unknown as ClaudeJsonlMessage, sessionFile, project, lineNumber)
        : parsePiLine(parsed as unknown as PiJsonlMessage, sessionFile, project, lineNumber);

    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

function parsePiLine(
  parsed: PiJsonlMessage,
  sessionFile: string,
  project: string,
  lineNumber: number,
): SessionChunk | null {
  const timestamp = parsed.timestamp
    ? new Date(parsed.timestamp).toISOString()
    : "";

  // Compaction summaries
  if (parsed.type === "compaction" && parsed.compaction?.summary) {
    return {
      id: `${sessionFile}:${lineNumber}`,
      text: parsed.compaction.summary,
      sessionFile,
      project,
      lineNumber,
      timestamp,
      role: "compaction",
      source: "pi",
      metadata: { type: "compaction" },
    };
  }

  if (parsed.type !== "message" || !parsed.message) return null;

  const { role, content } = parsed.message;
  return parseMessageContent(
    role,
    content,
    sessionFile,
    project,
    lineNumber,
    timestamp,
    "pi",
  );
}

function parseClaudeLine(
  parsed: ClaudeJsonlMessage,
  sessionFile: string,
  project: string,
  lineNumber: number,
): SessionChunk | null {
  const { type } = parsed;

  // Claude Code: type IS the role ("user", "assistant")
  if (type !== "user" && type !== "assistant") return null;
  if (!parsed.message) return null;

  const timestamp = parsed.timestamp ?? "";
  const { content } = parsed.message;

  return parseMessageContent(
    type,
    content,
    sessionFile,
    project,
    lineNumber,
    timestamp,
    "claude",
  );
}

function parseMessageContent(
  role: string,
  content: Array<{ type: string; text?: string }> | string | undefined,
  sessionFile: string,
  project: string,
  lineNumber: number,
  timestamp: string,
  source: SessionSource,
): SessionChunk | null {
  if (!content) return null;
  if (role !== "user" && role !== "assistant") return null;

  const rawText = extractTextContent(content);
  if (!rawText) return null;

  // 1. Sanitize FIRST — strip OpenClaw-injected envelopes and drop
  //    generator-artifact wrappers. See session-sanitize.ts.
  const sanitized = sanitizeSessionChunkText(rawText, role, source);
  if (!sanitized.ok) return null;
  const text = sanitized.text;

  // 2. Length filter — POST-strip. An 80KB envelope-only message would
  //    now correctly fall through.
  // 3. Noise filter — patterns inherited from prior session-indexer behavior.
  // 4. Truncate — embedding input cap, unchanged from prior policy.

  if (role === "user" && text.length > 20) {
    if (isNoise(text)) return null;
    return {
      id: `${sessionFile}:${lineNumber}`,
      text: truncateText(text, 2000),
      sessionFile,
      project,
      lineNumber,
      timestamp,
      role: "user",
      source,
      metadata: { type: "user_message" },
    };
  }

  if (role === "assistant" && text.length > 100) {
    if (isNoise(text)) return null;
    return {
      id: `${sessionFile}:${lineNumber}`,
      text: truncateText(text, 2000),
      sessionFile,
      project,
      lineNumber,
      timestamp,
      role: "assistant",
      source,
      metadata: { type: "assistant_response" },
    };
  }

  return null;
}

// --- Helpers ---

function extractTextContent(
  content: Array<{ type: string; text?: string }> | string,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

// --- Legacy exports (backward compat with agent-config) ---

export function getSessionsBaseDir(): string {
  return getPiSessionsDir();
}

// ---------------------------------------------------------------------------
// Test-only export (kept undocumented for production callers)
// ---------------------------------------------------------------------------

export const __test = {
  isNativePiSessionFile,
  isExcludedProjectDir,
};
