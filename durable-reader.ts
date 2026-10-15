/**
 * Read-only reader for pi-durable session snapshots (issue #15, purpose 2).
 *
 * A pi-durable session is one SQLite file (`session.sqlite`) written by the
 * published `@earendil-works/pi-durable` SDK (schema v1). This module lets a
 * sibling read what that file preserves — GLG's turns, the answers, tool
 * results (where sibling reports live), compaction summaries and handoffs —
 * by entry id, without going through search. It applies no embedding policy:
 * every stored entry is readable, and each one carries an `origin` with the
 * `basis` that origin was inferred from.
 *
 * **Closed snapshots only.** A live session DB (WAL mode, held by a running
 * process) is refused before it is opened: any SQLite reader of a live WAL DB
 * writes a read mark into its `-shm` (measured on a synthetic WAL DB,
 * 2026-10-15), and live contact is not approved. The refusal checks run in
 * this order, each with a named reason:
 *
 *   missing-file / not-a-file   the path does not resolve to a regular file
 *   hardlinked                  it has more than one hard link (a snapshot is a
 *                               real copy; corpus rule "no hardlinks")
 *   live-store                  its realpath (symlinks resolved) is inside a
 *                               live durable root
 *   sidecar-present             a `-wal`, `-shm` or `-journal` sits beside it
 *   not-sqlite / wal-header     the header is not SQLite, or is WAL mode
 *   changed-during-open         the file or its sidecars changed between the
 *                               checks and the open
 *   not-durable                 no `durable_schema` table
 *   unsupported-schema          schema version newer than 1
 *
 * After the checks the file is opened with `mode=ro&immutable=1`, which tells
 * SQLite to take no locks and to read no `-wal`/`-shm`. That is a property of
 * reading a closed snapshot; it is not offered as a way to read a live DB.
 *
 * SDK facts this module relies on (pi-durable 1.2.0 dist):
 *   - schema v1 tables, `storage/sqlite/migrations.js:2-80`
 *   - entries and conversations are INSERT-only, `storage/sqlite/storage.js:577,581`
 *   - compaction and reset append; older entries stay, `harness/compaction.js:356-370`
 *   - root conversation id is 1, `types.js:2`
 *   - submissions carry `entry` (and `answer` once an input is done),
 *     `types.d.ts` SubmissionRecord
 *   - document kinds are JSON-encoded in the `kind` column, `storage.js:9,41`
 *
 * API 0. Network 0. Writes nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// node:sqlite, typed locally (the repo's @types/node predates node:sqlite)
// ---------------------------------------------------------------------------

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (location: string | URL, options?: { readOnly?: boolean }) => SqliteDatabase;
}

function loadSqlite(): SqliteModule {
  return createRequire(import.meta.url)("node:sqlite") as SqliteModule;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const SUPPORTED_DURABLE_SCHEMA = 1;
export const ROOT_CONVERSATION_ID = 1;

export type DurableRefusalReason =
  | "missing-file"
  | "not-a-file"
  | "live-store"
  | "hardlinked"
  | "sidecar-present"
  | "not-sqlite"
  | "wal-header"
  | "changed-during-open"
  | "not-durable"
  | "unsupported-schema"
  | "missing-entry"
  | "missing-conversation"
  | "bad-selection";

export class DurableReadRefused extends Error {
  constructor(
    readonly reason: DurableRefusalReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "DurableReadRefused";
  }
}

export type DurableOrigin =
  | "human"
  | "entwurf-brief"
  | "entwurf-doorbell"
  | "subagent-brief"
  | "background-report"
  | "input-entry"
  | "unsubmitted"
  | "assistant"
  | "tool-result"
  | "system"
  | "compaction-summary"
  | "handoff"
  | "reset"
  | "display"
  | "unknown";

export type ConversationScope = "root" | "task-owned" | "fork" | "ownerless";

export interface DurableConversation {
  id: number;
  scope: ConversationScope;
  parent: { conversationId: number; at: number } | null;
  owner: { conversationId: number; taskId: number } | null;
}

export interface DurableSubmissionRef {
  id: number;
  type: string;
  status: string;
  requestId: string | null;
  /** Explicit `answer` entry id of a done input submission; never inferred. */
  answer: number | null;
  reason: string | null;
}

export interface DurableToolCall {
  id: string | null;
  name: string;
  arguments: unknown;
}

/**
 * One message of an entry's `model` array, in stored order. SDK 1.2.0 writes a
 * single message for every built-in kind and for an InputEntry
 * (`harness/inbox.js:73-78`); a write submission or a direct extension append
 * may store more, and each keeps its own role and boundary here.
 */
