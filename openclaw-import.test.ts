#!/usr/bin/env tsx
/**
 * Fixture tests for the OpenClaw harvest.
 *
 * API 0. DB 0. Pure checks on `prepareRow` and `mergeWatermark`.
 *
 * Why this file exists: the harvest added two drop policies and an id scheme, and
 * a cross-review on 2026-09-03 found none of them covered. INVARIANT §8 — "if a
 * policy is added and no test changes, assume coverage is incomplete."
 *
 * The credential filter is the reason a fixture is not optional here. Measured
 * that day, **0 of 4,683 chunks matched**, so a detector that silently stopped
 * working would produce output identical to a clean corpus. A live run can never
 * distinguish those two; only a fixture carrying a known-positive string can.
 *
 * Run it: `./run.sh test:openclaw`.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { readStoreStamp } from "./embedding-profile.ts";
import {
	prepareRow,
	importOpenclaw,
	openclawProducerFromManifest,
	openclawManifestProducers,
	mergeWatermark,
	partitionByChange,
	type PreparedChunk,
	assertWatermarkHost,
	readWatermark,
	readWatermarkHost,
	writeWatermark,
	getWatermarkPath,
	OPENCLAW_UPDATED_AT_MEANING,
	type OpenclawRow,
} from "./openclaw-importer.ts";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const DIM = 1024;
const vec = (n = DIM) => JSON.stringify(Array.from({ length: n }, () => 1));

function row(over: Partial<OpenclawRow> = {}): OpenclawRow {
	return {
		agent: "glg",
		id: "chunk-1",
		path: "sessions/glg/abc.jsonl",
		source: "sessions",
		updated_at: 1788419146963,
		text: "어제 결정한 것을 다시 확인했다",
		embedding: vec(),
		...over,
	};
}

console.log("\n=== producer identity ===");
{
	const agent = (name: string, meta: unknown, revision = 1) => JSON.stringify({ kind: "agent", agent: name, state: "ok", revision, meta: { memory_index_meta_v1: meta } });
	const valid = { model: "baai/bge-m3", provider: "openai", vectorDims: 1024, chunkingVersion: 2 };
	const producer = openclawProducerFromManifest([agent("a", valid), agent("b", valid, 2)]);
	ok("producer keeps revisions and chunking versions", producer.revisions.a === 1 && producer.revisions.b === 2 && producer.chunkingVersions?.a === 2);
	for (const [label, lines, code] of [
		["mixed generation", [agent("a", valid), agent("b", { ...valid, vectorDims: 4096 })], "openclaw-producer-mismatch"],
		["missing meta", [agent("a", undefined)], "openclaw-producer-meta-missing"],
	] as const) {
		let message = "";
		try { openclawProducerFromManifest(lines); } catch (e) { message = String(e); }
		ok(label + " refused", message.includes(code));
	}
}

console.log("\n=== never-indexed empty agent (live shape 2026-11-26: claude) ===");
{
	const valid = { model: "baai/bge-m3", provider: "openai", vectorDims: 1024, chunkingVersion: 6 };
	const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	const populated = (name: string) => JSON.stringify({ kind: "agent", agent: name, state: "ok", rows: 3, revision: 4, meta: { memory_index_meta_v1: valid }, indexed_mtime: { memory: 1 }, max_updated_at: 5 });
	// The exact record the live export produced for an agent that never indexed.
	const emptyRec = (over: Record<string, unknown> = {}) => JSON.stringify({ kind: "agent", agent: "claude", run_id: "r", snapshot_at: 1, state: "ok", rows: 0, max_updated_at: null, revision: 0, meta: {}, indexed_mtime: {}, digest: EMPTY_SHA, row_digest: EMPTY_SHA, ...over });
	const r = openclawManifestProducers([populated("bbot"), emptyRec()]);
	ok("an explicitly never-indexed empty agent is named, not a producer", JSON.stringify(r.emptyAgents) === JSON.stringify(["claude"]));
	ok("its revision is never stamped", !("claude" in r.producer.revisions) && !("claude" in (r.producer.chunkingVersions ?? {})) && r.producer.revisions.bbot === 4);
	ok("the legacy entry point returns the same producer", JSON.stringify(openclawProducerFromManifest([populated("bbot"), emptyRec()])) === JSON.stringify(r.producer));
	const fatal: Array<[string, string[]]> = [
		["rows > 0 without meta", [populated("bbot"), emptyRec({ rows: 2 })]],
		["revision > 0 (it indexed before)", [populated("bbot"), emptyRec({ revision: 3 })]],
		["revision absent (ambiguous)", [populated("bbot"), JSON.stringify({ ...JSON.parse(emptyRec()), revision: undefined })]],
		["max_updated_at set", [populated("bbot"), emptyRec({ max_updated_at: 7 })]],
		["indexed_mtime non-empty", [populated("bbot"), emptyRec({ indexed_mtime: { memory: 1 } })]],
		["meta has other keys but no v1", [populated("bbot"), emptyRec({ meta: { something: 1 } })]],
		["meta field absent", [populated("bbot"), JSON.stringify({ ...JSON.parse(emptyRec()), meta: undefined })]],
		["digest not the empty digest", [populated("bbot"), emptyRec({ digest: "0".repeat(64) })]],
		["state delta-failed", [populated("bbot"), emptyRec({ state: "delta-failed" })]],
		["a chunk line listed for the empty agent", [populated("bbot"), emptyRec(), JSON.stringify({ kind: "chunk", agent: "claude", id: "x" })]],
		["only empty agents (no producer at all)", [emptyRec()]],
	];
	for (const [label, lines] of fatal) {
		let message = "";
		try { openclawManifestProducers(lines); } catch (e) { message = String(e); }
		ok(`fatal: ${label}`, message.includes("openclaw-producer-meta-missing"), message);
	}
}

console.log("\n=== openclaw harvest — row policy ===");

{
	const v = prepareRow(row());
	ok("a normal row imports", v.kind === "import");
	if (v.kind === "import") {
		ok("id is agent-scoped (ids are unique per agent DB, not across them)",
			v.chunk.id === "glg:chunk-1");
		ok("agent lands in project", v.chunk.project === "glg");
		ok("openclaw source is preserved verbatim", v.chunk.source === "sessions");
		ok("provenance survives in metadata",
			v.chunk.metadata.agent === "glg" && v.chunk.metadata.ocId === "chunk-1");
		ok("updated_at becomes an ISO timestamp",
			v.chunk.timestamp === new Date(1788419146963).toISOString());
	}
}

{
	// Two agents can hold the same chunk id; without scoping, one would overwrite
	// the other and the harvest would silently lose a bot.
	const a = prepareRow(row({ agent: "glg", id: "same" }));
	const b = prepareRow(row({ agent: "bbot", id: "same" }));
	ok("same id from two agents does not collide",
		a.kind === "import" && b.kind === "import" && a.chunk.id !== b.chunk.id);
}

console.log("\n=== credential policy — drop the chunk, never edit it ===");

{
	// Known-positive strings, one per rule. These are synthetic and match the
	// shape only; the point is that the detector fires at all.
	//
	// EVERY ONE IS ASSEMBLED, NEVER WRITTEN WHOLE — including the prefixes. A
	// fixture that works is by construction a string other scanners also call a
	// secret, and on 2026-09-04 the repo's own gitleaks pre-commit hook blocked
	// this file for exactly that reason. Both detectors were right. Splitting the
	// literal keeps what reaches `prepareRow` byte-identical while leaving no
	// contiguous token in the source, so the guard rail stays sharp instead of
	// being overridden every time a rule is added. Do not "tidy" these back into
	// one string.
	const cases: Array<[string, string]> = [
		["github-oauth", "gh" + "o_" + "a".repeat(36)],
		["google-ai", "AIza" + "Sy" + "b".repeat(33)],
		["telegram", "123456789" + ":AA" + "c".repeat(32)],
		["replicate", "r" + "8_" + "d".repeat(37)],
		["huggingface", "h" + "f_" + "e".repeat(34)],
		["slack", "xox" + "s-" + "f".repeat(16)],
	];
	for (const [name, token] of cases) {
		const v = prepareRow(row({ text: `the key is ${token} ok` }));
		ok(`${name} token drops the whole chunk`, v.kind === "drop-credential");
	}
}

{
	// The boundary is what keeps base64 reasoning blobs from reading as secrets.
	// redact-credentials.py measured 500 naive "hits" against 20 real ones.
	const v = prepareRow(row({ text: "xxgh" + "o_" + "a".repeat(36) + "yy" }));
	ok("a token embedded inside a longer word is NOT a credential",
		v.kind === "import");
	const w = prepareRow(row({ text: "gh" + "p_" + "a".repeat(36) }));
	ok("a different github prefix (ghp_) is not one of our rules",
		w.kind === "import");
}

console.log("\n=== boilerplate policy ===");

{
	const v = prepareRow(row({
		source: "memory",
		path: "memory/dreaming/deep/2026-04-25.md",
		text: "# Deep Sleep\n\n- Ranked 0 candidate(s) for durable promotion.\n",
	}));
	ok("an empty dreaming log is dropped", v.kind === "drop-boilerplate");

	const w = prepareRow(row({
		source: "memory",
		path: "memory/dreaming/light/2026-04-25.md",
		text: "- Candidate: 힣님은 자신의 프로젝트를 …",
	}));
	ok("a dreaming log with real candidates is kept", w.kind === "import");

	// Scoped to memory on purpose: the same words spoken in a session are speech
	// about the bot's own logs, which is evidence, not boilerplate.
	const x = prepareRow(row({
		source: "sessions",
		text: "로그에 Ranked 0 candidate 라고 찍혀 있었다",
	}));
	ok("the same phrase in a session is NOT boilerplate", x.kind === "import");
}

console.log("\n=== vector guards ===");

{
	ok("wrong dimension is refused",
		prepareRow(row({ embedding: vec(2560) })).kind === "drop-vector");
	ok("unparseable embedding is refused",
		prepareRow(row({ embedding: "not json" })).kind === "drop-vector");
	ok("a non-array embedding is refused",
		prepareRow(row({ embedding: '{"a":1}' })).kind === "drop-vector");
}

console.log("\n=== watermark ===");

{
	const m: Record<string, number> = {};
	mergeWatermark(m, "glg", 100);
	mergeWatermark(m, "mini", 50);
	ok("each agent keeps its own mark", m.glg === 100 && m.mini === 50);

	mergeWatermark(m, "glg", 90);
	ok("an out-of-order row never walks the mark backwards", m.glg === 100);

	mergeWatermark(m, "glg", 100);
	ok("re-seeing the boundary row is a no-op", m.glg === 100);

	// The export asks for `updated_at >= watermark`, so the boundary comes back
	// every run. That is deliberate: a strict `>` would permanently lose a row
	// committed in the same millisecond as the one that set the mark. What comes
	// back is the whole millisecond, not a row — measured 2026-09-04, 312 rows
	// across six agents, gpt alone 228.
	mergeWatermark(m, "bbot", 0);
	ok("a first-seen agent starts from its own row", m.bbot === 0);
}

console.log("\n=== unchanged rows are accepted, not rewritten ===");

{
	const chunk = (id: string, ts: string): PreparedChunk => ({
		id, text: "", vector: [], sessionFile: "", project: "glg",
		lineNumber: 0, timestamp: ts, role: "", source: "sessions", metadata: {},
	});
	const A = "2026-09-03T14:05:00.000Z";
	const B = "2026-09-03T15:00:00.000Z";

	const batch = [chunk("glg:1", A), chunk("glg:2", A), chunk("glg:3", B)];

	// The boundary case this exists for: every row came back and every row is
	// already held with the same stamp.
	const all = partitionByChange(batch, new Map([["glg:1", A], ["glg:2", A], ["glg:3", B]]));
	ok("a pure boundary re-fetch writes nothing", all.write.length === 0 && all.unchanged === 3);

	// A row whose stamp moved must still be written — that is the case only the
	// time cursor can see (same model string, different provider/embedding version).
	const moved = partitionByChange(batch, new Map([["glg:1", A], ["glg:2", B], ["glg:3", B]]));
	ok("a changed stamp still writes", moved.write.length === 1 && moved.write[0].id === "glg:2");

	// Never seen before → always written.
	const fresh = partitionByChange(batch, new Map([["glg:1", A]]));
	ok("rows we do not hold are written", fresh.write.length === 2 && fresh.unchanged === 1);

	ok("an empty store writes everything", partitionByChange(batch, new Map()).write.length === 3);
}

console.log("\n=== watermark host scoping ===");

{
	// A real file, in a temp data dir. The guard's whole job is to read what is on
	// disk, so a stubbed reader would test the stub. ANDENKEN_DATA is the same
	// override the rest of the repo uses.
	const prev = process.env.ANDENKEN_DATA;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-oc-"));
	process.env.ANDENKEN_DATA = tmp;
	try {
		writeWatermark({ glg: 100, mini: 50 }, "oracle");
		const raw = JSON.parse(fs.readFileSync(getWatermarkPath(), "utf-8"));
		ok("the host is recorded in the watermark file", raw._host === "oracle");
		ok("agent marks survive next to it", raw.glg === 100 && raw.mini === 50);
		ok("readWatermark hides _host from the agent marks",
			Object.keys(readWatermark()).sort().join(",") === "glg,mini");
		ok("readWatermarkHost reports it", readWatermarkHost() === "oracle");

		let refused = false;
		try { assertWatermarkHost("other-host"); } catch { refused = true; }
		ok("a cursor from another host is refused, not reused", refused);

		let allowed = true;
		try { assertWatermarkHost("oracle"); } catch { allowed = false; }
		ok("the recorded host passes", allowed);

		let unknownOk = true;
		try { assertWatermarkHost(null); } catch { unknownOk = false; }
		ok("an unknown staged host does not block (nothing to contradict)", unknownOk);

		// A watermark written before `_host` existed must keep working: the guard
		// refuses a CONTRADICTION, and silence is not one.
		fs.writeFileSync(getWatermarkPath(), JSON.stringify({ glg: 100 }) + "\n");
		let legacyOk = true;
		try { assertWatermarkHost("oracle"); } catch { legacyOk = false; }
		ok("a pre-_host watermark is adopted, not reset", legacyOk && readWatermarkHost() === null);

		writeWatermark(readWatermark(), "oracle");
		ok("and the next write stamps the host onto it", readWatermarkHost() === "oracle");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
		if (prev === undefined) delete process.env.ANDENKEN_DATA;
		else process.env.ANDENKEN_DATA = prev;
	}
}

console.log("\n=== openclaw updated_at label (index time, not event date) ===");

{
	// The stored timestamp is the upstream index-row stamp, carried verbatim. A
	// rebuild restamps rows, so the same chunk re-exported later carries a later
	// stamp although its content and date did not change.
	const before = prepareRow(row({ updated_at: Date.UTC(2026, 9, 23, 3, 36) }));
	const restamped = prepareRow(row({ updated_at: Date.UTC(2026, 10, 15, 11, 21) }));
	ok("timestamp is the upstream updated_at, verbatim",
		before.kind === "import" && before.chunk.timestamp === "2026-10-23T03:36:00.000Z");
	ok("a restamp changes only the timestamp, not id or text",
		before.kind === "import" && restamped.kind === "import"
		&& before.chunk.id === restamped.chunk.id && before.chunk.text === restamped.chunk.text
		&& before.chunk.timestamp !== restamped.chunk.timestamp);
	ok("the label names it index time", /index-row update time/.test(OPENCLAW_UPDATED_AT_MEANING));
	ok("the label says it is not the original date", /not the original/.test(OPENCLAW_UPDATED_AT_MEANING));

	// Static wiring check: search-openclaw keeps the `updated_at` key per hit and
	// adds the label at the top level (no rename, no schema change).
	const cli = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts"), "utf8");
	ok("search-openclaw still emits per-hit updated_at", /updated_at: r\.timestamp,/.test(cli));
	ok("search-openclaw adds updated_at_meaning at the top level",
		/updated_at_meaning: OPENCLAW_UPDATED_AT_MEANING, results: out/.test(cli));
}

{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-import-boundary-"));
	const prev = process.env.ANDENKEN_DATA;
	process.env.ANDENKEN_DATA = tmp;
	const stage = path.join(tmp, "openclaw-staging");
	fs.mkdirSync(stage);
	const file = path.join(stage, "openclaw-chunks.jsonl.gz");
	const manifest = (agent: string, revision: number) => fs.writeFileSync(path.join(stage, "manifest.jsonl.gz"), zlib.gzipSync(JSON.stringify({ kind: "agent", agent, state: "ok", revision, meta: { memory_index_meta_v1: { model: "baai/bge-m3", provider: "openai", vectorDims: 1024, chunkingVersion: 2 } } }) + "\n"));
	const rows = (r: OpenclawRow) => fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(r) + "\n"));
	try {
		manifest("a", 1); rows(row({ agent: "b" }));
		let err = "";
		try { await importOpenclaw(file); } catch (e) { err = String(e); }
		ok("unvouched agent refused", err.includes("openclaw-producer-meta-missing"));
		rows(row({ agent: "a" })); await importOpenclaw(file);
		manifest("b", 2); rows(row({ agent: "b" })); await importOpenclaw(file);
		const stamp = readStoreStamp(path.join(tmp, "openclaw.lance"));
		ok("producer revisions merge across imports", stamp.state === "ok" && stamp.stamp.producer?.revisions.a === 1 && stamp.stamp.producer?.revisions.b === 2);
		fs.unlinkSync(path.join(tmp, "openclaw.lance", "andenken-profile.json"));
		err = ""; try { await importOpenclaw(file); } catch (e) { err = String(e); }
		ok("unstamped populated store refused", err.includes("store-unstamped"));
		// A never-indexed empty agent with a chunk in the staged rows: refused before ANY store mutation.
		fs.rmSync(path.join(tmp, "openclaw.lance"), { recursive: true, force: true });
		fs.rmSync(path.join(tmp, "openclaw-watermark.json"), { force: true });
		const valid = { model: "baai/bge-m3", provider: "openai", vectorDims: 1024, chunkingVersion: 2 };
		const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		fs.writeFileSync(path.join(stage, "manifest.jsonl.gz"), zlib.gzipSync([
			JSON.stringify({ kind: "agent", agent: "a", state: "ok", rows: 250, revision: 1, meta: { memory_index_meta_v1: valid } }),
			JSON.stringify({ kind: "agent", agent: "claude", state: "ok", rows: 0, max_updated_at: null, revision: 0, meta: {}, indexed_mtime: {}, digest: EMPTY_SHA, row_digest: EMPTY_SHA }),
		].join("\n") + "\n"));
		// 250 rows of the vouched agent first (more than one 200-row flush), then one of the empty agent.
		const many = Array.from({ length: 250 }, (_, i) => JSON.stringify(row({ agent: "a", id: `a${i}`, text: `row ${i} 충분히 긴 본문 텍스트 ${i}` })));
		fs.writeFileSync(file, zlib.gzipSync([...many, JSON.stringify(row({ agent: "claude", id: "c1" }))].join("\n") + "\n"));
		err = ""; try { await importOpenclaw(file); } catch (e) { err = String(e); }
		ok("a chunk of the never-indexed empty agent is refused", err.includes("openclaw-producer-meta-missing") && err.includes("claude"), err);
		ok("…before any store mutation (no openclaw.lance created, no watermark)", !fs.existsSync(path.join(tmp, "openclaw.lance")) && !fs.existsSync(path.join(tmp, "openclaw-watermark.json")));
		// Without that chunk the import proceeds and names the empty agent.
		fs.writeFileSync(file, zlib.gzipSync(many.join("\n") + "\n"));
		const st = await importOpenclaw(file);
		ok("the import proceeds and reports the empty agent by name", JSON.stringify(st.emptyAgents) === JSON.stringify(["claude"]) && st.seen === 250);
		const s2 = readStoreStamp(path.join(tmp, "openclaw.lance"));
		ok("the stamp never records the empty agent", s2.state === "ok" && !("claude" in (s2.stamp.producer?.revisions ?? {})) && s2.stamp.producer?.revisions.a === 1);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
		if (prev === undefined) delete process.env.ANDENKEN_DATA; else process.env.ANDENKEN_DATA = prev;
	}
}

console.log(`\n${"─".repeat(40)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed  ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
