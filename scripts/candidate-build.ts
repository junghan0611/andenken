/**
 * candidate:sessions:build — ONE paid, isolated build of the control-v1
 * candidate sessions index (issue #18) into a fresh directory, from a reviewed
 * API-0 plan (scripts/candidate-plan.ts). Production data, manifests, corpus,
 * backups and archives are never written.
 *
 * Order — every refusal before the confirmation is API 0 and creates nothing:
 *   1. arguments, index authority, production sync lock held by an ancestor
 *   2. plan file: sha256 == --plan-sha, policy, complete, target, and the six
 *      plan source hashes == the files in this tree (else the plan is void)
 *   3. corpus + fresh target guards (canonical, same filesystem as the plan
 *      probe, no overlap with corpus / production data / repo / backups)
 *   4. CPU affinity ≤ 8, Qwen3-Embedding-8B / 4096 config, space budget
 *   5. JSONL file set == plan file set (size, boundary); durable pin set
 *   6. ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 and an interactive TTY "yes"
 * Then: create target, take the candidate writer lock, provider + one 4096d
 * probe, and per file: read once → sha/count == plan → whole-message S0 →
 * embed the send set → append; manifest only after flush. Durable B.1 as-is
 * with its S0 re-checked (any hold aborts). FTS, then integrity checks.
 *
 * Provider requests: transient failures (timeout, 429, 5xx, network) are
 * retried per request with bounded exponential backoff + jitter (≤ 12 attempts,
 * ≤ 30 min from the first attempt, honouring Retry-After) behind one pause gate
 * shared by every worker. Permanent failures (other 4xx, wrong dim, S0, space,
 * source drift) are never retried.
 *
 * A failure that survives that stops NEW requests, checkpoints the files that
 * were complete when it stopped (only for provider / source-drift codes — never
 * after a space, S0 or dimension failure), keeps the partial target and marks
 * the receipt `partial`. The whole build is never restarted automatically.
 *
 * `--resume` continues THAT partial target (same plan, sources, policy): API-0
 * reconciliation re-reads each manifest / DB file once and requires DB ids and
 * text hashes == the extraction; files complete in the DB but not yet in the
 * manifest are adopted, incomplete ones are deleted from the candidate only, a
 * manifest↔DB mismatch is refused. The same human gate applies. Each attempt's
 * receipt, manifest and ledger are archived under `attempts/`.
 *
 * Output is counts, ids and fixed codes — no text, no provider error message.
 *
 *   tsx scripts/candidate-build.ts --plan <abs> --plan-sha <hex> --target <abs> [--resume]
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { extractSessionChunksDetailed, findSessionFiles, type SessionChunk } from "../session-indexer.ts";
import { partitionMessagesForEmbedding, scanHighSignal, type SafetyKind } from "../session-selection.ts";
import { runDurableIndex, type DurableManifest } from "../durable-index.ts";
import { findDurableSnapshots, type DurableRow } from "../durable-source.ts";
import { VectorStore } from "../store.ts";
import { WriteBuffer, type BufferedRecord } from "../write-buffer.ts";
import { acquireSessionsLock, SessionsLockRefused, type SessionsLockHandle } from "../sessions-lock.ts";
import { checkSource, defaultPlanEnv, errorCode, readSourceOnce, type PlanEnv } from "./candidate-plan.ts";

export const BUILD_KIND = "andenken-candidate-build";
export const CANDIDATE_POLICY = "control-v1";
export const CANDIDATE_DIM = 4096;
const GiB = 1024 ** 3;
export const SPACE_CAP_BYTES = 5 * GiB;
export const ROOT_RESERVE_BYTES = 8 * GiB;
export const MAX_CPUS = 8;
export const MAX_API_CONCURRENCY = 4;
const CHECKPOINT_FILES = 100;
/** Texts per provider request; workers re-check the abort flag between requests. */
const REQUEST_BATCH = 64;
const DB_WRITE_BATCH = 2000;
const PROBE_TEXT = "andenken candidate dimension probe";
const TABLE = "session_chunks";
const PROGRESS_EVERY_MS = 60_000;

export interface RetryPolicy {
  /** Attempts per request, the first included. */
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  /** Wall-clock budget per request, counted from its first attempt. */
  budgetMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 12, baseMs: 2_000, capMs: 300_000, budgetMs: 30 * 60_000 };

/** The files whose hashes a plan records; any change voids that plan. */
export const PLAN_SOURCES = [
  "session-selection.ts",
  "session-indexer.ts",
  "session-sanitize.ts",
  "durable-index.ts",
  "durable-source.ts",
  "scripts/candidate-plan.ts",
] as const;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class BuildRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BuildRefused";
  }
}
export class BuildAborted extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BuildAborted";
  }
}

// ---------------------------------------------------------------------------
// Environment and injectable effects
// ---------------------------------------------------------------------------

export interface BuildEnv extends PlanEnv {
  device: string;
  authority: string;
  /** Never written, never overlapped: v3832 backup, investigation archives. */
  protectedPaths: string[];
  /** The production `data/.sync-sessions.lock` the wrapper holds (flock). */
  syncLockPath: string;
  allowPaid: boolean;
  providerConfig: { provider?: string; model?: string; dimensions?: string };
  apiConcurrency: number;
}

export function defaultBuildEnv(env: NodeJS.ProcessEnv = process.env): BuildEnv {
  const base = defaultPlanEnv(env);
  let device = "";
  try {
    device = fs.readFileSync(path.join(base.home, ".current-device"), "utf8").trim();
  } catch {
    device = "";
  }
  const requested = parseInt(env.INDEX_CONCURRENCY ?? "", 10);
  return {
    ...base,
    device,
    authority: env.ANDENKEN_INDEX_AUTHORITY ?? "thinkpad",
    protectedPaths: [
      path.join(base.home, ".local", "state", "andenken-issue16"),
      path.join(base.home, ".local", "state", "andenken", "investigations"),
    ],
    syncLockPath: path.join(REPO, "data", ".sync-sessions.lock"),
    allowPaid: env.ANDENKEN_ALLOW_PAID_FULL_REBUILD === "1",
    providerConfig: {
      provider: env.ANDENKEN_SESSION_PROVIDER,
      model: env.ANDENKEN_SESSION_MODEL,
      dimensions: env.ANDENKEN_SESSION_DIMENSIONS,
    },
    // The existing indexer default is 2; the candidate never exceeds 4 requests in flight.
    apiConcurrency: Math.max(1, Math.min(MAX_API_CONCURRENCY, Number.isFinite(requested) && requested > 0 ? requested : 2)),
  };
}

/** What the build needs from a provider — satisfied by createSessionProviderFromEnv(). */
export interface CandidateProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly isPaidRemote?: boolean;
  embedDocumentBatch(texts: string[]): Promise<number[][]>;
  getStats?(): { calls: number; estimatedTokens: number; estimatedCostUSD: number };
}

export interface BuildDeps {
  repo: string;
  cpuList: () => number[];
  availBytes: (p: string) => number;
  syncLockHeld: (lockPath: string) => boolean;
  isTTY: boolean;
  confirm: (summary: string[]) => Promise<string>;
  /** Called only after the confirmation; never before. */
  createProvider: () => Promise<CandidateProvider | null>;
  log: (line: string) => void;
  now: () => Date;
  /** Files between manifest checkpoints (default 100). */
  checkpointEvery?: number;
  /** Synthetic-suite observer: rows written, manifest saved. Never receives text. */
  trace?: (event: "rows-written" | "manifest-saved", n: number) => void;
  /** Retry schedule (default DEFAULT_RETRY). */
  retry?: RetryPolicy;
  /** Backoff clock; the suite injects a virtual one. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Progress line period (default 60 s; 0 disables). */
  progressEveryMs?: number;
}