export interface DurableMessageView {
  index: number;
  role: string | null;
  timestamp: string | null;
  text: string;
  chars: number;
  truncated: boolean;
  toolCalls: DurableToolCall[];
  omitted: Record<string, number>;
  stopReason: string | null;
  toolName: string | null;
  isError: boolean | null;
}

export interface DurableEntryView {
  entryId: number;
  conversationId: number;
  scope: ConversationScope;
  commitSeq: number;
  kind: string;
  origin: DurableOrigin;
  basis: string;
  /** role / timestamp / stopReason / toolName / isError describe the FIRST model message. */
  role: string | null;
  timestamp: string | null;
  head: number | null;
  byTaskId: number | null;
  /** The submission that placed this entry, if any. */
  submission: DurableSubmissionRef | null;
  /**
   * SUBMISSION ids (not entry ids) of done inputs whose explicit `answer` is
   * this entry. Ids are allocated from one space across tables, so a
   * submission id never names an entry; use `answeredInputs` for the entries.
   */
  answers: number[];
  /** The same done inputs resolved to their placed entry and its origin; null/unknown when the link is absent. */
  answeredInputs: Array<{ submissionId: number; entryId: number | null; origin: DurableOrigin }>;
  stopReason: string | null;
  toolName: string | null;
  isError: boolean | null;
  /** Tool calls of every message, in order. */
  toolCalls: DurableToolCall[];
  /** Text of every message joined by a blank line (or display `data.text`), possibly cut by maxChars. */
  text: string;
  /** Full length of `text` before any cut. */
  chars: number;
  truncated: boolean;
  /** Stored parts not rendered as text, by type: content blocks (thinking, image, …) and `contextEdit`. */
  omitted: Record<string, number>;
  /** Every model message with its own role and boundary. */
  messages: DurableMessageView[];
}

export interface DurableSnapshotInfo {
  file: string;
  /** `<13-digit ms>-<uuid>` session directory name, when the path has one. */
  sessionId: string | null;
  bucket: string | null;
  /** Corpus device segment (`<corpus>/<device>/.pi/agent/…`), when present. */
  device: string | null;
  schema: number;
  cwd: string | null;
  cwdBasis: string;
  project: string | null;
  bucketMatchesCwd: boolean | null;
  maxEntryId: number;
}

export interface DurableSelection {
  mode: "around" | "range";
  conversationId: number;
  center?: number;
  before?: number;
  after?: number;
  from?: number;
  to?: number;
  limit?: number;
}

export interface DurableReadResult {
  snapshot: DurableSnapshotInfo;
  conversation: DurableConversation;
  selection: DurableSelection;
  entries: DurableEntryView[];
  /** Where to continue a range read that hit `limit`; null when complete. */
  next: { from: number } | null;
  truncatedEntries: number;
}

export interface DurableCensus {
  snapshot: DurableSnapshotInfo;
  conversations: Array<DurableConversation & { entries: number; firstEntryId: number | null; lastEntryId: number | null }>;
  entries: { total: number; byKind: Record<string, number>; byOrigin: Record<string, number> };
  submissions: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    byRequestPrefix: Record<string, number>;
  };
  compactions: Array<{ entryId: number; conversationId: number; head: number | null }>;
}

export interface OpenOptions {
  /** Live durable roots to refuse. Default: `<agentDir>/experimental/durable-sessions`. */
  liveRoots?: string[];
}

