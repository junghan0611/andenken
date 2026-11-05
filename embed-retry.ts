/**
 * embed-retry.ts — bounded 429 rescheduling for the sessions document indexer.
 *
 * Scope: indexSessions only. Query embedding, the candidate builder (it has its
 * own resilientProvider), durable and md indexing are not wrapped.
 *
 * The provider's transport behaviour is unchanged: a 429 still leaves
 * VLLMProvider at once (its `nonRetryable` flag bypasses the transport retry
 * loop), and 5xx / timeout / network keep the provider's own internal retries
 * (up to 4 HTTP attempts per provider call). This wrapper resubmits on 429 only
 * and lets every other error through on its first provider call, so it adds no
 * resubmission on top of those transport retries. It does not cap HTTP
 * attempts: with mixed failures (a 503 retried inside one call, a 429 on the
 * next) a slice can take more HTTP attempts than its provider calls.
 *
 * Unit of retry: one provider call — one inner embedDocumentBatch() over a
 * slice no larger than the provider's configured maxBatchSize, i.e. one embed()
 * call, which may itself make several HTTP attempts. A slice that returned
 * vectors is never sent again; only the slice that met the 429 is. The wrapper
 * applies only where that size is known (`rateLimitSliceSize`); it never
 * guesses one.
 *
 * Admission is checked synchronously right before each provider call — the
 * only await in the gate is the sleep, after which the check runs again — so
 * after a stop or pause no NEW slice and no new provider call is admitted. A
 * provider call already entered is not interrupted: it runs to completion,
 * including its own bounded transport retries, which may send new HTTP requests
 * after the stop (VLLMProvider starts its first fetch before its first await).
 *
 * This schedules admission. It adds no deadline to a request: the provider's
 * existing header timeout and success-body read are as they were.
 *
 * Counters, kept apart: `slices` (logical slices handed in), `innerCalls`
 * (provider calls made here, resubmissions included); HTTP attempts are the
 * provider's own `httpAttempts`.
 */

import { VLLMProvider, type EmbeddingProvider, type EmbeddingStats, type ProviderErrorMeta } from "./embedding-provider.js";

export interface RateLimitPolicy {
  /** Provider calls per slice while it meets 429, the first included — not HTTP attempts. */
  maxAttempts: number;
  /** Equal-jitter exponential backoff: ceiling = min(capMs, baseMs × 2^(attempt−1)). */
  baseMs: number;
  capMs: number;
  /** Per slice: elapsed since its first attempt plus the next delay must fit. */
  sliceBudgetMs: number;
  /** Per run: total extension of the one shared pause. */
  runPauseBudgetMs: number;
}

export const DEFAULT_RATE_LIMIT_POLICY: Readonly<RateLimitPolicy> = Object.freeze({
  maxAttempts: 5,
  baseMs: 5_000,
  capMs: 60_000,
  sliceBudgetMs: 300_000,
  runPauseBudgetMs: 600_000,
});

export interface RetryClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

/** Monotonic: a wall-clock step cannot shorten or stretch a pause. */
export const SYSTEM_CLOCK: RetryClock = {
  nowMs: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};

export type ExhaustionReason = "slice-attempts" | "slice-budget" | "run-budget" | "retry-after-over-cap";

export interface RateLimitTelemetry {
  /** Logical slices handed to the wrapper. */
  slices: number;
  /** Inner provider calls made by the wrapper, resubmissions included. */
  innerCalls: number;
  resubmissions: number;
  resubmittedTexts: number;
  /** 429 responses seen by the wrapper. */
  rateLimited: number;
  /** Slices that returned vectors after at least one 429. */
  recovered: number;
  /** Extension of the shared pause, as scheduled (not measured). */
  sharedPauseMs: number;
  /** Sleep steps scheduled by workers waiting at the gate, summed over workers (not measured). */
  workerWaitMs: number;
  /** Admissions refused without any request once the run stopped. */
  refusedSlices: number;
  /** Texts of slices that returned vectors inside a call that then failed: embedded (possibly billed), not stored. */
  discardedTexts: number;
  stopped: ExhaustionReason | null;
  lastRateLimit: ProviderErrorMeta | null;
}

export function newRateLimitTelemetry(): RateLimitTelemetry {
  return {
    slices: 0,
    innerCalls: 0,
    resubmissions: 0,
    resubmittedTexts: 0,
    rateLimited: 0,
    recovered: 0,
    sharedPauseMs: 0,
    workerWaitMs: 0,
    refusedSlices: 0,
    discardedTexts: 0,
    stopped: null,
    lastRateLimit: null,
  };
}

/** A 429 that was not resubmitted again. `original` is the provider's 429 error. */
export class RateLimitExhausted extends Error {
  readonly code = "rate-limit-exhausted";
  constructor(
    readonly reason: ExhaustionReason,
    readonly attempts: number,
    readonly original: unknown,
  ) {
    super(
      `rate-limit exhausted (${reason}) after ${attempts} attempt(s): ` +
        (original instanceof Error ? original.message : "vLLM embed (429)"),
    );
    this.name = "RateLimitExhausted";
  }
}

/** Admission refused after the run stopped on 429: no request was made. */
export class RateLimitStop extends Error {
  readonly code = "rate-limit-stopped";
  constructor(readonly reason: ExhaustionReason) {
    super(`rate-limit stop (${reason}): slice not submitted`);
    this.name = "RateLimitStop";
  }
}

