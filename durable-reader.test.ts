#!/usr/bin/env tsx
/**
 * Fixture tests for durable-reader.ts (issue #15, purpose 2).
 *
 * API 0. Network 0. Two kinds of fixture:
 *   - probes/pi-durable/sample-1.2/…/session.sqlite, written by the published
 *     pi-durable 1.2.0 SDK with a faux provider (make-sample-1.2.mjs). Entries
 *     are located by their text markers, not by id, so a regenerated sample
 *     keeps the assertions valid.
 *   - small databases built here with the SDK's schema v1 DDL, for refusals
 *     and the classification edges the SDK sample cannot produce on demand.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  censusDurable,
  DurableReadRefused,
  LEGACY_ENTWURF_BRIEF,
  readDurableAround,
  readDurableRange,
  type DurableEntryView,
  type DurableRefusalReason,
} from "./durable-reader.ts";

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

async function refused(run: () => Promise<unknown>, reason: DurableRefusalReason, msg: string): Promise<void> {
  try {
    await run();
    failed++;
    console.log(`  ❌ ${msg} (not refused)`);
  } catch (err) {
    if (err instanceof DurableReadRefused && err.reason === reason) {
      passed++;
      console.log(`  ✅ ${msg}`);
    } else {
      failed++;
      console.log(`  ❌ ${msg} (got ${err instanceof DurableReadRefused ? err.reason : String(err)})`);
    }
  }
}

const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// A live root that holds nothing, so the developer's real live root is never consulted.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-durable-"));
const noLive = path.join(tmp, "no-live-root");
const opts = { liveRoots: [noLive] };

// ---------------------------------------------------------------------------
// SDK 1.2.0 sample
// ---------------------------------------------------------------------------

const sampleRoot = path.join(import.meta.dirname, "probes", "pi-durable", "sample-1.2");
const sample = fs
  .readdirSync(sampleRoot)
  .flatMap((b) => fs.readdirSync(path.join(sampleRoot, b)).map((s) => path.join(sampleRoot, b, s, "session.sqlite")))[0];
const sampleDir = path.dirname(sample);
const sampleShaBefore = sha(sample);

async function allEntries(file: string): Promise<DurableEntryView[]> {
  const census = await censusDurable(file, opts);
  const out: DurableEntryView[] = [];
  for (const c of census.conversations) {
    out.push(...(await readDurableRange(file, { conversationId: c.id, limit: 10_000 }, opts)).entries);
  }
  return out;
}

function byText(entries: DurableEntryView[], marker: string): DurableEntryView {
  const hit = entries.find((e) => e.text.includes(marker));
  if (!hit) throw new Error(`fixture has no entry containing ${marker}`);
  return hit;
}

console.log("\n# census (SDK 1.2.0 sample)");
{
  const c = await censusDurable(sample, opts);
  eq(c.snapshot.schema, 1, "schema v1");
  eq(c.snapshot.project, "andenken", "project from root pi.agent cwd");
  eq(c.snapshot.bucketMatchesCwd, true, "bucket = sha256(cwd)[:24]");
  truthy(c.snapshot.sessionId?.startsWith("1792000000000-"), "session id from the directory name");
  eq(c.snapshot.device, null, "no corpus device segment outside a corpus path");
  eq(c.conversations.map((x) => x.scope), ["root", "task-owned", "fork"], "conversation scopes");
  eq(c.entries.byOrigin.human, 12, "12 human turns (GLG-1…15 minus the ones that are not)");
  eq(c.entries.byOrigin.unsubmitted, 1, "hook continuation is unsubmitted, not human");
  eq(
    [c.entries.byOrigin["entwurf-brief"], c.entries.byOrigin["entwurf-doorbell"], c.entries.byOrigin["subagent-brief"], c.entries.byOrigin["background-report"]],
    [1, 1, 1, 1],
    "brief / doorbell / subagent / background report each named",
  );
  eq([c.entries.byOrigin["input-entry"], c.entries.byOrigin.display], [1, 1], "1.2.0 input entry and display-only write");
  eq(c.compactions.length, 1, "one compaction listed with its head");
  truthy(!JSON.stringify(c).includes("GLG-1"), "census carries no entry text");
}

console.log("\n# origin and basis (SDK 1.2.0 sample)");
const entries = await allEntries(sample);
{
  eq(byText(entries, "GLG-1:").origin, "human", "TUI input → human");
  truthy(byText(entries, "GLG-1:").basis.includes("not an authorship proof"), "human basis states it is an inference");
  eq(byText(entries, "HOOK-CONTINUE").origin, "unsubmitted", "onYield continuation (no submission) → unsubmitted");
  eq(byText(entries, "HOOK-CONTINUE").submission, null, "…and has no placing submission");
  eq(byText(entries, "You are a fresh visible citizen").origin, "entwurf-brief", "entwurf-first-input → entwurf-brief");
  eq(byText(entries, "[entwurf inbox]").origin, "entwurf-doorbell", "doorbell");
  const brief = byText(entries, "SUBAGENT-TASK");
  eq([brief.origin, brief.scope], ["subagent-brief", "task-owned"], "subagent brief lives in the task-owned child");
  eq(byText(entries, "[bash_background]").origin, "background-report", "background report");
  eq(byText(entries, "CUSTOM-INPUT").origin, "input-entry", "host input kind → input-entry, not human");
  eq(byText(entries, "DISPLAY-ONLY").origin, "display", "display-only write");
  truthy(byText(entries, "HANDOFF-RESET").basis.includes("reset() write submission"), "reset(handoff) basis");
  truthy(byText(entries, "HANDOFF-TOOL").basis.includes("tool-control"), "tool-control handoff basis");
  const steered = byText(entries, "GLG-9:");
  eq(steered.origin, "human", "steered input placed at a boundary is still human");
  truthy(steered.byTaskId !== null, "…even though it carries a byTaskId (byTaskId does not decide origin)");
  eq(byText(entries, "PARTIAL-ERR").stopReason, "error", "a provider error answer stays readable with its stop reason");
}

console.log("\n# explicit answers only");
{
  const glg6 = byText(entries, "GLG-6:");
  const final = byText(entries, "ASSISTANT-6b");
  const first = byText(entries, "ASSISTANT-6a");
  eq(glg6.submission?.answer, final.entryId, "GLG-6 submission.answer is the final answer after the continuation");
  eq(final.answers, [glg6.submission?.id], "final answer lists the submission that names it");
  eq(first.answers, [], "the intermediate answer is not joined to any input");
  eq(final.answeredInputs, [{ submissionId: glg6.submission!.id, entryId: glg6.entryId, origin: "human" }], "answeredInputs resolves the submission id to the input entry and its origin");
  truthy(!entries.some((e) => e.entryId === final.answers[0]), "a submission id in answers is not an entry id of this snapshot");
  eq(byText(entries, "ASSISTANT-3").answeredInputs[0]?.origin, "entwurf-doorbell", "a doorbell's answer resolves to the doorbell input");
}

console.log("\n# raw text survives compaction, reports survive in tool results");
{
  const compaction = entries.find((e) => e.kind === "pi.compaction")!;
  truthy(compaction.head !== null, "compaction has a head");
  const before = await readDurableRange(sample, { from: 1, to: compaction.head! - 1 }, opts);
  truthy(before.entries.some((e) => e.text.startsWith("GLG-1:") && e.origin === "human"), "GLG-1 is readable before the compaction head");
  const report = byText(entries, "SIBLING-BODY");
  eq([report.origin, report.toolName], ["tool-result", "entwurf_inbox_read"], "sibling report is a tool result of entwurf_inbox_read");
  eq(report.truncated, false, "…and is returned whole");
  const call = entries.find((e) => e.toolCalls.some((c) => c.name === "entwurf_inbox_read"))!;
  eq((call.toolCalls[0].arguments as { gardenId?: string }).gardenId, "20261015T114746-1ee521", "the coordinator's tool call arguments are preserved");
}

console.log("\n# windows stay inside one conversation");
{
  const brief = byText(entries, "SUBAGENT-TASK");
  const around = await readDurableAround(sample, brief.entryId, 5, 5, opts);
  truthy(around.entries.every((e) => e.conversationId === brief.conversationId), "around a child entry → child entries only");
  const parentCall = entries.find((e) => e.conversationId === 1 && e.toolCalls.some((c) => c.name === "subagent"))!;
  const rootAround = await readDurableAround(sample, parentCall.entryId, 5, 5, opts);
  truthy(rootAround.entries.every((e) => e.conversationId === 1), "around a root entry → no child entries mixed in");
  eq(rootAround.entries.length, 11, "5 before + center + 5 after, counted in root physical entries");
  const fork = entries.find((e) => e.scope === "fork")!;
  const forkRead = await readDurableRange(sample, { conversationId: fork.conversationId }, opts);
  eq(forkRead.entries.length, 2, "fork range = its own physical entries (inheritance not materialised)");
  eq(forkRead.conversation.parent?.conversationId, 1, "fork names its parent");
}

console.log("\n# truncation and continuation are explicit");
{
  const glg1 = byText(entries, "GLG-1:");
  const cut = await readDurableAround(sample, glg1.entryId, 0, 0, { ...opts, maxChars: 10 });
  const e = cut.entries[0];
  eq([e.truncated, e.text.length, e.chars > 10], [true, 10, true], "cut entry reports truncated + full length");
  eq(cut.truncatedEntries, 1, "result counts truncated entries");
  const page = await readDurableRange(sample, { limit: 3 }, opts);
  eq(page.entries.length, 3, "range honours limit");
  const rest = await readDurableRange(sample, { from: page.next!.from, limit: 1 }, opts);
  truthy(rest.entries[0].entryId > page.entries[2].entryId, "next.from continues after the page");
}

console.log("\n# reading leaves the snapshot untouched");
{
  eq(fs.readdirSync(sampleDir), ["session.sqlite"], "no -wal/-shm/-journal created");
  eq(sha(sample), sampleShaBefore, "snapshot bytes unchanged");
}

// ---------------------------------------------------------------------------
// Built databases (schema v1 DDL, pi-durable storage/sqlite/migrations.js)
// ---------------------------------------------------------------------------

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (p: string) => SqliteDb;
};

const DDL = `
CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL);
CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL, key_value TEXT NOT NULL, scope_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, record TEXT NOT NULL);
CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (document_id, seq));
`;

interface Row {
  id: number;
  kind: string;
  text?: string;
  role?: string;
  /** Raw model array; overrides `text`/`role`. */
  model?: unknown[];
  edits?: unknown[];
  submission?: { id: number; type: "input" | "write"; status?: string; requestId?: string; answer?: number };
}

