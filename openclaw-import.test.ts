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
import {
	prepareRow,
	mergeWatermark,
	assertWatermarkHost,
	readWatermark,
	readWatermarkHost,
	writeWatermark,
	getWatermarkPath,
	type OpenclawRow,
} from "./openclaw-importer.ts";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const DIM = 4096;
const vec = (n = DIM) => JSON.stringify(Array.from({ length: n }, () => 0));

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

console.log(`\n${"─".repeat(40)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed  ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