export interface ReadOptions {
  /** Cut each entry's text to this many characters; the cut is reported. */
  maxChars?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_DIR = /^\d{13}-[0-9a-f-]{36}$/;
const BUCKET_DIR = /^[0-9a-f]{24}$/;
/** Opening of the entwurf launcher brief; pre-v0.31.0 launchers sent it without a requestId. */
export const LEGACY_ENTWURF_BRIEF = "You are a fresh visible citizen that entwurf";

const REQUEST_ORIGINS: Array<{ prefix: string; origin: DurableOrigin; basis: string }> = [
  { prefix: "entwurf-first-input:", origin: "entwurf-brief", basis: "requestId entwurf-first-input: (entwurf pi-durable bootstrap launcher brief)" },
  { prefix: "entwurf-doorbell:", origin: "entwurf-doorbell", basis: "requestId entwurf-doorbell: (entwurf meta-bridge mailbox notice)" },
  { prefix: "subagent:", origin: "subagent-brief", basis: "requestId subagent: (carrier subagent tool brief to its child)" },
  { prefix: "bash-background-report:", origin: "background-report", basis: "requestId bash-background-report: (agent-config background bash report)" },
];

const HUMAN_BASIS =
  "input submission without requestId; in the inspected carrier the only such path is the TUI submit " +
  "(entwurf pi/pi-durable runtime.ts controller.submit) — inferred from the input path, not an authorship proof";

// ---------------------------------------------------------------------------
// Opening — the closed-snapshot contract
// ---------------------------------------------------------------------------

function defaultLiveRoots(): string[] {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = envDir
    ? envDir.replace(/^~(?=\/|$)/, os.homedir())
    : path.join(os.homedir(), ".pi", "agent");
  return [path.join(agentDir, "experimental", "durable-sessions")];
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const SIDECARS = ["-wal", "-shm", "-journal"];

function presentSidecars(file: string): string[] {
  return SIDECARS.filter((s) => fs.existsSync(file + s));
}

interface OpenedSnapshot {
  db: SqliteDatabase;
  file: string;
}

/**
 * Open a closed durable snapshot read-only, or throw DurableReadRefused.
 * The caller owns `db.close()`.
 */
export function openDurableSnapshot(file: string, options: OpenOptions = {}): OpenedSnapshot {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new DurableReadRefused("missing-file", file);
  }
  if (!st.isFile()) throw new DurableReadRefused("not-a-file", file);
  // A snapshot is a real copy (VACUUM INTO or cp → one link); a second link may be a live file's inode.
  if (st.nlink > 1) throw new DurableReadRefused("hardlinked", `${file} has ${st.nlink} hard links — read a real copy`);

  const real = fs.realpathSync(file);
  const roots = options.liveRoots ?? defaultLiveRoots();
  for (const root of roots) {
    const realRoot = realpathOrNull(root);
    if (realRoot && (real === realRoot || real.startsWith(realRoot + path.sep))) {
      throw new DurableReadRefused("live-store", `${real} is inside the live durable root ${realRoot}`);
    }
  }
  const sidecars = presentSidecars(real);
  if (sidecars.length > 0) {
    throw new DurableReadRefused("sidecar-present", `${real} has ${sidecars.join(", ")} beside it — not a closed snapshot`);
  }

  // Header checks and the identity the open must still match, from one descriptor.
  const fd = fs.openSync(real, "r");
  let before: fs.Stats;
  try {
    before = fs.fstatSync(fd);
    const header = Buffer.alloc(100);
    const n = fs.readSync(fd, header, 0, 100, 0);
    if (n < 100 || header.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") {
      throw new DurableReadRefused("not-sqlite", real);
    }
    // Bytes 18/19: file format write/read version; 2 means WAL mode.
    if (header[18] === 2 || header[19] === 2) {
      throw new DurableReadRefused("wal-header", `${real} is in WAL mode — snapshot it with VACUUM INTO first`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const url = pathToFileURL(real);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(url, { readOnly: true });

  const after = fs.statSync(real);
  const changed =
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    presentSidecars(real).length > 0;
  if (changed) {
    db.close();
    throw new DurableReadRefused("changed-during-open", real);
  }

  try {
    const hasSchema = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'").get();
    if (!hasSchema) throw new DurableReadRefused("not-durable", `${real} has no durable_schema table`);
    const row = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get();
    const version = Number(row?.version ?? 0);
    if (version < 1) throw new DurableReadRefused("not-durable", `${real} has schema version ${version}`);
    if (version > SUPPORTED_DURABLE_SCHEMA) {
      throw new DurableReadRefused("unsupported-schema", `${real} has schema version ${version}; supported ≤ ${SUPPORTED_DURABLE_SCHEMA}`);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return { db, file: real };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface RawEntry {
  id: number;
  conversationId: number;
  commitSeq: number;
  record: Record<string, unknown>;
}

interface Loaded {
  info: DurableSnapshotInfo;
  conversations: Map<number, DurableConversation>;
  byEntry: Map<number, DurableSubmissionRef>;
  byAnswer: Map<number, number[]>;
  firstRootInputEntry: number | null;
  /** Submission id → the entry it placed (absent when the record names none). */
  submissionEntry: Map<number, number>;
  /** Origin of any entry by id, read and classified on demand while the DB is open. */
  originOf: (entryId: number) => DurableOrigin;
}

function parseJson(text: unknown): Record<string, unknown> {
  try {
    const v = JSON.parse(String(text));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Same normalization as session-indexer `extractProjectName`, fed the cwd. */
export function projectFromCwd(cwd: string): string {
  const cleaned = cwd.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
  const repos = cleaned.match(/^home-[^-]+-repos-(?:gh|work|3rd)-(.+)$/);
  if (repos) return repos[1];
  const home = cleaned.match(/^home-[^-]+-(.+)$/);
  if (home) return home[1];
  if (/^home-[^-]+$/.test(cleaned)) return "home";
  return cleaned || "unknown";
}

function pathIdentity(file: string): { sessionId: string | null; bucket: string | null; device: string | null } {
  const parts = file.split(path.sep);
  const n = parts.length;
  const sessionId = n >= 2 && SESSION_DIR.test(parts[n - 2]) ? parts[n - 2] : null;
  const bucket = sessionId && n >= 3 && BUCKET_DIR.test(parts[n - 3]) ? parts[n - 3] : null;
  let device: string | null = null;
  const marker = parts.lastIndexOf(".pi");
  if (bucket && marker >= 1 && parts.slice(marker, marker + 4).join("/") === ".pi/agent/experimental/durable-sessions") {
    device = parts[marker - 1] || null;
  }
  return { sessionId, bucket, device };
}

async function sha24(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

async function load(opened: OpenedSnapshot): Promise<Loaded> {
  const { db, file } = opened;
  const conversations = new Map<number, DurableConversation>();
  for (const row of db.prepare("SELECT id, record FROM conversations ORDER BY id").all()) {
    const id = Number(row.id);
    const rec = parseJson(row.record);
    const parent = rec.parent as { conversationId?: unknown; at?: unknown } | undefined;
    const owner = rec.owner as { conversationId?: unknown; taskId?: unknown } | undefined;
    const p = parent && num(parent.conversationId) !== null && num(parent.at) !== null
      ? { conversationId: Number(parent.conversationId), at: Number(parent.at) }
      : null;
    const o = owner && num(owner.conversationId) !== null && num(owner.taskId) !== null
      ? { conversationId: Number(owner.conversationId), taskId: Number(owner.taskId) }
      : null;
    const scope: ConversationScope =
      id === ROOT_CONVERSATION_ID ? "root" : o ? "task-owned" : p ? "fork" : "ownerless";
    conversations.set(id, { id, scope, parent: p, owner: o });
  }

  const byEntry = new Map<number, DurableSubmissionRef>();
  const byAnswer = new Map<number, number[]>();
  const submissionEntry = new Map<number, number>();
  let firstRootInputEntry: number | null = null;
  for (const row of db.prepare("SELECT id, conversation_id, record FROM submissions ORDER BY id").all()) {
    const rec = parseJson(row.record);
    const type = String(rec.type ?? "");
    const status = String(rec.status ?? "");
    const ref: DurableSubmissionRef = {
      id: Number(row.id),
      type,
      status,
      requestId: typeof rec.requestId === "string" ? rec.requestId : null,
      // Only a done input names its answer (SubmissionRecord); anything else is not a confirmed join.
      answer: type === "input" && status === "done" ? num(rec.answer) : null,
      reason: typeof rec.reason === "string" ? rec.reason : null,
    };
    const entry = num(rec.entry);
    if (entry !== null) {
      byEntry.set(entry, ref);
      submissionEntry.set(ref.id, entry);
      if (ref.type === "input" && Number(row.conversation_id) === ROOT_CONVERSATION_ID) {
        if (firstRootInputEntry === null || entry < firstRootInputEntry) firstRootInputEntry = entry;
      }
    }
    if (ref.answer !== null) byAnswer.set(ref.answer, [...(byAnswer.get(ref.answer) ?? []), ref.id]);
  }

  // Root cwd from the root conversation's pi.agent document: newest base revision.
  // SDK 1.2.0 stored each measured cwd change as a new base (6 of 6, synthetic,
  // 2026-10-15), but it has a delta path (session/transaction.js:771-776). Deltas
  // are not applied here, so when any follow the base the cwd is withheld.
  let cwd: string | null = null;
  let cwdBasis = "no pi.agent document for the root conversation";
  const doc = db
    .prepare(
      `SELECT id FROM documents WHERE kind = '"pi.agent"' AND scope_kind = 'conversation'
       AND owner_id = ? AND retired_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(ROOT_CONVERSATION_ID);
  if (doc) {
    const base = db
      .prepare("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1")
      .get(doc.id);
    if (base) {
      const later = db
        .prepare("SELECT count(*) AS n FROM document_revisions WHERE document_id = ? AND seq > ?")
        .get(doc.id, base.seq);
      if (Number(later?.n ?? 0) > 0) {
        cwdBasis = "root pi.agent has delta revisions after its newest base; deltas are not applied, so the current cwd is unknown";
      } else {
        const value = parseJson(base.content);
        cwd = typeof value.cwd === "string" ? value.cwd : null;
        cwdBasis = "root pi.agent newest base revision (no later deltas)";
      }
    }
  }

  const origins = new Map<number, DurableOrigin>();
  const originOf = (entryId: number): DurableOrigin => {
    const known = origins.get(entryId);
    if (known) return known;
    const row = db.prepare("SELECT conversation_id, record FROM entries WHERE id = ?").get(entryId);
    let origin: DurableOrigin = "unknown";
    if (row) {
      const rec = parseJson(row.record);
      const message = firstMessage(rec);
      const text = message ? renderContent(message.content).text : "";
      origin = classifyEntry(
        String(rec.kind ?? ""), rec, entryId, conversations.get(Number(row.conversation_id)),
        byEntry.get(entryId) ?? null, firstRootInputEntry, text,
      ).origin;
    }
    origins.set(entryId, origin);
    return origin;
  };

  const { sessionId, bucket, device } = pathIdentity(file);
  const schema = Number(db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()?.version ?? 0);
  const maxEntryId = Number(db.prepare("SELECT coalesce(max(id), 0) AS m FROM entries").get()?.m ?? 0);
  return {
    info: {
      file,
      sessionId,
      bucket,
      device,
      schema,
      cwd,
      cwdBasis,
      project: cwd ? projectFromCwd(cwd) : null,
      bucketMatchesCwd: cwd && bucket ? (await sha24(cwd)) === bucket : null,
      maxEntryId,
    },
    conversations,
    byEntry,
    byAnswer,
    firstRootInputEntry,
    submissionEntry,
    originOf,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function firstMessage(record: Record<string, unknown>): Record<string, unknown> | null {
  const model = record.model;
  if (!Array.isArray(model) || model.length === 0) return null;
  const m = model[0];
  return m && typeof m === "object" ? (m as Record<string, unknown>) : null;
}

/** Text blocks joined; other block types counted, never silently dropped. */
function renderContent(content: unknown): { text: string; omitted: Record<string, number>; toolCalls: DurableToolCall[] } {
  const omitted: Record<string, number> = {};
  const toolCalls: DurableToolCall[] = [];
  if (typeof content === "string") return { text: content, omitted, toolCalls };
  if (!Array.isArray(content)) return { text: "", omitted, toolCalls };
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "toolCall") {
      toolCalls.push({ id: typeof b.id === "string" ? b.id : null, name: String(b.name ?? "?"), arguments: b.arguments ?? null });
    } else {
      const t = String(b.type ?? "unknown");
      omitted[t] = (omitted[t] ?? 0) + 1;
    }
  }
  return { text: parts.join("\n"), omitted, toolCalls };
}

export function classifyEntry(
  kind: string,
  record: Record<string, unknown>,
  entryId: number,
  conversation: DurableConversation | undefined,
  submission: DurableSubmissionRef | null,
  firstRootInputEntry: number | null,
  text: string,
): { origin: DurableOrigin; basis: string } {
  const message = firstMessage(record);
  switch (kind) {
    case "pi.user": {
      if (!submission) {
        return {
          origin: "unsubmitted",
          basis: "pi.user with no placing submission; SDK writer: onYield continuation (generation answer()) or a direct extension append",
        };
      }
      if (submission.type !== "input") {
        return { origin: "unknown", basis: `pi.user placed by a ${submission.type || "?"} submission` };
      }
      if (submission.requestId !== null) {
        const known = REQUEST_ORIGINS.find((r) => submission.requestId!.startsWith(r.prefix));
        if (known) return { origin: known.origin, basis: known.basis };
        const prefix = submission.requestId.split(":")[0];
        return { origin: "unknown", basis: `unrecognized requestId prefix "${prefix}"` };
      }
      if (text.startsWith(LEGACY_ENTWURF_BRIEF)) {
        if (conversation?.scope === "root" && entryId === firstRootInputEntry) {
          return {
            origin: "entwurf-brief",
            basis: "no requestId; first root input and its text opens with the entwurf launcher brief (pre-v0.31.0 launchers sent no requestId)",
          };
        }
        return { origin: "unknown", basis: "no requestId; text opens with the entwurf launcher brief but it is not the first root input" };
      }
      return { origin: "human", basis: HUMAN_BASIS };
    }
    case "pi.assistant":
      return { origin: "assistant", basis: "pi.assistant (provider result)" };
    case "pi.tool-result":
      return { origin: "tool-result", basis: "pi.tool-result" };
    case "pi.system":
      return { origin: "system", basis: "pi.system (prompt/tool change marker)" };
    case "pi.compaction":
      return { origin: "compaction-summary", basis: "pi.compaction (model-written summary; older entries stay stored)" };
    case "pi.reset":
      if (!message) return { origin: "reset", basis: "pi.reset without handoff text" };
      return submission
        ? { origin: "handoff", basis: "pi.reset with handoff text, placed by a reset() write submission" }
        : { origin: "handoff", basis: "pi.reset with handoff text, appended by a tool-control handoff (no submission)" };
  }
  if (!kind.startsWith("pi.")) {
    if (message && message.role === "user" && submission?.type === "input") {
      return { origin: "input-entry", basis: `host input kind "${kind}" carrying a user message (pi-durable 1.2.0 InputEntry)` };
    }
    if (!message) return { origin: "display", basis: `display-only entry kind "${kind}"` };
  }
  return { origin: "unknown", basis: `unrecognized entry kind "${kind}"` };
}

function cutText(text: string, maxChars: number | undefined): { text: string; truncated: boolean } {
  return maxChars !== undefined && text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}

function viewMessages(record: Record<string, unknown>, maxChars: number | undefined): DurableMessageView[] {
  const model = Array.isArray(record.model) ? record.model : [];
  return model.map((m, index) => {
    const message = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
    const rendered = renderContent(message.content);
    const ts = num(message.timestamp);
    const shown = cutText(rendered.text, maxChars);
    return {
      index,
      role: typeof message.role === "string" ? message.role : null,
      timestamp: ts !== null ? new Date(ts).toISOString() : null,
      text: shown.text,
      chars: rendered.text.length,
      truncated: shown.truncated,
      toolCalls: rendered.toolCalls,
      omitted: rendered.omitted,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
      toolName: typeof message.toolName === "string" ? message.toolName : null,
      isError: typeof message.isError === "boolean" ? message.isError : null,
    };
  });
}

function viewEntry(raw: RawEntry, loaded: Loaded, options: ReadOptions): DurableEntryView {
  const rec = raw.record;
  const kind = String(rec.kind ?? "");
  const messages = viewMessages(rec, options.maxChars);
  // Full (uncut) texts for the joined text and for classification.
  const fullTexts = (Array.isArray(rec.model) ? rec.model : []).map((m) =>
    renderContent(m && typeof m === "object" ? (m as Record<string, unknown>).content : undefined).text,
  );
  let text = fullTexts.filter((t) => t.length > 0).join("\n\n");
  if (messages.length === 0) {
    const data = rec.data as Record<string, unknown> | undefined;
    if (data && typeof data.text === "string") text = data.text;
  }
  const omitted: Record<string, number> = {};
  for (const m of messages) for (const [k, v] of Object.entries(m.omitted)) omitted[k] = (omitted[k] ?? 0) + v;
  if (Array.isArray(rec.edits) && rec.edits.length > 0) omitted.contextEdit = rec.edits.length;

  const conversation = loaded.conversations.get(raw.conversationId);
  const submission = loaded.byEntry.get(raw.id) ?? null;
  const { origin, basis } = classifyEntry(kind, rec, raw.id, conversation, submission, loaded.firstRootInputEntry, fullTexts[0] ?? text);
  const shown = cutText(text, options.maxChars);
  const first = messages[0];
  return {
    entryId: raw.id,
    conversationId: raw.conversationId,
    scope: conversation?.scope ?? "ownerless",
    commitSeq: raw.commitSeq,
    kind,
    origin,
    basis,
    role: first?.role ?? null,
    timestamp: first?.timestamp ?? null,
    head: num(rec.head),
    byTaskId: num(rec.byTaskId),
    submission,
    answers: loaded.byAnswer.get(raw.id) ?? [],
    answeredInputs: (loaded.byAnswer.get(raw.id) ?? []).map((submissionId) => {
      const entryId = loaded.submissionEntry.get(submissionId) ?? null;
      return { submissionId, entryId, origin: entryId === null ? "unknown" : loaded.originOf(entryId) };
    }),
    stopReason: first?.stopReason ?? null,
    toolName: first?.toolName ?? null,
    isError: first?.isError ?? null,
    toolCalls: messages.flatMap((m) => m.toolCalls),
    text: shown.text,
    chars: text.length,
    truncated: shown.truncated,
    omitted,
    messages,
  };
}

function rawRows(rows: Record<string, unknown>[]): RawEntry[] {
  return rows.map((r) => ({
    id: Number(r.id),
    conversationId: Number(r.conversation_id),
    commitSeq: Number(r.commit_seq),
    record: parseJson(r.record),
  }));
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/**
 * Entries around `center`, counted in physical entries of the center's own
 * conversation. A fork's inherited entries and other conversations are never
 * mixed in.
 */
export async function readDurableAround(
  file: string,
  center: number,
  before = 3,
  after = 3,
  options: ReadOptions & OpenOptions = {},
): Promise<DurableReadResult> {
  if (!Number.isInteger(center) || center < 1) throw new DurableReadRefused("bad-selection", `entry id must be a positive integer, got ${center}`);
  if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) {
    throw new DurableReadRefused("bad-selection", "before/after must be non-negative integers");
  }
  const opened = openDurableSnapshot(file, options);
  try {
    const loaded = await load(opened);
    const { db } = opened;
    const centerRow = db.prepare("SELECT id, conversation_id, commit_seq, record FROM entries WHERE id = ?").get(center);
    if (!centerRow) throw new DurableReadRefused("missing-entry", `entry ${center} is not in ${opened.file} (max ${loaded.info.maxEntryId})`);
    const conversationId = Number(centerRow.conversation_id);
    const older = rawRows(
      db.prepare("SELECT id, conversation_id, commit_seq, record FROM entries WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
        .all(conversationId, center, before),
    ).reverse();
    const newer = rawRows(
      db.prepare("SELECT id, conversation_id, commit_seq, record FROM entries WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
        .all(conversationId, center, after),
    );
    const entries = [...older, ...rawRows([centerRow]), ...newer].map((r) => viewEntry(r, loaded, options));
    return {
      snapshot: loaded.info,
      conversation: loaded.conversations.get(conversationId) ?? { id: conversationId, scope: "ownerless", parent: null, owner: null },
      selection: { mode: "around", conversationId, center, before, after },
      entries,
      next: null,
      truncatedEntries: entries.filter((e) => e.truncated).length,
    };
  } finally {
    opened.db.close();
  }
}

/** Physical entries `from ≤ id ≤ to` of one conversation (default: root), at most `limit`. */
export async function readDurableRange(
  file: string,
  range: { conversationId?: number; from?: number; to?: number; limit?: number },
  options: ReadOptions & OpenOptions = {},
): Promise<DurableReadResult> {
  const conversationId = range.conversationId ?? ROOT_CONVERSATION_ID;
  const from = range.from ?? 1;
  const to = range.to ?? Number.MAX_SAFE_INTEGER;
  const limit = range.limit ?? 200;
  if (![conversationId, from, limit].every((v) => Number.isInteger(v) && v >= 1) || !(to >= from)) {
    throw new DurableReadRefused("bad-selection", `invalid range conversation=${conversationId} from=${from} to=${to} limit=${limit}`);
  }
  const opened = openDurableSnapshot(file, options);
  try {
    const loaded = await load(opened);
    const conversation = loaded.conversations.get(conversationId);
    if (!conversation) throw new DurableReadRefused("missing-conversation", `conversation ${conversationId} is not in ${opened.file}`);
    const rows = rawRows(
      opened.db
        .prepare("SELECT id, conversation_id, commit_seq, record FROM entries WHERE conversation_id = ? AND id >= ? AND id <= ? ORDER BY id ASC LIMIT ?")
        .all(conversationId, from, to, limit + 1),
    );
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map((r) => viewEntry(r, loaded, options));
    return {
      snapshot: loaded.info,
      conversation,
      selection: { mode: "range", conversationId, from, to: range.to, limit },
      entries,
      next: more ? { from: rows[limit].id } : null,
      truncatedEntries: entries.filter((e) => e.truncated).length,
    };
  } finally {
    opened.db.close();
  }
}

/** Counts only — no entry text leaves this function. */
export async function censusDurable(file: string, options: OpenOptions = {}): Promise<DurableCensus> {
  const opened = openDurableSnapshot(file, options);
  try {
    const loaded = await load(opened);
    const byKind: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    const perConversation = new Map<number, { entries: number; first: number | null; last: number | null }>();
    const compactions: DurableCensus["compactions"] = [];
    let total = 0;
    for (const raw of rawRows(opened.db.prepare("SELECT id, conversation_id, commit_seq, record FROM entries ORDER BY id").all())) {
      const view = viewEntry(raw, loaded, {});
      total++;
      byKind[view.kind] = (byKind[view.kind] ?? 0) + 1;
      byOrigin[view.origin] = (byOrigin[view.origin] ?? 0) + 1;
      const c = perConversation.get(raw.conversationId) ?? { entries: 0, first: null, last: null };
      c.entries++;
      c.first ??= raw.id;
      c.last = raw.id;
      perConversation.set(raw.conversationId, c);
      if (view.kind === "pi.compaction") compactions.push({ entryId: raw.id, conversationId: raw.conversationId, head: view.head });
    }
    const subs = { total: 0, byType: {} as Record<string, number>, byStatus: {} as Record<string, number>, byRequestPrefix: {} as Record<string, number> };
    for (const row of opened.db.prepare("SELECT request_id, status, record FROM submissions").all()) {
      const rec = parseJson(row.record);
      subs.total++;
      const type = String(rec.type ?? "?");
      subs.byType[type] = (subs.byType[type] ?? 0) + 1;
      const status = String(row.status ?? "?");
      subs.byStatus[status] = (subs.byStatus[status] ?? 0) + 1;
      const prefix = typeof rec.requestId === "string" ? rec.requestId.split(":")[0] : "(none)";
      subs.byRequestPrefix[prefix] = (subs.byRequestPrefix[prefix] ?? 0) + 1;
    }
    return {
      snapshot: loaded.info,
      conversations: [...loaded.conversations.values()].map((c) => {
        const p = perConversation.get(c.id);
        return { ...c, entries: p?.entries ?? 0, firstEntryId: p?.first ?? null, lastEntryId: p?.last ?? null };
      }),
      entries: { total, byKind, byOrigin },
      submissions: subs,
      compactions,
    };
  } finally {
    opened.db.close();
  }
}

// ---------------------------------------------------------------------------
// Text rendering (the CLI's non-JSON form)
// ---------------------------------------------------------------------------

export function renderDurableRead(result: DurableReadResult): string {
  const s = result.snapshot;
  const c = result.conversation;
  const lines: string[] = [];
  lines.push(`# ${s.file}`);
  lines.push(`# session=${s.sessionId ?? "-"} project=${s.project ?? "-"} schema=${s.schema} maxEntryId=${s.maxEntryId}`);
  const rel = c.parent ? ` parent=${c.parent.conversationId}@${c.parent.at}` : c.owner ? ` owner=conv${c.owner.conversationId}/task${c.owner.taskId}` : "";
  lines.push(`# conversation=${c.id} scope=${c.scope}${rel}`);
  for (const e of result.entries) {
    const sub = e.submission
      ? ` sub=${e.submission.id}:${e.submission.type}:${e.submission.status}${e.submission.requestId ? `:${e.submission.requestId}` : ""}${e.submission.answer !== null ? ` answer=e${e.submission.answer}` : ""}`
      : "";
    const ans = e.answeredInputs.length > 0
      ? ` answers=${e.answeredInputs.map((a) => `sub${a.submissionId}→${a.entryId !== null ? `e${a.entryId}` : "?"}(${a.origin})`).join(",")}`
      : "";
    const stop = e.stopReason ? ` stop=${e.stopReason}` : "";
    const tool = e.toolName ? ` tool=${e.toolName}${e.isError ? " error" : ""}` : "";
    const head = e.head !== null ? ` head=e${e.head}` : "";
    const mark = result.selection.center === e.entryId ? ">>" : "  ";
    lines.push("");
    lines.push(`${mark} e${e.entryId} ${e.kind} [${e.origin}] ${e.timestamp ?? "-"}${sub}${ans}${stop}${tool}${head}`);
    const indent = (t: string) => t.split("\n").map((l) => `   ${l}`).join("\n");
    if (e.messages.length > 1) {
      // Keep each stored message's boundary and role visible.
      for (const m of e.messages) {
        lines.push(`   [message ${m.index} ${m.role ?? "-"}]`);
        for (const call of m.toolCalls) lines.push(`   call ${call.name} ${JSON.stringify(call.arguments)}`);
        if (m.text) lines.push(indent(m.text));
        if (m.truncated) lines.push(`   [truncated: ${m.text.length}/${m.chars} chars]`);
      }
    } else {
      for (const call of e.toolCalls) lines.push(`   call ${call.name} ${JSON.stringify(call.arguments)}`);
      if (e.text) lines.push(indent(e.text));
    }
    if (e.truncated) lines.push(`   [truncated: ${e.text.length}/${e.chars} chars — full: durable:read <file> --from ${e.entryId} --to ${e.entryId} --conversation ${e.conversationId}]`);
    const om = Object.entries(e.omitted);
    if (om.length > 0) lines.push(`   [not rendered: ${om.map(([k, v]) => `${k}×${v}`).join(", ")}]`);
  }
  if (result.next) lines.push(`\n# more: --from ${result.next.from} --conversation ${c.id}`);
  return lines.join("\n");
}

export const __test = { pathIdentity, renderContent };
