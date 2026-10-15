/**
 * pi-durable as a session SOURCE (issue #15, purpose 1): corpus admission,
 * corpus discovery, and row extraction.
 *
 * The corpus holds CLOSED snapshots only, at the live path with a device
 * prefix — the same contract as the JSONL corpus:
 *
 *   <corpus>/<device>/.pi/agent/experimental/durable-sessions/<bucket>/<session>/session.sqlite
 *
 * Nothing here finds, opens or copies a live durable DB. A snapshot reaches
 * the corpus only through `admitDurableSnapshot`, which takes ONE snapshot an
 * operator already made through an approved procedure, verifies it through the
 * reader's closed-snapshot refusals, and writes a real copy (0600, new
 * directories 0700) with an atomic rename. Replacing an existing corpus copy
 * requires the same lineage (root pi.provider sessionId), the old copy's last
 * entry present byte-identical in the new one, and no fewer entries.
 *
 * Extraction reuses the plan's B.1 decisions (durable-plan.ts) and the JSONL
 * path's sanitize + split, so a durable row is built the same way a JSONL row
 * is; only the line number is an entry id.
 *
 * API 0. Network 0.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  censusDurable,
  openDurableSnapshot,
  readDurableRange,
  type DurableEntryView,
  type OpenOptions,
} from "./durable-reader.js";
import { DURABLE_POLICY, rootLineage, type DurablePlan } from "./durable-plan.js";
import { splitForEmbedding } from "./session-indexer.js";
import { sanitizeSessionChunkText } from "./session-sanitize.js";

export const DURABLE_SEGMENTS = [".pi", "agent", "experimental", "durable-sessions"] as const;
const SESSION_DIR = /^\d{13}-[0-9a-f-]{36}$/;
const BUCKET_DIR = /^[0-9a-f]{24}$/;

export type DurableAdmitReason =
  | "no-corpus"
  | "unknown-device"
  | "bad-identity"
  | "identity-conflict"
  | "bucket-mismatch"
  | "dest-escape"
  | "dest-not-regular"
  | "durable-lineage-unknown"
  | "durable-lineage-mismatch"
  | "durable-rollback"
  | "durable-diverged"
  | "copy-mismatch";

export class DurableAdmitRefused extends Error {
  constructor(
    readonly reason: DurableAdmitReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "DurableAdmitRefused";
  }
}

// ---------------------------------------------------------------------------
// Corpus layout
// ---------------------------------------------------------------------------

/** `ANDENKEN_SESSION_CORPUS`, the same variable the JSONL indexer reads; undefined when unset. */
export function durableCorpusRoot(): string | undefined {
  const raw = process.env.ANDENKEN_SESSION_CORPUS;
  if (!raw) return undefined;
  return raw.replace(/^~(?=\/|$)/, os.homedir());
}

export function durableCorpusPath(corpus: string, device: string, bucket: string, session: string): string {
  return path.join(corpus, device, ...DURABLE_SEGMENTS, bucket, session, "session.sqlite");
}