interface BuildOptions {
  version?: number;
  wal?: boolean;
  /** cwd of each pi.agent base revision, oldest first. */
  bases?: string[];
  /** Chord ops of one delta revision after the last base. */
  deltaOps?: unknown[];
}

function build(file: string, rows: Row[], o: BuildOptions = {}): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (o.wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(DDL);
  db.prepare("INSERT INTO durable_schema VALUES (1, ?)").run(o.version ?? 1);
  db.prepare("INSERT INTO conversations VALUES (1, NULL, NULL, ?)").run(JSON.stringify({ id: 1 }));
  db.prepare("INSERT INTO documents VALUES (2, '\"pi.agent\"', 0, '\"\"', 'conversation', 1, 1, NULL, '{}')").run();
  const bases = o.bases ?? ["/home/u/repos/gh/demo"];
  bases.forEach((cwd, i) => db.prepare("INSERT INTO document_revisions VALUES (2, ?, 'base', 1, ?)").run(i + 1, JSON.stringify({ cwd })));
  if (o.deltaOps) db.prepare("INSERT INTO document_revisions VALUES (2, ?, 'delta', 1, ?)").run(bases.length + 1, JSON.stringify(o.deltaOps));
  let seq = 1;
  for (const r of rows) {
    const record: Record<string, unknown> = { id: r.id, conversationId: 1, kind: r.kind };
    if (r.model) record.model = r.model;
    else if (r.text !== undefined) record.model = [{ role: r.role ?? "user", content: [{ type: "text", text: r.text }], timestamp: 1_792_000_000_000 + r.id }];
    if (r.edits) record.edits = r.edits;
    db.prepare("INSERT INTO entries VALUES (?, 1, NULL, ?, ?)").run(r.id, seq++, JSON.stringify(record));
    if (r.submission) {
      const s = r.submission;
      const status = s.status ?? "done";
      const rec = {
        id: s.id, conversationId: 1, type: s.type, status, entry: r.id,
        ...(s.requestId ? { requestId: s.requestId } : {}),
        ...(s.answer !== undefined ? { answer: s.answer } : {}),
      };
      db.prepare("INSERT INTO submissions VALUES (?, 1, ?, ?, ?)").run(s.id, s.requestId ? JSON.stringify(s.requestId) : null, status, JSON.stringify(rec));
    }
  }
  db.close();
  return file;
}

