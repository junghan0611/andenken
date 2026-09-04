#!/usr/bin/env tsx
/**
 * Cross-language parity for the credential patterns.
 *
 * API 0. DB 0. Reads both implementations' SOURCE TEXT and compares them.
 *
 * The same six rules exist twice — `scripts/redact-credentials.py` (bytes regex,
 * redacts session transcripts) and `openclaw-importer.ts` (string regex, drops
 * harvested chunks). Two copies of one policy is the defect shape this repo keeps
 * finding: a copy is not born wrong, it quietly stays behind when the original
 * moves. Nothing structural stops someone from tightening one and not the other.
 *
 * A cross-review on 2026-09-03 measured the pair equal — synthetic cases through
 * both engines, 10 hits vs 10 hits, zero mismatch — and then made the point that
 * matters: that measurement lived in /tmp and proved a moment, not an invariant.
 * This file is the invariant.
 *
 * Two checks, deliberately in this order:
 *   1. the pattern BODIES are byte-identical between the two files. This fails the
 *      instant either side is edited alone, which is the actual failure mode.
 *   2. both engines agree on synthetic inputs, including boundary violations. This
 *      is what catches a difference the string comparison cannot see — a dialect
 *      gap rather than an edit.
 *
 * Run it: `./run.sh test:parity`.
 */

import * as fs from "fs";
import { execFileSync } from "child_process";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = "") {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const pySrc = fs.readFileSync("scripts/redact-credentials.py", "utf-8");
const tsSrc = fs.readFileSync("openclaw-importer.ts", "utf-8");

// Extract, never retype. Copying a pattern into this file would test my copy.
const pyRules = [...pySrc.matchAll(/\("([a-z-]+)",\s*re\.compile\(rb"(.+?)"\)\)/g)]
	.map((m) => [m[1], m[2]] as const);
const tsRules = [...tsSrc.matchAll(/\["([a-z-]+)",\s*\/(.+?)\/\]/g)]
	.map((m) => [m[1], m[2]] as const);

console.log("\n=== extraction ===");
ok(`python side exposes 6 rules (got ${pyRules.length})`, pyRules.length === 6);
ok(`typescript side exposes 6 rules (got ${tsRules.length})`, tsRules.length === 6);

console.log("\n=== 1. the two copies are the same text ===");
{
	const pyNames = pyRules.map(([n]) => n).sort();
	const tsNames = tsRules.map(([n]) => n).sort();
	ok("rule names match", JSON.stringify(pyNames) === JSON.stringify(tsNames),
		`${pyNames} vs ${tsNames}`);

	for (const [name, pyBody] of pyRules) {
		const found = tsRules.find(([n]) => n === name);
		ok(`${name}: pattern body identical`, !!found && found[1] === pyBody,
			found ? `py=${pyBody} ts=${found[1]}` : "missing on the TS side");
	}
}

console.log("\n=== 2. both engines agree on synthetic input ===");

// One known-positive per rule, then the boundary violations the token guards
// exist for. redact-credentials.py records why: without boundaries the corpus
// yielded 500 "values" of which ~460 were fragments of base64 reasoning blobs.
//
// EVERY LITERAL IS SPLIT, PREFIX INCLUDED. A fixture that trips our detector
// necessarily looks like a secret to every other one, and on 2026-09-04 the
// repo's gitleaks pre-commit hook blocked this file over the slack case. Both
// detectors were doing their job. Assembling the strings keeps the values that
// reach the regexes byte-identical while leaving no contiguous token in the
// source, so the rail is never overridden to land a test. Do not join them back.
const CASES: string[] = [
	"gh" + "o_" + "a".repeat(36),
	"AIza" + "Sy" + "b".repeat(33),
	"123456789" + ":AA" + "c".repeat(32),
	"r" + "8_" + "d".repeat(37),
	"h" + "f_" + "e".repeat(34),
	"xox" + "s-" + "f".repeat(16),
	// boundary violations — a token buried in a longer run is not a credential
	"xgh" + "o_" + "a".repeat(36),
	"gh" + "o_" + "a".repeat(36) + "z",
	"AAAAh" + "f_" + "e".repeat(34),
	// length off by one in both directions
	"gh" + "o_" + "a".repeat(35),
	"gh" + "o_" + "a".repeat(37),
	// a near-miss prefix that belongs to no rule of ours
	"gh" + "p_" + "a".repeat(36),
	// CJK adjacency — a POSITIVE, not a boundary violation. 한글 is not a token
	// character, so a real key pressed against Korean text is still a real key.
	// This corpus is mostly Korean, so if the boundaries were written to require
	// ASCII whitespace they would miss almost every credential that matters here.
	"기억" + "h" + "f_" + "e".repeat(34) + "있다",
	// plain prose that must never match
	"어제 결정한 것을 다시 확인했다",
];

const tsHits = CASES.map((c) =>
	tsRules.filter(([, body]) => new RegExp(body).test(c)).map(([n]) => n).sort(),
);

// The python side runs in python. Translating its regex into JS here would be
// testing a translation, which is the very thing this file exists to prevent.
const pyProgram = `
import json, re, sys
rules = json.loads(sys.argv[1])
cases = json.loads(sys.argv[2])
out = []
for c in cases:
    hits = sorted(n for n, p in rules if re.search(p.encode(), c.encode()))
    out.append(hits)
print(json.dumps(out))
`;
const pyHits: string[][] = JSON.parse(
	execFileSync("python3", ["-c", pyProgram, JSON.stringify(pyRules), JSON.stringify(CASES)], {
		encoding: "utf-8",
	}),
);

let mismatches = 0;
CASES.forEach((c, i) => {
	const same = JSON.stringify(tsHits[i]) === JSON.stringify(pyHits[i]);
	if (!same) {
		mismatches++;
		console.log(`  FAIL case ${i}: ts=${tsHits[i]} py=${pyHits[i]} — ${JSON.stringify(c.slice(0, 40))}`);
		fail++;
	}
});
ok(`all ${CASES.length} synthetic cases agree across engines`, mismatches === 0);

const totalTs = tsHits.reduce((n, h) => n + h.length, 0);
const totalPy = pyHits.reduce((n, h) => n + h.length, 0);
ok(`hit totals agree (ts=${totalTs} py=${totalPy})`, totalTs === totalPy);

// Seven positives: one per rule, plus the Korean-adjacent hf_ token. Pinning the
// absolute count is the point — a detector that quietly stopped working reports
// zero, which on a clean corpus is indistinguishable from success. This assertion
// already earned its place: it was first written as 6, and the run corrected it.
ok(`exactly the 7 known positives fire (got ${totalTs})`, totalTs === 7);

// And name the CJK one explicitly, so a future boundary tightening that starts
// requiring ASCII neighbours fails here instead of silently going blind on a
// Korean corpus.
const cjkIdx = CASES.findIndex((c) => c.startsWith("기억"));
ok("a token pressed against 한글 is still detected",
	tsHits[cjkIdx].includes("huggingface") && pyHits[cjkIdx].includes("huggingface"));

console.log(`\n${"─".repeat(40)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed  ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
