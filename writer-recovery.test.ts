/**
 * writer-recovery.test.ts — SYNTHETIC invariants (API 0, no LanceDB) for the
 * sessions writer's crash recovery and delete-error contract.
 *
 * Invariants:
 *   R  missing-rows rediscovery: a file whose manifest entry claims rows
 *      (chunks > 0) but has no rows in the DB is re-extracted by the next
 *      incremental run, whatever its mtime/size.
 *   T  the indexed set that feeds R is read strictly
 *      (VectorStore.getIndexedFilesStrict): empty means no table or no rows,
 *      a failed or short read rejects, and so does a table whose countRows
 *      moved during the read — so R never fires on a failed query.
 *   D  delete errors surface: VectorStore.deleteByFile rejects when the table
 *      delete fails, so WriteBuffer buffers nothing and no duplicate can land.
 *   P  source pins: every getStaleFiles caller reads strictly (org status
 *      catches its read error, see O); manifest chunks is the sent count;
 *      status/estimate show missing rows; candidate resume ends partial on a
 *      rejected discard.
 *   O  org status on an indexed-read error: the dependent numbers are null
 *      (unknown) and getStaleFiles is skipped — never 0, never a missing-rows
 *      count from an empty set; sessions status keeps failing whole.
 *   G  whole-store loss (R10) meets freshPaidRefusal before any write.
 *   B  sync-sessions keeps status stderr and stops by name on a status failure.
 *   M  the md replica check: a failed global status warns and the md verify
 *      still runs and decides the exit code. The remote command leaf is cut
 *      from the script source and run with a fake ./run.sh in a temp dir —
 *      never ssh, rsync or the real run.sh.
 *
 * Discovery is exercised through the real getStaleFiles (indexer.ts, import is
 * side-effect free) against real temp files for stat. The store is never
 * opened: VectorStore gets a stub table object. Crash states are produced with
 * the real WriteBuffer + finalizeIndexRun over an in-memory fake store.
 *
 * Named limits (L*) assert what the contract does NOT cover, so a reader sees
 * the boundary instead of assuming it.
 *
 *   node node_modules/tsx/dist/cli.mjs writer-recovery.test.ts
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WriteBuffer, type BufferedRecord } from "./write-buffer.ts";
import { finalizeIndexRun } from "./index-finalize.ts";
import { spawnSync } from "node:child_process";

type Entry = { mtimeMs: number; size: number; chunks: number };
type Manifest = { files: Record<string, Entry>; lastUpdated: string };
type Stale = (files: string[], indexed: Set<string>, manifest: Manifest) => { newFiles: string[]; staleFiles: string[]; missingRowFiles?: string[] };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "andk-writer-recovery-"));
// Isolate before the modules load: no real HOME, no real data dir.
const FAKE_HOME = path.join(TMP, "home");
const FAKE_DATA = path.join(TMP, "data");
fs.mkdirSync(FAKE_HOME);
fs.mkdirSync(FAKE_DATA);
process.env.HOME = FAKE_HOME;
process.env.ANDENKEN_DATA = FAKE_DATA;
const { VectorStore } = await import("./store.ts");
const indexer = await import("./indexer.ts");
const getStaleFiles = (indexer as unknown as { getStaleFiles?: Stale }).getStaleFiles;
let n = 0;
function file(content = "x\n"): string {
  const f = path.join(TMP, `s${++n}.jsonl`);
  fs.writeFileSync(f, content);
  return f;
}
const entryOf = (f: string, chunks: number): Entry => {
  const st = fs.statSync(f);
  return { mtimeMs: st.mtimeMs, size: st.size, chunks };
};
// A sentinel file that is indexed and unchanged keeps the indexed set non-empty
// (see R10), so a case decides on its own files only. It never appears in a result.
let SENTINEL = "";
const classify = (files: string[], indexed: string[], entries: Record<string, Entry>, opts: { sentinel?: boolean } = {}) => {
  ok(typeof getStaleFiles === "function", "getStaleFiles is exported from indexer.ts");
  const useSentinel = opts.sentinel ?? true;
  if (useSentinel && !SENTINEL) SENTINEL = file("sentinel\n");
  const fs_ = useSentinel ? [...files, SENTINEL] : files;
  const ix = useSentinel ? [...indexed, SENTINEL] : indexed;
  const en = useSentinel ? { ...entries, [SENTINEL]: entryOf(SENTINEL, 1) } : entries;
  return getStaleFiles!(fs_, new Set(ix), { files: en, lastUpdated: "" });
};

class FakeStore {
  rows: BufferedRecord[] = [];
  failAddOn = new Set<number>();
  deleteRejects = false;
  deletes = 0;
  private adds = 0;
  async deleteByFile(f: string): Promise<void> {
    this.deletes++;
    if (this.deleteRejects) throw new Error("fake delete failure");
    this.rows = this.rows.filter((r) => r.sessionFile !== f);
  }
  async addChunksRaw(c: BufferedRecord[]): Promise<void> {
    this.adds++;
    if (this.failAddOn.has(this.adds)) throw new Error(`fake add failure #${this.adds}`);
    this.rows.push(...c);
  }
  indexed(): string[] {
    return [...new Set(this.rows.map((r) => r.sessionFile))];
  }
}
const recs = (f: string, k: number, tag = "v"): BufferedRecord[] =>
  Array.from({ length: k }, (_, i) => ({
    id: `${f}:${i + 1}`, text: `${tag}-${i}`, vector: [0], sessionFile: f, project: "p",
    lineNumber: i + 1, timestamp: "", role: "user", metadata: { type: "user_message" },
  }));

const cases: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push([name, fn]);

// --- R. rediscovery -----------------------------------------------------------------

test("R1 missing-rows: entry chunks>0, not in DB, stat unchanged → stale", () => {
  const f = file();
  const r = classify([f], [], { [f]: entryOf(f, 3) });
  deepStrictEqual([r.newFiles, r.staleFiles], [[], [f]]);
});

test("R2 crash after delete, before flush (unchanged file reprocessed) → rediscovered", async () => {
  const f = file();
  const s = new FakeStore();
  s.rows.push(...recs(f, 2, "old"));
  const persisted = { [f]: entryOf(f, 2) };
  const wb = new WriteBuffer(s, 100);
  await wb.add(recs(f, 2, "new")); // delete committed, rows buffered; process dies here
  strictEqual(s.indexed().length, 0);
  deepStrictEqual(classify([f], s.indexed(), persisted).staleFiles, [f]);
});

test("R3 final flush failure → persist skipped → rediscovered", async () => {
  const f = file();
  const s = new FakeStore();
  s.rows.push(...recs(f, 2, "old"));
  s.failAddOn.add(1);
  let persisted: Record<string, Entry> = { [f]: entryOf(f, 2) };
  const mem = { ...persisted };
  const wb = new WriteBuffer(s, 100);
  await rejects(finalizeIndexRun({
    label: "Session",
    run: async () => { await wb.add(recs(f, 2, "new")); mem[f] = entryOf(f, 2); return { errors: 0 }; },
    flush: () => wb.flush(),
    persist: () => { persisted = { ...mem }; },
    summary: () => [], log: () => {}, close: async () => {},
  }), /fake add failure/);
  deepStrictEqual(classify([f], s.indexed(), persisted).staleFiles, [f]);
});

test("R4 persisted entry already advanced (flush/persist interleaving) while rows absent → rediscovered", () => {
  const f = file();
  // State only: the schedule that produces it is an entry set after the flush
  // and before persist; its likelihood is not measured here.
  deepStrictEqual(classify([f], [], { [f]: entryOf(f, 4) }).staleFiles, [f]);
});

test("R5 shared-batch failure, final flush succeeds: failed task's file is in DB without entry → ghost (stale)", async () => {
  const f = file(), g = file("yy\n");
  const s = new FakeStore();
  s.failAddOn.add(1);
  const wb = new WriteBuffer(s, 4);
  const mem: Record<string, Entry> = {};
  await wb.add(recs(f, 3));
  mem[f] = entryOf(f, 3);
  await rejects(wb.add(recs(g, 3)), /fake add failure/);
  await wb.flush();
  const r = classify([f, g], s.indexed(), mem);
  deepStrictEqual([r.newFiles, r.staleFiles], [[], [g]]);
});

test("R6 empty extraction persisted (chunks 0, no rows) → not stale (no reprocessing loop)", () => {
  const f = file();
  const r = classify([f], [], { [f]: entryOf(f, 0) });
  deepStrictEqual([r.newFiles, r.staleFiles], [[], []]);
});

test("R7 regression: indexed + unchanged entry → not stale; changed mtime → stale; no entry → new", () => {
  const a = file(), b = file(), c = file();
  const old = entryOf(b, 2);
  const r = classify([a, b, c], [a, b], { [a]: entryOf(a, 2), [b]: { ...old, mtimeMs: old.mtimeMs - 1000 } });
  deepStrictEqual([r.newFiles, r.staleFiles], [[c], [b]]);
});

test("R8 not in DB, entry chunks 0, but file changed → stale (unchanged rule)", () => {
  const f = file();
  const e = entryOf(f, 0);
  deepStrictEqual(classify([f], [], { [f]: { ...e, size: e.size + 1 } }).staleFiles, [f]);
});

test("R9 only a valid count claims rows: chunks must be a finite integer > 0", () => {
  const files = [file(), file(), file(), file()];
  const base = (f: string) => entryOf(f, 0) as unknown as Record<string, unknown>;
  const entries = {
    [files[0]]: { ...base(files[0]), chunks: "3" },
    [files[1]]: { ...base(files[1]), chunks: Number.NaN },
    [files[2]]: { ...base(files[2]), chunks: 1.5 },
    [files[3]]: { ...base(files[3]), chunks: -2 },
  } as unknown as Record<string, Entry>;
  // something else must be indexed so the guard (R10) does not decide this case
  const other = file();
  deepStrictEqual(classify([...files, other], [other], { ...entries, [other]: entryOf(other, 1) }).staleFiles, []);
});

test("R10 a DB with no rows at all: every file whose entry claims rows is rediscovered (whole-store loss)", () => {
  // Valid only because `indexed` comes from getIndexedFilesStrict (M1): an empty
  // set there means no rows, not a failed query.
  const a = file(), b = file(), c = file();
  const r = classify([a, b, c], [], { [a]: entryOf(a, 3), [b]: entryOf(b, 0), [c]: entryOf(c, 1) }, { sentinel: false });
  deepStrictEqual([r.newFiles, r.staleFiles, r.missingRowFiles], [[], [a, c], [a, c]]);
});

test("R13 a file discovered and then deleted before classification is skipped, not listed (no permanent failure)", () => {
  const f = file();
  const e = entryOf(f, 4);
  fs.rmSync(f);
  const r = classify([f], [], { [f]: e });
  deepStrictEqual([r.newFiles, r.staleFiles, r.missingRowFiles], [[], [], []]);
});

// --- T. strict indexed-files source (store) ---------------------------------------------

type FakeTable = { countRows?: () => Promise<number>; query?: () => unknown };
function storeWith(table: FakeTable | null) {
  const s = new VectorStore(path.join(TMP, `never-opened-${++n}.lance`), 1024);
  const any = s as unknown as { table: unknown; ensureInitialized: () => Promise<void> };
  any.table = table;
  any.ensureInitialized = async () => {}; // never connect
  return s;
}
const rowsQuery = (rows: Array<{ sessionFile: string }>, onQuery?: () => void) => () => {
  onQuery?.();
  const q = { select: () => q, limit: () => q, toArray: async () => rows };
  return q;
};

test("T1 strict: countRows failure rejects", async () => {
  const s = storeWith({ countRows: async () => { throw new Error("count failed"); } });
  await rejects(s.getIndexedFilesStrict(), /count failed/);
});

test("T2 strict: query failure rejects", async () => {
  const s = storeWith({
    countRows: async () => 2,
    query: () => { const q = { select: () => q, limit: () => q, toArray: async () => { throw new Error("query failed"); } }; return q; },
  });
  await rejects(s.getIndexedFilesStrict(), /query failed/);
});

test("T3 strict: a short read (fewer rows than countRows) rejects", async () => {
  const s = storeWith({ countRows: async () => 3, query: rowsQuery([{ sessionFile: "/a" }, { sessionFile: "/b" }]) });
  await rejects(s.getIndexedFilesStrict(), /indexed-files-short-read/);
});

test("T4 strict: no table → empty set; zero rows → empty set without a query", async () => {
  deepStrictEqual(await storeWith(null).getIndexedFilesStrict(), new Set());
  let queried = false;
  const s = storeWith({ countRows: async () => 0, query: rowsQuery([], () => { queried = true; }) });
  deepStrictEqual(await s.getIndexedFilesStrict(), new Set());
  strictEqual(queried, false);
});

test("T5 strict: normal read returns the distinct files", async () => {
  const s = storeWith({ countRows: async () => 3, query: rowsQuery([{ sessionFile: "/a" }, { sessionFile: "/a" }, { sessionFile: "/b" }]) });
  deepStrictEqual(await s.getIndexedFilesStrict(), new Set(["/a", "/b"]));
});

test("T7 strict: countRows that moved during the read rejects (grew or shrank)", async () => {
  for (const after of [4, 2]) {
    const counts = [3, after];
    const s = storeWith({
      countRows: async () => counts.shift() ?? -1,
      query: rowsQuery([{ sessionFile: "/a" }, { sessionFile: "/b" }, { sessionFile: "/c" }]),
    });
    await rejects(s.getIndexedFilesStrict(), /indexed-files-moved: countRows changed from 3 to /);
  }
});

test("T6 lenient getIndexedFiles keeps its empty-on-error contract (display/doctor callers)", async () => {
  const s = storeWith({ countRows: async () => { throw new Error("count failed"); } });
  deepStrictEqual(await s.getIndexedFiles(), new Set());
});

test("R11 no file is listed twice; missing-rows files are reported separately", () => {
  const a = file(), b = file(), other = file();
  const r = classify([a, b, other], [other], { [a]: entryOf(a, 2), [b]: entryOf(b, 2), [other]: entryOf(other, 1) });
  const all = [...r.newFiles, ...r.staleFiles];
  strictEqual(new Set(all).size, all.length);
  deepStrictEqual([r.newFiles, r.staleFiles, r.missingRowFiles], [[], [a, b], [a, b]]);
});

test("R12 import side effects: nothing written under the isolated HOME or data dir", () => {
  deepStrictEqual(fs.readdirSync(FAKE_HOME), []);
  deepStrictEqual(fs.readdirSync(FAKE_DATA), []);
});

// --- D. delete errors ----------------------------------------------------------------

test("D1 VectorStore.deleteByFile rejects when the table delete fails", async () => {
  const store = new VectorStore(path.join(TMP, "never-opened.lance"), 1024);
  (store as unknown as { table: unknown }).table = { delete: async () => { throw new Error("stub delete failure"); } };
  await rejects(store.deleteByFile("/x/a.jsonl"), /stub delete failure/);
});

test("D2 deleteByFile early-return branch: table still absent after ensureTable (stubbed) → resolves", async () => {
  // Stub covers only the `if (!this.table) return` branch. The real no-table
  // path creates an empty table in ensureTable() and deletes against it; that is
  // a LanceDB behaviour (coverage M6 receipt), not exercised here.
  const store = new VectorStore(path.join(TMP, "never-opened2.lance"), 1024);
  (store as unknown as { ensureTable: () => Promise<void> }).ensureTable = async () => {};
  await store.deleteByFile("/x/a.jsonl");
});

test("D3 rejected delete: nothing buffered, old rows kept, retry in the same buffer deletes again (no duplicate)", async () => {
  const f = file();
  const s = new FakeStore();
  s.rows.push(...recs(f, 2, "old"));
  s.deleteRejects = true;
  const wb = new WriteBuffer(s, 100);
  await rejects(wb.add(recs(f, 2, "new")), /fake delete failure/);
  strictEqual(wb.totalFlushed, 0);
  s.deleteRejects = false;
  await wb.add(recs(f, 2, "new"));
  await wb.flush();
  strictEqual(s.deletes, 2, "second attempt deleted again");
  deepStrictEqual(s.rows.map((r) => r.text), ["new-0", "new-1"]);
});

test("D4 rejected delete on markFile (empty extraction) propagates", async () => {
  const s = new FakeStore();
  s.deleteRejects = true;
  const wb = new WriteBuffer(s, 100);
  await rejects(wb.markFile("/x/a.jsonl"), /fake delete failure/);
});

// --- P. source pins (read, not executed) ----------------------------------------------

const REPO = path.dirname(new URL(import.meta.url).pathname);
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const fnBody = (text: string, name: string) => {
  const start = text.search(new RegExp(`(?:async )?function ${name}\\(`));
  ok(start >= 0, name);
  const next = text.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
};

test("P1 every getStaleFiles caller reads the indexed set strictly", () => {
  const ix = src("indexer.ts");
  const strict = ["indexSessions", "collectSessionStatus", "estimate"];
  for (const name of strict) {
    const body = fnBody(ix, name);
    ok(body.includes("getStaleFiles("), `${name} calls getStaleFiles`);
    ok(body.includes("getIndexedFilesStrict()"), `${name} uses getIndexedFilesStrict`);
    ok(!body.includes("getIndexedFiles()"), `${name} has no lenient read`);
  }
  // Calls with an argument only (the definition breaks the line; comments say "getStaleFiles()").
  const calls = (ix.match(/getStaleFiles\([a-zA-Z]/g) ?? []).length;
  strictEqual(calls, strict.length, "a new getStaleFiles caller must be added to this list");
});

test("P2 indexSessions: a failed strict read closes the store and rethrows before any embedding", () => {
  const body = fnBody(src("indexer.ts"), "indexSessions");
  const iRead = body.indexOf("getIndexedFilesStrict()");
  const iEmbed = body.indexOf(".embedDocumentBatch(");
  ok(iRead > 0 && iEmbed > iRead);
  ok(/catch \(e\) \{\s*\n\s*await store\.close\(\);\s*\n\s*throw e;/.test(body.slice(iRead, iRead + 300)));
});

test("P3 manifest chunks = sent count (S0-held excluded); zero sent → markFile, so all-held files do not loop", () => {
  const body = fnBody(src("indexer.ts"), "indexSessions");
  ok(body.includes("const { send: chunks, held } = await extractForPolicy("));
  ok(body.includes("manifestEntry = { mtimeMs: stat.mtimeMs, size: stat.size, chunks: chunks.length }"));
  const iZero = body.indexOf("if (chunks.length === 0) {");
  ok(iZero > 0 && body.indexOf("await wb.markFile(file);", iZero) > iZero);
});

test("P4 status and estimate expose the missing-rows count from the same getStaleFiles call", () => {
  const ix = src("indexer.ts");
  for (const name of ["collectSessionStatus"]) {
    const body = fnBody(ix, name);
    ok(body.includes("missingCount = missingRowFiles.length") && body.includes("missing_rows: missingCount"), name);
  }
  const est = fnBody(ix, "estimate");
  ok(est.includes("missingRowsToEstimate = missingRowFiles.length") && est.includes("missing rows (in files to index)"));
});

test("P5 candidate resume: a rejected discard delete ends the attempt as partial before adopt/manifest", () => {
  const body = src("scripts/candidate-build.ts");
  const i = body.indexOf("for (const [f, n] of resume.discard)");
  ok(i > 0);
  const seg = body.slice(body.lastIndexOf("try {", i), body.indexOf('return finish("partial", errorCode(e));', i) + 40);
  ok(seg.startsWith("try {") && seg.indexOf("await store.deleteByFile(f);") < seg.indexOf("resume.adopt"));
  ok(/catch \(e\) \{\s*\n\s*await store\.close\(\);\s*\n\s*return finish\("partial", errorCode\(e\)\);/.test(seg));
});

// --- L. limits (not covered by the contract) ------------------------------------------

test("sessions status strict read failure fails status", () => {
  const sess = fnBody(src("indexer.ts"), "collectSessionStatus");
  ok(sess.includes("await store.getIndexedFilesStrict()") && !/catch\b/.test(sess));
});

// --- G. whole-store loss meets the fresh paid guard ------------------------------------

test("G1 R10 whole-store loss: freshPaidRefusal refuses the paid run unless the explicit flag is set", async () => {
  const { freshPaidRefusal } = await import("./session-policy.ts");
  const a = file(), c = file();
  const files = [a, c];
  const indexed = new Set<string>();
  const r = classify(files, [], { [a]: entryOf(a, 3), [c]: entryOf(c, 1) }, { sentinel: false });
  const toIndex = [...r.newFiles, ...r.staleFiles].length;
  strictEqual(toIndex, 2, "every claimed file is stale");
  // The same arguments indexSessions passes.
  const args = { paid: true, indexedFiles: files.filter((f) => indexed.has(f)).length, toIndex };
  ok(freshPaidRefusal({ ...args, env: {} }), "paid + nothing indexed + work → refused");
  strictEqual(freshPaidRefusal({ ...args, env: { ANDENKEN_ALLOW_PAID_FULL_REBUILD: "1" } }), null, "explicit flag overrides");
  strictEqual(freshPaidRefusal({ ...args, paid: false, env: {} }), null, "non-paid endpoint is not refused");
  strictEqual(freshPaidRefusal({ ...args, toIndex: 0, env: {} }), null, "no work is not refused");
  // Boundary (Z1): one file still indexed and the guard does not fire.
  strictEqual(freshPaidRefusal({ ...args, indexedFiles: 1, env: {} }), null, "partial loss is not refused — the API-0 estimate gate covers it");
});

test("G2 indexSessions order: getStaleFiles → freshPaidRefusal (closes, throws) → first WriteBuffer", () => {
  const body = fnBody(src("indexer.ts"), "indexSessions");
  const iStale = body.indexOf("getStaleFiles(files, indexed, manifest)");
  const iGuard = body.indexOf("freshPaidRefusal({", iStale);
  const iWb = body.indexOf("new WriteBuffer(");
  ok(iStale > 0 && iGuard > iStale && iWb > iGuard, "stale → guard → write buffer");
  ok(/if \(refusal\) \{\s*\n\s*await store\.close\(\);\s*\n\s*throw new Error\(refusal\);/.test(body.slice(iGuard, iGuard + 300)));
});

// --- B. sync-sessions status calls ---------------------------------------------------

test("B1 sync-sessions: status --json keeps stderr and stops by name on failure (pre-index and post-index)", () => {
  const sh = src("scripts/sync-sessions.sh");
  ok(!/status --json 2>\/dev\/null/.test(sh), "no status call discards stderr");
  ok(/^set -euo pipefail$/m.test(sh), "strict shell");
  ok(/STATUS_JSON=\$\(pnpm exec tsx indexer\.ts status --json\) \|\| \{\n\s*echo "❌ refused: status --json failed[^"]*" >&2\n\s*exit 1\n\}/.test(sh), "pre-index stop");
  ok(/POST_JSON=\$\(pnpm exec tsx indexer\.ts status --json\) \|\| \{\n\s*echo "❌ publish stopped: post-index status --json failed[^"]*" >&2\n\s*exit 1\n\s*\}/.test(sh), "post-index stop");
  const iPost = sh.indexOf("POST_JSON=$(");
  ok(iPost > 0 && sh.indexOf("publish_replica", iPost) > sh.indexOf('ROWS=$(printf \'%s\' "$POST_JSON"', iPost), "rows read from POST_JSON before publish");
  ok(sh.indexOf("STATUS_JSON=$(") < sh.indexOf("TO_INDEX=$("), "status read precedes to_index");
});

// --- M. md replica check leaf ------------------------------------------------------------

const MD_SH = "scripts/sync-md-to-oracle.sh";
const PREFIX = "cd '$REMOTE_ROOT' && ";
function mdLeaf(): string {
  const lines = src(MD_SH).split("\n").filter((l) => /^\s*ssh "\$HOST" "cd '\$REMOTE_ROOT' && .*verify md/.test(l));
  strictEqual(lines.length, 1, "exactly one remote verify leaf");
  const m = lines[0].match(/^\s*ssh "\$HOST" "(.*)"\s*$/);
  ok(m, "leaf is one double-quoted ssh argument");
  const remote = m![1];
  ok(remote.startsWith(PREFIX), "exact cd prefix");
  const leaf = remote.slice(PREFIX.length);
  // Refuse before execution: nothing may reach the real repo, a host or a PATH tool.
  ok(!/\bcd\b|\bssh\b|\brsync\b|REMOTE_ROOT|HOST|[$`\\]|(?<![.])\/run\.sh|\bpnpm\b|\bnode\b|\btsx\b/.test(leaf), `leaf carries no cd/ssh/rsync/variable/absolute run.sh: ${leaf}`);
  ok(/^\{ .* \}$/.test(leaf), "leaf is one brace group");
  return leaf;
}
function bashAbs(): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, "bash");
    if (d.startsWith("/") && fs.existsSync(p)) return fs.realpathSync(p);
  }
  throw new Error("bash not found on PATH");
}
function runLeaf(statusRc: number, verifyRc: number) {
  const leaf = mdLeaf();
  const bash = bashAbs();
  const dir = fs.mkdtempSync(path.join(TMP, "md-leaf-"));
  const emptyBin = path.join(dir, "empty-bin");
  fs.mkdirSync(emptyBin);
  // Builtins only: echo, redirection, case, exit. The leaf calls ./run.sh relative
  // to this cwd, so only this fake can answer.
  fs.writeFileSync(
    path.join(dir, "run.sh"),
    `#!${bash}\necho "$*" >> calls.log\ncase "$1" in status) exit "$FAKE_STATUS_RC";; verify) exit "$FAKE_VERIFY_RC";; esac\nexit 99\n`,
    { mode: 0o700 },
  );
  const r = spawnSync(bash, ["-c", leaf], {
    cwd: dir,
    env: { PATH: emptyBin, HOME: dir, FAKE_STATUS_RC: String(statusRc), FAKE_VERIFY_RC: String(verifyRc) },
    encoding: "utf8",
    timeout: 5000,
  });
  const log = path.join(dir, "calls.log");
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { rc: r.status, stderr: r.stderr, calls };
}

test("M1 md leaf: status fails → warning, verify md still runs and passes → exit 0", () => {
  const r = runLeaf(1, 0);
  deepStrictEqual(r.calls, ["status", "verify md"]);
  strictEqual(r.rc, 0);
  ok(r.stderr.includes("warning: global status failed; continuing mandatory md verification"));
});

test("M2 md leaf: verify md fails → nonzero, with status passing or failing", () => {
  for (const statusRc of [0, 1]) {
    const r = runLeaf(statusRc, 3);
    deepStrictEqual(r.calls, ["status", "verify md"]);
    strictEqual(r.rc, 3);
  }
});

test("M3 md leaf: normal → status and verify md, exit 0, no warning", () => {
  const r = runLeaf(0, 0);
  deepStrictEqual(r.calls, ["status", "verify md"]);
  strictEqual(r.rc, 0);
  strictEqual(r.stderr, "");
});

test("M4 md script shape: strict shell; dry-run exits before VERIFY; SMOKE runs only after VERIFY", () => {
  const sh = src(MD_SH);
  ok(/^set -euo pipefail$/m.test(sh));
  const iDry = sh.indexOf('if [ "$DRY_RUN" = "1" ]; then');
  const iVerify = sh.indexOf('if [ "$VERIFY" = "1" ]; then');
  const iSmoke = sh.indexOf('if [ "$SMOKE" = "1" ]; then');
  ok(iDry > 0 && iVerify > iDry && iSmoke > iVerify, "dry-run → verify → smoke");
  ok(/exit 0/.test(sh.slice(iDry, iVerify)), "dry-run exits 0 before verify");
});

test("L1 baseline entry (chunks 0) whose rows were lost is NOT rediscovered", () => {
  const f = file();
  deepStrictEqual(classify([f], [], { [f]: entryOf(f, 0) }).staleFiles, []);
});

test("L2 partial rows (file present in DB with fewer rows) are NOT detected — presence only", () => {
  const f = file();
  deepStrictEqual(classify([f], [f], { [f]: entryOf(f, 5) }).staleFiles, []);
});

test("L3 legacy entry without a chunks field, rows absent, unchanged → NOT rediscovered", () => {
  const f = file();
  const e = entryOf(f, 0) as Partial<Entry>;
  delete e.chunks;
  deepStrictEqual(classify([f], [], { [f]: e as Entry }).staleFiles, []);
});

// --- run ---------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