/** Device ids in `<corpus>/DEVICES.json`, any state (a retired device's sessions stay admissible). */
export function rosterDevices(corpus: string): string[] {
  const file = path.join(corpus, "DEVICES.json");
  try {
    const roster = JSON.parse(fs.readFileSync(file, "utf-8")) as { devices?: Array<{ id?: unknown }> };
    return (roster.devices ?? []).map((d) => d.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export interface DurableCorpusFile {
  file: string;
  device: string;
  bucket: string;
  session: string;
}

/** Every corpus snapshot in the durable grammar, sorted. Symlinks are skipped, never followed. */
export function findDurableSnapshots(corpus: string): DurableCorpusFile[] {
  const out: DurableCorpusFile[] = [];
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const device of dirs(corpus)) {
    const root = path.join(corpus, device, ...DURABLE_SEGMENTS);
    for (const bucket of dirs(root).filter((b) => BUCKET_DIR.test(b))) {
      for (const session of dirs(path.join(root, bucket)).filter((s) => SESSION_DIR.test(s))) {
        const file = path.join(root, bucket, session, "session.sqlite");
        try {
          if (fs.lstatSync(file).isFile()) out.push({ file, device, bucket, session });
        } catch {
          /* no database in this session directory */
        }
      }
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function fileSha256(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export interface DurableWitness {
  id: number;
  sha256: string;
}

/** The last entry at or below `upTo` and the sha256 of its stored record — an INSERT-only row, so a fixed point. */
export function witnessAt(file: string, upTo: number, options: OpenOptions = {}): DurableWitness | null {
  const { db } = openDurableSnapshot(file, options);
  try {
    const row = db.prepare("SELECT id, record FROM entries WHERE id <= ? ORDER BY id DESC LIMIT 1").get(upTo);
    if (!row) return null;
    return { id: Number(row.id), sha256: crypto.createHash("sha256").update(String(row.record)).digest("hex") };
  } finally {
    db.close();
  }
}

/** True when `file` holds entry `w.id` with exactly the recorded bytes. */
export function witnessHolds(file: string, w: DurableWitness, options: OpenOptions = {}): boolean {
  const { db } = openDurableSnapshot(file, options);
  try {
    const row = db.prepare("SELECT record FROM entries WHERE id = ?").get(w.id);
    return !!row && crypto.createHash("sha256").update(String(row.record)).digest("hex") === w.sha256;
  } finally {
    db.close();
  }
}

export interface DurableIdentity {
  lineage: string | null;
  maxEntryId: number;
  cwd: string | null;
  bucket: string | null;
  session: string | null;
  sha256: string;
}

export async function durableIdentity(file: string, options: OpenOptions = {}): Promise<DurableIdentity> {
  const census = await censusDurable(file, options);
  return {
    lineage: rootLineage(file, options).lineage,
    maxEntryId: census.snapshot.maxEntryId,
    cwd: census.snapshot.cwd,
    bucket: census.snapshot.bucket,
    session: census.snapshot.sessionId,
    sha256: fileSha256(census.snapshot.file),
  };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface AdmitOptions extends OpenOptions {
  input: string;
  device: string;
  bucket?: string;
  session?: string;
  corpus?: string;
}

export interface AdmitReport {
  action: "created" | "replaced" | "unchanged";
  dest: string;
  sha256: string;
  lineage: string | null;
  maxEntryId: number;
  previous: { sha256: string; maxEntryId: number } | null;
  notes: string[];
}

function mkdirPrivate(dir: string): void {
  // Create missing components one by one so only the new ones get 0700.
  const missing: string[] = [];
  let p = dir;
  while (!fs.existsSync(p)) {
    missing.unshift(p);
    p = path.dirname(p);
  }
  for (const m of missing) fs.mkdirSync(m, { mode: 0o700 });
}

/**
 * Copy ONE closed snapshot into the corpus. Refuses by name; never touches a
 * live DB (the input goes through the reader's refusals first).
 */
export async function admitDurableSnapshot(opts: AdmitOptions): Promise<AdmitReport> {
  const corpus = opts.corpus ?? durableCorpusRoot();
  if (!corpus || !fs.existsSync(corpus) || !fs.statSync(corpus).isDirectory()) {
    throw new DurableAdmitRefused("no-corpus", `corpus root ${corpus ?? "(ANDENKEN_SESSION_CORPUS unset)"} is not a directory`);
  }
  const devices = rosterDevices(corpus);
  if (!devices.includes(opts.device)) {
    throw new DurableAdmitRefused("unknown-device", `${opts.device} is not in ${path.join(corpus, "DEVICES.json")} (${devices.join(", ") || "empty"})`);
  }

  const notes: string[] = [];
  const input = await durableIdentity(opts.input, opts);
  const bucket = opts.bucket ?? input.bucket;
  const session = opts.session ?? input.session;
  if (!bucket || !BUCKET_DIR.test(bucket) || !session || !SESSION_DIR.test(session)) {
    throw new DurableAdmitRefused("bad-identity", `need a 24-hex bucket and a <13 digits>-<uuid> session (got ${bucket ?? "-"} / ${session ?? "-"})`);
  }
  if ((opts.bucket && input.bucket && opts.bucket !== input.bucket) || (opts.session && input.session && opts.session !== input.session)) {
    throw new DurableAdmitRefused("identity-conflict", `arguments ${opts.bucket ?? "-"}/${opts.session ?? "-"} disagree with the input path ${input.bucket}/${input.session}`);
  }
  if (input.cwd) {
    const expected = crypto.createHash("sha256").update(input.cwd).digest("hex").slice(0, 24);
    if (expected !== bucket) throw new DurableAdmitRefused("bucket-mismatch", `sha256(${input.cwd})[:24] = ${expected}, not ${bucket}`);
  } else {
    notes.push("root cwd unknown — bucket not verified against it");
  }
  if (!input.lineage) notes.push("root pi.provider sessionId absent — lineage unknown; a later replacement will be refused");

  const dest = durableCorpusPath(corpus, opts.device, bucket, session);
  const destDir = path.dirname(dest);
  mkdirPrivate(destDir);
  const realCorpus = fs.realpathSync(corpus);
  const realDir = fs.realpathSync(destDir);
  if (!realDir.startsWith(realCorpus + path.sep)) {
    throw new DurableAdmitRefused("dest-escape", `${destDir} resolves to ${realDir}, outside ${realCorpus}`);
  }

  let previous: AdmitReport["previous"] = null;
  if (fs.existsSync(dest) || fs.lstatSync(destDir).isDirectory() && fs.readdirSync(destDir).includes("session.sqlite")) {
    const st = fs.lstatSync(dest);
    if (!st.isFile()) throw new DurableAdmitRefused("dest-not-regular", `${dest} exists and is not a regular file`);
    const old = await durableIdentity(dest, opts);
    previous = { sha256: old.sha256, maxEntryId: old.maxEntryId };
    if (old.sha256 === input.sha256) {
      return { action: "unchanged", dest, sha256: input.sha256, lineage: input.lineage, maxEntryId: input.maxEntryId, previous, notes };
    }
    if (!old.lineage || !input.lineage) {
      throw new DurableAdmitRefused("durable-lineage-unknown", `cannot prove ${opts.input} continues ${dest}: lineage ${old.lineage ?? "unknown"} → ${input.lineage ?? "unknown"}`);
    }
    if (old.lineage !== input.lineage) {
      throw new DurableAdmitRefused("durable-lineage-mismatch", `${dest} is lineage ${old.lineage}, input is ${input.lineage}`);
    }
    if (input.maxEntryId < old.maxEntryId) {
      throw new DurableAdmitRefused("durable-rollback", `input maxEntryId ${input.maxEntryId} < corpus copy ${old.maxEntryId}`);
    }
    const w = witnessAt(dest, old.maxEntryId, opts);
    if (w && !witnessHolds(opts.input, w, opts)) {
      throw new DurableAdmitRefused("durable-diverged", `entry e${w.id} of the corpus copy is absent or different in the input`);
    }
  }

  // Real copy beside the target, verified, then renamed over it.
  const tmp = path.join(destDir, `.session.sqlite.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.copyFileSync(opts.input, tmp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tmp, 0o600);
    const fd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const copied = fileSha256(tmp);
    if (copied !== input.sha256) throw new DurableAdmitRefused("copy-mismatch", `copy sha ${copied} ≠ input ${input.sha256}`);
    fs.renameSync(tmp, dest);
    const dfd = fs.openSync(destDir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return {
    action: previous ? "replaced" : "created",
    dest,
    sha256: input.sha256,
    lineage: input.lineage,
    maxEntryId: input.maxEntryId,
    previous,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface DurableRow {
  id: string;
  text: string;
  sessionFile: string;
  project: string;
  lineNumber: number;
  timestamp: string;
  role: "user" | "assistant" | "compaction";
  source: "pi-durable";
  metadata: Record<string, string>;
}

export interface DurableExtraction {
  rows: DurableRow[];
  /** Plan-included entries in the range. */
  candidates: number;
  /** Entries the sanitizer dropped, by reason. */
  sanitizeDrops: Record<string, number>;
}

const SUMMARY_WRAPPER = /^The conversation history before this point was compacted into the following summary:\n\n<summary>\n([\s\S]*)\n<\/summary>$/;

/**
 * Rows for the plan's B.1 includes with `after < entryId ≤ upTo`. The text is
 * read through the reader; user/assistant text goes through the JSONL
 * sanitizer, every row through the JSONL splitter.
 */
export async function extractDurableRows(
  file: string,
  plan: DurablePlan,
  range: { after: number; upTo: number },
  provenance: { device: string; session: string },
  options: OpenOptions = {},
): Promise<DurableExtraction> {
  const picked = plan.candidates.filter((c) => c.B.decision === "include" && c.entryId > range.after && c.entryId <= range.upTo);
  const sanitizeDrops: Record<string, number> = {};
  const rows: DurableRow[] = [];
  if (picked.length === 0) return { rows, candidates: 0, sanitizeDrops };

  const views = new Map<number, DurableEntryView>();
  for (const conv of new Set(picked.map((c) => c.conversationId))) {
    const read = await readDurableRange(file, { conversationId: conv, from: range.after + 1, to: range.upTo, limit: Number.MAX_SAFE_INTEGER - 1 }, options);
    for (const e of read.entries) views.set(e.entryId, e);
  }
  const project = plan.snapshot.project ?? "unknown";
  for (const c of picked) {
    const e = views.get(c.entryId);
    if (!e || !c.role) continue;
    let text = e.text;
    if (c.role === "compaction") {
      text = (text.match(SUMMARY_WRAPPER)?.[1] ?? text).trim();
    } else {
      const s = sanitizeSessionChunkText(text, c.role, "pi");
      if (!s.ok) {
        sanitizeDrops[s.dropReason] = (sanitizeDrops[s.dropReason] ?? 0) + 1;
        continue;
      }
      text = s.text;
    }
    if (!text) {
      sanitizeDrops.empty = (sanitizeDrops.empty ?? 0) + 1;
      continue;
    }
    const parts = splitForEmbedding(text);
    const type = c.role === "user" ? "user_message" : c.role === "assistant" ? "assistant_response" : "compaction";
    parts.forEach((part, i) => {
      rows.push({
        id: parts.length === 1 ? `${file}:e${e.entryId}` : `${file}:e${e.entryId}#${i}`,
        text: part,
        sessionFile: file,
        project,
        lineNumber: e.entryId,
        timestamp: e.timestamp ?? "",
        role: c.role!,
        source: "pi-durable",
        metadata: {
          type,
          origin: e.origin,
          entryId: String(e.entryId),
          conversationId: String(e.conversationId),
          scope: e.scope,
          lineage: plan.snapshot.lineage ?? "",
          session: provenance.session,
          device: provenance.device,
          policy: DURABLE_POLICY,
          ...(parts.length > 1 ? { part: String(i), parts: String(parts.length) } : {}),
        },
      });
    });
  }
  return { rows, candidates: picked.length, sanitizeDrops };
}