console.log("\n# classification edges (built DBs)");
{
  const f = build(path.join(tmp, "edges", "session.sqlite"), [
    { id: 10, kind: "pi.user", text: `${LEGACY_ENTWURF_BRIEF} opened. TASK`, submission: { id: 11, type: "input" } },
    { id: 12, kind: "pi.user", text: `${LEGACY_ENTWURF_BRIEF} pasted later`, submission: { id: 13, type: "input" } },
    { id: 14, kind: "pi.user", text: "from an unknown host path", submission: { id: 15, type: "input", requestId: "mystery-host:1" } },
    { id: 16, kind: "pi.user", text: "written, not input", submission: { id: 17, type: "write" } },
    { id: 18, kind: "pi.future-kind", text: "a kind this reader does not know" },
  ]);
  const all = (await readDurableRange(f, {}, opts)).entries;
  const at = (id: number) => all.find((e) => e.entryId === id)!;
  eq(at(10).origin, "entwurf-brief", "legacy NULL-requestId brief as the first root input → entwurf-brief");
  truthy(at(10).basis.includes("pre-v0.31.0"), "…with the legacy basis");
  eq(at(12).origin, "unknown", "brief text that is not the first root input → unknown, not human");
  eq(at(14).origin, "unknown", "unrecognized requestId prefix → unknown");
  truthy(at(14).basis.includes("mystery-host"), "…naming the prefix");
  eq(at(16).origin, "unknown", "pi.user placed by a write submission → unknown");
  eq(at(18).origin, "unknown", "unrecognized pi.* kind → unknown");
  const c = await censusDurable(f, opts);
  eq([c.snapshot.cwd, c.snapshot.project], ["/home/u/repos/gh/demo", "demo"], "single base → its cwd and project");
  eq(c.snapshot.bucketMatchesCwd, null, "no bucket in the path → no bucket check");
}

