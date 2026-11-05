/**
 * embed-retry.test.ts — SYNTHETIC suite (API 0) for the sessions 429
 * rescheduler (embed-retry.ts), VLLMProvider error diagnostics and transport
 * counters (embedding-provider.ts), the index-run finalization seam
 * (index-finalize.ts) and its wiring in indexer.ts.
 *
 * fetch is replaced: the default stub throws, so any unplanned request fails
 * the suite. A fake clock replaces time for the rescheduler. HOME points at a
 * fresh temp dir (no ~/.env.local is read) and ANDENKEN_DATA at a temp dir
 * unless one is given; credential-shaped env names are removed from this
 * process first. Fake credentials are assembled at runtime.
 *
 *   ./run.sh test:retry
 */

import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GeminiProvider,
  VLLMProvider,
  createSessionProviderFromEnv,
  diagnosticToken,
  parseRetryAfterMs,
  readBoundedBody,
  runWithConcurrency,
  type EmbeddingProvider,
  type EmbeddingStats,
} from "./embedding-provider.ts";
import {
  DEFAULT_RATE_LIMIT_POLICY,
  RateLimitExhausted,
  RateLimitStop,
  newRateLimitTelemetry,
  rateLimitDelayMs,
  rateLimitSliceSize,
  withRateLimitRetry,
  type RetryClock,
  type SharedGate,
} from "./embed-retry.ts";
import { IndexRunFailed, finalizeIndexRun, formatApiSummary, type FinalizeDeps } from "./index-finalize.ts";
import { getModelPreset } from "./model-presets.ts";
// Pure classification only: importing runs no build (direct-run guard), and
// store.ts loads LanceDB lazily; no runBuild/verifyCandidate/default deps here.
import { classifyProviderFailure, providerErrorCode } from "./scripts/candidate-build.ts";

// --- isolation -------------------------------------------------------------

const REPO = path.dirname(fileURLToPath(import.meta.url));
const scrubbed = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) || k.startsWith("ANDENKEN_SESSION_"));
for (const k of scrubbed) delete process.env[k];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-retry-test-"));
process.env.HOME = TMP;
const givenData = process.env.ANDENKEN_DATA;
if (givenData && path.resolve(givenData) === path.join(REPO, "data")) {
  console.error("refusing: ANDENKEN_DATA is this repo's data dir");
  process.exit(2);
}
if (!givenData) process.env.ANDENKEN_DATA = path.join(TMP, "data");
console.log(
  `isolation: ${scrubbed.length} credential-shaped/session env names removed; HOME → temp; ANDENKEN_DATA ${givenData ? "given" : "→ temp"}`,
);
setTimeout(() => {
  console.error("suite timeout (60s)");
  process.exit(3);
}, 60_000).unref();

// --- fixtures ---------------------------------------------------------------

const KEY = ["canary", "key", "7f3a9b", "test", "only"].join("-");
const INPUT_CANARY = ["INPUT", "CANARY", "c41d"].join("-");
const TEXT_CANARY = ["TEXT", "CANARY", "9e2b"].join("-");
const RAW_CANARY = ["RAW", "CANARY", "55aa"].join("-");
const SK_SHAPE = ["sk", "or", "v1", "0000abcd"].join("-");

type Call = { url: string; input: string[]; auth: string | null };
const calls: Call[] = [];
let route: ((call: Call, n: number) => Response | Promise<Response>) | null = null;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  if (!route) throw new Error("network forbidden in this suite");
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  const call = { url: String(input), input: body.input, auth: new Headers(init?.headers).get("authorization") };
  calls.push(call);
  return route(call, calls.length);
}) as typeof fetch;
const useRoute = (r: (call: Call, n: number) => Response | Promise<Response>) => {
  calls.length = 0;
  route = r;
};
const endRoute = () => {
  route = null;
};

