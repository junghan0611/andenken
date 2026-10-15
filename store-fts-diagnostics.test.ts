#!/usr/bin/env tsx
/**
 * Full-text (BM25) leg diagnostics (issue #16): `fullTextSearch` keeps returning
 * rows, and an optional observer learns once per call whether 0 rows means
 * "nothing matched" or "the leg did not work".
 *
 * API 0, network 0. Synthetic temp LanceDB tables with fixed 4d vectors, pure
 * mocks for native failures and broken rows, and one `cli.ts search-sessions
 * --mode recent` child (no embedding call) against a synthetic store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { VectorStore, StoreRowDecodeError } from "./store.ts";
import { FtsDiagnosticsCollector, attachFtsReport, ftsNote, ftsRequestReport, type FtsDiagnostic } from "./fts-diagnostics.ts";
import { searchMdCore } from "./md-search.ts";

let passed = 0;
let failed = 0;
function eq<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  }
}
function truthy(actual: unknown, msg: string): void {
  if (actual) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg} (got ${JSON.stringify(actual)})`);
  }
}

const repo = import.meta.dirname;
const TSX = path.join(repo, "node_modules", ".bin", "tsx");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-fts-diag-"));
fs.chmodSync(tmp, 0o700);

const row = (id: string, text: string, vector: number[]) => ({
  id, text, vector, sessionFile: "/synthetic/a.jsonl", project: "synthetic",
  lineNumber: 1, timestamp: "2026-10-15T00:00:00Z", role: "user", source: "pi", metadata: {},
});
async function syntheticStore(name: string, withFts: boolean): Promise<VectorStore> {
  const store = new VectorStore(path.join(tmp, name, "sessions.lance"), 4);
  await store.ensureTable();
  await store.addChunks([
    row("a", "zebra crossing synthetic alpha", [1, 0, 0, 0]),
    row("b", "quantum lattice synthetic beta", [0, 1, 0, 0]),
    row("c", "harbor lighthouse synthetic gamma", [0, 0, 1, 0]),
  ]);
  if (withFts) await store.createFtsIndex();
  return store;
}
function record(): { seen: FtsDiagnostic[]; observe: (d: FtsDiagnostic) => void } {
  const seen: FtsDiagnostic[] = [];
  return { seen, observe: (d) => seen.push(d) };
}
/** Capture stderr writes of this process for the duration of `fn`. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    buf += String(s);
    return true;
  };
  try {
    return { value: await fn(), stderr: buf };
  } catch (error) {
    return { error, stderr: buf };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}
/** A stand-in for the native table: only what fullTextSearch touches. */
function fakeTable(opts: { queryThrows?: boolean; rows?: Record<string, unknown>[]; indices?: unknown[] | "throw" }) {
  const chain = {
    fullTextSearch() { return chain; },
    where() { return chain; },
    select() { return chain; },
    limit() { return chain; },
    async toArray() { return opts.rows ?? []; },
  };
  return {
    query() {
      if (opts.queryThrows) throw new Error("NATIVE-SECRET detail at /home/someone/private/path");
      return chain;
    },
    async listIndices() {
      if (opts.indices === "throw") throw new Error("NATIVE-SECRET listIndices");
      return opts.indices ?? [];
    },
  };
}
async function storeWith(table: unknown): Promise<VectorStore> {
  const store = new VectorStore(path.join(tmp, `fake-${Math.random().toString(36).slice(2)}`, "sessions.lance"), 4);
  await store.init();
  (store as unknown as { table: unknown }).table = table;
  return store;
}
const SECRET = /NATIVE-SECRET|\/home\/someone|private row text|not json|lighthouse/;

