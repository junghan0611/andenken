/**
 * selection-gates.test.ts — SYNTHETIC suite (API 0): which production gates keep
 * near-anchor evidence out of the embedding input, each against a positive
 * control that differs in one variable; and where splitting FRAGMENTS text
 * (no character lost) versus where text is LITERALLY lost (whitespace at
 * seams, non-text blocks, stripped prefixes). JSONL (pi, Claude Code) and a
 * closed pi-durable snapshot built here (schema-v1 DDL subset).
 *
 * No network, store, provider or real session; every file is a temp file this
 * suite wrote. This is a characterization of current behaviour, not a policy:
 * a change in any gate should fail here and be reviewed, not be "fixed" here.
 *
 *   tsx selection-gates.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as SI from "./session-indexer.ts";
import { getProfile, embedSplitFor, codepointsNfkc } from "./embedding-profile.ts";
import { planDurable } from "./durable-plan.ts";
import { extractDurableRows } from "./durable-source.ts";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d?: unknown) => { if (c) { pass++; console.log(`  PASS ${m}`); } else { fail++; console.log(`  FAIL ${m} ${d === undefined ? "" : JSON.stringify(d)}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selprobe-"));
const A = "ANCHOR-Z9Q4";                       // synthetic anchor token
const has = (chunks: { text: string }[], s: string) => chunks.some((c) => c.text.includes(s));
const UUID7 = (n: number) => `0198aaaa-bbbb-7ccc-8ddd-${String(n).padStart(12, "0")}`;
const piDir = path.join(tmp, "pi", "--home-x-repos-probe--");
const ccDir = path.join(tmp, "cc", ".claude", "projects", "-home-x-repos-probe");
fs.mkdirSync(piDir, { recursive: true }); fs.mkdirSync(ccDir, { recursive: true });
const ts = "2099-01-01T00:00:00.000Z";
const piMsg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "message", timestamp: ts, message: { role, content, ...extra } });
const ccMsg = (type: string, content: unknown) => JSON.stringify({ type, timestamp: ts, message: { role: type, content } });
const writePi = (n: number, lines: string[]) => { const f = path.join(piDir, `2099-01-01T00-00-00_${UUID7(n)}.jsonl`); fs.writeFileSync(f, lines.join("\n") + "\n"); return f; };
const writeCc = (name: string, lines: string[]) => { const f = path.join(ccDir, `${name}.jsonl`); fs.writeFileSync(f, lines.join("\n") + "\n"); return f; };
const pad = (s: string, n: number) => s + "x".repeat(Math.max(0, n - s.length));

console.log("\n# J1 JSONL message gates — excluded case vs positive control (same anchor, one variable changed)");
{
  // exact-boundary pairs; content = string so length is exact
  const u20 = pad(`${A} B`, 20), u21 = pad(`${A} B`, 21);
  const a100 = pad(`${A} decision B`, 100), a101 = pad(`${A} decision B`, 101);
  const f = writePi(1, [
    piMsg("user", u20),                       // L1 excluded: user ≤20
    piMsg("user", u21),                       // L2 control
    piMsg("assistant", [{ type: "text", text: a100 }]), // L3 excluded: assistant ≤100
    piMsg("assistant", [{ type: "text", text: a101 }]), // L4 control
    piMsg("assistant", [{ type: "text", text: pad(`PASS ${A} decided B`, 150) }]),   // L5 noise prefix
    piMsg("assistant", [{ type: "text", text: pad(`Result: PASS ${A} decided B`, 150) }]), // L6 control
    piMsg("assistant", [{ type: "thinking", thinking: pad(`${A} reasoning in thinking`, 300) }, { type: "toolCall", name: "bash", arguments: { cmd: `echo ${A}-TOOLARG` } }]), // L7 non-text only
    piMsg("assistant", [{ type: "text", text: pad(`${A}-MIXED kept text`, 150) }, { type: "toolCall", name: "bash", arguments: { cmd: `echo ${A}-TOOLARG2` } }]), // L8 mixed: text kept, tool arg lost
    JSON.stringify({ type: "message", timestamp: ts, message: { role: "toolResult", content: [{ type: "text", text: pad(`${A}-TOOLRESULT output`, 300) }] } }), // L9 toolResult role
    piMsg("user", pad(`System (untrusted): [${A}-WRAP] cron note`, 120)), // L10 sanitize drop
    piMsg("user", `[Mon 2099-01-01 09:00 KST] ${pad(`${A}-TS kept body`, 60)}`), // L11 timestamp prefix stripped
    piMsg("user", "   short   "),             // L12 padding check (not anchor)
  ]);
  const chunks = await SI.extractSessionChunks(f);
  const byLine = (n: number) => chunks.filter((c: any) => c.lineNumber === n);
  ok(byLine(1).length === 0 && byLine(2).length === 1, "user 20 chars excluded / 21 chars emitted (floor `> 20`)", [byLine(1).length, byLine(2).length]);
  ok(byLine(3).length === 0 && byLine(4).length === 1, "assistant 100 chars excluded / 101 emitted (floor `> 100`)", [byLine(3).length, byLine(4).length]);
  ok(byLine(5).length === 0 && byLine(6).length === 1, "noise /^PASS / excludes the whole message; same anchor mid-text emitted");
  ok(byLine(7).length === 0, "thinking + toolCall only → no chunk (non-text blocks never read)");
  ok(byLine(8).length === 1 && !has(byLine(8), `${A}-TOOLARG2`) && has(byLine(8), `${A}-MIXED`), "mixed message: text kept, toolCall argument literal absent (block-level literal loss)");
  ok(byLine(9).length === 0, "pi toolResult role → no chunk");
  ok(byLine(10).length === 0, "`System (untrusted): [` user wrapper → sanitize drop");
  ok(byLine(11).length === 1 && !has(byLine(11), "2099-01-01 09:00") && has(byLine(11), `${A}-TS`), "leading `[Mon … KST]` prefix stripped: body kept, time literal lost", byLine(11).map((c: any) => c.text.slice(0, 40)));
  const det = await SI.extractSessionChunksDetailed(fs.createReadStream(f), f, "control-v1");
  ok(det.selected.length === det.legacy.length && det.decisions.length === 0, "control-v1 changes nothing here: these exclusions are legacy gates, not issue-#18 selection", [det.legacy.length, det.selected.length]);
}

console.log("\n# J2 Claude Code JSONL — tool_result / tool_use / thinking vs text control");
{
  const f = writeCc("11111111-2222-4333-8444-555555555555", [
    ccMsg("user", [{ type: "tool_result", tool_use_id: "t1", content: pad(`${A}-CCTR tool output`, 300) }]),
    ccMsg("user", [{ type: "text", text: pad(`${A}-CCTR tool output`, 300) }]),
    ccMsg("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `grep ${A}-CCTU` } }]),
    ccMsg("assistant", [{ type: "thinking", thinking: pad(`${A}-CCTH`, 300) }]),
  ]);
  const ch = await SI.extractSessionChunks(f);
  ok(!ch.some((c: any) => c.lineNumber === 1) && ch.some((c: any) => c.lineNumber === 2), "same 300-char text: tool_result block excluded, text block emitted");
  ok(!has(ch, `${A}-CCTU`) && !has(ch, `${A}-CCTH`), "tool_use input and thinking never reach a chunk");
}

console.log("\n# J3 control-v1 selection (issue #18) — dropped vs controls");
{
  const notice = `\n[tool:done] ${A} grep result — found decision B\n`;
  const f = writePi(2, [
    piMsg("assistant", [{ type: "text", text: notice }, { type: "text", text: pad(`real answer about ${A}`, 150) }], { api: "entwurf" }), // block dropped, message kept
    piMsg("assistant", [{ type: "text", text: notice }], { api: "entwurf" }),                     // only notice: legacy-ineligible (≤100) anyway
    piMsg("assistant", [{ type: "text", text: pad(notice.slice(0, -1), 140) + "\n" }], { api: "entwurf" }), // notice-shaped but >100 chars
    piMsg("assistant", [{ type: "text", text: notice }, { type: "text", text: pad(`real answer about ${A}`, 150) }], { api: "anthropic" }), // control: non-ACP api
    piMsg("assistant", [{ type: "text", text: notice.replace("] ", "]  ") }, { type: "text", text: pad(`real answer about ${A}`, 150) }], { api: "entwurf" }), // control: double space ≠ sanitized
  ]);
  const det = await SI.extractSessionChunksDetailed(fs.createReadStream(f), f, "control-v1");
  const L = (arr: any[], n: number) => arr.filter((c) => c.lineNumber === n);
  ok(L(det.legacy, 1)[0]?.text.includes("found decision B") && !L(det.selected, 1)[0]?.text.includes("found decision B") && L(det.selected, 1).length === 1,
    "line1: legacy keeps notice literal; control-v1 removes that block, keeps the answer block");
  ok(L(det.legacy, 2).length === 0 && det.decisions.find((d: any) => d.lineNumber === 2)?.outcome === "selected-empty", "line2: notice-only short block: legacy already 0 chunks (≤100 floor); control-v1 labels it selected-empty (empty check precedes legacy-ineligible)");
  const d3 = det.decisions.find((d: any) => d.lineNumber === 3);
  ok(L(det.legacy, 3).length === 1 && has(L(det.legacy, 3), A) && d3?.outcome === "selected-empty" && L(det.selected, 3).length === 0,
    "line3: >100-char notice-shaped block with anchor — legacy emits, control-v1 drops whole message (selected-empty)", d3?.outcome);
  console.log(`    line3 control-v1 outcome=${d3?.outcome ?? "none(kept)"} selectedChunks=${L(det.selected, 3).length}`);
  const p4 = await SI.extractSessionChunksDetailed(fs.createReadStream(f), f, "control-v1");
  ok(L(det.selected, 4)[0]?.text.includes("found decision B"), "control: same blocks under a non-ACP api are kept");
  ok(L(det.selected, 5)[0]?.text.includes("found decision B"), "control: unsanitized (double-space) notice is kept");
}

console.log("\n# J4 file-level discovery gates — size floor, filename species, tmp dir, subagents");
{
  const big = (n: number) => { const lines = [piMsg("user", pad(`${A}-FILE${n} decision`, 60))]; while (lines.join("\n").length <= 200 * 1024) lines.push(piMsg("assistant", [{ type: "text", text: "y".repeat(4000) }])); return lines; };
  const disc = path.join(tmp, "disc"); const proj = path.join(disc, "--home-x-repos-probe--"); fs.mkdirSync(proj, { recursive: true });
  const exact = path.join(proj, `a_${UUID7(10)}.jsonl`); fs.writeFileSync(exact, Buffer.alloc(200 * 1024, 0x20));
  const over = path.join(proj, `a_${UUID7(11)}.jsonl`); fs.writeFileSync(over, big(11).join("\n") + "\n");
  const small = path.join(proj, `a_${UUID7(12)}.jsonl`); fs.writeFileSync(small, piMsg("user", pad(`${A}-SMALL decision`, 60)) + "\n");
  const garden = path.join(proj, `a_20990101T000000-abcdef.jsonl`); fs.writeFileSync(garden, big(13).join("\n") + "\n");
  const v4 = path.join(proj, `a_0198aaaa-bbbb-4ccc-8ddd-000000000014.jsonl`); fs.writeFileSync(v4, big(14).join("\n") + "\n");
  const tmpd = path.join(disc, "--tmp-probe--"); fs.mkdirSync(tmpd); const intmp = path.join(tmpd, `a_${UUID7(15)}.jsonl`); fs.writeFileSync(intmp, big(15).join("\n") + "\n");
  const found = SI.findSessionFiles(disc);
  ok(found.length === 1 && found[0] === over, "only >200KB, UUIDv7-suffix, non-tmp file discovered", found.map((p: string) => path.basename(p)));
  ok(fs.statSync(exact).size === 204800 && !found.includes(exact), "exactly 204800 B excluded (`size > MIN`)");
  ok(!found.includes(small) && (await SI.extractSessionChunks(small)).length === 1, "small file's anchor message WOULD chunk if read — excluded only by size gate");
  ok(!found.includes(garden) && !found.includes(v4) && !found.includes(intmp), "garden-id suffix, UUIDv4 and tmp-project files excluded despite >200KB");
  // Claude subagents dir (scanClaudeDir is not baseDir-routable; check the predicate via __test is not exposed → documented only)
}

console.log("\n# F1 split — fragmentation vs literal loss (historical split, target 2000)");
const nonWs = (s: string) => s.replace(/\s+/g, "");
{
  const head = "p".repeat(1990) + `\n\n${A} `; // anchor line straddles 2000 window
  const text = head + "decision is B because of cost.\n" + "q".repeat(500);
  const parts: string[] = SI.__test.splitForEmbedding(text);
  const anchorIn = parts.map((p) => p.includes(A)); const declIn = parts.map((p) => p.includes("decision is B"));
  ok(parts.length === 2 && anchorIn[1] && declIn[1], "seam `\\n\\n` before anchor: anchor+decision stay together in part 1", { lens: parts.map((p) => p.length), anchorIn, declIn });
  const text2 = "p".repeat(1980) + `\n\n${"r".repeat(10)} ${A}\n\ndecision is B.\n` + "q".repeat(500);
  const p2: string[] = SI.__test.splitForEmbedding(text2);
  console.log(`    seam-after-anchor: lens=${JSON.stringify(p2.map((p) => p.length))} anchorIn=${JSON.stringify(p2.map((p) => p.includes(A)))} decisionIn=${JSON.stringify(p2.map((p) => p.includes("decision is B")))}`);
  // hard slice: no seam at all → anchor token cut
  const blob = "z".repeat(1996) + A + "z".repeat(600);
  const p3: string[] = SI.__test.splitForEmbedding(blob);
  ok(!p3.some((p) => p.includes(A)) && p3.join("") === blob, "no-seam blob: anchor token cut across parts (no part contains it) yet join(\"\") === text — fragmentation, zero char loss", p3.map((p) => p.length));
  // sentence seam with Korean `다. `
  const ko = "가".repeat(1990) + `다. ${A} 결정은 B다. ` + "나".repeat(400);
  const p4: string[] = SI.__test.splitForEmbedding(ko);
  ok(p4.some((p) => p.includes(A)) && nonWs(p4.join("")) === nonWs(ko), "Korean sentence seam keeps anchor whole; non-whitespace preserved", p4.map((p) => p.length));
  // literal (whitespace) loss at seams
  const ws = "a".repeat(1000) + "\n\n   \n\n" + "b".repeat(1500) + "\n" + "c".repeat(150);
  const p5: string[] = SI.__test.splitForEmbedding(ws);
  const lost = ws.length - p5.join("").length;
  ok(nonWs(p5.join("")) === nonWs(ws) && p5.join("") !== ws, `seam trimEnd/trimStart drops whitespace only (Δchars=${lost}, non-ws identical)`, p5.map((p) => p.length));
  // short tail fold inserts "\n"
  const fold = "a".repeat(1990) + "\n" + "t".repeat(50);
  const p6: string[] = SI.__test.splitForEmbedding(fold);
  ok(p6.length === 1 && p6[0] === "a".repeat(1990) + "\n" + "t".repeat(50), "short tail (<200) folded with \"\\n\" into previous part (one row)", p6.map((p) => p.length));
}

console.log("\n# F2 split — profiled generation (ollama-bge-m3-1024) code-point pass");
{
  const prof = getProfile("ollama-bge-m3-1024");
  const split = embedSplitFor(prof)!;
  console.log(`    embedSplit=${JSON.stringify(split)}`);
  const text = "w".repeat(split.target - 3) + A + "w".repeat(3000);
  const parts: string[] = await SI.withEmbedSplit(split, async () => SI.splitForActiveEmbedding(text));
  ok(parts.every((p) => codepointsNfkc(p) <= split.maxCodepoints), "every part ≤ maxCodepoints", parts.map((p) => codepointsNfkc(p)));
  ok(!parts.some((p) => p.includes(A)) && parts.join("") === text, "profiled no-seam: anchor cut across parts, lossless join", parts.map((p) => p.length));
  // NFKC-expanding chars (e.g. ﷺ → 18 cps) force the code-point pass
  const exp = "\uFDFA".repeat(130) + `\n${A} decision B\n`;
  const pe: string[] = await SI.withEmbedSplit(split, async () => SI.splitForActiveEmbedding(exp));
  ok(pe.join("") === exp || nonWs(pe.join("")) === nonWs(exp), "NFKC-expanding text: code-point pass lossless", { parts: pe.length, cps: pe.map((p) => codepointsNfkc(p)) });
}

console.log("\n# D1 closed pi-durable (synthetic schema-v1) — B.1 gate vs control, then rows/split");
{
  type SqliteDb = { exec(s: string): void; prepare(s: string): { run(...p: unknown[]): unknown }; close(): void };
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const file = path.join(tmp, "durable", "b", "s", "session.sqlite"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL, key_value TEXT NOT NULL, scope_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, record TEXT NOT NULL);
    CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (document_id, seq));
    INSERT INTO durable_schema VALUES (1, 1); INSERT INTO conversations VALUES (1, NULL, NULL, '{"id":1}');`);
  let seq = 1;
  const ent = (id: number, kind: string, role: string, content: unknown) =>
    db.prepare("INSERT INTO entries VALUES (?, 1, NULL, ?, ?)").run(id, seq++, JSON.stringify({ id, conversationId: 1, kind, model: [{ role, content, ...(role === "assistant" ? { stopReason: "stop" } : {}) }] }));
  const sub = (id: number, entry: number, answer: number, requestId?: string) =>
    db.prepare("INSERT INTO submissions VALUES (?, 1, ?, 'done', ?)").run(id, requestId ? JSON.stringify(requestId) : null, JSON.stringify({ id, conversationId: 1, type: "input", status: "done", entry, answer, ...(requestId ? { requestId } : {}) }));
  const longAns = "p".repeat(1990) + "\n\n" + `${A}-DLONG decision B.\n` + "q".repeat(2500);
  ent(10, "pi.user", "user", [{ type: "text", text: `${A} 응` }]); sub(11, 10, 13);                       // short human turn (no floor)
  ent(12, "pi.assistant", "assistant", [{ type: "text", text: `${A}-DMID ok` }, { type: "toolCall", id: "c", name: "bash", arguments: { cmd: `${A}-DARG` } }]);
  ent(13, "pi.assistant", "assistant", [{ type: "text", text: longAns }]);
  ent(14, "pi.assistant", "assistant", [{ type: "text", text: `${A}-DAFTER after run, unlinked` }]);      // after run end
  ent(20, "pi.user", "user", [{ type: "text", text: "sibling mail notice" }]); sub(21, 20, 22, "entwurf-doorbell:x");
  ent(22, "pi.assistant", "assistant", [{ type: "text", text: `${A}-DBELL reply to doorbell` }]);       // doorbell reply
  ent(30, "pi.user", "user", [{ type: "text", text: "next human" }]); sub(31, 30, 33);
  ent(32, "pi.tool-result", "toolResult", [{ type: "text", text: `${A}-DTOOLRES output` }]);
  ent(33, "pi.assistant", "assistant", [{ type: "text", text: `${A}-DCTRL answered` }]);                  // control
  db.close();
  const opts = { liveRoots: [path.join(tmp, "no-live")] };
  const plan = await planDurable(file, opts);
  const c = (id: number) => { const x = plan.candidates.find((y) => y.entryId === id); if (!x) throw new Error(`no candidate e${id}`); return x; };
  const show = (id: number) => `e${id} ${c(id).origin} B=${c(id).B.decision} (${c(id).B.basis})`;
  for (const id of [10, 12, 13, 14, 20, 22, 30, 32, 33]) console.log(`    ${show(id)}`);
  ok(c(10).B.decision === "include" && c(10).chars < 20, "10-char human turn INCLUDED (durable has no 20-char floor; JSONL would drop it)");
  ok(c(14).B.decision === "exclude" && c(33).B.decision === "include", "unlinked assistant after run end excluded / answered control included");
  ok(c(22).B.decision === "exclude" && c(22).C.decision === "include", "doorbell reply: B excludes, C includes");
  ok(c(32).B.decision === "exclude", "tool-result entry readable-only, excluded");
  const split = embedSplitFor(getProfile("ollama-bge-m3-1024"));
  const ex = await SI.withEmbedSplit(split, () => extractDurableRows(file, plan, { after: 0, upTo: 99 }, { device: "synthetic", session: "s" }, opts));
  const rowsOf = (id: number) => ex.rows.filter((r: any) => r.lineNumber === id);
  ok(rowsOf(12).length === 1 && has(rowsOf(12), `${A}-DMID`) && !has(rowsOf(12), `${A}-DARG`), "durable mixed entry: text row kept, toolCall argument literal absent");
  const r13 = rowsOf(13);
  ok(r13.length >= 2 && nonWs(r13.map((r: any) => r.text).join("")) === nonWs(longAns), `durable long answer fragmented into ${r13.length} rows; non-ws chars identical`, r13.map((r: any) => r.text.length));
  ok(r13.filter((r: any) => r.text.includes(`${A}-DLONG`)).length === 1, "anchor+decision line lands whole in exactly one durable row");
  ok(!has(ex.rows, `${A}-DAFTER`) && !has(ex.rows, `${A}-DBELL`) && !has(ex.rows, `${A}-DTOOLRES`), "plan-excluded entries produce no rows");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