console.log("\n# every model message keeps its role and boundary");
{
  const f = build(path.join(tmp, "multi", "session.sqlite"), [
    {
      id: 20,
      kind: "pi.user",
      model: [
        { role: "user", content: [{ type: "text", text: "FIRST-MESSAGE" }], timestamp: 1_792_000_000_020 },
        { role: "user", content: [{ type: "text", text: "SECOND-MODEL-MESSAGE" }, { type: "image", data: "…" }], timestamp: 1_792_000_000_021 },
      ],
      submission: { id: 21, type: "input" },
    },
    {
      id: 22,
      kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "ANSWER" }], stopReason: "stop" }],
      edits: [{ target: 20, action: "omit" }],
    },
  ]);
  const read = await readDurableRange(f, {}, opts);
  const user = read.entries.find((e) => e.entryId === 20)!;
  truthy(user.text.includes("FIRST-MESSAGE") && user.text.includes("SECOND-MODEL-MESSAGE"), "joined text carries the second message");
  eq(user.messages.map((m) => [m.index, m.role, m.text]), [[0, "user", "FIRST-MESSAGE"], [1, "user", "SECOND-MODEL-MESSAGE"]], "messages in stored order, each with its role");
  eq(user.omitted, { image: 1 }, "a non-text block of message 1 is counted, not dropped silently");
  const asst = read.entries.find((e) => e.entryId === 22)!;
  eq(asst.omitted, { thinking: 1, contextEdit: 1 }, "thinking and context edits are counted");
  const cut = await readDurableRange(f, {}, { ...opts, maxChars: 5 });
  const cu = cut.entries.find((e) => e.entryId === 20)!;
  eq([cu.truncated, cu.messages[1].truncated, cu.messages[1].chars], [true, true, 20], "a cut reaches each message and reports its full length");
}

console.log("\n# cwd is withheld when deltas follow the newest base");
{
  const bucketDir = path.join(tmp, "a".repeat(24), "1792000000000-00000000-0000-4000-8000-000000000001");
  // SDK 1.2.0 stored measured cwd changes as new bases; the newest base is current.
  const rebased = build(path.join(tmp, "rebased", "session.sqlite"), [], { bases: ["/home/u/repos/gh/before", "/home/u/repos/gh/after"] });
  eq((await censusDurable(rebased, opts)).snapshot.cwd, "/home/u/repos/gh/after", "newest base wins");
  // A cwd-changing delta in the SDK's chord op shape (testing/storage-benchmark.js:110: ["s", path, value]).
  const moved = build(path.join(bucketDir, "session.sqlite"), [], { deltaOps: [["s", ["cwd"], "/home/u/repos/gh/moved"]] });
  const s = (await censusDurable(moved, opts)).snapshot;
  eq([s.cwd, s.project, s.bucketMatchesCwd], [null, null, null], "delta after the base → cwd, project, bucket check all null");
  truthy(s.cwdBasis.includes("unknown"), "…and the basis says the current cwd is unknown");
}