export function isRateLimited(e: unknown): boolean {
  if (e instanceof RateLimitExhausted || e instanceof RateLimitStop) return false;
  if ((e as { status?: unknown } | null)?.status === 429) return true;
  return e instanceof Error && /^vLLM embed \(429\)/.test(e.message);
}

function retryAfterOf(e: unknown): number | undefined {
  const v = (e as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function providerMetaOf(e: unknown): ProviderErrorMeta | null {
  const m = (e as { providerMeta?: unknown } | null)?.providerMeta;
  return m !== null && typeof m === "object" ? (m as ProviderErrorMeta) : null;
}

/** Delay after failed attempt `attempt` (1-based); Retry-After is a floor (rounded up); never above capMs. */
export function rateLimitDelayMs(attempt: number, p: RateLimitPolicy, random: () => number, retryAfterMs?: number): number {
  const ceiling = Math.min(p.capMs, p.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = ceiling / 2 + random() * (ceiling / 2);
  return Math.min(p.capMs, Math.ceil(Math.max(jittered, retryAfterMs ?? 0)));
}

/** The pause every worker of one wrapper waits behind. */
export interface SharedGate {
  pausedUntil: number;
}

/** The slice size to wrap with, or null: only a VLLMProvider with a configured batch size qualifies. */
export function rateLimitSliceSize(p: EmbeddingProvider): number | null {
  return p instanceof VLLMProvider ? (p.configuredMaxBatchSize ?? null) : null;
}

export interface RateLimitRetrying extends EmbeddingProvider {
  readonly sliceSize: number;
  readonly telemetry: RateLimitTelemetry;
}

export function withRateLimitRetry(
  inner: EmbeddingProvider,
  sliceSize: number,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
  clock: RetryClock = SYSTEM_CLOCK,
  telemetry: RateLimitTelemetry = newRateLimitTelemetry(),
  gate: SharedGate = { pausedUntil: 0 },
): RateLimitRetrying {
  if (!Number.isInteger(sliceSize) || sliceSize <= 0) {
    throw new Error(`withRateLimitRetry: slice size must be a positive integer, got ${sliceSize}`);
  }
  const tele = telemetry;

  const exhaust = (reason: ExhaustionReason, attempts: number, original: unknown): never => {
    if (tele.stopped === null) tele.stopped = reason;
    throw new RateLimitExhausted(reason, attempts, original);
  };

  const runSlice = async (slice: string[]): Promise<number[][]> => {
    tele.slices += 1;
    const first = clock.nowMs();
    let last: unknown = null;
    for (let attempt = 1; ; attempt++) {
      // One gate for every worker: a 429 seen by one pauses all of them. The
      // check is repeated after every sleep and the last one passes with no
      // await between it and the inner call below.
      for (;;) {
        if (tele.stopped !== null) {
          tele.refusedSlices += 1;
          throw new RateLimitStop(tele.stopped);
        }
        const left = gate.pausedUntil - clock.nowMs();
        if (left <= 0) break;
        const step = Math.min(left, 1000);
        tele.workerWaitMs += step;
        await clock.sleep(step);
      }
      // Budget is checked again before a new attempt: the shared pause may have
      // been extended by another worker while this one waited.
      if (attempt > 1 && clock.nowMs() - first > policy.sliceBudgetMs) exhaust("slice-budget", attempt - 1, last);
      tele.innerCalls += 1;
      if (attempt > 1) {
        tele.resubmissions += 1;
        tele.resubmittedTexts += slice.length;
      }
      try {
        const vectors = await inner.embedDocumentBatch(slice);
        if (attempt > 1) tele.recovered += 1;
        return vectors;
      } catch (e) {
        if (!isRateLimited(e)) throw e;
        last = e;
        tele.rateLimited += 1;
        tele.lastRateLimit = providerMetaOf(e) ?? tele.lastRateLimit;
        if (tele.stopped !== null) exhaust(tele.stopped, attempt, e);
        if (attempt >= policy.maxAttempts) exhaust("slice-attempts", attempt, e);
        const ra = retryAfterOf(e);
        if (ra !== undefined && ra > policy.capMs) exhaust("retry-after-over-cap", attempt, e);
        const delay = rateLimitDelayMs(attempt, policy, clock.random, ra);
        const now = clock.nowMs();
        if (now - first + delay > policy.sliceBudgetMs) exhaust("slice-budget", attempt, e);
        const until = Math.max(gate.pausedUntil, now + delay);
        const extension = until - Math.max(gate.pausedUntil, now);
        if (tele.sharedPauseMs + extension > policy.runPauseBudgetMs) exhaust("run-budget", attempt, e);
        tele.sharedPauseMs += extension;
        gate.pausedUntil = until;
      }
    }
  };

  return {
    get name() {
      return inner.name;
    },
    get dimensions() {
      return inner.dimensions;
    },
    sliceSize,
    telemetry: tele,
    embedQuery: (text: string) => inner.embedQuery(text),
    embedDocument: (text: string) => inner.embedDocument(text),
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      let embedded = 0;
      try {
        for (let i = 0; i < texts.length; i += sliceSize) {
          const slice = texts.slice(i, i + sliceSize);
          const vectors = await runSlice(slice);
          for (const v of vectors) out.push(v);
          embedded += slice.length;
        }
        return out;
      } catch (e) {
        tele.discardedTexts += embedded;
        throw e;
      }
    },
    getStats: (): EmbeddingStats => inner.getStats(),
    resetStats: () => inner.resetStats(),
  };
}