export function defaultBuildDeps(): BuildDeps {
  return {
    repo: REPO,
    cpuList: () => allowedCpus(fs.readFileSync("/proc/self/status", "utf8")),
    availBytes: (p) => {
      const st = fs.statfsSync(p);
      return Number(st.bavail) * Number(st.bsize);
    },
    syncLockHeld: (lockPath) => syncLockHeldByAncestor(lockPath),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (summary) => {
      for (const line of summary) process.stdout.write(`${line}\n`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string>((resolve) => rl.question("Type 'yes' to proceed (anything else aborts): ", resolve));
      } finally {
        rl.close();
      }
    },
    createProvider: async () => {
      const { createSessionProviderFromEnv } = await import("../embedding-provider.ts");
      return createSessionProviderFromEnv();
    },
    log: (line) => process.stdout.write(`${line}\n`),
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for the synthetic suite)
// ---------------------------------------------------------------------------

export function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function ancestorsCanonical(p: string): boolean {
  let cur = path.dirname(p);
  while (true) {
    if (fs.existsSync(cur) && fs.realpathSync(cur) !== cur) return false;
    const next = path.dirname(cur);
    if (next === cur) return true;
    cur = next;
  }
}

function nearestExisting(p: string): string {
  let cur = p;
  while (!fs.existsSync(cur)) cur = path.dirname(cur);
  return cur;
}

/** `Cpus_allowed_list:\t0-3,8,10-11` → [0,1,2,3,8,10,11]. */
export function allowedCpus(procStatus: string): number[] {
  const m = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(procStatus);
  if (!m) return [];
  const out: number[] = [];
  for (const part of m[1].split(",")) {
    const [a, b] = part.split("-").map((x) => Number(x));
    if (!Number.isInteger(a)) return [];
    const end = b === undefined ? a : b;
    if (!Number.isInteger(end) || end < a) return [];
    for (let i = a; i <= end; i++) out.push(i);
  }
  return out;
}

/** Match Node's ordinary Stats millisecond arithmetic without rounding epoch nanoseconds first. */
export function statMtimeMs(nanoseconds: string): number {
  const ns = BigInt(nanoseconds);
  return Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1e6;
}

/** Linux st_dev → "maj:min" in the hex form /proc/locks prints. */
function devKey(dev: number): string {
  const major = ((dev >>> 8) & 0xfff) | (Math.floor(dev / 2 ** 32) & ~0xfff);
  const minor = (dev & 0xff) | ((dev >>> 12) & ~0xff & 0xfffff);
  return `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}`;
}

/**
 * Whether /proc/locks shows a FLOCK on `ino`/`dev` held by one of `pids`.
 * Pure over its inputs; `syncLockHeldByAncestor` feeds it the live values.
 */
export function flockHeldBy(procLocks: string, dev: number, ino: number, pids: ReadonlySet<number>): boolean {
  const want = devKey(dev);
  for (const line of procLocks.split("\n")) {
    const f = line.trim().split(/\s+/);
    // "1: FLOCK  ADVISORY  WRITE 12345 fd:01:123456 0 EOF"
    if (f[1] !== "FLOCK" || f[3] !== "WRITE") continue;
    const pid = Number(f[4]);
    const parts = (f[5] ?? "").split(":");
    if (parts.length !== 3) continue;
    const key = `${parts[0].toLowerCase()}:${parts[1].toLowerCase()}`;
    if (Number(parts[2]) === ino && key === want && pids.has(pid)) return true;
  }
  return false;
}

export function ancestorPids(start: number = process.pid): Set<number> {
  const seen = new Set<number>();
  let pid = start;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    try {
      const m = /^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      pid = m ? Number(m[1]) : 0;
    } catch {
      break;
    }
  }
  return seen;
}

export function syncLockHeldByAncestor(lockPath: string): boolean {
  try {
    const st = fs.statSync(lockPath);
    return flockHeldBy(fs.readFileSync("/proc/locks", "utf8"), st.dev, st.ino, ancestorPids());
  } catch {
    return false;
  }
}

const QWEN3_8B_MODELS = new Set(["qwen/qwen3-embedding-8b"]);
export function providerConfigOk(c: BuildEnv["providerConfig"]): boolean {
  return (
    (c.provider === "openrouter" || c.provider === "vllm") &&
    typeof c.model === "string" &&
    QWEN3_8B_MODELS.has(c.model.toLowerCase()) &&
    c.dimensions === String(CANDIDATE_DIM)
  );
}

/** A provider failure reduced to a code; never the upstream body or message. */
export function providerErrorCode(e: unknown): string {
  if (e instanceof BuildAborted || e instanceof BuildRefused) return e.code;
  const msg = e instanceof Error ? e.message : "";
  const http = /^vLLM embed \((\d{3})\)/.exec(msg);
  if (http) return `provider-http-${http[1]}`;
  if (/request timeout/.test(msg)) return "provider-timeout";
  if (/unreachable|host not found/.test(msg)) return "provider-unreachable";
  if (/empty embedding data/.test(msg)) return "provider-empty-response";
  return errorCode(e);
}

// ---------------------------------------------------------------------------
// Bounded retry for transient provider failures
// ---------------------------------------------------------------------------

export type FailureClass = "timeout" | "rate-limit" | "server" | "network" | "permanent";

/** Transient classes are retried; `permanent` stops the build. Decided on the code, never logged raw. */
export function classifyProviderFailure(e: unknown): FailureClass {
  if (e instanceof BuildAborted || e instanceof BuildRefused) return "permanent";
  const code = providerErrorCode(e);
  if (code === "provider-timeout" || code === "provider-http-408") return "timeout";
  if (code === "provider-http-429") return "rate-limit";
  const http = /^provider-http-(\d{3})$/.exec(code);
  if (http) return Number(http[1]) >= 500 ? "server" : "permanent";
  if (code === "provider-empty-response" || code === "SyntaxError") return "server";
  if (code === "provider-unreachable" || /^E(CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH)$/.test(code)) return "network";
  if (e instanceof TypeError && /fetch failed|terminated|socket|network|other side closed/i.test(e.message)) return "network";
  return "permanent";
}

/** Exponential backoff with equal jitter; 429 starts 4× higher; Retry-After is a floor; capped. */
export function backoffDelayMs(attempt: number, cls: FailureClass, p: RetryPolicy, random: () => number, retryAfterMs?: number): number {
  const ceiling = Math.min(p.capMs, p.baseMs * (cls === "rate-limit" ? 4 : 1) * 2 ** Math.max(0, attempt - 1));
  const jittered = ceiling / 2 + random() * (ceiling / 2);
  return Math.round(Math.min(p.capMs, Math.max(jittered, retryAfterMs ?? 0)));
}

export interface ApiTelemetry {
  attempts: number;
  retries: number;
  /** Texts sent again after a failed attempt — an upper bound on double billing (a timed-out request may have been billed). */
  retriedTexts: number;
  recovered: number;
  failures: Record<FailureClass, number>;
  /** Backoff scheduled by failures, and time workers actually spent waiting at the shared gate. */
  pauseMs: number;
  waitedMs: number;
  /** Texts embedded for a file that was then dropped because the build stopped. */
  discardedTexts: number;
  inflight: number;
  lastOkAt: number | null;
  lastFailure: { at: number; cls: FailureClass } | null;
  latencyMs: number[];
  pausedUntil: number;
}

export function newTelemetry(): ApiTelemetry {
  return {
    attempts: 0,
    retries: 0,
    retriedTexts: 0,
    recovered: 0,
    failures: { timeout: 0, "rate-limit": 0, server: 0, network: 0, permanent: 0 },
    pauseMs: 0,
    waitedMs: 0,
    discardedTexts: 0,
    inflight: 0,
    lastOkAt: null,
    lastFailure: null,
    latencyMs: [],
    pausedUntil: 0,
  };
}

export interface RetryClock {
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

/**
 * Wrap the raw provider: transient failures wait behind ONE gate shared by all
 * workers (a 429 or outage pauses everyone, not just the request that saw it),
 * then retry within the policy. `shouldStop` turns waiting into a stop once the
 * build has failed elsewhere.
 */
export function resilientProvider(
  p: CandidateProvider,
  policy: RetryPolicy,
  clock: RetryClock,
  tele: ApiTelemetry,
  shouldStop: () => boolean,
): CandidateProvider {
  const waitGate = async () => {
    while (!shouldStop()) {
      const left = tele.pausedUntil - clock.nowMs();
      if (left <= 0) return;
      const step = Math.min(left, 1000);
      tele.waitedMs += step;
      await clock.sleep(step);
    }
  };
  return {
    name: p.name,
    dimensions: p.dimensions,
    isPaidRemote: p.isPaidRemote,
    getStats: p.getStats?.bind(p),
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
      const first = clock.nowMs();
      for (let attempt = 1; ; attempt++) {
        await waitGate();
        if (shouldStop()) throw new BuildAborted("stopped");
        tele.attempts += 1;
        tele.inflight += 1;
        const t0 = clock.nowMs();
        try {
          const vectors = await p.embedDocumentBatch(texts);
          tele.latencyMs.push(clock.nowMs() - t0);
          tele.lastOkAt = clock.nowMs();
          if (attempt > 1) tele.recovered += 1;
          return vectors;
        } catch (e) {
          const cls = classifyProviderFailure(e);
          tele.failures[cls] += 1;
          tele.lastFailure = { at: clock.nowMs(), cls };
          if (cls === "permanent" || attempt >= policy.maxAttempts) throw e;
          const ra = (e as { retryAfterMs?: unknown } | null)?.retryAfterMs;
          const delay = backoffDelayMs(attempt, cls, policy, clock.random, typeof ra === "number" ? ra : undefined);
          if (clock.nowMs() - first + delay > policy.budgetMs) throw e;
          tele.retries += 1;
          tele.retriedTexts += texts.length;
          tele.pauseMs += delay;
          tele.pausedUntil = Math.max(tele.pausedUntil, clock.nowMs() + delay);
        } finally {
          tele.inflight -= 1;
        }
      }
    },
  };
}

