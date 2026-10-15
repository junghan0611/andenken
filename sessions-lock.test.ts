#!/usr/bin/env tsx
/**
 * Tests for the shared sessions.lance writer lock (sessions-lock.ts and
 * scripts/lib/sessions-lock.sh).
 *
 * API 0. Temp data dirs only. Subprocess writers get a vLLM provider at
 * 127.0.0.1:9, so nothing can reach a paid endpoint.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireSessionsLock,
  readSessionsLockOwner,
  sessionsLockDir,
  SessionsLockRefused,
  withSessionsLock,
  SESSIONS_LOCK_ENV,
} from "./sessions-lock.ts";
import { admitDurableSnapshot } from "./durable-source.ts";
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
function refusedReason(fn: () => unknown): string {
  try {
    fn();
    return "not refused";
  } catch (err) {
    return err instanceof SessionsLockRefused ? err.reason : String(err);
  }
}

const repo = import.meta.dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-sessions-lock-"));
const TSX = path.join(repo, "node_modules", ".bin", "tsx");
const deadPid = (() => {
  const p = spawnSync("true");
  return p.pid!;
})();

console.log("\n# node semantics");
{
  const data = path.join(tmp, "d1");
  const lock = acquireSessionsLock("test-a", { dataDir: data, env: {} });
  const dir = sessionsLockDir(data);
  const owner = readSessionsLockOwner(dir);
  eq([lock.reentrant, owner?.pid, owner?.command, owner?.token === lock.token], [false, process.pid, "test-a", true], "acquire writes the owner atomically");
  eq(refusedReason(() => acquireSessionsLock("test-b", { dataDir: data, env: {} })), "sessions-writer-busy", "a second writer is refused while the owner lives");
  const child = acquireSessionsLock("test-child", { dataDir: data, env: lock.childEnv({}) });
  eq(child.reentrant, true, "a child carrying the owner's token re-enters");
  child.release();
  truthy(fs.existsSync(dir), "a re-entered handle's release leaves the lock");
  truthy(!(SESSIONS_LOCK_ENV in process.env), "the token is never written into process.env");
  lock.release();
  truthy(!fs.existsSync(dir), "the owner's release removes the lock");
  acquireSessionsLock("test-c", { dataDir: data, env: {} }).release();
  truthy(!fs.existsSync(dir), "the lock can be taken again after release");
}
{
  const data = path.join(tmp, "d2");
  const dir = sessionsLockDir(data);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "owner"), `pid=${deadPid}\ntoken=deadbeefdeadbeef\ncommand=old\nstartedAt=2026-01-01T00:00:00Z\nhost=x\n`);
  eq(refusedReason(() => acquireSessionsLock("test", { dataDir: data, env: {} })), "sessions-writer-stale-lock", "a dead owner's lock is refused as stale");
  eq(refusedReason(() => acquireSessionsLock("test", { dataDir: data, env: { [SESSIONS_LOCK_ENV]: "deadbeefdeadbeef" } })), "sessions-writer-stale-lock", "a stale owner's token does not let anyone in");
  truthy(fs.existsSync(path.join(dir, "owner")), "a stale lock is never reclaimed automatically");
  fs.rmSync(dir, { recursive: true });
  const empty = path.join(tmp, "d2b");
  fs.mkdirSync(sessionsLockDir(empty), { recursive: true });
  eq(refusedReason(() => acquireSessionsLock("test", { dataDir: empty, env: {} })), "sessions-writer-stale-lock", "a lock without a readable owner is refused as stale");
}
{
  const data = path.join(tmp, "d3");
  const lock = acquireSessionsLock("mine", { dataDir: data, env: {} });
  const dir = sessionsLockDir(data);
  fs.writeFileSync(path.join(dir, "owner"), `pid=${process.pid}\ntoken=someoneelse00000\ncommand=other\nstartedAt=x\nhost=x\n`);
  lock.release();
  truthy(fs.existsSync(dir), "release never removes a lock that carries another token");
  fs.rmSync(dir, { recursive: true });
  await withSessionsLock("throws", async () => {
    throw new Error("boom");
  }, { dataDir: data, env: {} }).catch(() => {});
  truthy(!fs.existsSync(dir), "the lock is released when the guarded work fails");
}

console.log("\n# shell semantics (scripts/lib/sessions-lock.sh)");
{
  const data = path.join(tmp, "d4");
  const childScript = path.join(tmp, "child.mts");
  fs.writeFileSync(
    childScript,
    `import { acquireSessionsLock } from ${JSON.stringify(path.join(repo, "sessions-lock.ts"))};\n` +
      `const h = acquireSessionsLock("child", { dataDir: ${JSON.stringify(data)} });\n` +
      `console.log(h.reentrant ? "reentrant" : "acquired");\nh.release();\n`,
  );
  const env = { ...process.env, ANDENKEN_DATA: data, [SESSIONS_LOCK_ENV]: "" };
  const r = spawnSync("bash", ["-c", `. scripts/lib/sessions-lock.sh; sessions_lock_acquire "shell-holder"; "${TSX}" "${childScript}"; ls "$(sessions_lock_dir)" >/dev/null && echo still-held`], { cwd: repo, env, encoding: "utf-8" });
  eq([r.status, r.stdout.trim().split("\n")], [0, ["reentrant", "still-held"]], "a node child of the shell holder re-enters; the lock outlives the child");
  truthy(!fs.existsSync(sessionsLockDir(data)), "the shell holder releases on exit");

  const holder = spawn("bash", ["-c", `. scripts/lib/sessions-lock.sh; sessions_lock_acquire "shell-sleeper"; sleep 3`], { cwd: repo, env });
  for (let i = 0; i < 50 && !readSessionsLockOwner(sessionsLockDir(data)); i++) await new Promise((r2) => setTimeout(r2, 100));
  eq(refusedReason(() => acquireSessionsLock("outsider", { dataDir: data, env: {} })), "sessions-writer-busy", "an outside process is refused while the shell holder lives");
  const second = spawnSync("bash", ["-c", `. scripts/lib/sessions-lock.sh; sessions_lock_acquire "second-shell"; echo got-it`], { cwd: repo, env: { ...process.env, ANDENKEN_DATA: data, [SESSIONS_LOCK_ENV]: "" }, encoding: "utf-8" });
  truthy(second.status === 75 && second.stderr.includes("sessions-writer-busy"), "a second shell holder exits 75 with sessions-writer-busy");
  await new Promise((r2) => holder.on("exit", r2));
  truthy(!fs.existsSync(sessionsLockDir(data)), "the lock is gone after the shell holder exits");
}

console.log("\n# real writers race the lock (subprocess)");
{
  const data = path.join(tmp, "race-data");
  const corpus = path.join(tmp, "race-corpus");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, "DEVICES.json"), JSON.stringify({ devices: [{ id: "thinkpad", state: "active", transport: "push" }] }));
  const snap1 = (() => {
    const dir = path.join(repo, "probes", "pi-durable", "sample-1.2-midrun", "snap1");
    const b = fs.readdirSync(dir)[0];
    return path.join(dir, b, fs.readdirSync(path.join(dir, b))[0], "session.sqlite");
  })();
  await admitDurableSnapshot({ input: snap1, device: "thinkpad", corpus, liveRoots: [path.join(tmp, "none")] });
  const store = new VectorStore(path.join(data, "sessions.lance"), 4);
  await store.init();
  await store.ensureTable();
  await store.close();
  const env = {
    ...process.env,
    ANDENKEN_DATA: data,
    ANDENKEN_SESSION_CORPUS: corpus,
    ANDENKEN_SESSION_PROVIDER: "vllm",
    ANDENKEN_SESSION_ENDPOINT: "http://127.0.0.1:9",
    ANDENKEN_SESSION_MODEL: "stub-model",
    ANDENKEN_SESSION_DIMENSIONS: "4",
    ANDENKEN_INDEX_AUTHORITY: fs.readFileSync(path.join(os.homedir(), ".current-device"), "utf-8").trim(),
    [SESSIONS_LOCK_ENV]: "",
    SKIP_GATHER: "1",
  };
  // The winner: a shell writer that holds the lock and writes its own marker manifest.
  const marker = JSON.stringify({ version: 1, files: { "/winner/marker": {} }, lastUpdated: "winner" });
  const winner = spawn("bash", ["-c", `. scripts/lib/sessions-lock.sh; sessions_lock_acquire "winner-writer"; printf '%s' '${marker}' > "$ANDENKEN_DATA/durable-manifest.json"; sleep 4`], { cwd: repo, env });
  for (let i = 0; i < 50 && !readSessionsLockOwner(sessionsLockDir(data)); i++) await new Promise((r2) => setTimeout(r2, 100));
  const run = (args: string[]) => spawnSync(TSX, [path.join(repo, "indexer.ts"), ...args], { cwd: repo, env, encoding: "utf-8" });
  const durable = run(["durable"]);
  eq([durable.status, durable.stderr.includes("sessions-writer-busy")], [75, true], "index:durable loses: exit 75, sessions-writer-busy");
  const jsonl = run(["sessions"]);
  eq([jsonl.status, jsonl.stderr.includes("sessions-writer-busy")], [75, true], "index:sessions loses the same way");
  const sync = spawnSync("bash", [path.join(repo, "scripts", "sync-sessions.sh")], { cwd: repo, env, encoding: "utf-8" });
  eq([sync.status, sync.stderr.includes("sessions-writer-busy")], [75, true], "sync-sessions.sh (the warm path) loses the same way");
  const dry = run(["durable", "--dry-run"]);
  eq(dry.status, 0, "index:durable --dry-run needs no lock and runs meanwhile");
  eq(fs.readFileSync(path.join(data, "durable-manifest.json"), "utf-8"), marker, "the losers wrote nothing into the winner's manifest");
  await new Promise((r2) => winner.on("exit", r2));
  const s = new VectorStore(path.join(data, "sessions.lance"), 4);
  await s.init();
  eq(await s.getCount(), 0, "the losers wrote no rows");
  await s.close();

  fs.rmSync(path.join(data, "durable-manifest.json"));
  const after = run(["durable"]);
  truthy(after.status === 0 && fs.existsSync(path.join(data, "durable-manifest.json")), "after the winner exits, index:durable takes the lock and writes its checkpoint");
  truthy(!fs.existsSync(sessionsLockDir(data)), "…and releases it");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
