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
 * With `ANDENKEN_SESSION_CORPUS` set, both roots are read per device from the
 * gathered corpus instead (`<corpus>/<device>/.pi/agent/sessions`, etc.) — the
 * same paths with a device prefix. See `getCorpusRoot` below.
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

/**
 * Session corpus root, when the operator has switched discovery over to it.
 *
 * `~/repos/gh/session` gathers every device's admitted sessions into one place
 * (see `scripts/gather-corpus.sh`) so an agent on any machine searches the same
 * memory axis. Each device dir keeps the runtime's own path shape — the corpus
 * path is the live path with `<corpus>/<device>` bolted on the front:
 *
 *   ~/repos/gh/session/oracle/.claude/projects/-home-junghan-repos-gh-entwurf/…
 *   ~/repos/gh/session/oracle/.pi/agent/sessions/--home-junghan-repos-gh-entwurf--/…
 *
 * That shape is load-bearing, not cosmetic: `detectSource` keys off `/.claude/`
 * and `extractProjectName` off the `projects`/`sessions` path segment, so both
 * keep working unmodified, and the device stays recoverable from the path via
 * the existing `sessionFileContains` store filter — no schema change, no
 * rebuild of `sessions.lance` to gain a device dimension.
 *
 * **Opt-in on purpose.** Unset (the default) means discovery reads this
 * machine's live runtime stores, exactly as before. Corpus paths are new keys in
 * `data/session-manifest.json`, so the first indexing run after the switch
 * re-embeds the whole corpus (~2k files). That belongs to a deliberate operator
 * decision, not to whichever cron run happens to fire first.
 */
function getCorpusRoot(): string | undefined {
  const raw = process.env.ANDENKEN_SESSION_CORPUS;
  if (!raw) return undefined;
  return raw.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
}

/**
 * Device dirs under the corpus root, sorted for deterministic discovery order.
 * A missing or empty corpus yields `[]`, which makes the callers below fall back
 * to the live runtime stores rather than silently indexing nothing.
 */
function getCorpusDevices(): string[] {
  const root = getCorpusRoot();
  if (!root || !fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => !d.startsWith(".") && fs.statSync(path.join(root, d)).isDirectory())
    .sort();
}

function getPiSessionsDirs(): string[] {
  const root = getCorpusRoot();
  const devices = getCorpusDevices();
  if (root && devices.length > 0) {
    return devices.map((d) => path.join(root, d, ".pi", "agent", "sessions"));
  }
  return [path.join(process.env.HOME ?? "", ".pi", "agent", "sessions")];
}

function getClaudeProjectsDirs(): string[] {
  const root = getCorpusRoot();
  const devices = getCorpusDevices();
  if (root && devices.length > 0) {
    return devices.map((d) => path.join(root, d, ".claude", "projects"));
  }
  return [path.join(process.env.HOME ?? "", ".claude", "projects")];
}

/**
 * Drop corpus copies of the same session held by more than one device.
 *
 * GLG's two machines already exchanged a manual `rsync -a` of the live claude
 * store at some point, so 553 of ~2.1k gathered files exist under both device
 * dirs, byte-identical. Indexing both would double those chunks and let one
 * conversation answer a query twice.
 *
 * The key is the **basename**: pi and claude session ids are UUIDs, unique by
 * construction, so two files sharing a basename are the same conversation. The
 * winner is the larger file — a transcript only ever grows, so the larger copy
 * is the one that was captured later and holds strictly more turns. Size ties
 * break on the lexicographically smaller path, which keeps the choice stable
 * across runs (an unstable choice would churn the manifest and re-embed).
 *
 * A no-op when discovery is on the live stores: one device cannot collide with
 * itself.
 */
