/**
 * candidate:sessions:plan — API-0 plan for ONE selection-candidate sessions
 * index (issue #18, policy control-v1). Plan only: there is no build here.
 *
 * Per discovered corpus JSONL:
 *   input boundary from metadata (inside the corpus, regular file, no symlink
 *   on the path) → open O_NOFOLLOW, fstat, read the bytes ONCE from that
 *   descriptor, fstat + path re-check → sha256 → one pass of
 *   extractSessionChunksDetailed over those same bytes, which yields the legacy
 *   chunks (production parser) AND the control-v1 chunks of the same snapshot →
 *   S0 over each whole message text before split (a hit holds the message).
 * A refused source is never read; a moved one is `changed`; a failure is an
 * `error` (code only). None enters the totals and each makes the plan
 * incomplete. Empty discovery is `status: "empty"`, never a complete zero.
 * No automatic retry.
 *
 * Window: --since-kst/--until-kst (both required, half-open KST) select files by latest eligible send
 * timestamp; profile ollama-bge-m3-1024 is required and recorded with its fingerprint; lengthPlan is
 * reported for the send set.
 *
 * Admitted closed pi-durable snapshots pass the same boundary, are pinned by
 * size + sha256 before AND after, and are planned through the existing
 * `runDurableIndex` dry run against the (absent) candidate durable manifest,
 * B.1 as-is (control-v1 is NOT applied to durable rows), with the same S0.
 *
 * Never: provider, store, network, gather, live SQLite, text in the output.
 * The output carries counts, coordinates (file, line, chunk id) and fixed
 * codes — never a reason detail or exception message.
 *
 *   tsx scripts/candidate-plan.ts --target <abs dir> --out <abs file> --since-kst <ISO> --until-kst <ISO>
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  extractSessionChunksDetailed,
  findSessionFiles,
  withEmbedSplit,
  type SelectionDecision,
} from "../session-indexer.ts";
import { partitionMessagesForEmbedding, type MessageGroup, type SafetyKind } from "../session-selection.ts";
import { runDurableIndex } from "../durable-index.ts";
import { findDurableSnapshots } from "../durable-source.ts";
import type { DurableRefusalReason } from "../durable-reader.ts";
import { PROFILES, codepointsNfkc, embedSplitFor, getProfile, lengthPlan, maxInputCodepoints, profileFingerprint, type EmbeddingProfile } from "../embedding-profile.ts";

export const PLAN_KIND = "andenken-candidate-plan";
export const PLAN_POLICY = "control-v1" as const;
/** The ONLY embedding generation this candidate may be built with (local Ollama BGE-M3, 1024d). */
export const CANDIDATE_PROFILE_ID = "ollama-bge-m3-1024";
export const CANDIDATE_PROFILE: EmbeddingProfile = PROFILES[CANDIDATE_PROFILE_ID];
const VECTOR_BYTES_PER_ROW = CANDIDATE_PROFILE.dimensions * 4;
const GiB = 1024 ** 3;
/** Draft budget (coordinator 13:56): candidate ≤ 5 GiB, ≥ 8 GiB left on the target fs. Confirmed only after the plan. */
const DRAFT_CANDIDATE_CAP = 5 * GiB;
const DRAFT_ROOT_RESERVE = 8 * GiB;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface PlanEnv {
  /** `ANDENKEN_SESSION_PROFILE`; must be the candidate profile. */
  profileId?: string;
  home: string;
  corpus: string | undefined;
  dataDir: string;
  candidatesRoot: string;
}

export function defaultPlanEnv(env: NodeJS.ProcessEnv = process.env): PlanEnv {
  const home = env.HOME ?? os.homedir();
  const corpusRaw = env.ANDENKEN_SESSION_CORPUS;
  const expanded = corpusRaw ? corpusRaw.replace(/^~(?=\/|$)/, home) : undefined;
  return {
    profileId: env.ANDENKEN_SESSION_PROFILE,
    home,
    // String normalization only (trailing slash, `..`); a relative value stays as-is for the guard to refuse.
    corpus: expanded && path.isAbsolute(expanded) ? path.resolve(expanded) : expanded,
    dataDir: env.ANDENKEN_DATA ?? path.join(home, "repos", "gh", "andenken", "data"),
    candidatesRoot: path.join(home, ".local", "state", "andenken", "candidates"),
  };
}

// ---------------------------------------------------------------------------
// Date window — fixed KST, half-open [since, until), both explicit
// ---------------------------------------------------------------------------

export interface PlanWindow {
  sinceKst: string;
  untilKst: string;
  sinceMs: number;
  untilMs: number;
}