export function latencySummary(xs: number[]): { n: number; p50: number | null; p90: number | null; p99: number | null; max: number | null; mean: number | null } {
  if (xs.length === 0) return { n: 0, p50: null, p90: null, p99: null, max: null, mean: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}

/**
 * Codes after which the files that were COMPLETE when the build stopped may
 * still be checkpointed: provider failures and per-file source drift. Never
 * after a space, S0, dimension or vector-count failure, or an unknown code.
 */
export function checkpointAllowedAfter(code: string): boolean {
  return (
    /^provider-(timeout|unreachable|empty-response|http-\d{3})$/.test(code) ||
    /^(corpus-file-(changed|refused|sha-mismatch)|plan-count-mismatch|s0-held-mismatch|SyntaxError|TypeError)$/.test(code) ||
    /^E(CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH)$/.test(code)
  );
}

/**
 * The existing provider writes `⟳ vLLM retry n/N: <first 80 chars of the error>`
 * to stderr, and an upstream error body could echo anything. In this process
 * only, keep the attempt counter and drop the entire write's detail, including
 * embedded newlines; other writes pass as-is.
 */
export function sanitizeProviderStderr(chunk: string): string {
  return chunk.replace(/⟳ vLLM retry (\d+)\/(\d+):[\s\S]*/, "⟳ provider retry $1/$2 (detail withheld)\n");
}

/** Provider-internal transport retries seen by the filter (the provider's own 3-attempt loop). */
export const stderrStats = { providerRetryLines: 0 };

export function installStderrFilter(): () => void {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    const raw = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null;
    const text = raw === null ? chunk : sanitizeProviderStderr(raw);
    if (raw !== null && text !== raw) stderrStats.providerRetryLines += 1;
    return (original as (...a: unknown[]) => boolean)(text, ...rest);
  }) as typeof process.stderr.write;
  return () => {
    process.stderr.write = original as typeof process.stderr.write;
  };
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Allocated bytes under `dir` (st_blocks × 512), symlinks not followed. */
export function allocatedBytes(dir: string): { allocated: number; apparent: number; files: number } {
  let allocated = 0;
  let apparent = 0;
  let files = 0;
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    allocated += st.blocks * 512;
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    } else {
      apparent += st.size;
      files += 1;
    }
  };
  walk(dir);
  return { allocated, apparent, files };
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 1) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Plan shape (only the fields the build relies on)
// ---------------------------------------------------------------------------

interface PlanFile {
  file: string;
  sha256: string;
  size: number;
  invalidJsonLines: number;
  legacy: { chunks: number };
  control: { chunks: number };
  safetyHeldChunks: number;
  toSendChunks: number;
}
interface PlanDoc {
  kind: string;
  policy: string;
  status: string;
  complete: boolean;
  target: string;
  sources: Record<string, string>;
  corpusPin: { files: number; sha256: string };
  durablePin: { files: Array<{ file: string; size: number; sha256: string }>; sha256: string };
  totals: { toSend: { chunks: number }; safetyHeld: { chunks: number } };
  durable: { ran: boolean; files?: Array<{ file: string; status: string; rows: number }>; safety: { held: { chunks: number }; toSend: { chunks: number } } };
  budget: { sendRows: number; estimateBytes: number; probedPath: string };
  coords: { safetyHeld: Array<{ id: string; kinds: SafetyKind[]; chars: number }> };
  perFile: PlanFile[];
}

export interface BuildArgs {
  plan: string;
  planSha: string;
  target: string;
  /** Continue an existing partial target of the same plan instead of a fresh one. */
  resume: boolean;
}

export function parseBuildArgs(argv: string[]): BuildArgs {
  const known = new Set(["--plan", "--plan-sha", "--target"]);
  const v: Record<string, string> = {};
  let resume = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resume") {
      if (resume) throw new BuildRefused("argument-repeated");
      resume = true;
      continue;
    }
    if (!known.has(a)) throw new BuildRefused("unknown-argument");
    if (a in v) throw new BuildRefused("argument-repeated");
    const x = argv[i + 1];
    if (x === undefined || x.startsWith("--")) throw new BuildRefused("argument-missing-value");
    v[a] = x;
    i++;
  }
  if (!v["--plan"] || !v["--plan-sha"] || !v["--target"]) throw new BuildRefused("plan-plan-sha-target-required");
  if (!/^[0-9a-f]{64}$/.test(v["--plan-sha"])) throw new BuildRefused("plan-sha-not-hex64");
  return { plan: v["--plan"], planSha: v["--plan-sha"], target: v["--target"], resume };
}

// ---------------------------------------------------------------------------
// Preflight — API 0, creates nothing
// ---------------------------------------------------------------------------

export interface Preflight {
  args: BuildArgs;
  plan: PlanDoc;
  files: Array<{ abs: string; rel: string; plan: PlanFile }>;
  heldByFile: Map<string, Set<string>>;
  durable: Array<{ abs: string; rel: string; size: number; sha256: string }>;
  durableRows: number;
  /** Set for `--resume`: what the API-0 reconciliation verified in the partial target. */
  resume: ResumeState | null;
  summary: string[];
}

interface ManifestEntry {
  mtimeMs: number;
  size: number;
  chunks: number;
  sha256: string;
}
interface HeldEntry {
  id: string;
  kinds: SafetyKind[];
  chars: number;
}
type FileRef = Preflight["files"][number];

export interface ResumeState {
  /** sha256 of the receipt / manifest bytes the reconciliation read (re-checked under the lock). */
  receiptSha: string;
  manifestSha: string | null;
  priorReceipt: Record<string, unknown>;
  priorAttempt: number;
  /** Manifest entries whose DB rows == the extraction (ids and text hashes). */
  reuse: Map<string, ManifestEntry>;
  /** Files complete in the DB but not yet in the manifest. */
  adopt: Map<string, ManifestEntry>;
  /** Files with an incomplete row set in the DB and no manifest entry: deleted from the candidate. */
  discard: Map<string, number>;
  held: Map<string, HeldEntry[]>;
  reusedRows: number;
  adoptedRows: number;
  discardRows: number;
  dbRows: number;
  durableDbRows: number;
  durableManifestChunks: number;
  remainingFiles: number;
  remainingJsonlRows: number;
}

/**
 * Read one corpus file once and require it to be exactly what the plan saw:
 * bytes sha / size, per-file counts, and the S0-held chunk ids.
 */
async function extractVerified(f: FileRef, corpus: string, heldByFile: Map<string, Set<string>>) {
  const r = readSourceOnce(f.abs, corpus);
  if (r.kind !== "ok") throw new BuildAborted(r.kind === "changed" ? "corpus-file-changed" : "corpus-file-refused");
  if (sha256(r.bytes) !== f.plan.sha256 || r.stat.size !== f.plan.size) throw new BuildAborted("corpus-file-sha-mismatch");
  const det = await extractSessionChunksDetailed(Readable.from([r.bytes]), f.abs, CANDIDATE_POLICY);
  const { send, held } = partitionMessagesForEmbedding(det.selectedGroups);
  const heldChunks = held.flatMap((h) => h.chunks.map((c) => ({ c, kinds: h.kinds })));
  if (
    det.legacy.length !== f.plan.legacy.chunks ||
    det.selected.length !== f.plan.control.chunks ||
    send.length !== f.plan.toSendChunks ||
    heldChunks.length !== f.plan.safetyHeldChunks ||
    det.invalidJsonLines !== f.plan.invalidJsonLines
  ) {
    throw new BuildAborted("plan-count-mismatch");
  }
  const planHeld = heldByFile.get(f.rel) ?? new Set<string>();
  const ids = heldChunks.map(({ c }) => path.relative(corpus, c.id));
  if (ids.length !== planHeld.size || ids.some((id) => !planHeld.has(id))) throw new BuildAborted("s0-held-mismatch");
  const heldLedger: HeldEntry[] = heldChunks.map(({ c, kinds }) => ({ id: path.relative(corpus, c.id), kinds, chars: c.text.length }));
  return { stat: r.stat, send, heldLedger };
}

