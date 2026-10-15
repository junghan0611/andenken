#!/usr/bin/env tsx
/**
 * Tests for the pi-durable source (issue #15): corpus admission, incremental
 * indexing with its checkpoint manifest, the shared excerpt dispatch, and the
 * existing sessions maintenance paths run against durable rows.
 *
 * API 0. Network 0. Everything happens in a temp corpus, a temp data dir and a
 * temp LanceDB with a stub provider (4-dim vectors). Subprocesses get a vLLM
 * provider pointed at 127.0.0.1:9, so an accidental embedding call fails
 * instead of reaching a paid endpoint.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { DurableReadRefused, readDurableRange } from "./durable-reader.ts";
import { DURABLE_POLICY, planDurable } from "./durable-plan.ts";
import { admitDurableSnapshot, DurableAdmitRefused, durableCorpusPath, findDurableSnapshots } from "./durable-source.ts";
import {
  loadDurableManifest,
  runDurableIndex,
  saveDurableManifest,
  type DurableIndexDeps,
  type DurableProvider,
  type DurableStore,
} from "./durable-index.ts";
import { readHitExcerpt, isHitExcerpt } from "./session-excerpt-dispatch.ts";
import { VectorStore } from "./store.ts";

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
async function refused(run: () => Promise<unknown>, reason: string, msg: string): Promise<void> {
  try {
    await run();
    failed++;
    console.log(`  ❌ ${msg} (not refused)`);
  } catch (err) {
    const got = err instanceof DurableAdmitRefused || err instanceof DurableReadRefused ? err.reason : String(err);
    if (got === reason) {
      passed++;
      console.log(`  ✅ ${msg}`);
    } else {
      failed++;
      console.log(`  ❌ ${msg} (got ${got})`);
    }
  }
}

const repo = import.meta.dirname;
const probes = path.join(repo, "probes", "pi-durable");
const one = (dir: string) => {
  const b = fs.readdirSync(dir)[0];
  return path.join(dir, b, fs.readdirSync(path.join(dir, b))[0], "session.sqlite");
};
const SAMPLE = one(path.join(probes, "sample-1.2"));
const SNAP1 = one(path.join(probes, "sample-1.2-midrun", "snap1"));
const SNAP2 = one(path.join(probes, "sample-1.2-midrun", "snap2"));
const BUCKET = path.basename(path.dirname(path.dirname(SNAP2)));
const MID_SESSION = path.basename(path.dirname(SNAP2));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-durable-src-"));
const liveRoots = [path.join(tmp, "no-live-root")];
const ROSTER = { formatVersion: 1, devices: [{ id: "thinkpad", state: "active", transport: "push" }, { id: "oracle", state: "active", transport: "ssh" }] };
function newCorpus(name: string, extra: string[] = []): string {
  const c = path.join(tmp, name);
  fs.mkdirSync(c, { recursive: true });
  const roster = { ...ROSTER, devices: [...ROSTER.devices, ...extra.map((id) => ({ id, state: "active", transport: "ssh" }))] };
  fs.writeFileSync(path.join(c, "DEVICES.json"), JSON.stringify(roster));
  return c;
}
const admit = (corpus: string, input: string, device = "thinkpad", extra: { bucket?: string; session?: string } = {}) =>
  admitDurableSnapshot({ input, device, corpus, liveRoots, ...extra });

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): Record<string, unknown> | undefined };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };

// ---------------------------------------------------------------------------
console.log("\n# admission");
// ---------------------------------------------------------------------------
{
  const corpus = newCorpus("corpus-admit", ["evil"]);
  await refused(() => admit(corpus, SNAP1, "laptop-typo"), "unknown-device", "device outside the roster is refused (no new device dir)");
  truthy(!fs.existsSync(path.join(corpus, "laptop-typo")), "…and no directory was created for it");
  await refused(() => admitDurableSnapshot({ input: SNAP1, device: "thinkpad", corpus: path.join(tmp, "nope"), liveRoots }), "no-corpus", "missing corpus root");

  const created = await admit(corpus, SNAP1);
  const dest = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  eq([created.action, created.dest], ["created", dest], "first admission creates the canonical corpus path");
  const st = fs.statSync(dest);
  eq([st.mode & 0o777, st.nlink], [0o600, 1], "corpus copy is 0600 and a real copy (one link)");
  eq(fs.statSync(path.dirname(dest)).mode & 0o777, 0o700, "new session directory is 0700");
  truthy(created.lineage && created.lineage.length === 36, "lineage recorded from root pi.provider");
  eq((await admit(corpus, SNAP1)).action, "unchanged", "same bytes again → unchanged");
  const replaced = await admit(corpus, SNAP2);
  eq([replaced.action, replaced.previous?.maxEntryId], ["replaced", 13], "a later snapshot of the same lineage replaces the copy");
  await refused(() => admit(corpus, SNAP1), "durable-rollback", "an older snapshot cannot replace a newer one");

  // A different session (other lineage) aimed at this path through arguments.
  const plain = path.join(tmp, "plain", "session.sqlite");
  fs.mkdirSync(path.dirname(plain), { recursive: true });
  fs.copyFileSync(SAMPLE, plain);
  await refused(() => admit(corpus, plain, "thinkpad", { bucket: BUCKET, session: MID_SESSION }), "durable-lineage-mismatch", "another lineage cannot replace the copy");
  await refused(() => admit(corpus, plain, "thinkpad", { bucket: "0".repeat(24), session: MID_SESSION }), "bucket-mismatch", "bucket must be sha256(cwd)[:24]");
  await refused(() => admit(corpus, SAMPLE, "thinkpad", { session: MID_SESSION }), "identity-conflict", "arguments that disagree with the input path are refused");

  // Same lineage, more entries, but the copy's last entry was rewritten → diverged.
  const div = path.join(tmp, "div", BUCKET, MID_SESSION, "session.sqlite");
  fs.mkdirSync(path.dirname(div), { recursive: true });
  fs.copyFileSync(SNAP2, div);
  const ddb = new DatabaseSync(div);
  const last = ddb.prepare("SELECT id, conversation_id, commit_seq, record FROM entries ORDER BY id DESC LIMIT 1").get()!;
  ddb.prepare("UPDATE entries SET record = ? WHERE id = ?").run(String(last.record).replace("FINAL", "EDITED"), last.id);
  ddb.prepare("INSERT INTO entries VALUES (?, ?, NULL, ?, ?)").run(Number(last.id) + 50, last.conversation_id, Number(last.commit_seq) + 50, String(last.record));
  ddb.close();
  await refused(() => admit(corpus, div), "durable-diverged", "a copy whose recorded last entry changed is refused");

  // corpus/evil is a symlink out of the corpus.
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(corpus, "evil"));
  await refused(() => admit(corpus, SNAP2, "evil"), "dest-escape", "a destination that resolves outside the corpus is refused");

  // Live input → the reader's refusal comes through unchanged.
  const live = path.join(tmp, "live-root", BUCKET, MID_SESSION, "session.sqlite");
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.copyFileSync(SNAP2, live);
  await refused(() => admitDurableSnapshot({ input: live, device: "thinkpad", corpus, liveRoots: [path.join(tmp, "live-root")] }), "live-store", "input inside a live root is refused");

  // Lineage unknown: first admission notes it; a replacement is refused.
  const noProv = path.join(tmp, "noprov", "a".repeat(24), "1792000000009-00000000-0000-4000-8000-000000000009", "session.sqlite");
  fs.mkdirSync(path.dirname(noProv), { recursive: true });
  fs.copyFileSync(SNAP2, noProv);
  const ndb = new DatabaseSync(noProv);
  ndb.exec(`DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind IN ('"pi.provider"', '"pi.agent"'));
            DELETE FROM documents WHERE kind IN ('"pi.provider"', '"pi.agent"');`);
  ndb.close();
  const nu = await admit(corpus, noProv);
  truthy(nu.action === "created" && nu.notes.some((n) => n.includes("lineage unknown")), "lineage-unknown snapshot is admitted with a note");
  const ndb2 = new DatabaseSync(noProv);
  ndb2.prepare("INSERT INTO entries VALUES (999, 1, NULL, 999, '{\"id\":999,\"conversationId\":1,\"kind\":\"pi.system\"}')").run();
  ndb2.close();
  await refused(() => admit(corpus, noProv), "durable-lineage-unknown", "…and replacing it is refused");
  eq(findDurableSnapshots(corpus).map((f) => f.device), ["thinkpad", "thinkpad"], "discovery sees corpus-grammar snapshots only (symlinked device skipped)");
}

// ---------------------------------------------------------------------------
// Index harness
// ---------------------------------------------------------------------------

class StubProvider implements DurableProvider {
  calls = 0;
  failOnCall = 0;
  async embedDocumentBatch(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.failOnCall && this.calls === this.failOnCall) throw new Error("stub embed failure");
    return texts.map((t) => [t.length % 7, 1, 0, 0]);
  }
}

async function freshStore(name: string): Promise<{ store: VectorStore; data: string }> {
  const data = path.join(tmp, name);
  fs.mkdirSync(data, { recursive: true });
  const store = new VectorStore(path.join(data, "sessions.lance"), 4);
  await store.init();
  await store.ensureTable();
  return { store, data };
}

interface Row { id: string; sessionFile: string; lineNumber: number; source: string }
async function rowsOf(store: VectorStore): Promise<Row[]> {
  const table = (store as unknown as { table: { query(): { select(c: string[]): { limit(n: number): { toArray(): Promise<Row[]> } } } } }).table;
  const all = await table.query().select(["id", "sessionFile", "lineNumber", "source"]).limit(1_000_000).toArray();
  return all.map((r) => ({ id: r.id, sessionFile: r.sessionFile, lineNumber: Number(r.lineNumber), source: r.source })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

const SEED_JSONL = path.join(tmp, "seed", "--home-u-repos-gh-demo--", "2026_0190b2a0-0000-7000-8000-000000000000.jsonl");
fs.mkdirSync(path.dirname(SEED_JSONL), { recursive: true });
fs.writeFileSync(SEED_JSONL, '{"type":"message","message":{"role":"user","content":"seed"}}\n');
// Another durable file's rows; the file exists so verify/cleanup do not call it an orphan.
const OTHER_DURABLE = path.join(tmp, "elsewhere", "other", "session.sqlite");
fs.mkdirSync(path.dirname(OTHER_DURABLE), { recursive: true });
fs.copyFileSync(SAMPLE, OTHER_DURABLE);
async function seed(store: VectorStore): Promise<void> {
  const base = { text: "seed", project: "demo", timestamp: "2026-10-15T00:00:00.000Z", role: "user", metadata: {}, vector: [1, 0, 0, 0] };
  await store.addChunksRaw([
    { ...base, id: `${SEED_JSONL}:1`, sessionFile: SEED_JSONL, lineNumber: 1, source: "pi" },
    { ...base, id: `${OTHER_DURABLE}:e5`, sessionFile: OTHER_DURABLE, lineNumber: 5, source: "pi-durable" },
  ]);
}
const seeded = (rows: Row[]) => rows.filter((r) => r.sessionFile === SEED_JSONL || r.sessionFile === OTHER_DURABLE).length;

function deps(corpus: string, data: string, extra: Partial<DurableIndexDeps>): DurableIndexDeps {
  return {
    corpus,
    manifestPath: path.join(data, "durable-manifest.json"),
    dryRun: false,
    liveRoots,
    batchSize: 2,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
console.log("\n# incremental indexing across two snapshots");
// ---------------------------------------------------------------------------
let gateCorpus = "";
let gateData = "";
let gateFile = "";
{
  const corpus = newCorpus("corpus-index");
  await admit(corpus, SNAP1);
  const file = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  const { store, data } = await freshStore("data-index");
  await seed(store);
  const provider = new StubProvider();

  const dry = await runDurableIndex(deps(corpus, data, { dryRun: true }));
  eq([dry.files[0].status, provider.calls, fs.existsSync(path.join(data, "durable-manifest.json"))], ["planned", 0, false], "dry-run: planned, no provider call, no manifest");
  eq(dry.files[0].held.length, 1, "dry-run lists the held entry");

  const r1 = await runDurableIndex(deps(corpus, data, { store, provider }));
  const m1 = loadDurableManifest(path.join(data, "durable-manifest.json")).files[file];
  eq([r1.files[0].status, r1.files[0].rows, m1.processedId, m1.policy], ["indexed", 0, 6, DURABLE_POLICY], "snap1: checkpoint stops before the open human input (e7), nothing embedded yet");
  truthy(r1.files[0].freshness.maxEntryId === 13, "report states freshness (turns after the snapshot are not collected)");

  await admit(corpus, SNAP2);
  const r2 = await runDurableIndex(deps(corpus, data, { store, provider }));
  const rows2 = (await rowsOf(store)).filter((r) => r.sessionFile === file);
  eq(rows2.map((r) => r.lineNumber).sort((a, b) => a - b), [7, 11, 15, 16], "snap2: e7 e11 e15 e16 embedded (held entry now settled)");
  eq(r2.files[0].ambiguous.map(Number), [19, 25], "snap2: ambiguous doorbell-mixed entries reported, not embedded");
  eq(new Set(rows2.map((r) => r.id)).size, rows2.length, "no duplicate row ids");
  truthy(rows2.every((r) => r.source === "pi-durable"), "rows carry source pi-durable");
  eq(seeded(await rowsOf(store)), 2, "other sources' and other files' rows are untouched");

  const callsBefore = provider.calls;
  const r3 = await runDurableIndex(deps(corpus, data, { store, provider }));
  eq([r3.files[0].status, provider.calls - callsBefore], ["up-to-date", 0], "rerun: up-to-date, no provider call");

  // Decisions at or below snap1's checkpoint do not change in snap2 (no gap, no flip).
  const p1 = await planDurable(SNAP1, { liveRoots });
  const p2 = await planDurable(SNAP2, { liveRoots });
  const upTo = p1.watermark.safeProcessedId;
  const d = (p: typeof p1) => p.candidates.filter((c) => c.entryId <= upTo).map((c) => [c.entryId, c.B.decision]);
  eq(d(p2), d(p1), "B.1 decisions up to the checkpoint are identical in the later snapshot");

  gateCorpus = corpus;
  gateData = data;
  gateFile = file;
  await store.close();
}

// ---------------------------------------------------------------------------
console.log("\n# a failure at each write step leaves a repeatable state");
// ---------------------------------------------------------------------------
for (const step of ["embed", "flush", "manifest"] as const) {
  const corpus = newCorpus(`corpus-fail-${step}`);
  await admit(corpus, SNAP2);
  const file = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  const { store, data } = await freshStore(`data-fail-${step}`);
  await seed(store);
  const provider = new StubProvider();
  let failNext = true;
  const wrapped: DurableStore = {
    deleteByFile: (f) => store.deleteByFile(f),
    deleteByFileAbove: (f, n) => store.deleteByFileAbove(f, n),
    addChunksRaw: async (rows) => {
      if (step === "flush" && failNext) {
        failNext = false;
        throw new Error("stub flush failure");
      }
      await store.addChunksRaw(rows);
    },
  };
  if (step === "embed") provider.failOnCall = 2;
  const saveManifest = (f: string, m: Parameters<typeof saveDurableManifest>[1]) => {
    if (step === "manifest" && failNext) {
      failNext = false;
      throw new Error("stub manifest failure");
    }
    saveDurableManifest(f, m);
  };
  const first = await runDurableIndex(deps(corpus, data, { store: wrapped, provider, saveManifest }));
  eq(first.files[0].status, "failed", `${step} failure → file reported failed`);
  eq(loadDurableManifest(path.join(data, "durable-manifest.json")).files[file], undefined, `${step} failure → manifest not advanced`);
  provider.failOnCall = 0;
  const second = await runDurableIndex(deps(corpus, data, { store: wrapped, provider, saveManifest }));
  const rows = (await rowsOf(store)).filter((r) => r.sessionFile === file);
  eq([second.files[0].status, rows.length, new Set(rows.map((r) => r.id)).size], ["indexed", 4, 4], `${step} failure → rerun ends with exactly the 4 rows, no duplicates`);
  eq(seeded(await rowsOf(store)), 2, `${step} failure → other rows untouched`);
  await store.close();
}

// ---------------------------------------------------------------------------
console.log("\n# refusals against the manifest, aliases");
// ---------------------------------------------------------------------------
{
  const corpus = newCorpus("corpus-refuse");
  await admit(corpus, SNAP2);
  await admit(corpus, SNAP2, "oracle");
  const file = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  const ofile = durableCorpusPath(corpus, "oracle", BUCKET, MID_SESSION);
  const { store, data } = await freshStore("data-refuse");
  const provider = new StubProvider();
  const r = await runDurableIndex(deps(corpus, data, { store, provider }));
  eq([r.files.length, r.aliases.length, r.aliases[0]?.winner], [1, 1, ofile], "one lineage under two devices is indexed once (alias reported)");
  eq((await rowsOf(store)).filter((x) => x.sessionFile === file).length, 0, "…the alias path gets no rows");

  const mp = path.join(data, "durable-manifest.json");
  const good = loadDurableManifest(mp);
  const tamper = async (edit: (e: (typeof good.files)[string]) => void, reason: string, msg: string) => {
    const m = JSON.parse(JSON.stringify(good));
    edit(m.files[ofile]);
    saveDurableManifest(mp, m);
    const rr = await runDurableIndex(deps(corpus, data, { store, provider }));
    eq([rr.files[0].status, rr.files[0].reason?.split(":")[0]], ["refused", reason], msg);
  };
  await tamper((e) => (e.policy = "B.0"), "durable-policy-changed", "a different policy version is refused");
  await tamper((e) => (e.lineage = "other"), "durable-lineage-mismatch", "a different lineage is refused");
  await tamper((e) => (e.witness = { id: e.witness!.id, sha256: "00" }), "durable-diverged", "a changed witness is refused");
  await tamper((e) => (e.processedId = 999), "durable-rollback", "a snapshot behind the checkpoint is refused");
  saveDurableManifest(mp, good);

  await store.close();
}

// ---------------------------------------------------------------------------
console.log("\n# one lineage keeps one indexed path (winner churn)");
// ---------------------------------------------------------------------------
{
  // (1) an alias of the same bytes appears after the first sync and wins the tie.
  const corpus = newCorpus("corpus-churn-tie");
  await admit(corpus, SNAP2);
  const a = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  const { store, data } = await freshStore("data-churn-tie");
  const provider = new StubProvider();
  await runDurableIndex(deps(corpus, data, { store, provider }));
  const calls = provider.calls;
  await admit(corpus, SNAP2, "oracle");
  const r = await runDurableIndex(deps(corpus, data, { store, provider }));
  const refusedRow = r.files.find((f) => f.status === "refused");
  eq(refusedRow?.reason?.split(":")[0], "durable-winner-path-changed", "tie alias after the first sync → durable-winner-path-changed");
  truthy(refusedRow?.reason?.includes(a), "…naming the path already indexed");
  const rows = await rowsOf(store);
  eq([rows.filter((x) => x.sessionFile === a).length, rows.length, provider.calls - calls], [4, 4, 0], "accepted rows kept, nothing re-embedded, no duplicates");
  await store.close();
}
{
  // (2) a copy elsewhere grows past the indexed one and becomes the winner.
  const corpus = newCorpus("corpus-churn-newer");
  await admit(corpus, SNAP2);
  const a = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  const { store, data } = await freshStore("data-churn-newer");
  const provider = new StubProvider();
  await runDurableIndex(deps(corpus, data, { store, provider }));
  const newer = path.join(tmp, "newer", BUCKET, MID_SESSION, "session.sqlite");
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.copyFileSync(SNAP2, newer);
  const db = new DatabaseSync(newer);
  const last = db.prepare("SELECT id, conversation_id, commit_seq, record FROM entries ORDER BY id DESC LIMIT 1").get()!;
  db.prepare("INSERT INTO entries VALUES (?, ?, NULL, ?, ?)").run(Number(last.id) + 10, last.conversation_id, Number(last.commit_seq) + 10, String(last.record).replace(/"id":\d+/, `"id":${Number(last.id) + 10}`));
  db.close();
  await admit(corpus, newer, "oracle");
  const calls = provider.calls;
  const r = await runDurableIndex(deps(corpus, data, { store, provider }));
  eq(r.files.find((f) => f.status === "refused")?.reason?.split(":")[0], "durable-winner-path-changed", "a newer copy elsewhere → durable-winner-path-changed");
  const rows = await rowsOf(store);
  eq([rows.filter((x) => x.sessionFile === a).length, rows.length, provider.calls - calls], [4, 4, 0], "accepted rows kept, nothing re-embedded, no duplicates");
  await store.close();
}

// ---------------------------------------------------------------------------
console.log("\n# the checkpoint never outlives its rows");
// ---------------------------------------------------------------------------
const subEnv = (data: string, corpus: string) => ({
  ...process.env,
  ANDENKEN_DATA: data,
  ANDENKEN_SESSION_CORPUS: corpus,
  ANDENKEN_SESSION_PROVIDER: "vllm",
  ANDENKEN_SESSION_ENDPOINT: "http://127.0.0.1:9",
  ANDENKEN_SESSION_MODEL: "stub-model",
  ANDENKEN_SESSION_DIMENSIONS: "4",
  ANDENKEN_INDEX_AUTHORITY: fs.readFileSync(path.join(os.homedir(), ".current-device"), "utf-8").trim(),
  ANDENKEN_SESSIONS_LOCK_TOKEN: "",
});
const TSX = path.join(repo, "node_modules", ".bin", "tsx");
const indexer = (env: NodeJS.ProcessEnv, args: string[]) => spawnSync(TSX, [path.join(repo, "indexer.ts"), ...args], { env, cwd: repo, encoding: "utf-8" });
{
  const corpus = newCorpus("corpus-consist");
  await admit(corpus, SNAP2);
  const file = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  const { store, data } = await freshStore("data-consist");
  const provider = new StubProvider();
  const mp = path.join(data, "durable-manifest.json");
  await runDurableIndex(deps(corpus, data, { store, provider }));
  await store.close();
  const env = subEnv(data, corpus);

  // index:sessions --force wipes the table → the durable checkpoint goes too.
  const f = indexer({ ...env, ANDENKEN_ALLOW_PAID_FULL_REBUILD: "1" }, ["sessions", "--force"]);
  const s1 = new VectorStore(path.join(data, "sessions.lance"), 4);
  await s1.init();
  eq([f.status, fs.existsSync(mp), (await rowsOf(s1)).length], [0, false, 0], "sessions --force: rows and durable checkpoint gone together");
  await s1.ensureTable();
  const back = await runDurableIndex(deps(corpus, data, { store: s1, provider }));
  eq([back.files[0].status, (await rowsOf(s1)).filter((x) => x.sessionFile === file).length], ["indexed", 4], "…and the next durable run rebuilds from 0");
  await s1.close();

  // cleanup removes an orphan durable file's rows → its checkpoint is dropped; re-admit recovers.
  fs.rmSync(file);
  const c = indexer(env, ["cleanup", "sessions"]);
  truthy(c.status === 0 && c.stdout.includes("Durable checkpoints dropped: 1"), "cleanup sessions drops the orphan file's checkpoint with its rows");
  eq(loadDurableManifest(mp).files[file], undefined, "…the manifest no longer claims it");
  await admit(corpus, SNAP2);
  const s2 = new VectorStore(path.join(data, "sessions.lance"), 4);
  await s2.init();
  const again = await runDurableIndex(deps(corpus, data, { store: s2, provider }));
  const rows = (await rowsOf(s2)).filter((x) => x.sessionFile === file);
  eq([again.files[0].status, rows.length, new Set(rows.map((x) => x.id)).size], ["indexed", 4, 4], "re-admitted copy re-indexes to the same 4 rows, no duplicates");
  await s2.close();
}
{
  // Crash windows. The checkpoint goes first and the rows second, so a failure in
  // between leaves rows without a checkpoint (re-processed later), never a
  // checkpoint claiming rows that are gone.
  const corpus = newCorpus("corpus-order");
  await admit(corpus, SNAP2);
  const file = durableCorpusPath(corpus, "thinkpad", BUCKET, MID_SESSION);
  const { store, data } = await freshStore("data-order");
  const provider = new StubProvider();
  const mp = path.join(data, "durable-manifest.json");
  await runDurableIndex(deps(corpus, data, { store, provider }));
  await store.close();
  const env = subEnv(data, corpus);
  const lance = path.join(data, "sessions.lance");
  const fileRows = async () => {
    const s = new VectorStore(lance, 4);
    await s.init();
    const rows = (await rowsOf(s)).filter((x) => x.sessionFile === file);
    await s.close();
    return rows;
  };
  // Read-only tree: LanceDB can read the table but cannot drop or delete from it.
  const writable = (dir: string, on: boolean) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) writable(p, on);
      else fs.chmodSync(p, on ? 0o644 : 0o444);
    }
    fs.chmodSync(dir, on ? 0o755 : 0o555);
  };
  const reindex = async () => {
    const s = new VectorStore(lance, 4);
    await s.init();
    const r = await runDurableIndex(deps(corpus, data, { store: s, provider }));
    const rows = (await rowsOf(s)).filter((x) => x.sessionFile === file);
    await s.close();
    return [r.files[0].status, rows.length, new Set(rows.map((x) => x.id)).size];
  };
  const force = () => indexer({ ...env, ANDENKEN_ALLOW_PAID_FULL_REBUILD: "1" }, ["sessions", "--force"]);

  // sessions --force: invalidation fails → the table is not reset.
  const saved = fs.readFileSync(mp);
  fs.rmSync(mp);
  fs.mkdirSync(path.join(mp, "blocker"), { recursive: true });
  const f1 = force();
  eq([f1.status !== 0, (await fileRows()).length], [true, 4], "sessions --force: checkpoint invalidation fails → no row is reset");
  fs.rmSync(mp, { recursive: true });
  fs.writeFileSync(mp, saved);

  // sessions --force: invalidation succeeds, the reset fails → rows stay without a checkpoint.
  writable(lance, false);
  const f2 = force();
  writable(lance, true);
  eq([f2.status !== 0, fs.existsSync(mp), (await fileRows()).length], [true, false, 4], "sessions --force: reset fails after invalidation → rows stay, checkpoint gone");
  eq(await reindex(), ["indexed", 4, 4], "…the next durable run re-indexes from 0: the same 4 rows, no duplicates");

  // cleanup: dropping the checkpoint fails → no orphan row is deleted.
  fs.rmSync(file);
  const good = fs.readFileSync(mp);
  fs.writeFileSync(mp, "{ not a manifest");
  const c1 = indexer(env, ["cleanup", "sessions"]);
  eq([c1.status !== 0, (await fileRows()).length], [true, 4], "cleanup: checkpoint drop fails → no orphan row is deleted");
  fs.writeFileSync(mp, good);

  // cleanup: the checkpoint is dropped, the row delete fails → a rerun finishes the job.
  writable(lance, false);
  const c2 = indexer(env, ["cleanup", "sessions"]);
  writable(lance, true);
  eq([c2.status !== 0, loadDurableManifest(mp).files[file], (await fileRows()).length], [true, undefined, 4], "cleanup: delete fails after the checkpoint drop → rows stay, checkpoint gone");
  const c3 = indexer(env, ["cleanup", "sessions"]);
  eq([c3.status, (await fileRows()).length], [0, 0], "…a rerun of cleanup removes the orphan rows");
  await admit(corpus, SNAP2);
  eq(await reindex(), ["indexed", 4, 4], "…and a re-admitted copy re-indexes to the same 4 rows, no duplicates");
}
{
  // index:durable --json (writing path, zero rows to embed): stdout is one JSON document.
  const corpus = newCorpus("corpus-json");
  await admit(corpus, SNAP1);
  const { store, data } = await freshStore("data-json");
  await store.close();
  const j = indexer(subEnv(data, corpus), ["durable", "--json"]);
  let parsed: { files?: Array<{ status: string }>; api?: { calls: number } } = {};
  try {
    parsed = JSON.parse(j.stdout);
  } catch {
    /* asserted below */
  }
  eq([j.status, parsed.files?.[0]?.status, parsed.api?.calls], [0, "indexed", 0], "index:durable --json: stdout parses as one JSON document with api cost inside");
}

