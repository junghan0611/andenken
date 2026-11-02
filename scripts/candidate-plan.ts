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
 * Admitted closed pi-durable snapshots pass the same boundary, are pinned by
 * size + sha256 before AND after, and are planned through the existing
 * `runDurableIndex` dry run against the (absent) candidate durable manifest,
 * B.1 as-is (control-v1 is NOT applied to durable rows), with the same S0.
 *
 * Never: provider, store, network, gather, live SQLite, text in the output.
 * The output carries counts, coordinates (file, line, chunk id) and fixed
 * codes — never a reason detail or exception message.
 *
 *   tsx scripts/candidate-plan.ts --target <abs dir> --out <abs file>
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
  type SelectionDecision,
} from "../session-indexer.ts";
import { partitionMessagesForEmbedding, type MessageGroup, type SafetyKind } from "../session-selection.ts";
import { runDurableIndex } from "../durable-index.ts";
import { findDurableSnapshots } from "../durable-source.ts";
import type { DurableRefusalReason } from "../durable-reader.ts";

export const PLAN_KIND = "andenken-candidate-plan";
export const PLAN_POLICY = "control-v1" as const;
const VECTOR_BYTES_PER_ROW = 4096 * 4;
const GiB = 1024 ** 3;
/** Draft budget (coordinator 13:56): candidate ≤ 5 GiB, ≥ 8 GiB left on the target fs. Confirmed only after the plan. */
const DRAFT_CANDIDATE_CAP = 5 * GiB;
const DRAFT_ROOT_RESERVE = 8 * GiB;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface PlanEnv {
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
    home,
    // String normalization only (trailing slash, `..`); a relative value stays as-is for the guard to refuse.
    corpus: expanded && path.isAbsolute(expanded) ? path.resolve(expanded) : expanded,
    dataDir: env.ANDENKEN_DATA ?? path.join(home, "repos", "gh", "andenken", "data"),
    candidatesRoot: path.join(home, ".local", "state", "andenken", "candidates"),
  };
}

export type PlanArgs = { ok: true; target: string; out: string } | { ok: false; code: string };

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
  const known = new Set(["--target", "--out"]);
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
  return { ok: true, target, out };
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

/** S0 over message groups: send/held tallies, kinds once per held message, coordinates per held chunk. */
function applyS0<T extends { id: string; text: string }>(
  groups: ReadonlyArray<MessageGroup<T>>,
  corpus: string,
  sink: { held: Tally; toSend: Tally; heldMessages: number; kinds: Record<string, number>; coords: HeldCoord[] },
): void {
  const { send, held } = partitionMessagesForEmbedding(groups);
  add(sink.toSend, send);
  for (const h of held) {
    sink.heldMessages += 1;
    for (const k of h.kinds) inc(sink.kinds, k);
    add(sink.held, h.chunks);
    for (const c of h.chunks) sink.coords.push({ id: path.relative(corpus, c.id), kinds: h.kinds, chars: c.text.length });
  }
}

export async function runPlan(target: string, env: PlanEnv) {
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

  const jsonlSafety = { held: totals.safetyHeld, toSend: totals.toSend, heldMessages: 0, kinds: totals.safetyKinds, coords: coords.safetyHeld };
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
        outcomes: f.outcomes,
      });
    } catch (e) {
      errors.push({ file: rel, code: errorCode(e) });
    }
  }
  totals.safetyHeldMessages = jsonlSafety.heldMessages;

  // --- pi-durable: admitted closed snapshots, pinned, B.1 as-is, message-level S0 ---
  const durableSafety = { held: tally(), toSend: tally(), heldMessages: 0, kinds: {} as Record<string, number>, coords: [] as HeldCoord[] };
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
        inspectExtraction: (_file, x) => applyS0(x.groups, corpus, durableSafety),
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

  const complete = files.length > 0 && refused.length === 0 && changed.length === 0 && errors.length === 0;
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
        "arithmetic only: send rows × 4096 × 4 B (f32 vector) + UTF-8 text bytes. Excludes FTS index, metadata columns, LanceDB versions/manifests and temporaries — not a disk-usage prediction and not a ceiling.",
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
  const plan = await runPlan(args.target, env);
  const prev = process.umask(0o077);
  try {
    fs.writeFileSync(args.out, JSON.stringify(plan, null, 1) + "\n", { flag: "wx", mode: 0o600 });
  } finally {
    process.umask(prev);
  }
  const t = plan.totals;
  console.log(`candidate plan (${plan.policy}) → ${args.out}`);
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
