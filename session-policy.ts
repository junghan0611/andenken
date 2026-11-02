/**
 * Sessions selection policy pin (issue #18).
 *
 * The regular sessions writers (`indexer.ts sessions`, `estimate sessions`,
 * `index:durable`, `cli.ts reindex`, pi `/memory reindex`) read ONE file to learn
 * which selection policy the data directory they write into was built with:
 *
 *   <data>/session-policy.json
 *   {"kind":"andenken-sessions-policy","version":1,"selection":"control-v1","s0":"whole-message-v1"}
 *
 *   absent              → legacy. Byte-identical to the writers before this file.
 *   exactly the above   → control-v1 selection + whole-message S0 hold.
 *   anything else       → every writer refuses (unreadable, not a regular file,
 *                         malformed JSON, unknown kind/version/value, extra keys).
 *
 * The same object is also recorded as `selectionPolicy` at the top level of
 * `<data>/session-manifest.json`, so losing one file cannot silently turn a
 * control-v1 index back into a legacy one. Both absent → legacy (every index
 * written before this file). Both present and identical → pinned. One side only,
 * or the two differ → refuse. `pinSessionsPolicy` writes both. A manifest that is
 * present must be a regular file holding a JSON object: a symlink, a directory or
 * unparseable bytes refuse every writer instead of reading as "no field" (which
 * would turn a lost pin back into legacy).
 *
 * The pin is a declaration, not a verification: it says which policy the rows
 * WERE built with. Pin only a data dir built under control-v1 (a verified
 * candidate). Pinning an existing legacy index does not re-select its rows or
 * hold its S0 matches — it would mislabel them.
 *
 * There is no third value and no default upgrade: a data directory is pinned by
 * writing this file deliberately, at cutover. A writer that cannot understand the
 * pin stops instead of guessing, because guessing is how two policies end up
 * mixed in one index.
 *
 * Not here: which policy the CANDIDATE was built with (its receipt says that),
 * any version protocol for sources, or archive hooks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "./store.js";
import { extractSessionChunks, extractSessionChunksDetailed, MAX_CHUNK_CHARS, type SessionChunk } from "./session-indexer.js";
import { partitionMessagesForEmbedding, SAFETY_KINDS, type SafetyKind } from "./session-selection.js";

export const SESSIONS_POLICY_FILE = "session-policy.json";
export const SESSIONS_POLICY_KIND = "andenken-sessions-policy";
export const S0_LEDGER_FILE = "s0-held.json";
export const S0_LEDGER_NOTE = "S0-held rows: never sent to the provider. Ids and kinds only.";

export type SessionsPolicy =
  | { selection: "legacy"; pinned: false }
  | { selection: "control-v1"; s0: "whole-message-v1"; pinned: true };

export const LEGACY_POLICY: SessionsPolicy = { selection: "legacy", pinned: false };

/** The exact pin content. `writeSessionsPolicy` and tests use it; readers compare against it. */
export const CONTROL_V1_PIN = Object.freeze({
  kind: SESSIONS_POLICY_KIND,
  version: 1,
  selection: "control-v1",
  s0: "whole-message-v1",
});