// ---------------------------------------------------------------------------
console.log("\n# excerpt dispatch (CLI and pi tool share it)");
// ---------------------------------------------------------------------------
{
  const plan = await planDurable(SAMPLE, { liveRoots });
  const all = (await readDurableRange(SAMPLE, { limit: 10_000 }, { liveRoots })).entries;
  const glg1 = all.find((e) => e.text.startsWith("GLG-1:"))!;
  const before = all.filter((e) => e.entryId < glg1.entryId && e.kind !== "pi.system").at(-1)!;
  eq(plan.candidates.find((c) => c.entryId === before.entryId)?.B.decision, "exclude", "the turn before GLG-1 is excluded from embedding…");
  const ex = await readHitExcerpt({ source: "pi-durable", sessionFile: SAMPLE, lineNumber: glg1.entryId });
  truthy(isHitExcerpt(ex) && ex.unit === "durable-entry", "pi-durable hit → unit durable-entry");
  truthy(isHitExcerpt(ex) && ex.text.includes(`e${before.entryId} `) && ex.startLine <= before.entryId, "…but the excerpt still shows it (before ≥ 1)");
  truthy(isHitExcerpt(ex) && ex.entry === glg1.entryId && !!ex.session && !!ex.lineage, "excerpt carries entry, session and lineage");
  const missing = await readHitExcerpt({ source: "pi-durable", sessionFile: path.join(tmp, "gone.sqlite"), lineNumber: 3 });
  truthy(!isHitExcerpt(missing) && missing?.unsupported === "pi-durable:missing-file" && !!missing.read, "an unreadable durable hit is a named unsupported with a read command");
  // midrun snap2: the doorbell-mixed run's answer sits more than 3 entries after its prompt.
  const mid = (await readDurableRange(SNAP2, { limit: 10_000 }, { liveRoots })).entries;
  const promptM2 = mid.find((e) => e.text.startsWith("GLG-M2:"))!;
  const answerM2 = mid.find((e) => e.text.startsWith("FINAL-ANSWER-2"))!;
  const ex4 = await readHitExcerpt({ source: "pi-durable", sessionFile: SNAP2, lineNumber: answerM2.entryId });
  const ptrs = isHitExcerpt(ex4) ? ex4.answeredInputs ?? [] : [];
  const ptr = ptrs.find((p) => p.entryId === promptM2.entryId);
  truthy(isHitExcerpt(ex4) && ex4.startLine > promptM2.entryId, "the answer's window does not reach its prompt…");
  eq([ptr?.origin, ptr?.line?.startsWith("GLG-M2:")], ["human", true], "…so the excerpt names the prompt entry, origin and one line of it");
  truthy(isHitExcerpt(ex4) && ex4.text.includes(`answers e${promptM2.entryId} (GLG): GLG-M2:`), "…in the excerpt text too");
  truthy(isHitExcerpt(ex4) && ex4.read?.startsWith(`${path.join(repo, "run.sh")} durable:read '${SNAP2}' --around `), "excerpt read command: absolute run.sh, quoted file");
  const quoted = await readHitExcerpt({ source: "pi-durable", sessionFile: path.join(tmp, "it's gone.sqlite"), lineNumber: 3 });
  truthy(!isHitExcerpt(quoted) && quoted?.read?.includes(`'${path.join(tmp, "it'\\''s gone.sqlite")}'`), "unsupported read command shell-quotes the file");
  const jsonl = await readHitExcerpt({ source: "pi", sessionFile: SEED_JSONL, lineNumber: 1 });
  truthy(isHitExcerpt(jsonl) && jsonl.unit === "jsonl-line", "JSONL hit → unit jsonl-line");
}

