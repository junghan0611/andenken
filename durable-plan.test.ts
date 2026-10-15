#!/usr/bin/env tsx
/**
 * Fixture tests for durable-plan.ts (issue #15, purpose 1 — plan only).
 *
 * API 0. Network 0. Fixtures:
 *   - probes/pi-durable/sample-1.2/              (make-sample-1.2.mjs)
 *   - probes/pi-durable/sample-1.2-midrun/snap1|snap2/ — one session, mid-run
 *     and after, with a doorbell steered into a human run (make-sample-1.2-midrun.mjs)
 *   - small schema-v1 databases built here for edges the SDK samples lack
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { DurableReadRefused, readDurableRange } from "./durable-reader.ts";
import { planDurable, type DurablePlan, type PlanCandidate } from "./durable-plan.ts";

let passed = 0;
let failed = 0;

function eq<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-durable-plan-"));
const opts = { liveRoots: [path.join(tmp, "no-live-root")] };
const probes = path.join(import.meta.dirname, "probes", "pi-durable");
const one = (dir: string) => {
  const b = fs.readdirSync(dir)[0];
  return path.join(dir, b, fs.readdirSync(path.join(dir, b))[0], "session.sqlite");
};

/** Candidate whose entry text contains `marker` (located through the reader; the plan itself has no text). */
async function at(file: string, plan: DurablePlan, marker: string): Promise<PlanCandidate> {
  for (const conv of new Set(plan.candidates.map((c) => c.conversationId))) {
    const hit = (await readDurableRange(file, { conversationId: conv, limit: 10_000 }, opts)).entries.find((e) => e.text.includes(marker));
    if (hit) return plan.candidates.find((c) => c.entryId === hit.entryId)!;
  }
  throw new Error(`no entry containing ${marker}`);
}

console.log("\n# SDK 1.2.0 sample");
{
  const f = one(path.join(probes, "sample-1.2"));
  const plan = await planDurable(f, opts);
  truthy(plan.snapshot.lineage?.length === 36, "lineage = root pi.provider sessionId");
  eq([plan.totals.B.include.entries, plan.totals.B.ambiguous.entries, plan.totals.B.hold.entries], [25, 1, 0], "B: 25 include (12 human + 10 answers + 3 compaction/handoff), 1 ambiguous");
  eq(plan.totals.C.include.entries, 30, "C: 30 include");
  eq(plan.totals.B.include.estTokens, Math.ceil(plan.totals.B.include.chars / 2.5), "estTokens follows the stated chars/2.5 assumption");
  eq((await at(f, plan, "GLG-8:")).B.decision, "include", "a 17-char GLG turn is included (no length floor)");
  const a6 = await at(f, plan, "ASSISTANT-6a");
  eq(a6.B.decision, "ambiguous", "answer before an unsubmitted continuation → ambiguous");
  truthy(a6.B.basis.includes("unsubmitted"), "…naming the intruding entry's origin");
  eq((await at(f, plan, "ASSISTANT-6b")).B.decision, "include", "the explicit answer after it is included");
  const bell = await at(f, plan, "ASSISTANT-3");
  eq([bell.B.decision, bell.C.decision], ["exclude", "include"], "reply to a doorbell: B excludes, C includes");
  eq((await at(f, plan, "ASSISTANT-0")).B.decision, "exclude", "reply to the launcher brief: B excludes");
  eq((await at(f, plan, "SUBAGENT-ANSWER")).C.decision, "exclude", "task-owned subagent answer: C excludes");
  eq((await at(f, plan, "PARTIAL-ERR")).B.decision, "exclude", "provider error text is excluded");
  eq((await at(f, plan, "HOOK-CONTINUE")).B.decision, "exclude", "unsubmitted user text is never included");
  const handoff = await at(f, plan, "HANDOFF-RESET");
  eq([handoff.B.decision, handoff.role], ["include", "compaction"], "handoff is included as role compaction");
  const dump = JSON.stringify(plan);
  truthy(!dump.includes("GLG-1:") && !dump.includes("SIBLING-BODY"), "the plan carries no entry text");
}

console.log("\n# one session, two snapshots: open run → hold, then settled");
{
  const s1 = one(path.join(probes, "sample-1.2-midrun", "snap1"));
  const s2 = one(path.join(probes, "sample-1.2-midrun", "snap2"));
  const p1 = await planDurable(s1, opts);
  const p2 = await planDurable(s2, opts);
  eq(p1.snapshot.lineage, p2.snapshot.lineage, "both snapshots carry the same lineage");
  const h1 = await at(s1, p1, "응 진행해");
  eq([h1.B.decision, h1.chars], ["include", 5], "a 5-char GLG decision is included");
  eq((await at(s1, p1, "INTERMEDIATE-EXPLAIN")).B.decision, "hold", "snap1: text inside the open run is held");
  eq([p1.watermark.heldBy, p1.watermark.safeProcessedId], [h1.entryId, h1.entryId - 1], "snap1: watermark stops before the open human input");
  eq((await at(s1, p1, "INTERMEDIATE-EXPLAIN")).C.decision, "include", "snap1: C includes it without waiting");
  eq((await at(s2, p2, "INTERMEDIATE-EXPLAIN")).B.decision, "include", "snap2: the same entry is included once the run has its answer");
  eq((await at(s2, p2, "FINAL-ANSWER-1")).B.decision, "include", "snap2: the final answer is included");
  eq([p2.watermark.heldBy, p2.watermark.safeProcessedId], [null, p2.watermark.maxEntryId], "snap2: nothing held");
  const mixed = await at(s2, p2, "MIXED-EXPLAIN");
  eq(mixed.B.decision, "ambiguous", "a doorbell steered into the human run makes the range ambiguous");
  truthy(mixed.B.basis.includes("entwurf-doorbell"), "…naming the doorbell");
  const final2 = await at(s2, p2, "FINAL-ANSWER-2");
  eq(final2.B.decision, "ambiguous", "an answer shared by the human input and the doorbell is ambiguous");
}

