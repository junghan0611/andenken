#!/usr/bin/env tsx
/**
 * Fixture tests for long-turn splitting.
 *
 * API 0. DB 0. Pure function checks on `splitForEmbedding`.
 *
 * Why this file exists: until 2026-09-02 a turn longer than 2,000 characters
 * was head-truncated at embed time. Measured over the corpus that day, 30.3% of
 * user turns exceeded the cap and **51.1% of all user characters never reached
 * the index** — a decision stated in the second half of a long prompt could not
 * be retrieved at all. The invariant that replaces it is the one worth pinning:
 * splitting loses nothing.
 *
 * Run it: `./run.sh test:split`.
 */

import { __test } from "./session-indexer.ts";

const { splitForEmbedding } = __test;

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

// The load-bearing invariant: every character survives into exactly one part.
// Whitespace at the seams is trimmed, so compare with whitespace collapsed.
function lossless(text: string, parts: string[]): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "");
  return norm(parts.join("")) === norm(text);
}

// --- short turns are untouched ---
const short = "짧은 프롬프트 하나.";
ok("short text stays one part", splitForEmbedding(short).length === 1);
ok("short text is returned verbatim", splitForEmbedding(short)[0] === short);
ok("text exactly at the target is one part", splitForEmbedding("x".repeat(2000)).length === 1);

// --- paragraph seams are preferred ---
const para = Array.from({ length: 8 }, (_, i) => `문단 ${i}. ` + "가".repeat(400)).join("\n\n");
const paraParts = splitForEmbedding(para);
ok(`paragraph text splits (${paraParts.length} parts)`, paraParts.length > 1);
ok("paragraph split is lossless", lossless(para, paraParts));
ok("no part exceeds the target", paraParts.every((p) => p.length <= 2000));
ok(
  "parts begin at a paragraph seam",
  paraParts.slice(1).every((p) => /^문단 \d/.test(p)),
);

// --- line seams when there are no blank lines ---
const lines = Array.from({ length: 60 }, (_, i) => `line ${i}: ` + "b".repeat(100)).join("\n");
const lineParts = splitForEmbedding(lines);
ok("line-only text splits", lineParts.length > 1);
ok("line split is lossless", lossless(lines, lineParts));
ok("parts begin at a line seam", lineParts.slice(1).every((p) => /^line \d+:/.test(p)));

// --- no seam at all: a pasted blob still splits and terminates ---
const blob = "z".repeat(9500);
const blobParts = splitForEmbedding(blob);
ok(`seamless blob splits (${blobParts.length} parts)`, blobParts.length === 5);
ok("blob split is lossless", lossless(blob, blobParts));
ok("blob parts respect the target", blobParts.every((p) => p.length <= 2000));

// --- the real shape: GLG's longest observed turn (79,928 chars) ---
const huge = Array.from({ length: 200 }, (_, i) => `단락 ${i}.\n` + "다".repeat(390)).join("\n\n");
const hugeParts = splitForEmbedding(huge);
ok(`80k-scale turn splits (${hugeParts.length} parts, ${huge.length} chars)`, hugeParts.length > 30);
ok("80k-scale split is lossless", lossless(huge, hugeParts));

// --- short tails fold back rather than being embedded alone ---
const withTail = "y".repeat(2000) + "\n\n" + "짧은 꼬리";
const tailParts = splitForEmbedding(withTail);
ok("short tail folds into the previous part", tailParts.length === 1 || tailParts.length === 2);
ok("tail fold is lossless", lossless(withTail, tailParts));
ok(
  "no part is a lone fragment under 200 chars",
  tailParts.length === 1 || tailParts[tailParts.length - 1].length >= 200,
);

// --- custom target ---
const custom = splitForEmbedding("w".repeat(1000), 100);
ok("custom target is honored", custom.length === 10 && custom.every((p) => p.length <= 100));

console.log(`\nsession-split: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