export class SessionsPolicyRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`sessions-policy ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "SessionsPolicyRefused";
  }
}

export function sessionsPolicyPath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, SESSIONS_POLICY_FILE);
}

export const MANIFEST_POLICY_FIELD = "selectionPolicy";

export function sessionManifestPath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, "session-manifest.json");
}

/** Whether `doc` is exactly the control-v1 pin. Throws `code-prefix` refusals naming `where`. */
function assertExactPin(doc: unknown, where: string): void {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new SessionsPolicyRefused("policy-malformed", where);
  const d = doc as Record<string, unknown>;
  const want = CONTROL_V1_PIN as Record<string, unknown>;
  if (Object.keys(d).sort().join(",") !== Object.keys(want).sort().join(",")) {
    throw new SessionsPolicyRefused("policy-unknown-fields", where);
  }
  for (const k of Object.keys(want)) {
    if (d[k] !== want[k]) throw new SessionsPolicyRefused("policy-unknown-value", `${k} in ${where}`);
  }
}

/** The pin file: undefined when absent, else its parsed content (validated). */
function readPinFile(dataDir: string): true | undefined {
  const p = sessionsPolicyPath(dataDir);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SessionsPolicyRefused("policy-unreadable", (e as NodeJS.ErrnoException).code);
  }
  if (!st.isFile()) throw new SessionsPolicyRefused("policy-not-regular-file", p);
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    throw new SessionsPolicyRefused("policy-malformed", p);
  }
  assertExactPin(doc, p);
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** lstat `p`: undefined when absent; any other failure throws `code`. Never follows a symlink. */
function lstatOrAbsent(p: string, code: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SessionsPolicyRefused(code, `${p} (${(e as NodeJS.ErrnoException).code})`);
  }
}

/**
 * The session manifest as a JSON object, or undefined when absent. Present but a
 * symlink / non-regular file / unparseable / not an object → throws (`prefix`-*).
 */
function readManifestObject(dataDir: string, prefix: "policy-manifest" | "pin-manifest"): Record<string, unknown> | undefined {
  const p = sessionManifestPath(dataDir);
  const st = lstatOrAbsent(p, `${prefix}-unreadable`);
  if (!st) return undefined;
  if (!st.isFile()) throw new SessionsPolicyRefused(`${prefix}-not-regular-file`, p);
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    throw new SessionsPolicyRefused(`${prefix}-malformed`, p);
  }
  if (!isPlainObject(doc)) throw new SessionsPolicyRefused(`${prefix}-malformed`, `${p} is not a JSON object`);
  return doc;
}

/** The manifest's copy: undefined when the manifest or the field is absent; validated when present. */
function readManifestPin(dataDir: string): true | undefined {
  const doc = readManifestObject(dataDir, "policy-manifest");
  if (!doc || !(MANIFEST_POLICY_FIELD in doc)) return undefined;
  assertExactPin(doc[MANIFEST_POLICY_FIELD], `${sessionManifestPath(dataDir)} ${MANIFEST_POLICY_FIELD}`);
  return true;
}

/** Read the pin of `dataDir` (file + manifest copy). Both absent → legacy. Anything else not exactly understood → throws. */
export function readSessionsPolicy(dataDir: string = getDataDir()): SessionsPolicy {
  const file = readPinFile(dataDir);
  const manifest = readManifestPin(dataDir);
  if (!file && !manifest) return LEGACY_POLICY;
  if (!file) throw new SessionsPolicyRefused("policy-file-missing", `session-manifest.json is pinned but ${SESSIONS_POLICY_FILE} is absent`);
  if (!manifest) throw new SessionsPolicyRefused("policy-manifest-missing", `${SESSIONS_POLICY_FILE} is present but session-manifest.json carries no ${MANIFEST_POLICY_FIELD}`);
  return { selection: "control-v1", s0: "whole-message-v1", pinned: true };
}

function writeAtomic(p: string, text: string): void {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, p);
}

/**
 * Pin `dataDir` to control-v1: the manifest field first, then the pin file. A
 * crash between the two leaves one side only, which every writer refuses.
 * Refuses a dir whose sessions.lance is not a real directory, whose manifest is
 * not a regular JSON-object file, or that already carries any pin entry (a
 * broken symlink at the pin path counts). The caller holds the sessions writer
 * lock of `dataDir`.
 *
 * Metadata only: the rows are neither read nor re-selected. Pin a data dir that
 * was BUILT under control-v1 (a verified candidate), never a legacy index.
 */
export function pinSessionsPolicy(dataDir: string): void {
  const lance = path.join(dataDir, "sessions.lance");
  const lst = lstatOrAbsent(lance, "pin-index-unreadable");
  if (!lst) throw new SessionsPolicyRefused("pin-no-index", dataDir);
  if (!lst.isDirectory()) throw new SessionsPolicyRefused("pin-index-not-directory", lance);
  const pp = sessionsPolicyPath(dataDir);
  if (lstatOrAbsent(pp, "pin-unreadable")) throw new SessionsPolicyRefused("pin-exists", pp);
  const mp = sessionManifestPath(dataDir);
  const doc = readManifestObject(dataDir, "pin-manifest");
  if (!doc) throw new SessionsPolicyRefused("pin-no-manifest", dataDir);
  if (MANIFEST_POLICY_FIELD in doc) throw new SessionsPolicyRefused("pin-exists", `${mp} ${MANIFEST_POLICY_FIELD}`);
  doc[MANIFEST_POLICY_FIELD] = { ...CONTROL_V1_PIN };
  writeAtomic(mp, JSON.stringify(doc, null, 2));
  writeAtomic(sessionsPolicyPath(dataDir), JSON.stringify(CONTROL_V1_PIN, null, 1) + "\n");
}

/** Writers that have no control-v1 implementation refuse a pinned data dir with this. */
export function refuseIfPinned(policy: SessionsPolicy, writer: string): void {
  if (policy.pinned) {
    throw new SessionsPolicyRefused(
      "pinned-writer-unsupported",
      `${writer} writes legacy selection only; this data dir is pinned to ${policy.selection}. Use ./run.sh sync:sessions`,
    );
  }
}

// --- Extraction per policy ---

export interface HeldEntry {
  /** Chunk id, corpus-relative when the file is inside the corpus (same form as the candidate ledger). */
  id: string;
  kinds: SafetyKind[];
  chars: number;
}

export interface PolicyExtraction {
  send: SessionChunk[];
  held: HeldEntry[];
}

/** `id` as the ledger records it: relative to the corpus root when inside it. */
export function ledgerId(id: string, corpus: string | undefined): string {
  return corpus && id.startsWith(corpus + path.sep) ? path.relative(corpus, id) : id;
}

/**
 * The chunks a writer may send for `file` under `policy`, and the S0-held ones.
 * legacy: exactly `extractSessionChunks(file)`, nothing held — the old path.
 * control-v1: the selected groups, partitioned by the whole-message S0 scan.
 *
 * control-v1 also refuses the WHOLE file (`held-sanitize-conflict`, line numbers
 * only) when any message's retained text fails sanitize. The candidate plan
 * reports those messages explicitly; a regular writer has no ledger for them, so
 * it does not drop them silently either: the throw reaches the writer's per-file
 * error path, which leaves that file's rows and manifest entry as they were and
 * fails the run. Conservative limit: the file's other, clean messages wait too,
 * until an operator resolves the conflict.
 */
export async function extractForPolicy(
  file: string,
  policy: SessionsPolicy,
  corpus: string | undefined,
): Promise<PolicyExtraction> {
  if (!policy.pinned) return { send: await extractSessionChunks(file), held: [] };
  const det = await extractSessionChunksDetailed(fs.createReadStream(file), file, "control-v1");
  const conflicts = det.decisions.filter((d) => d.outcome === "held-sanitize-conflict").map((d) => d.lineNumber);
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 5).join(",") + (conflicts.length > 5 ? ",…" : "");
    throw new SessionsPolicyRefused("held-sanitize-conflict", `${ledgerId(file, corpus)}: ${conflicts.length} message(s), line(s) ${shown}; file not indexed, its rows and manifest entry kept`);
  }
  const { send, held } = partitionMessagesForEmbedding(det.selectedGroups);
  return {
    send,
    held: held.flatMap((h) => h.chunks.map((c) => ({ id: ledgerId(c.id, corpus), kinds: h.kinds, chars: c.text.length }))),
  };
}

// --- S0 ledger (same document shape as the candidate's s0-held.json) ---

export interface S0Ledger {
  note: string;
  count: number;
  rows: HeldEntry[];
}

export function s0LedgerPath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, S0_LEDGER_FILE);
}

const LEDGER_KEYS = "count,note,rows";
const ROW_KEYS = "chars,id,kinds";
/** `<file>.jsonl:<line>` or `<file>.jsonl:<line>#<part>` — the chunk id form. */
const CHUNK_ID = /^(.+\.jsonl):\d+(?:#\d+)?$/;

function validLedgerId(id: unknown): id is string {
  if (typeof id !== "string" || /[\0\n\r]/.test(id)) return false;
  const m = CHUNK_ID.exec(id);
  if (!m) return false;
  const file = m[1];
  // Corpus-relative (the candidate and corpus form) or absolute (a file outside
  // the corpus); either way already normal, with no `.`/`..` segment.
  return path.normalize(file) === file && !file.split("/").some((seg) => seg === ".." || seg === ".");
}

function validKinds(kinds: unknown): kinds is SafetyKind[] {
  if (!Array.isArray(kinds) || kinds.length === 0) return false;
  let prev = -1;
  for (const k of kinds) {
    const i = SAFETY_KINDS.indexOf(k as SafetyKind);
    if (i <= prev) return false; // unknown (-1), duplicate or out of canonical order
    prev = i;
  }
  return true;
}

/**
 * Absent → empty. Present: a regular file holding exactly `{note,count,rows}`,
 * the candidate's note, and rows of exactly `{id,kinds,chars}` — a chunk id
 * (unique), known S0 kinds in canonical order, a chunk length the splitter can
 * emit. Anything else throws a fixed code naming the row index and field, never
 * a value: a writer must not re-save what it cannot vouch for, and the ledger
 * must stay ids and kinds only. The returned rows are rebuilt from those three
 * fields.
 */
export function loadS0Ledger(dataDir: string = getDataDir()): S0Ledger {
  const p = s0LedgerPath(dataDir);
  const st = lstatOrAbsent(p, "s0-ledger-unreadable");
  if (!st) return { note: S0_LEDGER_NOTE, count: 0, rows: [] };
  if (!st.isFile()) throw new SessionsPolicyRefused("s0-ledger-not-regular-file", p);
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    throw new SessionsPolicyRefused("s0-ledger-malformed", p);
  }
  if (!isPlainObject(doc)) throw new SessionsPolicyRefused("s0-ledger-malformed", `${p} is not a JSON object`);
  if (Object.keys(doc).sort().join(",") !== LEDGER_KEYS) throw new SessionsPolicyRefused("s0-ledger-unknown-fields", p);
  if (doc.note !== S0_LEDGER_NOTE) throw new SessionsPolicyRefused("s0-ledger-unknown-value", `note in ${p}`);
  if (!Array.isArray(doc.rows) || doc.count !== doc.rows.length) throw new SessionsPolicyRefused("s0-ledger-malformed", `count/rows in ${p}`);
  const seen = new Set<string>();
  const rows: HeldEntry[] = [];
  doc.rows.forEach((r: unknown, i: number) => {
    if (!isPlainObject(r) || Object.keys(r).sort().join(",") !== ROW_KEYS) throw new SessionsPolicyRefused("s0-ledger-row-unknown-fields", `row ${i} in ${p}`);
    if (!validLedgerId(r.id) || seen.has(r.id)) throw new SessionsPolicyRefused("s0-ledger-row-invalid", `row ${i} id in ${p}`);
    if (!validKinds(r.kinds)) throw new SessionsPolicyRefused("s0-ledger-row-invalid", `row ${i} kinds in ${p}`);
    const chars = r.chars;
    if (typeof chars !== "number" || !Number.isSafeInteger(chars) || chars < 1 || chars > MAX_CHUNK_CHARS) {
      throw new SessionsPolicyRefused("s0-ledger-row-invalid", `row ${i} chars in ${p}`);
    }
    seen.add(r.id);
    rows.push({ id: r.id, kinds: [...r.kinds], chars });
  });
  return { note: S0_LEDGER_NOTE, count: rows.length, rows };
}