// ---------------------------------------------------------------------------
// Built databases (schema v1 DDL subset)
// ---------------------------------------------------------------------------

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };

function build(file: string, rows: Array<{ id: number; kind: string; role: string; text: string; sub?: { id: number; requestId?: string; answer?: number } }>): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL, key_value TEXT NOT NULL, scope_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, record TEXT NOT NULL);
    CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (document_id, seq));
    INSERT INTO durable_schema VALUES (1, 1);
    INSERT INTO conversations VALUES (1, NULL, NULL, '{"id":1}');
  `);
  let seq = 1;
  for (const r of rows) {
    const record = { id: r.id, conversationId: 1, kind: r.kind, model: [{ role: r.role, content: [{ type: "text", text: r.text }], ...(r.role === "assistant" ? { stopReason: "stop" } : {}) }] };
    db.prepare("INSERT INTO entries VALUES (?, 1, NULL, ?, ?)").run(r.id, seq++, JSON.stringify(record));
    if (r.sub) {
      const s = r.sub;
      const rec = { id: s.id, conversationId: 1, type: "input", status: "done", entry: r.id, ...(s.requestId ? { requestId: s.requestId } : {}), ...(s.answer ? { answer: s.answer } : {}) };
      db.prepare("INSERT INTO submissions VALUES (?, 1, ?, 'done', ?)").run(s.id, s.requestId ? JSON.stringify(s.requestId) : null, JSON.stringify(rec));
    }
  }
  db.close();
  return file;
}

console.log("\n# edges (built DBs)");
{
  const f = build(path.join(tmp, "edges", "session.sqlite"), [
    { id: 10, kind: "pi.user", role: "user", text: "   ", sub: { id: 11, answer: 12 } },
    { id: 12, kind: "pi.assistant", role: "assistant", text: "reply to an empty turn" },
    { id: 13, kind: "pi.user", role: "user", text: "from an unknown host path", sub: { id: 14, requestId: "mystery-host:1", answer: 15 } },
    { id: 15, kind: "pi.assistant", role: "assistant", text: "reply to the unknown input" },
  ]);
  const plan = await planDurable(f, opts);
  const c = (id: number) => plan.candidates.find((x) => x.entryId === id)!;
  eq([c(10).B.decision, c(10).B.basis], ["exclude", "empty human input"], "whitespace-only human turn is excluded");
  eq(c(13).B.decision, "exclude", "unknown origin is never treated as human");
  eq(c(15).B.decision, "exclude", "…and its reply is not a human-run answer");
  truthy(c(15).B.basis.includes("explicit answer of e13 (unknown)"), "…and its exclusion names the explicit link, not a run guess");
  eq(plan.snapshot.project, null, "no pi.agent document → project null (shown as unknown, never guessed)");
  // B.1: a human steered into a human run is not a mix.
  const steer = build(path.join(tmp, "steer", "session.sqlite"), [
    { id: 20, kind: "pi.user", role: "user", text: "first human turn", sub: { id: 21, answer: 24 } },
    { id: 22, kind: "pi.assistant", role: "assistant", text: "working on it, reading files" },
    { id: 23, kind: "pi.user", role: "user", text: "steered human turn", sub: { id: 25, answer: 24 } },
    { id: 24, kind: "pi.assistant", role: "assistant", text: "one answer for both turns" },
    { id: 26, kind: "pi.assistant", role: "assistant", text: "text after the run with no link" },
  ]);
  const sp = await planDurable(steer, opts);
  const sc = (id: number) => sp.candidates.find((x) => x.entryId === id)!;
  eq([sc(22).B.decision, sc(24).B.decision], ["include", "include"], "B.1: a human steer inside a human run keeps the run's text included");
  truthy(sc(26).B.decision === "exclude" && sc(26).B.basis.includes("no explicit answer link"), "an exclusion without a link says so instead of attributing the run");
  try {
    const liveRoot = path.join(tmp, "live");
    const liveFile = build(path.join(liveRoot, "b", "s", "session.sqlite"), []);
    await planDurable(liveFile, { liveRoots: [liveRoot] });
    failed++;
    console.log("  ❌ plan refuses a live-root file (not refused)");
  } catch (err) {
    eq(err instanceof DurableReadRefused ? err.reason : String(err), "live-store", "plan inherits the reader's live-store refusal");
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