/** Read-only scan of a candidate DB: per-file id → text sha for JSONL rows, per-file counts for durable rows. */
async function scanCandidateDb(dbPath: string) {
  const byFile = new Map<string, Map<string, string>>();
  const durableByFile = new Map<string, number>();
  let rows = 0;
  let duplicateIds = 0;
  let dim: number | null = null;
  if (!fs.existsSync(dbPath)) return { byFile, durableByFile, rows, duplicateIds, dim };
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(dbPath);
  if (!(await db.tableNames()).includes(TABLE)) return { byFile, durableByFile, rows, duplicateIds, dim };
  const table = await db.openTable(TABLE);
  const vf = (await table.schema()).fields.find((x) => x.name === "vector");
  dim = (vf?.type as { listSize?: number } | undefined)?.listSize ?? null;
  const seen = new Set<string>();
  for await (const batch of table.query().select(["id", "sessionFile", "source", "text"])) {
    const id = batch.getChild("id");
    const file = batch.getChild("sessionFile");
    const source = batch.getChild("source");
    const text = batch.getChild("text");
    for (let i = 0; i < batch.numRows; i++) {
      rows += 1;
      const rid = String(id?.get(i));
      if (seen.has(rid)) duplicateIds += 1;
      seen.add(rid);
      const f = String(file?.get(i) ?? "");
      if (String(source?.get(i) ?? "") === "pi-durable") {
        durableByFile.set(f, (durableByFile.get(f) ?? 0) + 1);
        continue;
      }
      if (!byFile.has(f)) byFile.set(f, new Map());
      byFile.get(f)!.set(rid, sha256(String(text?.get(i) ?? "")));
    }
  }
  return { byFile, durableByFile, rows, duplicateIds, dim };
}

function readCanonicalFile(p: string): Buffer | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (!st.isFile() || fs.realpathSync(p) !== p) throw new BuildRefused("candidate-file-not-regular");
  return fs.readFileSync(p);
}

/**
 * API-0 reconciliation of a partial target. Refuses (BuildRefused) on anything
 * it cannot prove; never writes.
 */
async function reconcileTarget(
  target: string,
  args: BuildArgs,
  plan: PlanDoc,
  files: FileRef[],
  durable: Preflight["durable"],
  heldByFile: Map<string, Set<string>>,
  corpus: string,
): Promise<ResumeState> {
  if (fs.existsSync(path.join(target, ".sessions-write.lock"))) throw new BuildRefused("candidate-writer-active");
  const receiptBytes = readCanonicalFile(path.join(target, "candidate-receipt.json"));
  if (!receiptBytes) throw new BuildRefused("not-a-candidate-target");
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new BuildRefused("not-a-candidate-target");
  }
  if (receipt.kind !== BUILD_KIND || receipt.policy !== CANDIDATE_POLICY) throw new BuildRefused("not-a-candidate-target");
  if (receipt.status === "built") throw new BuildRefused("candidate-already-built");
  if (receipt.status !== "partial" && receipt.status !== "building") throw new BuildRefused("candidate-receipt-status-unknown");
  const rp = receipt.plan as { path?: string; sha256?: string } | undefined;
  if (receipt.target !== target || rp?.sha256 !== args.planSha || rp?.path !== args.plan) throw new BuildRefused("candidate-plan-mismatch");
  if (JSON.stringify(receipt.planSources) !== JSON.stringify(plan.sources)) throw new BuildRefused("candidate-plan-mismatch");

  const manifestBytes = readCanonicalFile(path.join(target, "session-manifest.json"));
  let mfiles: Record<string, ManifestEntry> = {};
  if (manifestBytes) {
    try {
      mfiles = (JSON.parse(manifestBytes.toString("utf8")) as { files?: Record<string, ManifestEntry> }).files ?? {};
    } catch {
      throw new BuildRefused("candidate-manifest-not-json");
    }
  }
  const db = await scanCandidateDb(path.join(target, "sessions.lance"));
  if (db.dim !== null && db.dim !== CANDIDATE_DIM) throw new BuildRefused("candidate-db-wrong-dim");
  if (db.duplicateIds > 0) throw new BuildRefused("candidate-db-duplicate-id");

  const byAbs = new Map(files.map((f) => [f.abs, f]));
  const durableAbs = new Set(durable.map((d) => d.abs));
  for (const f of db.byFile.keys()) if (!byAbs.has(f)) throw new BuildRefused("candidate-db-unknown-file");
  for (const f of db.durableByFile.keys()) if (!durableAbs.has(f)) throw new BuildRefused("candidate-db-unknown-file");
  for (const [abs, e] of Object.entries(mfiles)) {
    const f = byAbs.get(abs);
    if (!f) throw new BuildRefused("candidate-manifest-unknown-file");
    if (e.sha256 !== f.plan.sha256 || e.size !== f.plan.size || e.chunks !== f.plan.toSendChunks) throw new BuildRefused("candidate-manifest-plan-mismatch");
  }
  let durableManifestChunks = 0;
  const dmBytes = readCanonicalFile(path.join(target, "durable-manifest.json"));
  if (dmBytes) {
    let dm: { files?: Record<string, { chunks?: number }> };
    try {
      dm = JSON.parse(dmBytes.toString("utf8"));
    } catch {
      throw new BuildRefused("candidate-manifest-not-json");
    }
    for (const [f, e] of Object.entries(dm.files ?? {})) {
      if (!durableAbs.has(f)) throw new BuildRefused("candidate-manifest-unknown-file");
      durableManifestChunks += e.chunks ?? 0;
    }
  }

  const reuse = new Map<string, ManifestEntry>();
  const adopt = new Map<string, ManifestEntry>();
  const discard = new Map<string, number>();
  const held = new Map<string, HeldEntry[]>();
  const toCheck = [...new Set([...Object.keys(mfiles), ...db.byFile.keys()])].sort();
  for (const abs of toCheck) {
    const f = byAbs.get(abs)!;
    let x: Awaited<ReturnType<typeof extractVerified>>;
    try {
      x = await extractVerified(f, corpus, heldByFile);
    } catch (e) {
      throw new BuildRefused(e instanceof BuildAborted ? e.code : "corpus-file-refused");
    }
    const got = db.byFile.get(abs) ?? new Map<string, string>();
    const same = got.size === x.send.length && x.send.every((c) => got.get(c.id) === sha256(c.text));
    if (abs in mfiles) {
      if (!same) throw new BuildRefused("candidate-manifest-db-mismatch");
      reuse.set(abs, mfiles[abs]);
      held.set(abs, x.heldLedger);
    } else if (got.size > 0) {
      if (same) {
        adopt.set(abs, { mtimeMs: statMtimeMs(x.stat.mtimeNs), size: x.stat.size, chunks: x.send.length, sha256: f.plan.sha256 });
        held.set(abs, x.heldLedger);
      } else {
        discard.set(abs, got.size);
      }
    }
  }
  const sum = (m: Map<string, { chunks: number }>) => [...m.values()].reduce((n, e) => n + e.chunks, 0);
  const reusedRows = sum(reuse);
  const adoptedRows = sum(adopt);
  const done = new Set([...reuse.keys(), ...adopt.keys()]);
  const remaining = files.filter((f) => !done.has(f.abs));
  return {
    receiptSha: sha256(receiptBytes),
    manifestSha: manifestBytes ? sha256(manifestBytes) : null,
    priorReceipt: receipt,
    priorAttempt: typeof receipt.attempt === "number" ? receipt.attempt : 1,
    reuse,
    adopt,
    discard,
    held,
    reusedRows,
    adoptedRows,
    discardRows: [...discard.values()].reduce((a, b) => a + b, 0),
    dbRows: db.rows,
    durableDbRows: [...db.durableByFile.values()].reduce((a, b) => a + b, 0),
    durableManifestChunks,
    remainingFiles: remaining.length,
    remainingJsonlRows: remaining.reduce((n, f) => n + f.plan.toSendChunks, 0),
  };
}

function absNormalized(p: string): boolean {
  return path.isAbsolute(p) && path.resolve(p) === p;
}