function dedupeByBasename(files: string[]): string[] {
  const best = new Map<string, { path: string; size: number }>();
  for (const f of files) {
    let size: number;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue;
    }
    const key = path.basename(f);
    const cur = best.get(key);
    if (!cur || size > cur.size || (size === cur.size && f < cur.path)) {
      best.set(key, { path: f, size });
    }
  }
  return [...best.values()].map((v) => v.path);
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
    : [
        ...getPiSessionsDirs().flatMap(scanDir),
        ...getClaudeProjectsDirs().flatMap(scanClaudeDir),
      ];
  return dedupeByBasename(raw.filter(f => {
    try { return fs.statSync(f).size > MIN_SESSION_SIZE_BYTES; } catch { return false; }
  })).sort();
}

/**
 * Find session files from a specific source only
 */
export function findSessionFilesBySource(source: SessionSource): string[] {
  const raw = source === "pi"
    ? getPiSessionsDirs().flatMap(scanDir)
    : getClaudeProjectsDirs().flatMap(scanClaudeDir);
  return dedupeByBasename(raw.filter(f => {
    try { return fs.statSync(f).size > MIN_SESSION_SIZE_BYTES; } catch { return false; }
  }));
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

    const lineChunks =
      source === "claude"
        ? parseClaudeLine(parsed as unknown as ClaudeJsonlMessage, sessionFile, project, lineNumber)
        : parsePiLine(parsed as unknown as PiJsonlMessage, sessionFile, project, lineNumber);

    for (const chunk of lineChunks) chunks.push(chunk);
  }

  return chunks;
}