const vec = (t: string) => [Array.from(t).reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)];
const vecs = (xs: string[]) => xs.map(vec);
const ok200 = (inputs: string[], promptTokens?: number) =>
  new Response(
    JSON.stringify({
      data: inputs.map((t, index) => ({ index, embedding: vec(t) })).reverse(),
      ...(promptTokens === undefined ? {} : { usage: { prompt_tokens: promptTokens } }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const errRes = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

const mkProvider = (extra: Partial<ConstructorParameters<typeof VLLMProvider>[0]> = {}) =>
  new VLLMProvider({
    endpoint: "http://stub.invalid",
    model: "stub/model",
    dimensions: 1,
    maxBatchSize: 3,
    documentInstruction: "DOC: ",
    apiKey: KEY,
    timeoutMs: 5000,
    ...extra,
  });

/**
 * Time moves only through sleep(); each sleep yields a macrotask so workers
 * interleave. `onNextNow` runs a one-shot hook inside the next clock read.
 */
function fakeClock(randoms: number[] = [0.5]) {
  let now = 0;
  let r = 0;
  const sleeps: number[] = [];
  let hook: (() => void) | null = null;
  const clock: RetryClock = {
    nowMs: () => {
      const h = hook;
      hook = null;
      h?.();
      return now;
    },
    sleep: (ms) =>
      new Promise<void>((res) =>
        setImmediate(() => {
          sleeps.push(ms);
          now += ms;
          res();
        }),
      ),
    random: () => randoms[r++ % randoms.length],
  };
  return {
    clock,
    sleeps,
    now: () => now,
    onNextNow: (f: () => void) => {
      hook = f;
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeInner(script: (slice: string[], n: number) => number[][] | Promise<number[][]>) {
  const seen: string[][] = [];
  const p: EmbeddingProvider = {
    name: "fake",
    dimensions: 1,
    embedQuery: async () => {
      throw new Error("unused");
    },
    embedDocument: async () => {
      throw new Error("unused");
    },
    embedDocumentBatch: async (texts) => {
      seen.push([...texts]);
      return script(texts, seen.length);
    },
    getStats: () => ({ calls: seen.length, estimatedTokens: 0, estimatedCostUSD: 0 }),
    resetStats: () => {},
  };
  return { p, seen };
}

const e429 = (retryAfterMs?: number) =>
  Object.assign(new Error("vLLM embed (429): body=parsed type=rate_limit_error"), {
    status: 429,
    nonRetryable: true,
    retryAfterMs,
    providerMeta: { status: 429, body: "parsed" as const, type: "rate_limit_error" },
  });
const POLICY = DEFAULT_RATE_LIMIT_POLICY;
const T7 = ["a", "b", "c", "d", "e", "f", "g"];
const isExhausted = (reason: string, attempts?: number, original?: unknown) => (e: unknown) =>
  e instanceof RateLimitExhausted &&
  e.reason === reason &&
  (attempts === undefined || e.attempts === attempts) &&
  (original === undefined || e.original === original);

// --- runner ------------------------------------------------------------------

const cases: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push([name, fn]);

// --- A. rescheduler (fake inner provider) -------------------------------------

test("A1 slices of the given size; vectors keep input order; empty input makes no call", async () => {
  const { p, seen } = fakeInner((s) => vecs(s));
  const w = withRateLimitRetry(p, 3, POLICY, fakeClock().clock);
  deepStrictEqual(await w.embedDocumentBatch(T7), vecs(T7));
  deepStrictEqual(seen, [["a", "b", "c"], ["d", "e", "f"], ["g"]]);
  deepStrictEqual([w.telemetry.slices, w.telemetry.innerCalls, w.telemetry.resubmissions], [3, 3, 0]);
  deepStrictEqual(await w.embedDocumentBatch([]), []);
  strictEqual(seen.length, 3);
});

test("A2 429 then success: only the failed slice is resubmitted", async () => {
  const { p, seen } = fakeInner((s, n) => {
    if (n === 2) throw e429();
    return vecs(s);
  });
  const fc = fakeClock([0]);
  const w = withRateLimitRetry(p, 3, POLICY, fc.clock);
  deepStrictEqual(await w.embedDocumentBatch(T7), vecs(T7));
  deepStrictEqual(seen, [["a", "b", "c"], ["d", "e", "f"], ["d", "e", "f"], ["g"]]);
  const t = w.telemetry;
  deepStrictEqual(
    [t.slices, t.innerCalls, t.resubmissions, t.resubmittedTexts, t.rateLimited, t.recovered, t.stopped, t.discardedTexts],
    [3, 4, 1, 3, 1, 1, null, 0],
  );
  strictEqual(t.sharedPauseMs, 2500); // attempt 1, random 0: ceiling 5000 / 2
  strictEqual(fc.sleeps.reduce((a, b) => a + b, 0), 2500);
  deepStrictEqual(t.lastRateLimit, { status: 429, body: "parsed", type: "rate_limit_error" });
});

test("A3 non-429 errors pass through on the first attempt, no sleep", async () => {
  const errors: unknown[] = [
    ...[400, 401, 402, 403, 404, 408, 422, 500, 502, 503].map((status) =>
      Object.assign(new Error(`vLLM embed (${status}): body=empty`), { status, nonRetryable: status < 500 }),
    ),
    new Error("vLLM request timeout (30s): http://stub.invalid"),
    new Error("vLLM endpoint unreachable: http://stub.invalid — network error"),
    new TypeError("fetch failed"),
  ];
  for (const boom of errors) {
    const { p, seen } = fakeInner(() => {
      throw boom;
    });
    const fc = fakeClock();
    const w = withRateLimitRetry(p, 3, POLICY, fc.clock);
    await rejects(w.embedDocumentBatch(["a"]), (e) => e === boom);
    deepStrictEqual([seen.length, fc.sleeps.length, w.telemetry.rateLimited, w.telemetry.stopped], [1, 0, 0, null]);
  }
});

test("A4 Retry-After is a floor; the resubmission waits it out", async () => {
  const fc = fakeClock([0]);
  const times: number[] = [];
  const { p } = fakeInner((s, n) => {
    times.push(fc.now());
    if (n === 1) throw e429(7000);
    return vecs(s);
  });
  const w = withRateLimitRetry(p, 3, POLICY, fc.clock);
  deepStrictEqual(await w.embedDocumentBatch(["a"]), vecs(["a"]));
  strictEqual(w.telemetry.sharedPauseMs, 7000);
  deepStrictEqual(times, [0, 7000]);
});

test("A5 Retry-After over the cap: typed exhaustion with the original 429, no sleep; then nothing is submitted", async () => {
  const boom = e429(61_000);
  const { p, seen } = fakeInner(() => {
    throw boom;
  });
  const fc = fakeClock();
  const w = withRateLimitRetry(p, 3, POLICY, fc.clock);
  await rejects(w.embedDocumentBatch(["a"]), (e) => {
    ok(isExhausted("retry-after-over-cap", 1, boom)(e));
    ok(/^rate-limit exhausted \(retry-after-over-cap\) after 1 attempt\(s\): vLLM embed \(429\): /.test((e as Error).message));
    return true;
  });
  deepStrictEqual([seen.length, fc.sleeps.length, w.telemetry.stopped], [1, 0, "retry-after-over-cap"]);
  await rejects(w.embedDocumentBatch(["b", "c"]), (e) => e instanceof RateLimitStop && e.reason === "retry-after-over-cap");
  deepStrictEqual([seen.length, w.telemetry.refusedSlices], [1, 1]);
});

test("A6 backoff bounds; five provider calls per slice on 429, then exhaustion", async () => {
  for (const [attempt, ceil] of [[1, 5000], [2, 10000], [3, 20000], [4, 40000], [5, 60000], [9, 60000]]) {
    strictEqual(rateLimitDelayMs(attempt, POLICY, () => 0), ceil / 2);
    strictEqual(rateLimitDelayMs(attempt, POLICY, () => 1), ceil);
    const mid = rateLimitDelayMs(attempt, POLICY, () => 0.5);
    ok(mid >= ceil / 2 && mid <= ceil);
  }
  strictEqual(rateLimitDelayMs(1, POLICY, () => 0, 9000), 9000);
  strictEqual(rateLimitDelayMs(1, POLICY, () => 0, 7000.2), 7001); // the floor rounds up, never below Retry-After
  strictEqual(rateLimitDelayMs(1, POLICY, () => 0, 3_600_000), 60_000);
  const { p, seen } = fakeInner(() => {
    throw e429();
  });
  const fc = fakeClock([1]);
  const w = withRateLimitRetry(p, 3, POLICY, fc.clock);
  await rejects(w.embedDocumentBatch(["a"]), isExhausted("slice-attempts", 5));
  deepStrictEqual([seen.length, w.telemetry.resubmissions, w.telemetry.sharedPauseMs], [5, 4, 75_000]);
});

test("A7 slice budget: no attempt is scheduled past it", async () => {
  const { p, seen } = fakeInner(() => {
    throw e429();
  });
  const fc = fakeClock([1]); // delays 5000, then 10000
  const w = withRateLimitRetry(p, 3, { ...POLICY, sliceBudgetMs: 12_000 }, fc.clock);
  await rejects(w.embedDocumentBatch(["a"]), isExhausted("slice-budget", 2));
  deepStrictEqual([seen.length, w.telemetry.sharedPauseMs, fc.now()], [2, 5000, 5000]);
});

test("A8 run shared-pause budget; slices already embedded in the failing call are counted as discarded", async () => {
  const failedOnce = new Set<string>();
  const { p, seen } = fakeInner((s) => {
    if (!failedOnce.has(s[0])) {
      failedOnce.add(s[0]);
      throw e429();
    }
    return vecs(s);
  });
  const w = withRateLimitRetry(p, 1, { ...POLICY, runPauseBudgetMs: 12_000 }, fakeClock([1]).clock);
  await rejects(w.embedDocumentBatch(["a", "b", "c"]), isExhausted("run-budget", 1));
  const t = w.telemetry;
  deepStrictEqual([t.sharedPauseMs, t.recovered, t.discardedTexts, t.stopped, seen.length], [10_000, 2, 2, "run-budget", 5]);
});

test("A9 one shared gate: a 429 on one worker holds the other's next slice", async () => {
  const fc = fakeClock([0]);
  const times: Array<[string, number]> = [];
  let a1Failed = false;
  let b1DoneAt = -1;
  const { p } = fakeInner(async (s) => {
    times.push([s[0], fc.now()]);
    if (s[0] === "a1" && !a1Failed) {
      a1Failed = true;
      throw e429(5000);
    }
    if (s[0] === "b1") {
      await new Promise((r) => setImmediate(r)); // still in flight when a1's 429 lands
      b1DoneAt = fc.now();
    }
    return vecs(s);
  });
  const w = withRateLimitRetry(p, 1, POLICY, fc.clock);
  const [ra, rb] = await Promise.all([w.embedDocumentBatch(["a1"]), w.embedDocumentBatch(["b1", "b2"])]);
  deepStrictEqual([ra, rb], [vecs(["a1"]), vecs(["b1", "b2"])]);
  const at = (k: string, nth = 0) => times.filter(([t]) => t === k)[nth][1];
  deepStrictEqual([at("a1"), at("b1"), b1DoneAt], [0, 0, 0]);
  ok(at("b2") >= 5000, `b2 admitted at ${at("b2")} — before the shared pause ended`);
  ok(at("a1", 1) >= 5000);
  strictEqual(w.telemetry.sharedPauseMs, 5000);
  ok(w.telemetry.workerWaitMs >= 5000);
});

test("A10 a permanent error in a later slice: earlier slices counted as discarded, later never sent", async () => {
  const boom = Object.assign(new Error("vLLM embed (401): body=empty"), { status: 401, nonRetryable: true });
  const { p, seen } = fakeInner((s, n) => {
    if (n === 2) throw boom;
    return vecs(s);
  });
  const w = withRateLimitRetry(p, 3, POLICY, fakeClock().clock);
  await rejects(w.embedDocumentBatch(T7), (e) => e === boom);
  deepStrictEqual([seen.length, w.telemetry.discardedTexts, w.telemetry.stopped], [2, 3, null]);
});

test("A11 eligibility: a configured native batch size only, never a guess", () => {
  strictEqual(rateLimitSliceSize(mkProvider({ maxBatchSize: 3 })), 3);
  for (const maxBatchSize of [undefined, Number.NaN, 0, -1, 2.5]) strictEqual(rateLimitSliceSize(mkProvider({ maxBatchSize })), null);
  strictEqual(rateLimitSliceSize(new GeminiProvider({ apiKey: KEY })), null);
  strictEqual(rateLimitSliceSize(fakeInner(() => []).p), null);
  for (const n of [0, -1, 1.5, Number.NaN]) throws(() => withRateLimitRetry(fakeInner(() => []).p, n));
});

test("A12 the namespaced sessions factory: MAX_BATCH_SIZE, else the model preset, else none", () => {
  const base = {
    ANDENKEN_SESSION_PROVIDER: "openrouter",
    ANDENKEN_SESSION_ENDPOINT: "http://stub.invalid",
    ANDENKEN_SESSION_MODEL: "qwen/qwen3-embedding-8b",
    ANDENKEN_SESSION_DIMENSIONS: "4096",
  };
  const make = (extra: Record<string, string>) => {
    for (const k of Object.keys(process.env)) if (k.startsWith("ANDENKEN_SESSION_")) delete process.env[k];
    Object.assign(process.env, base, extra);
    const p = createSessionProviderFromEnv();
    ok(p);
    return p;
  };
  try {
    strictEqual(rateLimitSliceSize(make({ ANDENKEN_SESSION_MAX_BATCH_SIZE: "5" })), 5);
    const preset = getModelPreset("qwen/qwen3-embedding-8b");
    ok(preset);
    strictEqual(rateLimitSliceSize(make({})), preset.maxBatchSize);
    strictEqual(rateLimitSliceSize(make({ ANDENKEN_SESSION_MAX_BATCH_SIZE: "abc" })), null);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("ANDENKEN_SESSION_")) delete process.env[k];
  }
});

// The window these two close: a stop or pause another worker sets AFTER an
// admission check passed but BEFORE the request is entered. A microtask queued
// inside the slice's first clock read lands exactly there when admission awaits
// before the call; with the synchronous re-check the request is entered first
// (in flight) and only later slices see the stop/pause.

test("A13 stop set in the admission await window: no provider call starts while stopped; the in-flight one finishes", async () => {
  const fc = fakeClock();
  const tele = newRateLimitTelemetry();
  const stoppedAtCall: Array<string | null> = [];
  const { p, seen } = fakeInner((s) => {
    stoppedAtCall.push(tele.stopped);
    return vecs(s);
  });
  const w = withRateLimitRetry(p, 1, POLICY, fc.clock, tele);
  fc.onNextNow(() =>
    queueMicrotask(() => {
      tele.stopped = "run-budget";
    }),
  );
  await rejects(w.embedDocumentBatch(["a", "b"]), (e) => e instanceof RateLimitStop && e.reason === "run-budget");
  deepStrictEqual(stoppedAtCall, [null]);
  deepStrictEqual(seen, [["a"]]);
  deepStrictEqual([tele.innerCalls, tele.refusedSlices, tele.discardedTexts], [1, 1, 1]);
});

test("A14 pause set in the admission await window: no provider call starts while paused; later slices wait it out", async () => {
  const fc = fakeClock();
  const gate: SharedGate = { pausedUntil: 0 };
  const pausedAtCall: boolean[] = [];
  const times: number[] = [];
  const { p } = fakeInner((s) => {
    pausedAtCall.push(gate.pausedUntil > fc.now());
    times.push(fc.now());
    return vecs(s);
  });
  const w = withRateLimitRetry(p, 1, POLICY, fc.clock, newRateLimitTelemetry(), gate);
  fc.onNextNow(() =>
    queueMicrotask(() => {
      gate.pausedUntil = 5000;
    }),
  );
  deepStrictEqual(await w.embedDocumentBatch(["a", "b"]), vecs(["a", "b"]));
  deepStrictEqual(pausedAtCall, [false, false]);
  strictEqual(times[0], 0);
  ok(times[1] >= 5000, `b entered at ${times[1]}`);
});

// --- B. transport (VLLMProvider over the fetch stub) -----------------------------

test("B1 HTTP slice size = configured maxBatchSize; instruction once; order kept; only the 429 slice re-requested", async () => {
  const fc = fakeClock([0]);
  const p = mkProvider({ maxBatchSize: 3 });
  const size = rateLimitSliceSize(p);
  strictEqual(size, 3);
  const w = withRateLimitRetry(p, size!, POLICY, fc.clock);
  useRoute((call, n) =>
    n === 2
      ? errRes(429, JSON.stringify({ error: { type: "rate_limit_error", message: TEXT_CANARY } }), { "retry-after": "1" })
      : ok200(call.input, 10),
  );
  const texts = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"];
  const out = await w.embedDocumentBatch(texts);
  endRoute();
  const d = (t: string) => `DOC: ${t}`;
  deepStrictEqual(
    calls.map((c) => c.input),
    [["t0", "t1", "t2"], ["t3", "t4", "t5"], ["t3", "t4", "t5"], ["t6"]].map((s) => s.map(d)),
  );
  ok(calls.every((c) => c.input.every((s) => !s.startsWith("DOC: DOC: "))));
  deepStrictEqual(out, texts.map((t) => vec(d(t))));
  const s = p.getStats();
  deepStrictEqual([s.calls, s.httpAttempts, s.httpOk, s.httpFailed], [4, 4, 3, 1]);
  deepStrictEqual([w.telemetry.slices, w.telemetry.innerCalls, w.telemetry.sharedPauseMs], [3, 4, 2500]);
  ok(calls.every((c) => c.auth === `Bearer ${KEY}`));
});

test("B2 factory provider: HTTP request sizes follow ANDENKEN_SESSION_MAX_BATCH_SIZE", async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith("ANDENKEN_SESSION_")) delete process.env[k];
  Object.assign(process.env, {
    ANDENKEN_SESSION_PROVIDER: "openrouter",
    ANDENKEN_SESSION_ENDPOINT: "http://stub.invalid",
    ANDENKEN_SESSION_MODEL: "qwen/qwen3-embedding-8b",
    ANDENKEN_SESSION_DIMENSIONS: "4096",
    ANDENKEN_SESSION_MAX_BATCH_SIZE: "2",
  });
  try {
    const p = createSessionProviderFromEnv();
    ok(p);
    const w = withRateLimitRetry(p, rateLimitSliceSize(p)!, POLICY, fakeClock().clock);
    useRoute((call) => ok200(call.input));
    const texts = ["u0", "u1", "u2", "u3", "u4"];
    const out = await w.embedDocumentBatch(texts);
    endRoute();
    const instr = getModelPreset("qwen/qwen3-embedding-8b")?.documentInstruction ?? "";
    deepStrictEqual(calls.map((c) => c.input), [["u0", "u1"], ["u2", "u3"], ["u4"]].map((s) => s.map((t) => instr + t)));
    deepStrictEqual(out, texts.map((t) => vec(instr + t)));
    strictEqual(calls[0].auth, null); // no key configured anywhere in this process
  } finally {
    endRoute();
    for (const k of Object.keys(process.env)) if (k.startsWith("ANDENKEN_SESSION_")) delete process.env[k];
  }
});

const leaks = (e: unknown, extra: string[] = []) => {
  const err = e as Error & { providerMeta?: unknown };
  const s = `${err.message}\n${String(err.stack)}\n${JSON.stringify(err.providerMeta ?? null)}`;
  return [TEXT_CANARY, RAW_CANARY, KEY, KEY.slice(0, 8), KEY.slice(-8), INPUT_CANARY, SK_SHAPE, "Bearer", "exceeded", "https", "example.invalid", "stub.invalid", "Authorization", ...extra].filter((c) =>
    s.includes(c),
  );
};

test("B3 429 diagnostics: allowlisted fields only, compat flags kept, no transport retry", async () => {
  const upstream = JSON.stringify({
    error: { type: "rate_limit_error", message: `You exceeded your tokens quota. ${TEXT_CANARY} https://quota.example.invalid/req` },
  });
  const body = JSON.stringify({
    error: { code: 429, message: `HTTP 429: ${upstream}`, metadata: { provider_name: "FakeUpstream", raw: `${RAW_CANARY} Bearer ${KEY}` } },
  });
  useRoute(() => errRes(429, body, { "retry-after": "7" }));
  const p = mkProvider();
  const caught = await p.embedDocumentBatch([INPUT_CANARY]).then(
    () => null,
    (e: unknown) => e as Error & Record<string, unknown>,
  );
  endRoute();
  ok(caught);
  strictEqual(caught.message, "vLLM embed (429): body=parsed code=429 provider=FakeUpstream upstream=429/rate_limit_error retry-after=7000ms");
  deepStrictEqual([caught.status, caught.nonRetryable, caught.retryAfterMs], [429, true, 7000]);
  deepStrictEqual(caught.providerMeta, {
    status: 429,
    retryAfterMs: 7000,
    body: "parsed",
    code: "429",
    providerName: "FakeUpstream",
    upstreamStatus: 429,
    upstreamType: "rate_limit_error",
  });
  deepStrictEqual(leaks(caught), []);
  deepStrictEqual([calls.length, p.getStats().httpAttempts, p.getStats().httpFailed], [1, 1, 1]);
  // Retry-After forms, at a fixed now: delay-seconds, HTTP date, invalid/past.
  const NOW = Date.parse("2026-11-05T08:00:00Z");
  strictEqual(parseRetryAfterMs("7", NOW), 7000);
  strictEqual(parseRetryAfterMs(" 0 ", NOW), 0);
  strictEqual(parseRetryAfterMs("Thu, 05 Nov 2026 08:00:30 GMT", NOW), 30_000);
  strictEqual(parseRetryAfterMs("Thu, 05 Nov 2026 07:59:00 GMT", NOW), undefined);
  strictEqual(parseRetryAfterMs("999999", NOW), 3_600_000);
  for (const bad of [null, "", "soon", "-5", "1.5", "7s"]) strictEqual(parseRetryAfterMs(bad, NOW), undefined, `parsed: ${bad}`);
});

test("B4 the configured key or a credential shape inside an allowlisted field is dropped", async () => {
  const body = JSON.stringify({ error: { type: KEY, code: SK_SHAPE, metadata: { provider_name: `P-${KEY.slice(0, 12)}` } } });
  useRoute(() => errRes(403, body));
  const caught = await mkProvider().embedDocumentBatch(["x"]).then(
    () => null,
    (e: unknown) => e as Error & Record<string, unknown>,
  );
  endRoute();
  ok(caught);
  strictEqual(caught.message, "vLLM embed (403): body=parsed dropped=3");
  deepStrictEqual(caught.providerMeta, { status: 403, body: "parsed", dropped: 3 });
  deepStrictEqual(leaks(caught), []);
  strictEqual(diagnosticToken("rate_limit_error", KEY), "rate_limit_error");
  strictEqual(diagnosticToken(429, KEY), "429");
  strictEqual(diagnosticToken("Nebius AI Studio", KEY), "Nebius AI Studio");
  strictEqual(diagnosticToken(undefined, KEY), undefined);
  for (const bad of [KEY, `x${KEY.slice(3, 11)}`, SK_SHAPE, "Bearer abc", "a".repeat(24), "x".repeat(65), "line\nbreak", "https://a.b/c", "a.b/c?d=e", { a: 1 }, [1], true, Number.NaN]) {
    strictEqual(diagnosticToken(bad, KEY), null, `accepted: ${JSON.stringify(bad)}`);
  }
  // A configured key shorter than 8 characters: the whole key is still refused.
  const SHORT = ["k", "7", "q"].join("");
  strictEqual(diagnosticToken(SHORT, SHORT), null);
  strictEqual(diagnosticToken(`up-${SHORT}-x`, SHORT), null);
  strictEqual(diagnosticToken("rate_limit_error", SHORT), "rate_limit_error");
});

test("B5 bodies: truncated (read ≤4KiB then cancelled), unparsed, empty, read error → state only", async () => {
  let pulled = 0;
  let cancelled = false;
  const big = new ReadableStream<Uint8Array>(
    {
      pull(ctrl) {
        if (pulled >= 1 << 20) {
          ctrl.close();
          return;
        }
        pulled += 1024;
        ctrl.enqueue(new TextEncoder().encode((pulled === 1024 ? `{"error":{"type":"` : "") + TEXT_CANARY.padEnd(1024, "x")).subarray(0, 1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const bodies: Array<[BodyInit | null, string]> = [
    [big, "truncated"],
    [`<html>${TEXT_CANARY}</html>`, "unparsed"],
    [null, "empty"],
    [
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(new Error(RAW_CANARY));
        },
      }),
      "read-error",
    ],
    [JSON.stringify(TEXT_CANARY), "parsed"],
  ];
  for (const [body, state] of bodies) {
    useRoute(() => errRes(400, body));
    const caught = await mkProvider().embedDocumentBatch(["x"]).then(
      () => null,
      (e: unknown) => e as Error & Record<string, unknown>,
    );
    endRoute();
    ok(caught);
    strictEqual(caught.message, `vLLM embed (400): body=${state}`);
    deepStrictEqual(caught.providerMeta, { status: 400, body: state });
    deepStrictEqual(leaks(caught), []);
  }
  await new Promise((r) => setImmediate(r));
  ok(cancelled, "stream not cancelled");
  strictEqual(pulled, 4096, `pulled ${pulled} bytes; the limit is reached after four 1KiB chunks`);
  const pad = (n: number) => {
    const head = `{"error":{"type":"t"},"p":"`;
    return head + "p".repeat(n - head.length - 2) + `"}`;
  };
  strictEqual((await readBoundedBody(new Response(pad(4095)))).state, "complete");
  strictEqual((await readBoundedBody(new Response(pad(4096)))).state, "truncated"); // exactly the limit: conservative
  strictEqual((await readBoundedBody(new Response(pad(4097)))).state, "truncated");
});

test("B5b a body that sends exactly 4096 bytes and then hangs open: no further read, cancelled, truncated", async () => {
  let sent = 0;
  let extraPulls = 0;
  let cancelled = false;
  const hanging = new ReadableStream<Uint8Array>(
    {
      pull(ctrl) {
        if (sent >= 4096) {
          extraPulls += 1;
          return new Promise<void>(() => {}); // never sends, never closes
        }
        sent += 1024;
        ctrl.enqueue(new Uint8Array(1024).fill(0x7b));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const timer = deferred<"hung">();
  const t = setTimeout(() => timer.resolve("hung"), 2000);
  const r = await Promise.race([readBoundedBody(new Response(hanging)), timer.promise]);
  clearTimeout(t);
  ok(r !== "hung", "readBoundedBody waited on a hanging body");
  strictEqual(r.state, "truncated");
  await new Promise((res) => setImmediate(res));
  deepStrictEqual([sent, extraPulls, cancelled], [4096, 0, true]);
});

test("B6 5xx keeps the provider's own transport retries; the rescheduler adds none", async () => {
  useRoute(() => errRes(503, JSON.stringify({ error: { type: "overloaded" } })));
  const p = mkProvider();
  const fc = fakeClock();
  const w = withRateLimitRetry(p, 3, POLICY, fc.clock);
  await rejects(w.embedDocumentBatch(["a"]), (e) => (e as Error).message === "vLLM embed (503): body=parsed type=overloaded");
  endRoute();
  const s = p.getStats();
  deepStrictEqual([calls.length, s.calls, s.httpAttempts, s.httpOk, s.httpFailed], [4, 1, 4, 0, 4]);
  deepStrictEqual([w.telemetry.innerCalls, w.telemetry.rateLimited, fc.sleeps.length], [1, 0, 0]);
});

test("B7 provider-reported usage is kept apart from the estimate; unknown is never shown as 0; reset clears all", async () => {
  const p = mkProvider({ maxBatchSize: 2 });
  let n = 0;
  useRoute((call) => ok200(call.input, ++n === 2 ? undefined : 7));
  await p.embedDocumentBatch(["a", "b", "c", "d", "e"]);
  endRoute();
  const s = p.getStats();
  deepStrictEqual(
    [s.calls, s.httpAttempts, s.httpOk, s.httpFailed, s.reportedPromptTokens, s.okWithUsage, s.okWithoutUsage],
    [3, 3, 3, 0, 14, 2, 1],
  );
  ok(formatApiSummary(s, { kind: "off", why: "t" })[1].endsWith("provider-reported prompt tokens: ≥14 (partial: 2/3 ok responses reported usage)"));
  p.resetStats();
  const r = p.getStats();
  deepStrictEqual(
    [r.calls, r.estimatedTokens, r.httpAttempts, r.httpOk, r.httpFailed, r.reportedPromptTokens, r.okWithUsage, r.okWithoutUsage],
    [0, 0, 0, 0, 0, 0, 0, 0],
  );
  const base: EmbeddingStats = { calls: 1, estimatedTokens: 0, estimatedCostUSD: 0, httpAttempts: 1, httpOk: 1, httpFailed: 0 };
  ok(formatApiSummary({ ...base, reportedPromptTokens: 0, okWithUsage: 0, okWithoutUsage: 1 }, { kind: "off", why: "t" })[1].endsWith("unknown (0/1 ok responses reported usage)"));
  ok(formatApiSummary({ ...base, reportedPromptTokens: 9, okWithUsage: 1, okWithoutUsage: 0 }, { kind: "off", why: "t" })[1].endsWith(": 9 (1/1 ok responses reported usage)"));
  strictEqual(formatApiSummary({ calls: 2, estimatedTokens: 0, estimatedCostUSD: 0 }, { kind: "off", why: "t" }).length, 2); // no HTTP line without transport counters
});

test("B8 summary labels: counters named apart, no unique-request or bill claim", () => {
  const stats: EmbeddingStats = {
    calls: 4,
    estimatedTokens: 12_000,
    estimatedCostUSD: 0.0001,
    httpAttempts: 4,
    httpOk: 3,
    httpFailed: 1,
    reportedPromptTokens: 30,
    okWithUsage: 3,
    okWithoutUsage: 0,
  };
  const telemetry = {
    ...newRateLimitTelemetry(),
    slices: 3,
    innerCalls: 4,
    resubmissions: 1,
    resubmittedTexts: 3,
    rateLimited: 1,
    recovered: 1,
    sharedPauseMs: 2500,
    workerWaitMs: 2500,
    lastRateLimit: { status: 429, body: "parsed" as const, type: "rate_limit_error" },
  };
  const all = formatApiSummary(stats, { kind: "on", telemetry }).join("\n");
  for (const s of [
    "💰 API: 4 provider calls (resubmissions included)",
    "~12K submitted-input tokens (estimate)",
    "actual bill unknown",
    "the shell's preflight probe is not counted",
    "🌐 HTTP: 4 attempts (ok 3, failed 1)",
    "⟳ 429 retry: slices 3 | inner calls 4 (resubmissions 1, 3 texts)",
    "429 seen 1, recovered 1",
    "scheduled shared pause 2.5s, scheduled worker wait 2.5s",
    "stopped: no | refused before a provider call: 0 | discarded embedded texts: 0",
    "last 429: status=429 body=parsed type=rate_limit_error",
  ]) {
    ok(all.includes(s), `missing: ${s}`);
  }
  ok(!/unique|billed/i.test(all));
  ok(formatApiSummary(stats, { kind: "off", why: "not applied to md" }).join("\n").includes("⟳ 429 retry: off — not applied to md"));
});

// --- C. finalization seam (fake deps) -----------------------------------------

function fakeDeps(over: Partial<{ errors: number; run: Error; flush: Error; persist: Error; onSuccess: Error; summary: Error; log: Error; close: Error }> = {}) {
  const order: string[] = [];
  const outcomes: unknown[] = [];
  const deps: FinalizeDeps = {
    label: "Session",
    run: async () => {
      order.push("run");
      if (over.run) throw over.run;
      return { errors: over.errors ?? 0 };
    },
    flush: async () => {
      order.push("flush");
      if (over.flush) throw over.flush;
    },
    persist: () => {
      order.push("persist");
      if (over.persist) throw over.persist;
    },
    onSuccess: async () => {
      order.push("onSuccess");
      if (over.onSuccess) throw over.onSuccess;
    },
    summary: (o) => {
      order.push("summary");
      outcomes.push(o);
      if (over.summary) throw over.summary;
      return ["line"];
    },
    log: () => {
      order.push("log");
      if (over.log) throw over.log;
    },
    close: async () => {
      order.push("close");
      if (over.close) throw over.close;
    },
  };
  return { deps, order, outcomes };
}

test("C1 success: run → flush → persist → onSuccess → summary → close", async () => {
  const { deps, order, outcomes } = fakeDeps();
  await finalizeIndexRun(deps);
  deepStrictEqual(order, ["run", "flush", "persist", "onSuccess", "summary", "log", "close"]);
  deepStrictEqual(outcomes, [{ ok: true, failedFiles: 0, persisted: true }]);
});

test("C2 failed files: completed files persisted, summary printed, closed, run fails with the same message as before", async () => {
  const { deps, order, outcomes } = fakeDeps({ errors: 2 });
  await rejects(finalizeIndexRun(deps), (e) => e instanceof IndexRunFailed && e.failedFiles === 2 && e.message === "Session indexing failed for 2 files");
  deepStrictEqual(order, ["run", "flush", "persist", "summary", "log", "close"]);
  deepStrictEqual(outcomes, [{ ok: false, failedFiles: 2, persisted: true }]);
});

test("C3 flush failure: the manifest is not advanced; the flush error itself is thrown", async () => {
  const boom = new Error("flush failed");
  const { deps, order, outcomes } = fakeDeps({ errors: 1, flush: boom });
  await rejects(finalizeIndexRun(deps), (e) => e === boom);
  deepStrictEqual(order, ["run", "flush", "summary", "log", "close"]);
  deepStrictEqual(outcomes, [{ ok: false, failedFiles: 1, persisted: false }]);
});

test("C4 persist failure: summary and close still run; the persist error is thrown", async () => {
  const boom = new Error("persist failed");
  const { deps, order } = fakeDeps({ persist: boom });
  await rejects(finalizeIndexRun(deps), (e) => e === boom);
  deepStrictEqual(order, ["run", "flush", "persist", "summary", "log", "close"]);
});

test("C5 a run error is never replaced by a summary, log or close failure", async () => {
  {
    const { deps, order } = fakeDeps({ errors: 3, close: new Error("close failed"), summary: new Error("summary failed") });
    await rejects(finalizeIndexRun(deps), (e) => e instanceof IndexRunFailed && e.failedFiles === 3);
    deepStrictEqual(order, ["run", "flush", "persist", "summary", "log", "close"]);
  }
  {
    const { deps, order } = fakeDeps({ errors: 2, log: new Error("log failed") });
    await rejects(finalizeIndexRun(deps), (e) => e instanceof IndexRunFailed && e.failedFiles === 2);
    deepStrictEqual(order, ["run", "flush", "persist", "summary", "log", "log", "close"]);
  }
});

test("C5b a successful run whose summary, log or close fails is closed and fails (non-zero) with that error", async () => {
  {
    const closeErr = new Error("close failed");
    const { deps } = fakeDeps({ close: closeErr });
    await rejects(finalizeIndexRun(deps), (e) => e === closeErr);
  }
  {
    const summaryErr = new Error("summary failed");
    const { deps, order } = fakeDeps({ summary: summaryErr });
    await rejects(finalizeIndexRun(deps), (e) => e === summaryErr);
    deepStrictEqual(order, ["run", "flush", "persist", "onSuccess", "summary", "log", "close"]); // fallback warning, then close
  }
  {
    const logErr = new Error("log failed");
    const { deps, order } = fakeDeps({ log: logErr });
    await rejects(finalizeIndexRun(deps), (e) => e === logErr);
    deepStrictEqual(order, ["run", "flush", "persist", "onSuccess", "summary", "log", "log", "close"]);
  }
  {
    // The summary fails and so does the fallback warning: the summary error stands.
    const summaryErr = new Error("summary failed");
    const { deps, order } = fakeDeps({ summary: summaryErr, log: new Error("log failed") });
    await rejects(finalizeIndexRun(deps), (e) => e === summaryErr);
    deepStrictEqual(order, ["run", "flush", "persist", "onSuccess", "summary", "log", "close"]);
  }
  {
    // The summary fails and close fails too: the summary error stands; close still ran.
    const summaryErr = new Error("summary failed");
    const { deps, order } = fakeDeps({ summary: summaryErr, close: new Error("close failed") });
    await rejects(finalizeIndexRun(deps), (e) => e === summaryErr);
    strictEqual(order[order.length - 1], "close");
  }
});

test("C6 an unexpected run failure: nothing flushed or persisted; summary, close, the same error", async () => {
  const boom = new Error("runner failed");
  const { deps, order } = fakeDeps({ run: boom });
  await rejects(finalizeIndexRun(deps), (e) => e === boom);
  deepStrictEqual(order, ["run", "summary", "log", "close"]);
});

// --- E. candidate builder classification of the new message format (pure) --------

test("E1 candidate-build classifies provider errors in the new format unchanged", async () => {
  const errorFor = async (status: number, body: string, headers: Record<string, string> = {}) => {
    useRoute(() => errRes(status, body, headers));
    try {
      return await mkProvider().embedDocumentBatch(["x"]).then(
        () => null,
        (e: unknown) => e,
      );
    } finally {
      endRoute();
    }
  };
  const wrapped429 = JSON.stringify({
    error: { code: 429, message: `HTTP 429: ${JSON.stringify({ error: { type: "rate_limit_error" } })}`, metadata: { provider_name: "FakeUpstream" } },
  });
  const cases: Array<[number, string, string]> = [
    [429, wrapped429, "rate-limit"],
    [401, JSON.stringify({ error: { code: 401, type: "auth" } }), "permanent"],
    [402, JSON.stringify({ error: { code: 402 } }), "permanent"],
    [403, "", "permanent"],
    [503, JSON.stringify({ error: { type: "overloaded" } }), "server"], // provider transport retries first (~6s)
  ];
  for (const [status, body, cls] of cases) {
    const e = await errorFor(status, body, status === 429 ? { "retry-after": "3" } : {});
    ok(e, `no error for ${status}`);
    strictEqual(providerErrorCode(e), `provider-http-${status}`);
    strictEqual(classifyProviderFailure(e), cls, `class for ${status}`);
    if (status === 429) strictEqual((e as { retryAfterMs?: number }).retryAfterMs, 3000);
  }
});

// --- F. shared stop through the production dispatcher and seam ---------------------

// F1 is the 429-only scope (fake provider, no transport retries); F2 below covers
// what an already-entered call still sends after a stop.
test("F1 shared stop: the in-flight file is flushed then persisted; stopped and unstarted files advance nothing, send nothing; the run fails", async () => {
  const files = ["f1", "f2", "f3", "f4"];
  const chunksOf = (f: string) => [`${f}:0`, `${f}:1`];
  const f1Gate = deferred<number[][]>();
  const { p, seen } = fakeInner((s) => {
    if (s[0].startsWith("f1:")) {
      setImmediate(() => f1Gate.resolve(vecs(s))); // f1 is still in flight when f2's stop lands
      return f1Gate.promise;
    }
    if (s[0].startsWith("f2:")) throw e429(61_000); // over the cap: stop at once
    return vecs(s);
  });
  const w = withRateLimitRetry(p, 2, POLICY, fakeClock().clock);
  // Fake store: rows wait in a buffer until flush; the manifest is a map saved by persist.
  const buffered: string[] = [];
  const stored: string[] = [];
  const manifest: Record<string, number> = {};
  let persisted: string[] | null = null;
  const order: string[] = [];
  const tasks = files.map((f) => async () => {
    const chunks = chunksOf(f);
    const vectors = await w.embedDocumentBatch(chunks);
    buffered.push(...chunks.map((c, j) => `${c}=${vectors[j][0]}`));
    manifest[f] = chunks.length;
  });
  await rejects(
    finalizeIndexRun({
      label: "Session",
      run: () => runWithConcurrency(tasks, 2),
      flush: async () => {
        order.push("flush");
        stored.push(...buffered.splice(0));
      },
      persist: () => {
        order.push("persist");
        persisted = Object.keys(manifest).sort();
      },
      summary: () => [],
      log: () => {},
      close: async () => {
        order.push("close");
      },
    }),
    (e) => e instanceof IndexRunFailed && e.failedFiles === 3 && e.message === "Session indexing failed for 3 files",
  );
  deepStrictEqual(order, ["flush", "persist", "close"]);
  deepStrictEqual(persisted, ["f1"]);
  deepStrictEqual(stored, chunksOf("f1").map((c) => `${c}=${vec(c)[0]}`));
  deepStrictEqual(seen.map((s) => s[0].split(":")[0]), ["f1", "f2"]); // f3, f4: no request
  const t = w.telemetry;
  deepStrictEqual([t.stopped, t.innerCalls, t.refusedSlices, t.rateLimited], ["retry-after-over-cap", 2, 2, 1]);
});

test("F2 transport scope of a stop: no new slice or provider call is admitted, but a call already in flight completes its own 5xx transport retry — a new HTTP request after the stop", async () => {
  const p = mkProvider({ maxBatchSize: 2 });
  const tele = newRateLimitTelemetry();
  const w = withRateLimitRetry(p, 2, POLICY, fakeClock().clock, tele);
  const fetches: Array<[string, string | null]> = [];
  let b503 = false;
  useRoute((call) => {
    const file = call.input[0].replace(/^DOC: /, "").split(":")[0];
    fetches.push([file, tele.stopped]);
    if (file === "A") return errRes(429, JSON.stringify({ error: { type: "rate_limit_error" } }), { "retry-after": "61" });
    if (file === "B" && !b503) {
      b503 = true;
      return errRes(503, JSON.stringify({ error: { type: "overloaded" } })); // provider retries after ~1s
    }
    return ok200(call.input);
  });
  const chunksOf = (f: string) => [`${f}:0`, `${f}:1`];
  const buffered: string[] = [];
  const stored: string[] = [];
  const manifest: Record<string, number> = {};
  let persisted: string[] | null = null;
  const order: string[] = [];
  const tasks = ["B", "A", "C"].map((f) => async () => {
    const chunks = chunksOf(f);
    const vectors = await w.embedDocumentBatch(chunks);
    buffered.push(...chunks.map((c, j) => `${c}=${vectors[j][0]}`));
    manifest[f] = chunks.length;
  });
  try {
    await rejects(
      finalizeIndexRun({
        label: "Session",
        run: () => runWithConcurrency(tasks, 2),
        flush: async () => {
          order.push("flush");
          stored.push(...buffered.splice(0));
        },
        persist: () => {
          order.push("persist");
          persisted = Object.keys(manifest).sort();
        },
        summary: () => [],
        log: () => {},
        close: async () => {
          order.push("close");
        },
      }),
      (e) => e instanceof IndexRunFailed && e.failedFiles === 2,
    );
  } finally {
    endRoute();
  }
  // B entered before the stop; its transport retry sent a new request after it. C was never admitted.
  deepStrictEqual(fetches, [["B", null], ["A", null], ["B", "retry-after-over-cap"]]);
  deepStrictEqual(order, ["flush", "persist", "close"]);
  deepStrictEqual(persisted, ["B"]);
  deepStrictEqual(stored, chunksOf("B").map((c) => `${c}=${vec(`DOC: ${c}`)[0]}`));
  const s = p.getStats();
  deepStrictEqual([calls.length, s.httpAttempts, s.httpOk, s.httpFailed, s.calls], [3, 3, 1, 2, 2]);
  deepStrictEqual([tele.innerCalls, tele.refusedSlices, tele.stopped], [2, 1, "retry-after-over-cap"]);
  ok(calls.length > tele.innerCalls, "HTTP requests exceed provider calls: the stop does not cap the wire");
});

// --- D. wiring (source read, not executed) ---------------------------------------

test("D1 indexer.ts: sessions wraps with the rescheduler and finalizes; md finalizes only; no one else uses it", () => {
  const src = fs.readFileSync(path.join(REPO, "indexer.ts"), "utf8");
  const fn = (name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    ok(start >= 0, name);
    const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
    return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
  };
  const sess = fn("indexSessions");
  for (const s of ["rateLimitSliceSize(provider)", "withRateLimitRetry(provider, sliceSize)", "(embedder ?? provider).embedDocumentBatch(", "finalizeIndexRun({"]) {
    ok(sess.includes(s), `indexSessions lacks ${s}`);
  }
  ok(!sess.includes("throw new Error(`Session indexing failed"));
  const md = fn("indexMd");
  ok(md.includes("finalizeIndexRun({") && !md.includes("withRateLimitRetry") && !md.includes("throw new Error(`MD indexing failed"));
  strictEqual(src.split("withRateLimitRetry(").length - 1, 1);
  for (const f of ["scripts/candidate-build.ts", "durable-index.ts", "cli.ts", "index.ts", "md-search.ts"]) {
    ok(!fs.readFileSync(path.join(REPO, f), "utf8").includes("embed-retry"), `${f} imports embed-retry`);
  }
});

// --- run ---------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } finally {
    endRoute();
  }
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