export async function preflight(argv: string[], env: BuildEnv, deps: BuildDeps): Promise<Preflight> {
  const args = parseBuildArgs(argv);

  // 1. authority and the production sync lock
  if (!env.device || env.device !== env.authority) throw new BuildRefused("not-index-authority");
  if (!deps.syncLockHeld(env.syncLockPath)) throw new BuildRefused("sync-lock-not-held");

  // 2. plan file and its sources
  if (!absNormalized(args.plan)) throw new BuildRefused("plan-not-absolute-normalized");
  let pst: fs.Stats;
  try {
    pst = fs.lstatSync(args.plan);
  } catch {
    throw new BuildRefused("plan-missing");
  }
  if (!pst.isFile() || fs.realpathSync(args.plan) !== args.plan) throw new BuildRefused("plan-not-canonical-regular-file");
  const planBytes = fs.readFileSync(args.plan);
  if (sha256(planBytes) !== args.planSha) throw new BuildRefused("plan-sha-mismatch");
  let plan: PlanDoc;
  try {
    plan = JSON.parse(planBytes.toString("utf8")) as PlanDoc;
  } catch {
    throw new BuildRefused("plan-not-json");
  }
  if (plan.kind !== "andenken-candidate-plan" || plan.policy !== CANDIDATE_POLICY) throw new BuildRefused("plan-policy-mismatch");
  if (plan.status !== "complete" || plan.complete !== true) throw new BuildRefused("plan-not-complete");
  if (plan.target !== args.target) throw new BuildRefused("plan-target-mismatch");
  for (const name of PLAN_SOURCES) {
    let cur: string;
    try {
      cur = sha256(fs.readFileSync(path.join(deps.repo, name)));
    } catch {
      throw new BuildRefused("plan-source-missing");
    }
    if (plan.sources?.[name] !== cur) throw new BuildRefused("plan-sources-changed-replan-required");
  }

  // 3. corpus and target
  const corpus = env.corpus;
  if (!corpus || !absNormalized(corpus)) throw new BuildRefused("corpus-not-absolute");
  if (!fs.existsSync(corpus) || !fs.statSync(corpus).isDirectory() || fs.realpathSync(corpus) !== corpus) {
    throw new BuildRefused("corpus-not-canonical-dir");
  }
  if (defaultPlanEnv(process.env).corpus !== corpus) throw new BuildRefused("discovery-corpus-mismatch");

  const t = args.target;
  if (!absNormalized(t)) throw new BuildRefused("target-not-absolute-normalized");
  let tst: fs.Stats | null = null;
  try {
    tst = fs.lstatSync(t);
  } catch {
    tst = null;
  }
  if (!args.resume && tst) throw new BuildRefused("target-exists");
  if (args.resume && !tst) throw new BuildRefused("resume-target-missing");
  if (args.resume && (!tst!.isDirectory() || fs.realpathSync(t) !== t)) throw new BuildRefused("target-not-canonical");
  if (path.dirname(t) !== env.candidatesRoot) throw new BuildRefused("target-not-directly-under-candidates-root");
  if (!ancestorsCanonical(t)) throw new BuildRefused("target-symlinked-ancestor");
  const overlaps: Array<[string, string]> = [
    [corpus, "target-overlaps-corpus"],
    [env.dataDir, "target-overlaps-production-data"],
    [deps.repo, "target-overlaps-repo"],
    ...env.protectedPaths.map((p) => [p, "target-overlaps-protected"] as [string, string]),
  ];
  for (const [p, code] of overlaps) if (within(t, p) || within(p, t)) throw new BuildRefused(code);
  let probeDev: number;
  try {
    probeDev = fs.statSync(plan.budget.probedPath).dev;
  } catch {
    throw new BuildRefused("plan-probe-path-missing");
  }
  if (fs.statSync(nearestExisting(t)).dev !== probeDev) throw new BuildRefused("target-not-on-plan-filesystem");

  // 4. CPU, provider config, space
  const cpus = deps.cpuList();
  if (cpus.length === 0 || cpus.length > MAX_CPUS) throw new BuildRefused("cpu-affinity-not-bounded");
  if (!providerConfigOk(env.providerConfig)) throw new BuildRefused("provider-config-not-qwen3-8b-4096");
  const avail = deps.availBytes(nearestExisting(t));
  if (!args.resume && (plan.budget.estimateBytes > SPACE_CAP_BYTES || avail - plan.budget.estimateBytes < ROOT_RESERVE_BYTES)) {
    throw new BuildRefused("space-insufficient");
  }

  // 5. JSONL file set and durable pin set (metadata only)
  const planRels = new Map(plan.perFile.map((f) => [f.file, f]));
  const discovered = findSessionFiles();
  if (discovered.length !== planRels.size) throw new BuildRefused("corpus-file-set-mismatch");
  const files: Preflight["files"] = [];
  for (const abs of discovered) {
    const code = checkSource(abs, corpus);
    if (code) throw new BuildRefused("corpus-file-refused");
    const rel = path.relative(corpus, abs);
    const pf = planRels.get(rel);
    if (!pf) throw new BuildRefused("corpus-file-set-mismatch");
    if (fs.statSync(abs).size !== pf.size) throw new BuildRefused("corpus-file-size-mismatch");
    files.push({ abs, rel, plan: pf });
  }
  const heldByFile = new Map<string, Set<string>>();
  for (const h of plan.coords.safetyHeld) {
    const rel = h.id.slice(0, h.id.lastIndexOf(".jsonl:") + ".jsonl".length);
    if (!heldByFile.has(rel)) heldByFile.set(rel, new Set());
    heldByFile.get(rel)!.add(h.id);
  }

  const snaps = findDurableSnapshots(corpus);
  const pinned = new Map(plan.durablePin.files.map((f) => [f.file, f]));
  if (snaps.length !== pinned.size) throw new BuildRefused("durable-pin-set-mismatch");
  const durable: Preflight["durable"] = [];
  for (const s of snaps) {
    const rel = path.relative(corpus, s.file);
    const pin = pinned.get(rel);
    if (!pin) throw new BuildRefused("durable-pin-set-mismatch");
    if (checkSource(s.file, corpus)) throw new BuildRefused("durable-refused");
    if (fs.statSync(s.file).size !== pin.size) throw new BuildRefused("durable-pin-size-mismatch");
    durable.push({ abs: s.file, rel, size: pin.size, sha256: pin.sha256 });
  }
  if (plan.durable.safety.held.chunks !== 0) throw new BuildRefused("durable-s0-held-in-plan");
  const durableRows = plan.durable.safety.toSend.chunks;
  if (plan.totals.toSend.chunks + durableRows !== plan.budget.sendRows) throw new BuildRefused("plan-arithmetic-mismatch");

  // 5b. resume: API-0 reconciliation of the partial target, then its space budget
  let resume: ResumeState | null = null;
  if (args.resume) {
    resume = await reconcileTarget(t, args, plan, files, durable, heldByFile, corpus);
    const left = plan.budget.sendRows - resume.reusedRows - resume.adoptedRows - Math.min(resume.durableManifestChunks, durableRows);
    const leftBytes = Math.ceil((plan.budget.estimateBytes * Math.max(0, left)) / plan.budget.sendRows);
    if (allocatedBytes(t).allocated + leftBytes > SPACE_CAP_BYTES || avail - leftBytes < ROOT_RESERVE_BYTES) throw new BuildRefused("space-insufficient");
  }

  // 6. human gate
  if (!env.allowPaid) throw new BuildRefused("paid-gate-closed");
  if (!deps.isTTY) throw new BuildRefused("confirmation-needs-tty");

  const policy = deps.retry ?? DEFAULT_RETRY;
  const common = [
    `  plan     ${args.plan}`,
    `  plan sha ${args.planSha} (sources verified, policy ${CANDIDATE_POLICY})`,
  ];
  const tail = [
    `  model    ${env.providerConfig.model} ${CANDIDATE_DIM}d; 1 probe call first; API concurrency ${env.apiConcurrency}; CPUs ${cpus.length} (${cpus.join(",")})`,
    `  retry    timeout/429/5xx/network only: ≤ ${policy.maxAttempts} attempts per request, backoff ${policy.baseMs / 1000}s→${policy.capMs / 1000}s with jitter (Retry-After honoured), ≤ ${policy.budgetMs / 60000} min per request, one pause shared by all workers; other 4xx/dim/S0/space/source stop at once`,
    `  space    raw vector+text ${plan.budget.estimateBytes} B (arithmetic, excludes FTS/metadata/versions); stop at ${SPACE_CAP_BYTES} B candidate or < ${ROOT_RESERVE_BYTES} B free (checked at each flush/FTS — not a filesystem quota)`,
    "  on failure: new batches stop; files complete at that point are checkpointed (not after space/S0/dim failures); the partial target is kept; continue it with --resume; nothing is deleted outside the candidate",
  ];
  const summary = resume
    ? [
        "Proceed with the PAID control-v1 candidate RESUME?",
        ...common,
        `  target   ${t} (existing partial candidate, attempt ${resume.priorAttempt} → ${resume.priorAttempt + 1}; production data, manifests, corpus and backups untouched)`,
        `  verified reuse ${resume.reuse.size} files / ${resume.reusedRows} rows (manifest == DB ids and text hashes == extraction); adopt ${resume.adopt.size} files / ${resume.adoptedRows} rows (complete in DB, not yet in manifest); discard ${resume.discard.size} files / ${resume.discardRows} rows (incomplete; deleted from the candidate only)`,
        `  remaining ${resume.remainingFiles} files / ${resume.remainingJsonlRows} JSONL rows + durable ${durableRows} (B.1, own checkpoint; ${resume.durableManifestChunks} already in its manifest) = target ${plan.budget.sendRows}; S0-held JSONL rows ${plan.totals.safetyHeld.chunks} never sent`,
        ...tail,
      ]
    : [
        "Proceed with the PAID control-v1 candidate build?",
        ...common,
        `  target   ${t} (fresh; production data, manifests, corpus and backups untouched)`,
        `  rows     ${plan.totals.toSend.chunks} JSONL + ${durableRows} durable = ${plan.budget.sendRows}; S0-held JSONL rows ${plan.totals.safetyHeld.chunks} never sent`,
        ...tail,
      ];
  return { args, plan, files, heldByFile, durable, durableRows, resume, summary };
}