const KST_OFFSET_MS = 9 * 3600_000;
const KST_RE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(\+09:00)?$/;

/** `YYYY-MM-DD[THH:MM[:SS[.mmm]]][+09:00]`, always read as KST; any other offset or `Z` is refused. */
export function parseKstInstant(s: string): number | null {
  const m = KST_RE.exec(s);
  if (!m) return null;
  const iso = `${m[1]}T${m[2] ?? "00:00"}:${m[3] ?? "00"}.${(m[4] ?? "0").padEnd(3, "0")}+09:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // Reject rolled-over dates such as 2026-02-30.
  if (new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10) !== m[1]) return null;
  return ms;
}

export function kstIso(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

export function parseKstWindow(since: string | undefined, until: string | undefined): { ok: true; window: PlanWindow } | { ok: false; code: string } {
  if (since === undefined || until === undefined) return { ok: false, code: "window-required" };
  const a = parseKstInstant(since);
  const b = parseKstInstant(until);
  if (a === null || b === null) return { ok: false, code: "window-invalid" };
  if (!(a < b)) return { ok: false, code: "window-empty-or-inverted" };
  return { ok: true, window: { sinceKst: kstIso(a), untilKst: kstIso(b), sinceMs: a, untilMs: b } };
}

export type PlanArgs = { ok: true; target: string; out: string; window: PlanWindow } | { ok: false; code: string };

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Every EXISTING ancestor of `p` resolves to itself (no symlink on the way). */
function ancestorsCanonical(p: string): boolean {
  let cur = path.dirname(p);
  while (true) {
    if (fs.existsSync(cur) && fs.realpathSync(cur) !== cur) return false;
    const next = path.dirname(cur);
    if (next === cur) return true;
    cur = next;
  }
}

/** Metadata-only guard. Creates nothing, opens no session. */
export function validatePlanArgs(argv: string[], env: PlanEnv): PlanArgs {
  const known = new Set(["--target", "--out", "--since-kst", "--until-kst"]);
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) return { ok: false, code: "unknown-argument" };
    if (a in values) return { ok: false, code: "argument-repeated" };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { ok: false, code: "argument-missing-value" };
    values[a] = v;
    i++;
  }
  const target = values["--target"];
  const out = values["--out"];
  if (!target || !out) return { ok: false, code: "target-and-out-required" };
  const w = parseKstWindow(values["--since-kst"], values["--until-kst"]);
  if (!w.ok) return w;
  if (env.profileId !== CANDIDATE_PROFILE_ID) return { ok: false, code: "profile-not-ollama-bge-m3-1024" };
  if (!env.corpus) return { ok: false, code: "corpus-env-required" };
  if (!path.isAbsolute(env.corpus)) return { ok: false, code: "corpus-not-absolute" };
  if (!fs.existsSync(env.corpus) || !fs.statSync(env.corpus).isDirectory()) return { ok: false, code: "corpus-missing" };
  if (fs.realpathSync(env.corpus) !== env.corpus) return { ok: false, code: "corpus-not-canonical" };
  // An empty corpus makes discovery fall back to the LIVE stores (session-indexer getCorpusDevices).
  const devices = fs.readdirSync(env.corpus).filter((d) => !d.startsWith(".") && fs.statSync(path.join(env.corpus!, d)).isDirectory());
  if (devices.length === 0) return { ok: false, code: "corpus-has-no-device-dir" };

  for (const [name, p] of [["target", target], ["out", out]] as const) {
    if (!path.isAbsolute(p) || path.resolve(p) !== p) return { ok: false, code: `${name}-not-absolute-normalized` };
    if (fs.existsSync(p) || isSymlink(p)) return { ok: false, code: `${name}-exists` };
    if (!ancestorsCanonical(p)) return { ok: false, code: `${name}-symlinked-ancestor` };
    if (within(p, env.corpus) || within(env.corpus, p)) return { ok: false, code: `${name}-overlaps-corpus` };
    if (within(p, env.dataDir) || within(env.dataDir, p)) return { ok: false, code: `${name}-overlaps-production-data` };
    if (within(p, REPO)) return { ok: false, code: `${name}-inside-repo` };
  }
  if (path.dirname(target) !== env.candidatesRoot) return { ok: false, code: "target-not-directly-under-candidates-root" };
  if (within(out, target)) return { ok: false, code: "out-inside-target" };
  if (!fs.existsSync(path.dirname(out))) return { ok: false, code: "out-parent-missing" };
  return { ok: true, target, out, window: w.window };
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Input boundary — decided from metadata BEFORE any byte of a source is read
// ---------------------------------------------------------------------------

/**
 * A source may be read only if it is a normalized absolute path strictly inside
 * the corpus, a regular file (not a symlink), and canonical (no symlinked
 * ancestor). Returns a fixed refusal code, or null. Reads no content.
 */
export function checkSource(file: string, corpus: string): string | null {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) return "source-not-normalized";
  if (file === corpus || !within(file, corpus)) return "source-outside-corpus";
  let l: fs.Stats;
  try {
    l = fs.lstatSync(file);
  } catch {
    return "source-missing";
  }
  if (l.isSymbolicLink()) return "source-symlink";
  if (!l.isFile()) return "source-not-regular-file";
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return "source-missing";
  }
  if (real !== file) return "source-symlinked-ancestor";
  return null;
}

interface StatKey {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
}
const keyOf = (s: fs.BigIntStats): StatKey => ({ dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeNs: String(s.mtimeNs) });
const sameKey = (a: StatKey, b: StatKey) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

const ANNEX_POINTER = Buffer.from("/annex/objects/", "latin1");

export type ReadOnce =
  | { kind: "ok"; bytes: Buffer; stat: StatKey }
  | { kind: "changed"; pre: StatKey; post: StatKey | null }
  | { kind: "refused"; code: string };

/**
 * Read a source exactly once: boundary check, then open with O_NOFOLLOW on the
 * checked path, fstat the descriptor (must be the inode just checked), read the
 * whole file from that descriptor, fstat again and re-check the path. Any move
 * is `changed`; nothing is retried.
 */
export function readSourceOnce(file: string, corpus: string): ReadOnce {
  const code = checkSource(file, corpus);
  if (code) return { kind: "refused", code };
  const checked = fs.lstatSync(file, { bigint: true });
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    return { kind: "refused", code: (e as { code?: string }).code === "ELOOP" ? "source-symlink" : "source-open-failed" };
  }
  try {
    const s0 = fs.fstatSync(fd, { bigint: true });
    if (!s0.isFile() || s0.dev !== checked.dev || s0.ino !== checked.ino) return { kind: "refused", code: "source-swapped-before-open" };
    const pre = keyOf(s0);
    const bytes = fs.readFileSync(fd);
    const post = keyOf(fs.fstatSync(fd, { bigint: true }));
    let pathAfter: StatKey | null = null;
    try {
      const l1 = fs.lstatSync(file, { bigint: true });
      if (!l1.isSymbolicLink() && fs.realpathSync(file) === file) pathAfter = keyOf(l1);
    } catch {
      pathAfter = null;
    }
    if (!sameKey(pre, post) || bytes.length !== pre.size || !pathAfter || !sameKey(pre, pathAfter)) {
      return { kind: "changed", pre, post: pathAfter ?? post };
    }
    if (bytes.length <= 8192 && bytes.subarray(0, ANNEX_POINTER.length).equals(ANNEX_POINTER)) {
      return { kind: "refused", code: "source-annex-pointer" };
    }
    return { kind: "ok", bytes, stat: pre };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Codes only — a reason/exception string can carry payload, so none is emitted
// ---------------------------------------------------------------------------

const READER_REFUSALS: Record<DurableRefusalReason, true> = {
  "missing-file": true,
  "not-a-file": true,
  "live-store": true,
  hardlinked: true,
  "sidecar-present": true,
  "not-sqlite": true,
  "wal-header": true,
  "changed-during-open": true,
  "not-durable": true,
  "unsupported-schema": true,
  "missing-entry": true,
  "missing-conversation": true,
  "bad-selection": true,
};
const INDEX_REFUSALS: ReadonlySet<string> = new Set([
  "durable-winner-path-changed",
  "durable-policy-changed",
  "durable-lineage-mismatch",
  "durable-rollback",
  "durable-diverged",
]);

/** A durable report reason reduced to a known code; the detail after it is never kept. */
export function durableReasonCode(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const head = /^([a-z][a-z0-9-]{0,63}):/.exec(reason)?.[1];
  if (head && (Object.hasOwn(READER_REFUSALS, head) || INDEX_REFUSALS.has(head))) return head;
  return "unclassified";
}

/** An exception reduced to a Node errno code or an Error class name — never its message. */
export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z0-9_]{1,30}$/.test(code)) return code;
  if (e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name)) return e.name;
  return "unclassified";
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

interface Tally {
  chunks: number;
  chars: number;
  bytes: number;
}
const tally = (): Tally => ({ chunks: 0, chars: 0, bytes: 0 });
function add(t: Tally, chunks: readonly { text: string }[]): void {
  for (const c of chunks) {
    t.chunks += 1;
    t.chars += c.text.length;
    t.bytes += Buffer.byteLength(c.text, "utf8");
  }
}
function inc(o: Record<string, number>, k: string, n = 1): void {
  o[k] = (o[k] ?? 0) + n;
}

type HeldCoord = { id: string; kinds: SafetyKind[]; chars: number };

/** Length plan over the SEND set (S0-held chunks never leave, so they are not measured). */
interface LengthAcc {
  total: number;
  over: number;
  maxCodepoints: number;
  overCoords: Array<{ id: string; codepoints: number }>;
}
const OVER_COORDS_CAP = 200;
const newLengthAcc = (): LengthAcc => ({ total: 0, over: 0, maxCodepoints: 0, overCoords: [] });
function addLength(acc: LengthAcc, chunks: ReadonlyArray<{ id: string; text: string }>, corpus: string): void {
  const limit = maxInputCodepoints(CANDIDATE_PROFILE, "document");
  const r = lengthPlan(CANDIDATE_PROFILE, "document", chunks.map((c) => c.text));
  acc.total += r.total;
  acc.over += r.over;
  acc.maxCodepoints = Math.max(acc.maxCodepoints, r.maxCodepoints);
  if (r.over > 0 && limit !== null) {
    for (const c of chunks) {
      const n = codepointsNfkc(c.text);
      if (n > limit && acc.overCoords.length < OVER_COORDS_CAP) acc.overCoords.push({ id: path.relative(corpus, c.id), codepoints: n });
    }
  }
}

/** Latest parseable timestamp among send chunks, or null (no chunks / none parseable). */
export function latestSendMs(send: ReadonlyArray<{ timestamp: string }>): number | null {
  let latest: number | null = null;
  for (const c of send) {
    const t = Date.parse(c.timestamp);
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

export type ExcludeCode = "outside-window" | "no-send-chunks" | "no-parseable-timestamp";
/** Window rule over a send set: half-open [since, until). */
export function windowDecision(send: ReadonlyArray<{ timestamp: string }>, w: PlanWindow): { include: true; latestMs: number } | { include: false; code: ExcludeCode; latestMs: number | null } {
  if (send.length === 0) return { include: false, code: "no-send-chunks", latestMs: null };
  const latest = latestSendMs(send);
  if (latest === null) return { include: false, code: "no-parseable-timestamp", latestMs: null };
  if (latest >= w.sinceMs && latest < w.untilMs) return { include: true, latestMs: latest };
  return { include: false, code: "outside-window", latestMs: latest };
}

/** S0 over message groups: send/held tallies, kinds once per held message, coordinates per held chunk. */
function applyS0<T extends { id: string; text: string }>(
  groups: ReadonlyArray<MessageGroup<T>>,
  corpus: string,
  sink: { held: Tally; toSend: Tally; heldMessages: number; kinds: Record<string, number>; coords: HeldCoord[]; length?: LengthAcc },
): void {
  const { send, held } = partitionMessagesForEmbedding(groups);
  add(sink.toSend, send);
  if (sink.length) addLength(sink.length, send, corpus);
  for (const h of held) {
    sink.heldMessages += 1;
    for (const k of h.kinds) inc(sink.kinds, k);
    add(sink.held, h.chunks);
    for (const c of h.chunks) sink.coords.push({ id: path.relative(corpus, c.id), kinds: h.kinds, chars: c.text.length });
  }
}

/** The profile-scoped split in force for every extraction of this generation. */
export const CANDIDATE_SPLIT = embedSplitFor(CANDIDATE_PROFILE)!;

/** Every extraction (JSONL and durable) runs inside the profile's split scope, identically in plan, build and resume. */
export function runPlan(target: string, env: PlanEnv, window: PlanWindow) {
  return withEmbedSplit(CANDIDATE_SPLIT, () => runPlanScoped(target, env, window));
}

async function runPlanScoped(target: string, env: PlanEnv, window: PlanWindow) {
  if (env.profileId !== CANDIDATE_PROFILE_ID) throw new Error("profile-not-ollama-bge-m3-1024");
  const corpus = env.corpus!;
  const totals = {
    discovered: 0,
    files: 0,
    lines: 0,
    blankLines: 0,
    invalidJsonLines: 0,
    legacy: tally(),
    control: tally(),
    safetyHeld: tally(),
    safetyHeldMessages: 0,
    toSend: tally(),
    legacySafetyHits: tally(),
    outcomes: {} as Record<string, number>,
    outcomeLegacyChunks: {} as Record<string, number>,
    blockReasons: {} as Record<string, { blocks: number; rawChars: number }>,
    safetyKinds: {} as Record<string, number>,
  };
  const coords = {
    safetyHeld: [] as HeldCoord[],
    attention: [] as Array<{ file: string; line: number; outcome: string; retainedChars: number; legacyChunks: number }>,
  };
  const perFile: Array<Record<string, unknown>> = [];
  const excludedFiles: Array<{ file: string; size: number; code: ExcludeCode; latestSendKst: string | null }> = [];
  const excludedByCode: Record<string, number> = {};
  const lengthJsonl = newLengthAcc();
  const refused: Array<{ file: string; source: "jsonl" | "durable"; code: string }> = [];
  const changed: Array<{ file: string; source: "jsonl" | "durable"; pre: unknown; post: unknown }> = [];
  const errors: Array<{ file: string; code: string }> = [];
  const pinLines: string[] = [];
  const relOf = (f: string) => (within(f, corpus) && path.resolve(f) === f ? path.relative(corpus, f) : "<outside-corpus>");

  // findSessionFiles reads ANDENKEN_SESSION_CORPUS itself; it must be the corpus this plan guards.
  const discoveryCorpus = defaultPlanEnv(process.env).corpus;
  const files = discoveryCorpus === corpus ? findSessionFiles() : [];
  if (discoveryCorpus !== corpus) errors.push({ file: "<discovery>", code: "discovery-corpus-mismatch" });
  totals.discovered = files.length;

  const jsonlSafety = { held: totals.safetyHeld, toSend: totals.toSend, heldMessages: 0, kinds: totals.safetyKinds, coords: coords.safetyHeld, length: lengthJsonl };
  for (const file of files) {
    const rel = relOf(file);
    try {
      const r = readSourceOnce(file, corpus);
      if (r.kind === "refused") {
        refused.push({ file: rel, source: "jsonl", code: r.code });
        continue;
      }
      if (r.kind === "changed") {
        changed.push({ file: rel, source: "jsonl", pre: r.pre, post: r.post });
        continue;
      }
      const sha = crypto.createHash("sha256").update(r.bytes).digest("hex");
      const det = await extractSessionChunksDetailed(Readable.from([r.bytes]), file, PLAN_POLICY);

      // Window rule over the SEND set (control-v1 selection, whole-message S0 applied).
      const decision = windowDecision(partitionMessagesForEmbedding(det.selectedGroups).send, window);
      if (!decision.include) {
        excludedByCode[decision.code] = (excludedByCode[decision.code] ?? 0) + 1;
        excludedFiles.push({ file: rel, size: r.stat.size, code: decision.code, latestSendKst: decision.latestMs === null ? null : kstIso(decision.latestMs) });
        continue;
      }
      pinLines.push(`${rel}\t${r.stat.size}\t${sha}`);

      const before = { held: totals.safetyHeld.chunks, toSend: totals.toSend.chunks };
      const f = { legacy: tally(), control: tally(), outcomes: {} as Record<string, number> };
      add(f.legacy, det.legacy);
      add(f.control, det.selected);
      applyS0(det.selectedGroups, corpus, jsonlSafety);
      const legacyHeld = partitionMessagesForEmbedding(det.legacyGroups).held;
      for (const h of legacyHeld) add(totals.legacySafetyHits, h.chunks);
      for (const d of det.decisions) recordDecision(d, rel, f.outcomes, totals, coords);

      totals.files += 1;
      totals.lines += det.lines;
      totals.blankLines += det.blankLines;
      totals.invalidJsonLines += det.invalidJsonLines;
      for (const k of ["legacy", "control"] as const) {
        totals[k].chunks += f[k].chunks;
        totals[k].chars += f[k].chars;
        totals[k].bytes += f[k].bytes;
      }
      perFile.push({
        file: rel,
        sha256: sha,
        size: r.stat.size,
        lines: det.lines,
        invalidJsonLines: det.invalidJsonLines,
        legacy: f.legacy,
        control: f.control,
        safetyHeldChunks: totals.safetyHeld.chunks - before.held,
        toSendChunks: totals.toSend.chunks - before.toSend,
        latestSendKst: kstIso(decision.latestMs),
        outcomes: f.outcomes,
      });
    } catch (e) {
      errors.push({ file: rel, code: errorCode(e) });
    }
  }
  totals.safetyHeldMessages = jsonlSafety.heldMessages;

  // --- pi-durable: admitted closed snapshots, pinned, B.1 as-is, message-level S0 ---
  const lengthDurable = newLengthAcc();
  const durableSafety = { held: tally(), toSend: tally(), heldMessages: 0, kinds: {} as Record<string, number>, coords: [] as HeldCoord[], length: lengthDurable };
  const durableLatest = new Map<string, ReturnType<typeof windowDecision>>();
  const durablePinFiles: Array<{ file: string; size: number; mtimeNs: string; sha256: string }> = [];
  let durable: { ran: boolean; skipped?: string; policy?: string; files?: Array<Record<string, unknown>>; aliases?: number } = { ran: false };
  const snapshots = discoveryCorpus === corpus ? findDurableSnapshots(corpus) : [];
  const pre = new Map<string, { stat: StatKey; sha: string }>();
  for (const s of snapshots) {
    const rel = relOf(s.file);
    try {
      const r = readSourceOnce(s.file, corpus);
      if (r.kind === "refused") refused.push({ file: rel, source: "durable", code: r.code });
      else if (r.kind === "changed") changed.push({ file: rel, source: "durable", pre: r.pre, post: r.post });
      else {
        const sha = crypto.createHash("sha256").update(r.bytes).digest("hex");
        pre.set(s.file, { stat: r.stat, sha });
        durablePinFiles.push({ file: rel, size: r.stat.size, mtimeNs: r.stat.mtimeNs, sha256: sha });
      }
    } catch (e) {
      errors.push({ file: rel, code: errorCode(e) });
    }
  }
  if (pre.size !== snapshots.length) {
    durable = { ran: false, skipped: "durable-input-not-pinned" };
  } else if (snapshots.length > 0) {
    try {
      const report = await runDurableIndex({
        corpus,
        manifestPath: path.join(target, "durable-manifest.json"),
        dryRun: true,
        inspectExtraction: (file, x) => {
          applyS0(x.groups, corpus, durableSafety);
          durableLatest.set(relOf(file), windowDecision(partitionMessagesForEmbedding(x.groups).send, window));
        },
      });
      durable = {
        ran: true,
        policy: report.policy,
        files: report.files.map((f) => ({
          file: relOf(f.file),
          status: f.status,
          reasonCode: durableReasonCode(f.reason),
          rows: f.rows,
          chars: f.chars,
          range: f.range,
          held: f.held.length,
          ambiguous: f.ambiguous.length,
        })),
        aliases: report.aliases.length,
      };
      if (report.files.some((f) => f.status === "refused" || f.status === "failed")) {
        errors.push({ file: "<durable>", code: "durable-refused-or-failed" });
      }
    } catch (e) {
      errors.push({ file: "<durable>", code: errorCode(e) });
    }
    // The pin must still describe the bytes the dry run read.
    for (const s of snapshots) {
      const before = pre.get(s.file)!;
      const r = readSourceOnce(s.file, corpus);
      const sha = r.kind === "ok" ? crypto.createHash("sha256").update(r.bytes).digest("hex") : null;
      if (r.kind !== "ok" || sha !== before.sha || !sameKey(r.stat, before.stat)) {
        changed.push({ file: relOf(s.file), source: "durable", pre: before.stat, post: r.kind === "ok" ? r.stat : r.kind });
      }
    }
  }

  const sendRows = totals.toSend.chunks + durableSafety.toSend.chunks;
  const sendTextBytes = totals.toSend.bytes + durableSafety.toSend.bytes;
  const estimateBytes = sendRows * VECTOR_BYTES_PER_ROW + sendTextBytes;
  const fsProbe = nearestExisting(target);
  const st = fs.statfsSync(fsProbe);
  const availBytes = Number(st.bavail) * Number(st.bsize);

  // Durable snapshots: the SAME window rule is applied (latest eligible send entry), but runDurableIndex
  // takes every admitted snapshot and has no file filter, so a snapshot the rule would exclude cannot be
  // left out of the build. The plan counts them; the build refuses by name when any is outside the window.
  const durableWindow = { inWindow: 0, outsideWindow: 0, noSendChunks: 0, noParseableTimestamp: 0, notExtracted: 0 };
  const durableWindowFiles: Array<{ file: string; decision: string; latestSendKst: string | null }> = [];
  for (const p of durablePinFiles) {
    const d = durableLatest.get(p.file);
    durableWindowFiles.push({ file: p.file, decision: !d ? "not-extracted" : d.include ? "in-window" : d.code, latestSendKst: d && d.latestMs !== null ? kstIso(d.latestMs) : null });
    if (!d) durableWindow.notExtracted += 1;
    else if (d.include) durableWindow.inWindow += 1;
    else if (d.code === "outside-window") durableWindow.outsideWindow += 1;
    else if (d.code === "no-send-chunks") durableWindow.noSendChunks += 1;
    else durableWindow.noParseableTimestamp += 1;
  }
  const lengthTotal = {
    limit: maxInputCodepoints(CANDIDATE_PROFILE, "document"),
    total: lengthJsonl.total + lengthDurable.total,
    over: lengthJsonl.over + lengthDurable.over,
    maxCodepoints: Math.max(lengthJsonl.maxCodepoints, lengthDurable.maxCodepoints),
  };

  const complete = files.length > 0 && perFile.length > 0 && refused.length === 0 && changed.length === 0 && errors.length === 0;
  const status = complete ? "complete" : refused.length + changed.length + errors.length > 0 ? "incomplete" : "empty";
  const pinOf = (lines: string[]) => crypto.createHash("sha256").update([...lines].sort().join("\n")).digest("hex");

  return {
    kind: PLAN_KIND,
    policy: PLAN_POLICY,
    createdAt: new Date().toISOString(),
    device: readDevice(env.home),
    target,
    status,
    complete,
    profile: {
      id: CANDIDATE_PROFILE.id,
      fingerprint: profileFingerprint(CANDIDATE_PROFILE),
      model: CANDIDATE_PROFILE.model,
      digest: CANDIDATE_PROFILE.digest,
      dimensions: CANDIDATE_PROFILE.dimensions,
      maxInputTokens: CANDIDATE_PROFILE.maxInputTokens,
      maxBatchSize: CANDIDATE_PROFILE.maxBatchSize,
      endpoint: CANDIDATE_PROFILE.endpoint ?? null,
      paidRemote: CANDIDATE_PROFILE.paidRemote,
    },
    split: { target: CANDIDATE_SPLIT.target, maxCodepoints: CANDIDATE_SPLIT.maxCodepoints },
    window: {
      sinceKst: window.sinceKst,
      untilKst: window.untilKst,
      sinceMs: window.sinceMs,
      untilMs: window.untilMs,
      rule: "file included iff the LATEST parseable timestamp among its eligible SEND chunks (control-v1 selection, whole-message S0 applied) lies in the half-open KST window [since, until); no send chunk or no parseable timestamp → excluded",
      durable: { rule: "same rule per snapshot, but all-or-nothing: the build refuses when any admitted snapshot is outside the window or undated (no per-file filter in runDurableIndex)", ...durableWindow, files: durableWindowFiles },
    },
    selection: {
      discovered: files.length,
      included: perFile.length,
      excluded: excludedFiles.length,
      excludedByCode,
      excludedFiles,
    },
    lengthPlan: {
      basis: "NFKC code points of each SEND text vs the profile bound; the build refuses before any request when over > 0 (no silent truncation)",
      jsonl: { total: lengthJsonl.total, over: lengthJsonl.over, maxCodepoints: lengthJsonl.maxCodepoints },
      durable: { total: lengthDurable.total, over: lengthDurable.over, maxCodepoints: lengthDurable.maxCodepoints },
      ...lengthTotal,
      overCoords: [...lengthJsonl.overCoords, ...lengthDurable.overCoords].slice(0, OVER_COORDS_CAP),
    },
    notes: {
      complete:
        "every discovered JSONL passed the input boundary and was read once with unchanged identity; any discovered durable snapshots passed the boundary, were pinned before and after their dry run, and remained unchanged; JSONL discovery was not empty. It does NOT mean every line was valid JSON: see totals.invalidJsonLines / blankLines (skipped silently by the production parser too).",
      s0: "high-signal hold over each WHOLE message text before split plus each chunk; a hit holds every chunk of that message. Not complete detection.",
    },
    sources: {
      "session-selection.ts": sha256File(path.join(REPO, "session-selection.ts")),
      "session-indexer.ts": sha256File(path.join(REPO, "session-indexer.ts")),
      "session-sanitize.ts": sha256File(path.join(REPO, "session-sanitize.ts")),
      "durable-index.ts": sha256File(path.join(REPO, "durable-index.ts")),
      "durable-source.ts": sha256File(path.join(REPO, "durable-source.ts")),
      "scripts/candidate-plan.ts": sha256File(fileURLToPath(import.meta.url)),
    },
    corpusPin: { files: pinLines.length, sha256: pinOf(pinLines) },
    durablePin: {
      files: durablePinFiles,
      sha256: pinOf(durablePinFiles.map((f) => `${f.file}\t${f.size}\t${f.sha256}`)),
    },
    totals,
    durable: {
      ...durable,
      safety: { held: durableSafety.held, heldMessages: durableSafety.heldMessages, toSend: durableSafety.toSend, kinds: durableSafety.kinds },
      safetyHeldCoords: durableSafety.coords,
    },
    budget: {
      note: "draft caps; confirm after this plan",
      basis:
        "arithmetic only: send rows × profile dimensions × 4 B (f32 vector) + UTF-8 text bytes. Excludes FTS index, metadata columns, LanceDB versions/manifests and temporaries — not a disk-usage prediction and not a ceiling.",
      sendRows,
      vectorBytes: sendRows * VECTOR_BYTES_PER_ROW,
      sendTextBytes,
      estimateBytes,
      probedPath: fsProbe,
      availBytes,
      draftCandidateCapBytes: DRAFT_CANDIDATE_CAP,
      draftReserveBytes: DRAFT_ROOT_RESERVE,
      withinDraft: estimateBytes <= DRAFT_CANDIDATE_CAP && availBytes - estimateBytes >= DRAFT_ROOT_RESERVE,
    },
    coords,
    refused,
    changed,
    errors,
    perFile,
  };
}

function recordDecision(
  d: SelectionDecision,
  rel: string,
  fileOutcomes: Record<string, number>,
  totals: { outcomes: Record<string, number>; outcomeLegacyChunks: Record<string, number>; blockReasons: Record<string, { blocks: number; rawChars: number }> },
  coords: { attention: Array<{ file: string; line: number; outcome: string; retainedChars: number; legacyChunks: number }> },
): void {
  inc(fileOutcomes, d.outcome);
  inc(totals.outcomes, d.outcome);
  inc(totals.outcomeLegacyChunks, d.outcome, d.legacyChunks);
  for (const b of d.blocks) {
    const r = (totals.blockReasons[b.reason] ??= { blocks: 0, rawChars: 0 });
    r.blocks += 1;
    r.rawChars += b.rawChars;
  }
  if (d.outcome === "protected-short" || d.outcome === "protected-noise" || d.outcome === "held-sanitize-conflict") {
    coords.attention.push({ file: rel, line: d.lineNumber, outcome: d.outcome, retainedChars: d.retainedChars, legacyChunks: d.legacyChunks });
  }
}

function nearestExisting(p: string): string {
  let cur = p;
  while (!fs.existsSync(cur)) cur = path.dirname(cur);
  return cur;
}

function readDevice(home: string): string {
  try {
    return fs.readFileSync(path.join(home, ".current-device"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const env = defaultPlanEnv();
  const args = validatePlanArgs(process.argv.slice(2), env);
  if (!args.ok) {
    console.error(`REFUSED candidate-plan: ${args.code}`);
    return 2;
  }
  const plan = await runPlan(args.target, env, args.window);
  const prev = process.umask(0o077);
  try {
    fs.writeFileSync(args.out, JSON.stringify(plan, null, 1) + "\n", { flag: "wx", mode: 0o600 });
  } finally {
    process.umask(prev);
  }
  const t = plan.totals;
  console.log(`candidate plan (${plan.policy}) → ${args.out}`);
  console.log(`  profile=${plan.profile.id} window=[${plan.window.sinceKst}, ${plan.window.untilKst}) included=${plan.selection.included} excluded=${plan.selection.excluded} ${JSON.stringify(plan.selection.excludedByCode)}`);
  console.log(`  length limit=${plan.lengthPlan.limit} send=${plan.lengthPlan.total} over=${plan.lengthPlan.over} max=${plan.lengthPlan.maxCodepoints}`);
  console.log(`  status=${plan.status} discovered=${t.discovered} files=${t.files} refused=${plan.refused.length} changed=${plan.changed.length} errors=${plan.errors.length}`);
  console.log(`  lines=${t.lines} invalidJson=${t.invalidJsonLines} blank=${t.blankLines}`);
  console.log(`  legacy  chunks=${t.legacy.chunks} chars=${t.legacy.chars}`);
  console.log(`  control chunks=${t.control.chunks} chars=${t.control.chars}`);
  console.log(`  S0 held chunks=${t.safetyHeld.chunks} (messages=${t.safetyHeldMessages})  to-send chunks=${t.toSend.chunks}`);
  console.log(`  durable pinned=${plan.durablePin.files.length} ran=${String(plan.durable.ran)}`);
  console.log(`  outcomes ${JSON.stringify(t.outcomes)}`);
  console.log(`  budget estimate=${plan.budget.estimateBytes}B (vector+text arithmetic) avail=${plan.budget.availBytes}B withinDraft=${plan.budget.withinDraft}`);
  console.log("  no API call, no store, no gather; output holds counts, codes and coordinates only");
  return plan.complete ? 0 : 3;
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  main().then((code) => process.exit(code));
}