const prevUmask = process.umask(0o077);
try {
  console.log("\n# real synthetic tables (LanceDB 0.40)");
  {
    const empty = new VectorStore(path.join(tmp, "empty", "sessions.lance"), 4);
    await empty.init();
    const r = record();
    eq([await empty.fullTextSearch("anything", 5, undefined, r.observe), r.seen], [[], [{ status: "unavailable", code: "no-table" }]], "a store without a table: [] and unavailable/no-table, reported once");
    await empty.close();

    const noIdx = await syntheticStore("no-fts", false);
    const r2 = record();
    const rows2 = await noIdx.fullTextSearch("lighthouse", 5, undefined, r2.observe);
    eq([rows2, r2.seen], [[], [{ status: "unavailable", code: "no-fts-index" }]], "rows but no FTS index (0.40 refuses the query): [] and unavailable/no-fts-index, reported once");
    await noIdx.close();

    const store = await syntheticStore("with-fts", true);
    const hit = record();
    const rows = await store.fullTextSearch("lighthouse", 5, undefined, hit.observe);
    eq([rows.map((x) => x.id), hit.seen], [["c"], [{ status: "ok" }]], "an indexed match: rows and ok");
    truthy(rows.length === 1 && typeof rows[0].score === "number" && rows[0].score > 0 && rows[0].score !== 1, "the FTS score is the projected `_score`, not the rank fallback 1/(i+1)");
    const miss = record();
    eq([await store.fullTextSearch("nonexistentterm", 5, undefined, miss.observe), miss.seen], [[], [{ status: "ok" }]], "no match on a healthy leg: [] and ok — distinguishable from a failure");
    const v = await store.search([0, 0, 1, 0], 3, 0);
    eq([v[0]?.id, v[0]?.score], ["c", 1], "vector search projects `_distance` explicitly: exact match scores 1");
    const filtered = record();
    eq((await store.fullTextSearch("synthetic", 5, "claude", filtered.observe)).length, 0, "a source filter is still pushed down with the explicit projection");
    eq(filtered.seen, [{ status: "ok" }], "…and a filtered-out query is ok, not an error");
    await store.close();
  }

  console.log("\n# injected native failures (mock table)");
  {
    const s = await storeWith(fakeTable({ queryThrows: true, indices: [{ name: "text_idx", indexType: "FTS", columns: ["text"] }] }));
    const r = record();
    eq([await s.fullTextSearch("q", 5, undefined, r.observe), r.seen], [[], [{ status: "error", code: "query-failed" }]], "native failure with an FTS index present: error/query-failed");
    const s2 = await storeWith(fakeTable({ queryThrows: true, indices: [] }));
    const r2 = record();
    await s2.fullTextSearch("q", 5, undefined, r2.observe);
    eq(r2.seen, [{ status: "unavailable", code: "no-fts-index" }], "native failure and no FTS index listed: unavailable/no-fts-index");
    const s3 = await storeWith(fakeTable({ queryThrows: true, indices: "throw" }));
    const r3 = record();
    await s3.fullTextSearch("q", 5, undefined, r3.observe);
    eq(r3.seen, [{ status: "error", code: "query-failed" }], "native failure and unreadable index list: error/query-failed");

    const legacy = await captureStderr(() => s.fullTextSearch("the private query words", 5));
    eq(legacy.value, [], "no observer: the legacy array result is still []");
    eq(legacy.stderr.trim().split("\n").length, 1, "no observer: exactly one stderr line");
    truthy(legacy.stderr.includes("query-failed") && !SECRET.test(legacy.stderr) && !legacy.stderr.includes("private query"), "…carrying the fixed code only: no native message, path or query");
    const withObserver = await captureStderr(() => s.fullTextSearch("q", 5, undefined, () => {}));
    eq(withObserver.stderr, "", "with an observer nothing is written to stderr");
  }

  console.log("\n# a broken stored row is an error, not an empty result");
  {
    const bad = { id: "x", text: "private row text", sessionFile: "/s", project: "p", lineNumber: 1, timestamp: "t", role: "user", source: "pi", metadata: "{not json" };
    const s = await storeWith(fakeTable({ rows: [bad] }));
    const r = record();
    const out = await captureStderr(() => s.fullTextSearch("q", 5, undefined, r.observe));
    truthy(out.error instanceof StoreRowDecodeError, "row-decode-failed throws StoreRowDecodeError (observer present)");
    eq(r.seen, [{ status: "error", code: "row-decode-failed" }], "…after reporting error/row-decode-failed exactly once");
    const msg = out.error instanceof Error ? `${out.error.message} ${String((out.error as { cause?: unknown }).cause ?? "")}` : "";
    truthy(!SECRET.test(msg) && (out.error as { cause?: unknown }).cause === undefined, "…with a fixed message: no parser message, cause or row text");
    const noObs = await captureStderr(() => s.fullTextSearch("q", 5));
    truthy(noObs.error instanceof StoreRowDecodeError && noObs.stderr === "", "without an observer it throws the same typed error and writes no stderr line");

    const vs = await storeWith({ vectorSearch() { return { select() { return this; }, where() { return this; }, limit() { return this; }, async toArray() { return [{ ...bad, _distance: 0 }]; } }; } });
    const vOut = await captureStderr(() => vs.search([0, 0, 0, 1], 3, 0));
    truthy(vOut.error instanceof StoreRowDecodeError && !SECRET.test((vOut.error as Error).message), "vector search on a broken row throws the same safe typed error (no raw JSON.parse text)");
  }

  console.log("\n# the observer runs outside every catch");
  {
    const store = await syntheticStore("observer-throw", true);
    const boom = new Error("observer boom");
    let calls = 0;
    const out = await captureStderr(() => store.fullTextSearch("lighthouse", 5, undefined, () => {
      calls++;
      throw boom;
    }));
    truthy(out.error === boom && calls === 1, "an observer throw on ok propagates as itself, called once");
    const s = await storeWith(fakeTable({ queryThrows: true, indices: [] }));
    let calls2 = 0;
    const out2 = await captureStderr(() => s.fullTextSearch("q", 5, undefined, () => {
      calls2++;
      throw boom;
    }));
    truthy(out2.error === boom && calls2 === 1 && out2.stderr === "", "an observer throw on a native failure is not reclassified or warned about");
    await store.close();
  }

  console.log("\n# request-local collector");
  {
    const c = new FtsDiagnosticsCollector();
    eq([c.result(), c.degraded], [{ status: "not-run" }, false], "nothing observed: not-run, not degraded (never certified ok)");
    c.observe({ status: "ok" });
    c.observe({ status: "error", code: "query-failed" });
    c.observe({ status: "ok" });
    eq([c.result(), c.degraded], [{ status: "error", code: "query-failed" }, true], "a later ok never masks an earlier error");
    const u = new FtsDiagnosticsCollector();
    u.observe({ status: "unavailable", code: "no-fts-index" });
    u.observe({ status: "error", code: "query-failed" });
    eq(u.result(), { status: "error", code: "query-failed" }, "error outranks unavailable");
    eq(new FtsDiagnosticsCollector().result(), { status: "not-run" }, "a new collector starts clean: no state leaks between requests");
    eq([ftsNote({ status: "ok" }, "sessions"), ftsNote({ status: "not-run" }, "sessions")], [null, null], "ok and not-run produce no note");
    eq(ftsNote({ status: "unavailable", code: "no-fts-index" }, "sessions"), "sessions full-text (BM25) leg unavailable: no-fts-index; results come from the other legs only", "a degraded leg produces one fixed-vocabulary note");
  }

  console.log("\n# consumers carry the outcome (API 0)");
  {
    const provider = { dimensions: 4, async embedQuery() { return [0, 0, 1, 0]; } };
    const degradedStore = {
      async search() { return []; },
      async substringSearch() { return []; },
      async fullTextSearch(_q: string, _n: number, _f: unknown, onDiagnostic?: (d: FtsDiagnostic) => void) {
        onDiagnostic?.({ status: "unavailable", code: "no-fts-index" });
        return [];
      },
    };
    const out = await searchMdCore(degradedStore as never, provider as never, "query", 5, { expand: false });
    eq(out.fts, { status: "unavailable", code: "no-fts-index" }, "searchMdCore returns the request's FTS outcome");
    const legacyMock = { async search() { return []; }, async substringSearch() { return []; }, async fullTextSearch() { return []; } };
    const out2 = await searchMdCore(legacyMock as never, provider as never, "query", 5, { expand: false });
    eq([out2.results, out2.fts], [[], { status: "not-run" }], "a legacy 3-arg mock still works; with no report the outcome is not-run, not ok");

    const okStore = { ...legacyMock, async fullTextSearch(_q: string, _n: number, _f: unknown, cb?: (d: FtsDiagnostic) => void) { cb?.({ status: "ok" }); return []; } };
    const out3 = await searchMdCore(okStore as never, provider as never, "query", 5, { expand: false });
    eq([out3.fts, ftsRequestReport(out3.fts).degraded], [{ status: "ok" }, false], "a healthy md core reports ok and is not degraded");

    // The fields a request emits (CLI JSON top level, pi details) come from one helper.
    const ok = { status: "ok" } as const;
    const unavailable = { status: "unavailable", code: "no-fts-index" } as const;
    const error = { status: "error", code: "query-failed" } as const;
    const cliJson = (fallback: boolean, fts: FtsDiagnostic, fallbackFts?: FtsDiagnostic) =>
      JSON.parse(JSON.stringify({ query: "q", fallback, diagnostic: undefined, ...ftsRequestReport(fts, fallbackFts), count: 0, results: [] }));
    eq(cliJson(false, ok, unavailable), { query: "q", fallback: false, degraded: true, diagnostics: { fts: ok, fallbackFts: unavailable }, count: 0, results: [] }, "sessions ok + md fallback unavailable → degraded true; fallback keeps its own meaning (false: no md rows merged)");
    eq(cliJson(true, ok, error), { query: "q", fallback: true, degraded: true, diagnostics: { fts: ok, fallbackFts: error }, count: 0, results: [] }, "sessions ok + md fallback error → degraded true, fallback true stays true");
    eq(cliJson(true, ok, ok), { query: "q", fallback: true, degraded: false, diagnostics: { fts: ok, fallbackFts: ok }, count: 0, results: [] }, "both legs ok with md rows merged → not degraded, fallback true");
    eq(cliJson(false, ok), { query: "q", fallback: false, degraded: false, diagnostics: { fts: ok }, count: 0, results: [] }, "no md call → fallbackFts is omitted, not null");
    eq(cliJson(false, error), { query: "q", fallback: false, degraded: true, diagnostics: { fts: error }, count: 0, results: [] }, "a degraded sessions leg alone → degraded true");
    eq(ftsRequestReport({ status: "not-run" }).degraded, false, "not-run (mode=recent) is not degraded");

    // pi shape: the note goes on the model text, the report into details.
    const piOut = () => ({ content: [{ type: "text" as const, text: "## 1. hit" }], details: { query: "q", resultCount: 1 } as Record<string, unknown> });
    const pi1 = piOut();
    attachFtsReport(pi1, ftsRequestReport(ok, unavailable), { fts: "sessions", fallbackFts: "knowledge fallback" });
    eq(
      [pi1.content[0].text, pi1.details],
      ["## 1. hit\n\n(⚠ knowledge fallback full-text (BM25) leg unavailable: no-fts-index; results come from the other legs only)", { query: "q", resultCount: 1, degraded: true, diagnostics: { fts: ok, fallbackFts: unavailable } }],
      "pi: only the degraded fallback leg is noted; details carry degraded true and both outcomes",
    );
    const pi2 = piOut();
    attachFtsReport(pi2, ftsRequestReport(ok), { fts: "sessions", fallbackFts: "knowledge fallback" });
    eq([pi2.content[0].text, pi2.details], ["## 1. hit", { query: "q", resultCount: 1, degraded: false, diagnostics: { fts: ok } }], "pi: a healthy request leaves the text untouched");
    const pi3 = piOut();
    attachFtsReport(pi3, ftsRequestReport(error), { fts: "knowledge" });
    eq(pi3.content[0].text, "## 1. hit\n\n(⚠ knowledge full-text (BM25) leg error: query-failed; results come from the other legs only)", "pi knowledge_search: one fixed-vocabulary note");

    // CLI: --mode recent never runs FTS. Synthetic store, isolated HOME, no embedding call.
    await (await syntheticStore("cli", true)).close();
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const cli = spawnSync(TSX, [path.join(repo, "cli.ts"), "search-sessions", "anything", "--mode", "recent", "--project", "synthetic", "--limit", "2"], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        ANDENKEN_DATA: path.join(tmp, "cli"),
        ANDENKEN_SESSION_PROVIDER: "vllm",
        ANDENKEN_SESSION_ENDPOINT: "http://127.0.0.1:9",
        ANDENKEN_SESSION_MODEL: "stub-model",
        ANDENKEN_SESSION_DIMENSIONS: "4",
        ANDENKEN_DISABLE_RECALL_TRACKING: "1",
      },
    });
    let json: { degraded?: boolean; diagnostics?: { fts?: unknown }; count?: number } = {};
    try {
      json = JSON.parse(cli.stdout);
    } catch {
      json = {};
    }
    eq([cli.status, json.degraded, json.diagnostics?.fts, json.count], [0, false, { status: "not-run" }, 2], "cli search-sessions --mode recent: one JSON document, fts not-run, not degraded");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.umask(prevUmask);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