// ---------------------------------------------------------------------------
// Guards around provider and store
// ---------------------------------------------------------------------------

/** Every text is S0-scanned again before it can leave; every vector must be 4096d. */
export function guardProvider(p: CandidateProvider, onCall: (n: number) => void): CandidateProvider {
  return {
    name: p.name,
    dimensions: p.dimensions,
    isPaidRemote: p.isPaidRemote,
    getStats: p.getStats?.bind(p),
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
      for (const t of texts) if (scanHighSignal(t).length > 0) throw new BuildAborted("s0-guard-tripped");
      onCall(texts.length);
      const vectors = await p.embedDocumentBatch(texts);
      if (vectors.length !== texts.length) throw new BuildAborted("provider-vector-count-mismatch");
      for (const v of vectors) if (!Array.isArray(v) || v.length !== CANDIDATE_DIM) throw new BuildAborted("provider-wrong-dim");
      return vectors;
    },
  };
}

interface SpaceLedger {
  checks: number;
  maxAllocated: number;
  minAvail: number;
}

/** Store wrapper: space checks before and after every write (flush) — fail-closed, not a quota. */
function guardStore(store: VectorStore, check: (stage: string) => void, onWritten: (n: number) => void) {
  return {
    async deleteByFile(file: string) {
      await store.deleteByFile(file);
    },
    async deleteByFileAbove(file: string, line: number) {
      await store.deleteByFileAbove(file, line);
    },
    async addChunksRaw(rows: BufferedRecord[]) {
      check("before-write");
      await store.addChunksRaw(rows);
      onWritten(rows.length);
      check("after-write");
    },
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildResult {
  status: "built" | "partial";
  code?: string;
  receipt: string;
}

export async function runBuild(argv: string[], env: BuildEnv, deps: BuildDeps): Promise<BuildResult> {
  const preflightStartedAt = deps.now();
  const pf = await preflight(argv, env, deps);
  const promptedAt = deps.now();
  const reply = await deps.confirm(pf.summary);
  if (reply !== "yes") throw new BuildRefused("confirmation-declined");
  return build(pf, env, deps, { preflightStartedAt, promptedAt, confirmedAt: deps.now() });
}

interface Timing {
  preflightStartedAt: Date;
  promptedAt: Date;
  confirmedAt: Date;
}

const kst = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });

async function build(pf: Preflight, env: BuildEnv, deps: BuildDeps, timing: Timing): Promise<BuildResult> {
  const target = pf.args.target;
  const corpus = env.corpus!;
  const started = deps.now();
  const resume = pf.resume;

  if (!resume) {
    // Create the fresh target (never recursive past the candidates root).
    if (!fs.existsSync(env.candidatesRoot)) {
      if (!fs.existsSync(path.dirname(env.candidatesRoot))) throw new BuildRefused("candidates-root-parent-missing");
      fs.mkdirSync(env.candidatesRoot, { mode: 0o700 });
    }
    try {
      fs.mkdirSync(target, { mode: 0o700 });
    } catch {
      throw new BuildRefused("target-exists");
    }
    if (fs.realpathSync(target) !== target) throw new BuildRefused("target-not-canonical");
  }

  let lock: SessionsLockHandle;
  try {
    lock = acquireSessionsLock("candidate:sessions:build", { dataDir: target, env: {} });
  } catch (e) {
    throw new BuildRefused(e instanceof SessionsLockRefused ? e.reason : "candidate-lock-failed");
  }

  const receiptPath = path.join(target, "candidate-receipt.json");
  const manifestPath = path.join(target, "session-manifest.json");
  const durableManifestPath = path.join(target, "durable-manifest.json");
  const ledgerPath = path.join(target, "s0-held.json");

  // Resume: the files the reconciliation read must be the files we now hold the lock over.
  const attempts: Array<Record<string, unknown>> = [];
  if (resume) {
    const now = (p: string) => (fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null);
    if (now(receiptPath) !== resume.receiptSha || now(manifestPath) !== resume.manifestSha) {
      lock.release();
      throw new BuildRefused("candidate-changed-since-preflight");
    }
    // Archive the previous attempt's receipt, manifests and ledger byte-for-byte.
    const dir = path.join(target, "attempts");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    const n = String(resume.priorAttempt).padStart(2, "0");
    const archived: Record<string, string> = {};
    for (const name of ["candidate-receipt.json", "session-manifest.json", "durable-manifest.json", "s0-held.json"]) {
      const src = path.join(target, name);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(dir, `attempt-${n}-${name}`);
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dst, 0o600);
      archived[name] = sha256(fs.readFileSync(dst));
    }
    const prior = resume.priorReceipt;
    attempts.push(...(Array.isArray(prior.attempts) ? (prior.attempts as Array<Record<string, unknown>>) : []));
    attempts.push({
      attempt: resume.priorAttempt,
      status: prior.status,
      code: prior.code ?? null,
      startedAt: prior.startedAt ?? null,
      finishedAt: prior.finishedAt ?? null,
      archived: Object.fromEntries(Object.entries(archived).map(([k, v]) => [`attempts/attempt-${n}-${k}`, v])),
    });
  }

  const buildSources: Record<string, string> = {};
  for (const f of ["scripts/candidate-build.ts", "store.ts", "write-buffer.ts", "sessions-lock.ts", "embedding-provider.ts"]) {
    buildSources[f] = sha256(fs.readFileSync(path.join(deps.repo, f)));
  }
  const policy = deps.retry ?? DEFAULT_RETRY;
  const timeoutEnv = parseInt(process.env.ANDENKEN_SESSION_TIMEOUT_MS ?? "", 10);
  const receipt: Record<string, unknown> = {
    kind: BUILD_KIND,
    policy: CANDIDATE_POLICY,
    status: "building",
    notice:
      "Candidate index for measurement only. Not a production index: legacy writers (sync, index:sessions, pi /memory) know nothing of this policy and must not be pointed here. No cutover.",
    plan: { path: pf.args.plan, sha256: pf.args.planSha, corpusPin: pf.plan.corpusPin, durablePin: pf.plan.durablePin },
    planSources: pf.plan.sources,
    buildSources,
    target,
    attempt: resume ? resume.priorAttempt + 1 : 1,
    attempts,
    mode: resume ? "resume" : "fresh",
    startedAt: started.toISOString(),
    cpus: deps.cpuList(),
    apiConcurrency: env.apiConcurrency,
    retryPolicy: policy,
    requestTimeoutMs: Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : null,
    expected: { jsonlRows: pf.plan.totals.toSend.chunks, durableRows: pf.durableRows, rows: pf.plan.budget.sendRows, s0HeldJsonlRows: pf.plan.totals.safetyHeld.chunks },
    resume: resume
      ? {
          reusedFiles: resume.reuse.size,
          reusedRows: resume.reusedRows,
          adoptedFiles: resume.adopt.size,
          adoptedRows: resume.adoptedRows,
          discardedFiles: resume.discard.size,
          discardedRows: resume.discardRows,
          dbRowsBefore: resume.dbRows,
          durableDbRowsBefore: resume.durableDbRows,
          remainingFiles: resume.remainingFiles,
          remainingJsonlRows: resume.remainingJsonlRows,
        }
      : null,
  };
  writeJsonAtomic(receiptPath, receipt);

  const space: SpaceLedger = { checks: 0, maxAllocated: 0, minAvail: Number.MAX_SAFE_INTEGER };
  const checkSpace = (_stage: string) => {
    const { allocated } = allocatedBytes(target);
    const avail = deps.availBytes(target);
    space.checks += 1;
    space.maxAllocated = Math.max(space.maxAllocated, allocated);
    space.minAvail = Math.min(space.minAvail, avail);
    if (allocated > SPACE_CAP_BYTES) throw new BuildAborted("candidate-size-cap");
    if (avail < ROOT_RESERVE_BYTES) throw new BuildAborted("root-reserve");
  };

  let aborted: string | null = null;
  const abort = (code: string) => {
    if (!aborted) aborted = code;
  };
  let requests = 0;
  let sentTexts = 0;
  const tele = newTelemetry();
  const retryLinesAtStart = stderrStats.providerRetryLines;
  const counts = {
    files: 0,
    jsonlRows: 0,
    heldRows: 0,
    durableRows: 0,
    finalRows: 0,
    reusedFiles: resume?.reuse.size ?? 0,
    reusedRows: resume?.reusedRows ?? 0,
    adoptedFiles: resume?.adopt.size ?? 0,
    adoptedRows: resume?.adoptedRows ?? 0,
    discardedRows: 0,
  };
  const heldLedger: HeldEntry[] = [];
  for (const h of resume?.held.values() ?? []) heldLedger.push(...h);
  const manifest: { files: Record<string, ManifestEntry>; lastUpdated: string } = { files: {}, lastUpdated: "" };
  for (const [f, e] of resume?.reuse ?? []) manifest.files[f] = e;
  let finalCheckpoint: string | null = null;
  let processingStartedMs = deps.now().getTime();

  // Bounded progress: one line per period, counts and timings only.
  const samples: Array<[number, number]> = [];
  const totalFiles = pf.files.length;
  const progressLine = (): string => {
    const now = deps.now().getTime();
    const doneRows = counts.reusedRows + counts.adoptedRows + counts.jsonlRows;
    const doneFiles = counts.reusedFiles + counts.adoptedFiles + counts.files;
    samples.push([now, counts.jsonlRows]);
    if (samples.length > 6) samples.shift();
    const perMin = (rows: number, ms: number) => (ms > 0 ? (rows * 60_000) / ms : 0);
    const overall = perMin(counts.jsonlRows, now - processingStartedMs);
    const recent = samples.length > 1 ? perMin(samples[samples.length - 1][1] - samples[0][1], samples[samples.length - 1][0] - samples[0][0]) : overall;
    const left = pf.plan.totals.toSend.chunks - doneRows;
    const etas = [overall, recent].filter((r) => r > 0).map((r) => left / r);
    const eta = etas.length ? `${Math.floor(Math.min(...etas))}–${Math.ceil(Math.max(...etas))} min` : "?";
    const f = tele.failures;
    const paused = Math.max(0, tele.pausedUntil - now);
    return (
      `  [${kst(now)} KST] files ${doneFiles}/${totalFiles} rows ${doneRows}/${pf.plan.totals.toSend.chunks}` +
      ` (new ${counts.jsonlRows}, reused ${counts.reusedRows + counts.adoptedRows}) requests ${requests} attempts ${tele.attempts} inflight ${tele.inflight}` +
      ` retries ${tele.retries} [timeout ${f.timeout} 429 ${f["rate-limit"]} 5xx ${f.server} net ${f.network}]` +
      `${paused > 0 ? ` paused ${Math.ceil(paused / 1000)}s` : ""} last-ok ${tele.lastOkAt === null ? "-" : `${Math.round((now - tele.lastOkAt) / 1000)}s ago`}` +
      ` rate ${Math.round(recent)} rows/min eta ${eta}`
    );
  };
  const every = deps.progressEveryMs ?? PROGRESS_EVERY_MS;
  const ticker = every > 0 ? setInterval(() => deps.log(progressLine()), every) : null;
  ticker?.unref?.();

  let provider: CandidateProvider | null = null;
  const writeReceipt = (status: "built" | "partial", code?: string) => {
    const finishedAt = deps.now();
    counts.heldRows = heldLedger.length;
    Object.assign(receipt, {
      status,
      code,
      finishedAt: finishedAt.toISOString(),
      counts,
      api: {
        requests,
        texts: sentTexts,
        attempts: tele.attempts,
        retries: tele.retries,
        retriedTexts: tele.retriedTexts,
        recovered: tele.recovered,
        failures: tele.failures,
        pauseMs: tele.pauseMs,
        waitedMs: tele.waitedMs,
        discardedTexts: tele.discardedTexts,
        providerInternalRetryLines: stderrStats.providerRetryLines - retryLinesAtStart,
        latencyMs: latencySummary(tele.latencyMs),
        note: "retriedTexts bounds possible double billing: a timed-out request may have been billed before it was retried",
        ...(provider?.getStats ? provider.getStats() : {}),
      },
      space: { ...space, minAvail: space.minAvail === Number.MAX_SAFE_INTEGER ? null : space.minAvail, capBytes: SPACE_CAP_BYTES, reserveBytes: ROOT_RESERVE_BYTES, note: "checked before/after each write and around FTS; not a filesystem quota" },
      manifestFiles: Object.keys(manifest.files).length,
      finalCheckpoint,
      timing: {
        preflightStartedAt: timing.preflightStartedAt.toISOString(),
        promptedAt: timing.promptedAt.toISOString(),
        confirmedAt: timing.confirmedAt.toISOString(),
        startedAt: started.toISOString(),
        finishedAt: finishedAt.toISOString(),
        preflightMs: timing.promptedAt.getTime() - timing.preflightStartedAt.getTime(),
        humanWaitMs: timing.confirmedAt.getTime() - timing.promptedAt.getTime(),
        activeMs: finishedAt.getTime() - started.getTime(),
        wallMs: finishedAt.getTime() - timing.preflightStartedAt.getTime(),
      },
    });
    writeJsonAtomic(ledgerPath, { note: "S0-held rows: never sent to the provider. Ids and kinds only.", count: heldLedger.length, rows: heldLedger });
    writeJsonAtomic(receiptPath, receipt);
  };

  // An interrupted run (timeout, Ctrl-C) leaves a partial target, never a "building" one.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (sig: NodeJS.Signals) => {
    try {
      if (ticker) clearInterval(ticker);
      writeReceipt("partial", `interrupted-${sig}`);
    } finally {
      lock.release();
      process.exit(sig === "SIGINT" ? 130 : 143);
    }
  };
  for (const sig of signals) process.once(sig, onSignal);
  deps.log(
    `candidate build: target ${target}; ${resume ? `RESUME attempt ${receipt.attempt}; reuse ${counts.reusedRows} + adopt ${counts.adoptedRows} rows, discard ${resume.discardRows}; ` : ""}affinity ${(receipt.cpus as number[]).length} CPUs (${(receipt.cpus as number[]).join(",")}); API concurrency ${env.apiConcurrency}`,
  );

  const finish = (status: "built" | "partial", code?: string): BuildResult => {
    for (const sig of signals) process.off(sig, onSignal);
    if (ticker) clearInterval(ticker);
    writeReceipt(status, code);
    lock.release();
    deps.log(progressLine());
    deps.log(`candidate build ${status}${code ? ` (${code})` : ""}: rows=${counts.finalRows || counts.reusedRows + counts.adoptedRows + counts.jsonlRows + counts.durableRows} requests=${requests} retries=${tele.retries}`);
    return { status, code, receipt: receiptPath };
  };

  const clock: RetryClock = {
    nowMs: () => deps.now().getTime(),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    random: deps.random ?? Math.random,
  };
  try {
    const raw = await deps.createProvider();
    if (!raw) return finish("partial", "provider-unavailable");
    if (raw.dimensions !== CANDIDATE_DIM) return finish("partial", "provider-config-dim-mismatch");
    provider = guardProvider(
      resilientProvider(raw, policy, clock, tele, () => aborted !== null),
      (n) => {
        requests += 1;
        sentTexts += n;
      },
    );
    const probe = await provider.embedDocumentBatch([PROBE_TEXT]);
    if (probe.length !== 1 || probe[0].length !== CANDIDATE_DIM) return finish("partial", "probe-dim-mismatch");
  } catch (e) {
    return finish("partial", providerErrorCode(e));
  }

  const store = new VectorStore(path.join(target, "sessions.lance"), CANDIDATE_DIM);
  try {
    await store.init();
    await store.ensureTable();
    await store.assertCompatibleDim();
  } catch (e) {
    await store.close();
    return finish("partial", errorCode(e));
  }
  const guarded = guardStore(store, checkSpace, (n) => deps.trace?.("rows-written", n));
  const wb = new WriteBuffer(guarded, DB_WRITE_BATCH);

  // Resume: drop incomplete row sets (candidate only), then make adopted files visible.
  if (resume) {
    try {
      for (const [f, n] of resume.discard) {
        await store.deleteByFile(f);
        counts.discardedRows += n;
      }
      for (const [f, e] of resume.adopt) manifest.files[f] = e;
      manifest.lastUpdated = deps.now().toISOString();
      writeJsonAtomic(manifestPath, manifest);
    } catch (e) {
      await store.close();
      return finish("partial", errorCode(e));
    }
  }

  // Manifest entries become visible only after the flush that carries their rows.
  const pending: Array<[string, ManifestEntry]> = [];
  let checkpointChain: Promise<void> = Promise.resolve();
  const checkpoint = () => {
    checkpointChain = checkpointChain.then(async () => {
      const take = pending.splice(0);
      await wb.flush();
      for (const [f, e] of take) manifest.files[f] = e;
      manifest.lastUpdated = deps.now().toISOString();
      writeJsonAtomic(manifestPath, manifest);
      deps.trace?.("manifest-saved", Object.values(manifest.files).reduce((n, e) => n + e.chunks, 0));
    });
    return checkpointChain;
  };

  const processFile = async (f: FileRef) => {
    const x = await extractVerified(f, corpus, pf.heldByFile);
    if (aborted) return;
    const rows: BufferedRecord[] = [];
    try {
      for (let i = 0; i < x.send.length; i += REQUEST_BATCH) {
        if (aborted) {
          tele.discardedTexts += rows.length;
          return;
        }
        const slice: SessionChunk[] = x.send.slice(i, i + REQUEST_BATCH);
        const vectors = await provider!.embedDocumentBatch(slice.map((c) => c.text));
        slice.forEach((c, j) => rows.push({ ...c, vector: vectors[j] }));
      }
    } catch (e) {
      tele.discardedTexts += rows.length;
      throw e;
    }
    // A file whose every row is embedded is kept after a provider/source stop, never after space/S0/dim.
    if (aborted && !checkpointAllowedAfter(aborted)) {
      tele.discardedTexts += rows.length;
      return;
    }
    if (rows.length > 0) await wb.append(rows);
    heldLedger.push(...x.heldLedger);
    pending.push([f.abs, { mtimeMs: statMtimeMs(x.stat.mtimeNs), size: x.stat.size, chunks: x.send.length, sha256: f.plan.sha256 }]);
    counts.files += 1;
    counts.jsonlRows += x.send.length;
    if (counts.files % (deps.checkpointEvery ?? CHECKPOINT_FILES) === 0 && !aborted) {
      await checkpoint();
      deps.log(`  files ${counts.reusedFiles + counts.adoptedFiles + counts.files}/${totalFiles} rows ${counts.reusedRows + counts.adoptedRows + counts.jsonlRows} (new ${counts.jsonlRows}) requests ${requests} retries ${tele.retries}`);
    }
  };

  // Bounded pool over the files not yet in the manifest. The first failure stops every worker from starting new work.
  const work = pf.files.filter((f) => !(f.abs in manifest.files));
  processingStartedMs = deps.now().getTime();
  let next = 0;
  const worker = async () => {
    while (!aborted) {
      const i = next++;
      if (i >= work.length) return;
      try {
        await processFile(work[i]);
      } catch (e) {
        abort(providerErrorCode(e));
      }
    }
  };
  await Promise.all(Array.from({ length: env.apiConcurrency }, worker));
  if (aborted) {
    const code: string = aborted;
    if (checkpointAllowedAfter(code) && pending.length > 0) {
      try {
        await checkpoint();
        finalCheckpoint = "saved";
      } catch (e) {
        finalCheckpoint = `failed:${providerErrorCode(e)}`;
      }
    } else {
      finalCheckpoint = pending.length > 0 ? "withheld" : "nothing-pending";
    }
    await store.close();
    return finish("partial", code);
  }

  try {
    await checkpoint();

    // --- durable: pin → B.1 index (S0 must hold nothing; its own checkpoint resumes) → pin again ---
    const verifyPins = (code: string) => {
      for (const d of pf.durable) {
        const r = readSourceOnce(d.abs, corpus);
        if (r.kind !== "ok" || r.stat.size !== d.size || sha256(r.bytes) !== d.sha256) throw new BuildAborted(code);
      }
    };
    if (pf.durable.length > 0) {
      verifyPins("durable-pin-mismatch-before");
      const report = await runDurableIndex({
        corpus,
        manifestPath: durableManifestPath,
        dryRun: false,
        store: guarded,
        provider: provider!,
        saveManifest: (file: string, m: DurableManifest) => writeJsonAtomic(file, m),
        inspectExtraction: (_file, x) => {
          if (partitionMessagesForEmbedding(x.groups).held.length > 0) throw new BuildAborted("durable-s0-held");
        },
      });
      const done = report.files.filter((f) => f.status === "indexed" || f.status === "up-to-date");
      if (report.files.length !== pf.durable.length || done.length !== pf.durable.length) throw new BuildAborted("durable-not-indexed");
      const dm = JSON.parse(fs.readFileSync(durableManifestPath, "utf8")) as { files?: Record<string, { chunks?: number }> };
      counts.durableRows = pf.durable.reduce((n, d) => n + (dm.files?.[d.abs]?.chunks ?? 0), 0);
      if (counts.durableRows !== pf.durableRows) throw new BuildAborted("durable-row-count-mismatch");
      verifyPins("durable-pin-mismatch-after");
    }

    // --- FTS, then integrity ---
    checkSpace("before-fts");
    await store.createFtsIndex();
    checkSpace("after-fts");
    const integrity = await verifyCandidate(path.join(target, "sessions.lance"));
    counts.finalRows = integrity.rows;
    const manifestChunks = Object.values(manifest.files).reduce((n, e) => n + e.chunks, 0);
    const jsonlTotal = counts.reusedRows + counts.adoptedRows + counts.jsonlRows;
    receipt.integrity = { ...integrity, manifestChunks, manifestFiles: Object.keys(manifest.files).length };
    if (integrity.rows !== pf.plan.budget.sendRows) throw new BuildAborted("final-row-count-mismatch");
    if ((integrity.bySource["pi-durable"] ?? 0) !== counts.durableRows) throw new BuildAborted("durable-rows-not-in-db");
    if (manifestChunks !== jsonlTotal || integrity.rows - (integrity.bySource["pi-durable"] ?? 0) !== manifestChunks) {
      throw new BuildAborted("manifest-db-pair-mismatch");
    }
    if (Object.keys(manifest.files).length !== pf.files.length) throw new BuildAborted("manifest-file-count-mismatch");
    if (heldLedger.length !== pf.plan.totals.safetyHeld.chunks) throw new BuildAborted("s0-ledger-count-mismatch");
    if (!integrity.fts || integrity.dim !== CANDIDATE_DIM || integrity.distinctIds !== integrity.rows || integrity.s0Hits !== 0) {
      throw new BuildAborted("integrity-failed");
    }
  } catch (e) {
    await store.close();
    return finish("partial", providerErrorCode(e));
  }
  await store.close();
  return finish("built");
}