/** Replace every row of `fileId` (the file's ledger id) with `rows`. Pure. */
export function replaceLedgerFile(ledger: S0Ledger, fileId: string, rows: HeldEntry[]): S0Ledger {
  const prefix = fileId + ":";
  const kept = ledger.rows.filter((r) => !r.id.startsWith(prefix));
  const next = [...kept, ...rows];
  return { note: S0_LEDGER_NOTE, count: next.length, rows: next };
}

/** Atomic 0600 write (tmp + rename in the same directory). */
export function saveS0Ledger(ledger: S0Ledger, dataDir: string = getDataDir()): void {
  writeAtomic(s0LedgerPath(dataDir), JSON.stringify({ note: S0_LEDGER_NOTE, count: ledger.rows.length, rows: ledger.rows }, null, 1) + "\n");
}

// --- Index authority (any policy) ---

/**
 * INVARIANT 7.1: only the index authority writes sessions.lance. One judgement
 * for every Node sessions writer (`indexer.ts sessions` / `durable`, compact /
 * cleanup, `cli.ts reindex`, pi `/memory reindex`), the same as sync-sessions.sh:
 *   - device = `$HOME/.current-device`, trimmed; missing, unreadable or blank
 *     is an UNKNOWN device, and an unknown device is never the authority;
 *   - authority = ANDENKEN_INDEX_AUTHORITY, trimmed; unset, empty or blank →
 *     `thinkpad` (the shell's `${ANDENKEN_INDEX_AUTHORITY:-thinkpad}`);
 *   - ANDENKEN_ALLOW_REPLICA_INDEX=1 is the one override (a fork), unknown included.
 * (Before: a missing device file and ANDENKEN_INDEX_AUTHORITY='' compared '' ===
 * '' and passed.) Returns the refusal text, or null.
 */