// ---------------------------------------------------------------------------
console.log("\n# existing maintenance paths keep durable rows (subprocess gates)");
// ---------------------------------------------------------------------------
{
  const env = {
    ...process.env,
    ANDENKEN_DATA: gateData,
    ANDENKEN_SESSION_CORPUS: gateCorpus,
    ANDENKEN_SESSION_PROVIDER: "vllm",
    ANDENKEN_SESSION_ENDPOINT: "http://127.0.0.1:9",
    ANDENKEN_SESSION_MODEL: "stub-model",
    ANDENKEN_SESSION_DIMENSIONS: "4",
  };
  const tsx = path.join(repo, "node_modules", ".bin", "tsx");
  const run = (args: string[]) => spawnSync(tsx, [path.join(repo, "indexer.ts"), ...args], { env, cwd: repo, encoding: "utf-8" });
  const countBefore = (await rowsOf(await (async () => { const s = new VectorStore(path.join(gateData, "sessions.lance"), 4); await s.init(); return s; })())).length;

  const v = run(["verify", "sessions"]);
  truthy(v.status === 0 && v.stdout.includes("No orphan files"), "verify sessions passes with durable rows (corpus files exist)");
  const c = run(["cleanup", "sessions", "--dry-run"]);
  truthy(c.status === 0 && /Orphan files: 0\b/.test(c.stdout) && /Duplicate IDs: 0\b/.test(c.stdout), "cleanup sessions --dry-run finds no orphans or duplicates");
  const g = run(["sessions"]);
  truthy(g.status === 0 && g.stdout.includes("All sessions indexed"), "JSONL sessions run (no JSONL in corpus) exits without embedding");
  const s = new VectorStore(path.join(gateData, "sessions.lance"), 4);
  await s.init();
  const after = await rowsOf(s);
  eq([after.length, after.filter((r) => r.sessionFile === gateFile).length], [countBefore, 4], "row count unchanged; the 4 durable rows survive");
  await s.close();

  execFileSync("bash", [path.join(repo, "scripts", "corpus-manifest.sh"), "update"], { env, cwd: repo, encoding: "utf-8" });
  const manifest = JSON.parse(fs.readFileSync(path.join(gateCorpus, "MANIFEST.json"), "utf-8")) as { files: Record<string, unknown> };
  truthy(Object.keys(manifest.files).some((k) => k.endsWith(`${MID_SESSION}/session.sqlite`)), "corpus MANIFEST includes the durable snapshot");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