console.log("\n# answers join only done input submissions");
{
  const f = build(path.join(tmp, "answers", "session.sqlite"), [
    // SDK-impossible state, kept as a negative case: a write submission that names an answer.
    { id: 30, kind: "pi.user", text: "write-placed with an answer field", submission: { id: 31, type: "write", status: "placed", answer: 34 } },
    { id: 32, kind: "pi.user", text: "a real done input", submission: { id: 33, type: "input", status: "done", answer: 35 } },
    { id: 34, kind: "pi.assistant", text: "not a confirmed answer", role: "assistant" },
    { id: 35, kind: "pi.assistant", text: "the confirmed answer", role: "assistant" },
  ]);
  const all = (await readDurableRange(f, {}, opts)).entries;
  const at = (id: number) => all.find((e) => e.entryId === id)!;
  eq(at(30).submission?.answer, null, "write/placed submission exposes no answer");
  eq(at(34).answers, [], "…and joins nothing");
  eq([at(32).submission?.answer, at(35).answers], [35, [33]], "done input joins its explicit answer");
  // SDK-impossible negative case: a done input that names an answer but no entry.
  const raw = new DatabaseSync(f);
  raw.prepare("INSERT INTO submissions VALUES (40, 1, NULL, 'done', ?)").run(JSON.stringify({ id: 40, conversationId: 1, type: "input", status: "done", answer: 34 }));
  raw.close();
  const again = (await readDurableRange(f, {}, opts)).entries.find((e) => e.entryId === 34)!;
  eq(again.answeredInputs, [{ submissionId: 40, entryId: null, origin: "unknown" }], "an answer link without a placed entry stays null/unknown");
}

console.log("\n# named refusals");
{
  const good = build(path.join(tmp, "good", "session.sqlite"), [{ id: 3, kind: "pi.user", text: "hello there", submission: { id: 4, type: "input" } }]);
  await refused(() => censusDurable(path.join(tmp, "nope.sqlite"), opts), "missing-file", "missing file");
  await refused(() => censusDurable(tmp, opts), "not-a-file", "directory");
  const text = path.join(tmp, "text.sqlite");
  fs.writeFileSync(text, "x".repeat(200));
  await refused(() => censusDurable(text, opts), "not-sqlite", "non-SQLite bytes");
  const wal = build(path.join(tmp, "wal", "session.sqlite"), [], { wal: true });
  await refused(() => censusDurable(wal, opts), "wal-header", "WAL-mode header");
  const side = build(path.join(tmp, "side", "session.sqlite"), []);
  fs.writeFileSync(side + "-wal", "");
  await refused(() => censusDurable(side, opts), "sidecar-present", "-wal beside the file");
  const v2 = build(path.join(tmp, "v2", "session.sqlite"), [], { version: 2 });
  await refused(() => censusDurable(v2, opts), "unsupported-schema", "schema v2");
  const plain = path.join(tmp, "plain.sqlite");
  const pdb = new DatabaseSync(plain);
  pdb.exec("CREATE TABLE t (x)");
  pdb.close();
  await refused(() => censusDurable(plain, opts), "not-durable", "SQLite without durable_schema");
  await refused(() => readDurableAround(good, 999, 1, 1, opts), "missing-entry", "missing entry");
  await refused(() => readDurableRange(good, { conversationId: 7 }, opts), "missing-conversation", "missing conversation");
  await refused(() => readDurableAround(good, 0, 1, 1, opts), "bad-selection", "entry id 0");

  // A live root with one session; reached directly, through a symlink, and through a hardlink.
  const liveRoot = path.join(tmp, "live", "durable-sessions");
  const liveFile = build(path.join(liveRoot, "0".repeat(24), "1792000000000-00000000-0000-4000-8000-000000000000", "session.sqlite"), []);
  const live = { liveRoots: [liveRoot] };
  await refused(() => censusDurable(liveFile, live), "live-store", "file inside the live root");
  const link = path.join(tmp, "link.sqlite");
  fs.symlinkSync(liveFile, link);
  await refused(() => censusDurable(link, live), "live-store", "symlink into the live root (realpath)");
  const rootLink = path.join(tmp, "root-link");
  fs.symlinkSync(path.join(tmp, "live"), rootLink);
  await refused(() => censusDurable(liveFile, { liveRoots: [path.join(rootLink, "durable-sessions")] }), "live-store", "live root named through a symlink");
  // From here the live file has a second link.
  const hard = path.join(tmp, "hard.sqlite");
  fs.linkSync(liveFile, hard);
  await refused(() => censusDurable(hard, live), "hardlinked", "hardlink of a live file (nlink > 1)");
  await refused(() => censusDurable(liveFile, live), "hardlinked", "…and the live file itself once it has a second link");
  const copy = path.join(tmp, "copy", "session.sqlite");
  fs.mkdirSync(path.dirname(copy));
  fs.copyFileSync(hard, copy);
  truthy((await censusDurable(copy, live)).entries.total === 0, "a real copy of the same bytes (one link) is read");
  truthy((await censusDurable(good, live)).entries.total === 1, "a closed snapshot outside the live root is read");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
