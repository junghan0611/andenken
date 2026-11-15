/**
 * writer-crash.test.ts — SYNTHETIC characterization (API 0, no LanceDB) of the
 * sessions writer's delete/insert/manifest boundaries.
 *
 * It drives the real WriteBuffer (write-buffer.ts) and finalizeIndexRun
 * (index-finalize.ts) against an in-memory fake store, in the order indexer.ts
 * uses per file (embed → wb.add | wb.markFile → manifest entry in memory →
 * checkpoint flush → persist). Discovery (getStaleFiles) and the real store's
 * delete are executed in writer-recovery.test.ts (the store over a stub table);
 * here their indexer-side contract is pinned by source reads (section S).
 *
 * Cases named WINDOW pin raw writer windows that still exist by design (the
 * delete commits before the insert). They are no longer silent losses: the
 * recovery contract — missing-rows rediscovery in getStaleFiles and a
 * propagating store.deleteByFile — is tested in writer-recovery.test.ts.
 * Cases named FAKE-ONLY exercise behaviour the production store no longer has.
 * Cases named CONTRACT assert behaviour that is safe.
 *
 * Limits: the fake store does not exercise the production store, and nothing
 * here runs indexer.ts end to end against LanceDB.
 *
 *   node node_modules/tsx/dist/cli.mjs writer-crash.test.ts
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WriteBuffer, type BufferedRecord } from "./write-buffer.ts";
import { finalizeIndexRun } from "./index-finalize.ts";

const REPO = path.dirname(fileURLToPath(import.meta.url));

// --- fake store --------------------------------------------------------------------

class FakeStore {
  rows: BufferedRecord[] = [];
  log: string[] = [];
  /** Throw from addChunksRaw on these call numbers (1-based). */
  failAddOn = new Set<number>();
  /** "throw": delete rejects. "swallow": delete fails but resolves (store.ts:607-614 shape). */
  deleteMode: "ok" | "throw" | "swallow" = "ok";
  private adds = 0;

  async deleteByFile(file: string): Promise<void> {
    this.log.push(`delete ${path.basename(file)}`);
    if (this.deleteMode === "throw") throw new Error("fake delete failure");
    if (this.deleteMode === "swallow") {
      try {
        throw new Error("fake delete failure");
      } catch {
        return; // mirrors `catch { /* safe to ignore */ }`
      }
    }
    this.rows = this.rows.filter((r) => r.sessionFile !== file);
  }

  async addChunksRaw(chunks: BufferedRecord[]): Promise<void> {
    this.adds++;
    this.log.push(`add#${this.adds} ${chunks.length}`);
    if (this.failAddOn.has(this.adds)) throw new Error(`fake add failure #${this.adds}`);
    this.rows.push(...chunks);
  }

  count(file: string): number {
    return this.rows.filter((r) => r.sessionFile === file).length;
  }
  ids(file: string): string[] {
    return this.rows.filter((r) => r.sessionFile === file).map((r) => r.id);
  }
}