export function indexAuthorityRefusal(writer: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ANDENKEN_ALLOW_REPLICA_INDEX === "1") return null;
  let device = "";
  try {
    device = fs.readFileSync(path.join(env.HOME ?? "", ".current-device"), "utf-8").trim();
  } catch {
    device = "";
  }
  const authority = (env.ANDENKEN_INDEX_AUTHORITY ?? "").trim() || "thinkpad";
  if (device !== "" && device === authority) return null;
  return `${writer} writes only on the index authority (${authority}); this device is ${device || "unknown"} (INVARIANT 7.1, no API call was made)`;
}

// --- Fresh paid guard (any policy) ---

/**
 * A paid run into an index that holds NONE of the discovered JSONL files is a
 * full rebuild in all but name: a botched swap that leaves sessions.lance
 * missing or empty — or holding only pi-durable rows — would otherwise re-embed
 * the whole corpus on the next incremental call. It takes the same explicit flag
 * the --force path takes. `indexedFiles` = discovered JSONL files that already
 * have rows. Returns the refusal text, or null.
 */
export function freshPaidRefusal(opts: {
  paid: boolean;
  indexedFiles: number;
  toIndex: number;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const env = opts.env ?? process.env;
  if (!opts.paid || opts.indexedFiles > 0 || opts.toIndex === 0) return null;
  if (env.ANDENKEN_ALLOW_PAID_FULL_REBUILD === "1") return null;
  return (
    `refused: the sessions index holds none of the discovered sessions and ${opts.toIndex} files would be embedded against a paid endpoint.\n` +
    "  That is a full rebuild. Restore the index, or run scripts/rebuild-sessions-full.sh /\n" +
    "  set ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 after reviewing ./run.sh estimate:sessions.\n" +
    "  (no API call was made)"
  );
}