/** Read-only checks over a finished candidate DB: count, dim, FTS, unique ids, S0 hits, rows per source. */
export async function verifyCandidate(dbPath: string): Promise<{
  rows: number;
  dim: number | null;
  fts: boolean;
  distinctIds: number;
  s0Hits: number;
  bySource: Record<string, number>;
}> {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable(TABLE);
  const rows = await table.countRows();
  const indices = await table.listIndices();
  const fts = indices.some((i) => i.indexType === "FTS" && i.columns.length === 1 && i.columns[0] === "text");
  const ids = new Set<string>();
  const bySource: Record<string, number> = {};
  let s0Hits = 0;
  // Streamed batch by batch: the candidate's text never sits in memory at once.
  for await (const batch of table.query().select(["id", "text", "source"])) {
    const id = batch.getChild("id");
    const text = batch.getChild("text");
    const source = batch.getChild("source");
    for (let i = 0; i < batch.numRows; i++) {
      ids.add(String(id?.get(i)));
      const s = String(source?.get(i) ?? "");
      bySource[s] = (bySource[s] ?? 0) + 1;
      if (scanHighSignal(String(text?.get(i) ?? "")).length > 0) s0Hits += 1;
    }
  }
  const one = await table.query().select(["vector"]).limit(1).toArray();
  const v = one[0]?.vector as { length?: number } | undefined;
  return { rows, dim: v && typeof v.length === "number" ? v.length : null, fts, distinctIds: ids.size, s0Hits, bySource };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const restore = installStderrFilter();
  try {
    const result = await runBuild(process.argv.slice(2), defaultBuildEnv(), defaultBuildDeps());
    return result.status === "built" ? 0 : 4;
  } catch (e) {
    if (e instanceof BuildRefused) {
      console.error(`REFUSED candidate-build: ${e.code} (no provider call)`);
      return e.code === "sessions-writer-busy" ? 75 : 2;
    }
    console.error(`FAILED candidate-build: ${providerErrorCode(e)}`);
    return 1;
  } finally {
    restore();
  }
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  main().then((code) => process.exit(code));
}

export type { DurableRow };