const recs = (file: string, n: number, tag = "v"): BufferedRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${file}:${i + 1}`,
    text: `${tag}-${i}`,
    vector: [0],
    sessionFile: file,
    project: "p",
    lineNumber: i + 1,
    timestamp: "",
    role: "user",
    metadata: { type: "user_message" },
  }));

type Entry = { mtimeMs: number; size: number; chunks: number };
const F = "/corpus/dev/.pi/agent/sessions/--p--/a.jsonl";
const G = "/corpus/dev/.pi/agent/sessions/--p--/b.jsonl";

const cases: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push([name, fn]);

// --- W. WriteBuffer / finalize runtime ----------------------------------------------

test("W1 WINDOW add() deletes the file's committed rows before its new rows are inserted", async () => {
  const s = new FakeStore();
  s.rows.push(...recs(F, 3, "old"));
  const wb = new WriteBuffer(s, 100);
  await wb.add(recs(F, 3, "new"));
  strictEqual(s.count(F), 0, "between add() and flush the file has no committed rows");
  strictEqual(wb.totalFlushed, 3, "the new rows exist only in process memory");
  // a crash here (no flush) leaves the file with zero rows
  await wb.flush();
  deepStrictEqual(s.rows.map((r) => r.text), ["new-0", "new-1", "new-2"]);
});

test("W2 WINDOW final flush failure: persist skipped, run fails, file left with 0 rows; manifest keeps the PRIOR entry", async () => {
  const s = new FakeStore();
  s.rows.push(...recs(F, 2, "old"));
  s.failAddOn.add(1);
  const prior: Entry = { mtimeMs: 1000, size: 50, chunks: 2 };
  let persisted: Record<string, Entry> = { [F]: prior };
  const mem: Record<string, Entry> = { ...persisted };
  const wb = new WriteBuffer(s, 100);
  await rejects(
    finalizeIndexRun({
      label: "Session",
      run: async () => {
        await wb.add(recs(F, 2, "new"));
        mem[F] = { mtimeMs: 1000, size: 50, chunks: 2 }; // unchanged file re-extracted
        return { errors: 0 };
      },
      flush: () => wb.flush(),
      persist: () => {
        persisted = { ...mem };
      },
      summary: () => [],
      log: () => {},
      close: async () => {},
    }),
    /fake add failure #1/,
  );
  strictEqual(s.count(F), 0, "rows deleted, insert failed");
  deepStrictEqual(persisted[F], prior, "persist skipped: manifest still claims the prior extraction");
  // Discovery: F is not in the DB while its prior entry claims rows, so the
  // missing-rows rule re-extracts it even when unchanged (writer-recovery R3).
});

test("W3 FAKE-ONLY a delete that fails but resolves (the pre-fix store.ts shape) leaves old + new rows under the same ids", async () => {
  const s = new FakeStore();
  s.rows.push(...recs(F, 2, "old"));
  s.deleteMode = "swallow";
  const wb = new WriteBuffer(s, 100);
  await wb.add(recs(F, 2, "new"));
  await wb.flush();
  strictEqual(s.count(F), 4);
  deepStrictEqual(s.ids(F).sort(), [`${F}:1`, `${F}:1`, `${F}:2`, `${F}:2`]);
  // WriteBuffer marks F deleted after the resolved call, so no retry in this run
  await wb.add(recs(F, 1, "again"));
  strictEqual(s.log.filter((l) => l.startsWith("delete")).length, 1, "no second delete attempt for F in the same buffer");
});

test("W4 CONTRACT a delete that rejects fails the task before anything is buffered", async () => {
  const s = new FakeStore();
  s.rows.push(...recs(F, 2, "old"));
  s.deleteMode = "throw";
  const wb = new WriteBuffer(s, 100);
  await rejects(wb.add(recs(F, 2, "new")), /fake delete failure/);
  strictEqual(wb.totalFlushed, 0);
  strictEqual(s.count(F), 2, "old rows intact");
});

test("W5 WINDOW empty extraction: markFile deletes at once, nothing buffered (same unchanged-file window)", async () => {
  const s = new FakeStore();
  s.rows.push(...recs(F, 2, "old"));
  const wb = new WriteBuffer(s, 100);
  await wb.markFile(F);
  strictEqual(s.count(F), 0);
  strictEqual(wb.totalFlushed, 0);
});

test("W6 CONTRACT checkpoint: flush precedes persist, so a persisted entry never outruns its rows", async () => {
  const s = new FakeStore();
  const wb = new WriteBuffer(s, 100);
  const mem: Record<string, Entry> = {};
  let persistedRows = -1;
  await wb.add(recs(F, 3));
  mem[F] = { mtimeMs: 2000, size: 60, chunks: 3 };
  // indexer.ts checkpointIfNeeded: await wb.flush(); persist()
  await wb.flush();
  persistedRows = s.count(F);
  strictEqual(persistedRows, 3);
});

test("W7 CONTRACT shared-batch failure: the failing flush is reported by the task that triggered it; final flush re-sends both files", async () => {
  const s = new FakeStore();
  s.failAddOn.add(1);
  const wb = new WriteBuffer(s, 4);
  const mem: Record<string, Entry> = {};
  await wb.add(recs(F, 3)); // buffered, below batch size
  mem[F] = { mtimeMs: 1, size: 1, chunks: 3 };
  await rejects(wb.add(recs(G, 3)), /fake add failure #1/); // G's add triggers the flush of F+G
  strictEqual(mem[G], undefined, "G's task failed, so no manifest entry for G");
  strictEqual(wb.totalFlushed, 6, "both files restored to the buffer");
  await wb.flush(); // finalize's flush
  strictEqual(s.count(F), 3);
  strictEqual(s.count(G), 3, "G's rows land although its task failed");
  // G: in DB, no manifest entry → getStaleFiles ghost-zone branch re-indexes it (cost, not loss)
});

// --- S. source pins (read, not executed) -----------------------------------------

const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const fnBody = (text: string, name: string) => {
  const start = text.search(new RegExp(`(?:async )?function ${name}\\(`));
  ok(start >= 0, name);
  const next = text.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
};

test("S1 getStaleFiles: a manifest file absent from the DB is re-extracted on missing rows or on mtime/size change", () => {
  const body = fnBody(src("indexer.ts"), "getStaleFiles");
  const a = body.indexOf("if (!indexed.has(f))");
  const b = body.indexOf("// No manifest yet");
  ok(a > 0 && b > a, "not-indexed branch located");
  const notIndexed = body.slice(a, b);
  ok(notIndexed.includes("if (!entry) {") && notIndexed.includes("newFiles.push(f)"), "no entry → new");
  ok(notIndexed.includes("missingRowFiles.push(f)"), "entry claiming rows → stale (missing rows)");
  ok(notIndexed.includes("stat.mtimeMs > entry.mtimeMs || stat.size !== entry.size"), "otherwise stale on change");
});

test("S2 indexSessions: embed before wb.add; manifest entry set in memory after; persist only via flush-first paths", () => {
  const body = fnBody(src("indexer.ts"), "indexSessions");
  const iEmbed = body.indexOf(".embedDocumentBatch(");
  const iAdd = body.indexOf("await wb.add(");
  const iEntry = body.indexOf("manifest.files[file] = manifestEntry", iAdd);
  ok(iEmbed > 0 && iAdd > iEmbed && iEntry > iAdd, "embed → add → entry");
  ok(/await wb\.flush\(\);\s*\n\s*persist\(\);/.test(body), "checkpoint flushes before persist");
  ok(body.includes("finalizeIndexRun({"), "finalize seam");
});

test("S3 store.deleteByFile has no catch: delete errors propagate", () => {
  const body = src("store.ts");
  const start = body.indexOf("async deleteByFile(filePath: string)");
  ok(start > 0);
  const seg = body.slice(start, body.indexOf("\n  }\n", start));
  ok(!/catch\b/.test(seg), "no catch in deleteByFile");
  ok(seg.includes("await this.table.delete("), "delete awaited directly");
});

test("S4 finalize: a flush failure skips persist", () => {
  const body = src("index-finalize.ts");
  ok(/await d\.flush\(\);\s*\n\s*d\.persist\(\);\s*\n\s*persisted = true;/.test(body));
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
  }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