function parsePiLine(
  parsed: PiJsonlMessage,
  sessionFile: string,
  project: string,
  lineNumber: number,
): SessionChunk[] {
  const timestamp = parsed.timestamp
    ? new Date(parsed.timestamp).toISOString()
    : "";

  // Compaction summaries. Split like any other long text — a compaction summary
  // is often the densest record of a session and routinely runs past 2,000
  // chars, so head-truncating it lost exactly the part worth keeping.
  if (parsed.type === "compaction" && parsed.compaction?.summary) {
    const parts = splitForEmbedding(parsed.compaction.summary);
    return parts.map((part, i) => ({
      id: parts.length === 1
        ? `${sessionFile}:${lineNumber}`
        : `${sessionFile}:${lineNumber}#${i}`,
      text: part,
      sessionFile,
      project,
      lineNumber,
      timestamp,
      role: "compaction" as const,
      source: "pi" as const,
      metadata: (parts.length === 1
        ? { type: "compaction" }
        : { type: "compaction", part: String(i), parts: String(parts.length) }) as Record<string, string>,
    }));
  }

  if (parsed.type !== "message" || !parsed.message) return [];

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
): SessionChunk[] {
  const { type } = parsed;

  // Claude Code: type IS the role ("user", "assistant")
  if (type !== "user" && type !== "assistant") return [];
  if (!parsed.message) return [];

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
): SessionChunk[] {
  if (!content) return [];
  if (role !== "user" && role !== "assistant") return [];

  const rawText = extractTextContent(content);
  if (!rawText) return [];

  // 1. Sanitize FIRST — strip OpenClaw-injected envelopes and drop
  //    generator-artifact wrappers. See session-sanitize.ts.
  const sanitized = sanitizeSessionChunkText(rawText, role, source);
  if (!sanitized.ok) return [];
  const text = sanitized.text;

  // 2. Length filter — POST-strip. An 80KB envelope-only message would
  //    now correctly fall through.
  // 3. Noise filter — patterns inherited from prior session-indexer behavior.
  // 4. Split — a long turn becomes several parts instead of losing its tail.
  //    See splitForEmbedding for why head-truncation was retired.

  const minLength = role === "user" ? 20 : 100;
  if (text.length <= minLength) return [];
  if (isNoise(text)) return [];

  const parts = splitForEmbedding(text);
  const metaType = role === "user" ? "user_message" : "assistant_response";

  return parts.map((part, i) => ({
    // A turn that fits in one part keeps its historical id, so the 70% of
    // turns that never split are unaffected by this change.
    id: parts.length === 1
      ? `${sessionFile}:${lineNumber}`
      : `${sessionFile}:${lineNumber}#${i}`,
    text: part,
    sessionFile,
    project,
    lineNumber,
    timestamp,
    role: role as "user" | "assistant",
    source,
    metadata: (parts.length === 1
      ? { type: metaType }
      : { type: metaType, part: String(i), parts: String(parts.length) }) as Record<string, string>,
  }));
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

/**
 * Target size of one embedding part, in characters. Same number the old
 * head-truncation used, so a turn that already fit is unaffected — this changes
 * what happens to the ones that did NOT fit, not the size of a normal chunk.
 */
const CHUNK_TARGET_CHARS = 2000;

/**
 * A trailing fragment shorter than this is folded back into the previous part
 * instead of being embedded alone. A 40-character orphan carries no retrievable
 * meaning but still occupies a row and competes for top-k. Scaled to the target
 * so a smaller target does not fold whole parts back together.
 */
function minTailChars(target: number): number {
  return Math.min(200, Math.floor(target / 4));
}

/**
 * Split a long turn into embedding-sized parts along the text's own boundaries.
 *
 * **Why this replaces head-truncation.** Until 2026-09-02 both user and
 * assistant turns were cut at the first 2,000 characters. Measured over the
 * corpus that day: 30.3% of user turns exceed 2,000 chars and **51.1% of all
 * user characters were being discarded**, with the longest turn at 79,928.
 * GLG's long prompts were in the corpus but only their opening was in the
 * index, so a decision stated in the second half could never be retrieved. The
 * corpus exists to recover prompt originals; truncating them at embed time
 * contradicts the point of keeping them.
 *
 * Boundaries are tried widest-first — blank line, then line, then sentence —
 * so a part lands on a seam the writer actually made. A hard slice is the last
 * resort for text with no seams at all (a pasted log, a minified blob).
 *
 * Splitting, not summarizing: every character survives into exactly one part.
 */
export function splitForEmbedding(
  text: string,
  target: number = CHUNK_TARGET_CHARS,
): string[] {
  if (text.length <= target) return [text];

  const parts: string[] = [];
  let rest = text;

  while (rest.length > target) {
    const window = rest.slice(0, target);
    // Widest seam first. Each index is the END of the kept slice.
    let cut = window.lastIndexOf("\n\n");
    if (cut > 0) cut += 2;
    if (cut <= 0) {
      cut = window.lastIndexOf("\n");
      if (cut > 0) cut += 1;
    }
    if (cut <= 0) {
      const sentence = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
        window.lastIndexOf("다. "),
      );
      if (sentence > 0) cut = sentence + 1;
    }
    // No seam anywhere in the window (pasted log, minified blob) → hard slice.
    // Also guard the degenerate case where the only seam sits at the very
    // start, which would make no progress and spin forever.
    if (cut <= 0 || cut > target) cut = target;

    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) {
    // Fold a short tail back rather than embedding it alone.
    if (rest.length < minTailChars(target) && parts.length > 0) {
      parts[parts.length - 1] += "\n" + rest;
    } else {
      parts.push(rest);
    }
  }

  return parts.filter((p) => p.length > 0);
}

// --- Legacy exports (backward compat with agent-config) ---

/**
 * Single pi sessions root, for agent-config callers that predate the corpus.
 * Under a corpus, "the" pi root is no longer one directory — this returns the
 * first device's, which keeps the legacy signature honest for a single-device
 * caller. New code should use the discovery functions instead.
 */
export function getSessionsBaseDir(): string {
  return getPiSessionsDirs()[0];
}

// ---------------------------------------------------------------------------
// Test-only export (kept undocumented for production callers)
// ---------------------------------------------------------------------------

export const __test = {
  isNativePiSessionFile,
  isExcludedProjectDir,
  splitForEmbedding,
  getPiSessionsDirs,
  getClaudeProjectsDirs,
  dedupeByBasename,
};
