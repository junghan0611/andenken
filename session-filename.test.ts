#!/usr/bin/env tsx
/**
 * Fixture tests for pi corpus admission by filename.
 *
 * API 0. DB 0. Pure predicate checks against real observed filename species.
 *
 * Admission is a **suffix** rule: `_<UUIDv7>.jsonl`. The created-at prefix is not
 * validated — filenames decide corpus membership only, never identity.
 *
 * Why this file exists: 2026-08-06 was the last day pi wrote the garden-id suffix,
 * and the admission filter still demanded it. From 8/07 on, every new pi session
 * silently left the corpus — no error, just a thinning index. These cases pin the
 * current spec so the same class of drift fails loudly next time.
 *
 * Run it: `./run.sh test:filename`.
 */

import { strict as assert } from "node:assert";
import { __test } from "./session-indexer.ts";

const { isNativePiSessionFile, isExcludedProjectDir } = __test;

// Real filenames observed under ~/.pi/agent/sessions. Species census at
// 2026-08-10T17:31 KST: UUIDv7 856 · garden-id 803 · UUIDv4 219 · entwurf- 224 ·
// delegate- 121. Counts drift as sessions are written; the species do not.
// UUIDv7 has been written since 2026-04-15 and coexisted with the garden-id form
// from 2026-06-03 to 2026-08-06; from 2026-08-07 it is the only species pi emits.
const ADMITTED = [
  "2026-08-10T06-20-36-243Z_019fea54-8813-7905-9a89-f777aba5c3ef.jsonl",
  "2026-08-10T06-31-22-503Z_019fea5e-6487-7241-82c4-e74838738ab4.jsonl",
  // Contract boundary: admission is the `_<UUIDv7>.jsonl` SUFFIX. The created-at
  // prefix is not part of the predicate, so a name carrying only the suffix is
  // admitted. Filenames decide corpus membership, not identity.
  "_019fea54-8813-7905-9a89-f777aba5c3ef.jsonl",
];

const REJECTED: Array<[string, string]> = [
  [
    "2026-08-06T01-15-27-810Z_20260806T101526-6b7de3.jsonl",
    "retired garden-id suffix — not OR'd back in",
  ],
  [
    "2026-07-01T00-00-00-000Z_8db61ee4-a535-4aa7-a504-e4a28fdeea73.jsonl",
    "UUIDv4 (version nibble 4)",
  ],
  ["2026-06-03T18-59-00-000Z_entwurf-abc123.jsonl", "retired entwurf- species"],
  ["2026-06-03T18-59-00-000Z_delegate-abc123.jsonl", "retired delegate- species"],
  [
    "20260603T1859-test056529.jsonl",
    "test artifact — no `_<UUIDv7>` suffix (the created-at prefix is never checked)",
  ],
  [
    "2026-08-10T06-20-36-243Z_019fea54-8813-c905-9a89-f777aba5c3ef.jsonl",
    "version nibble c — not v7",
  ],
  [
    "2026-08-10T06-20-36-243Z_019fea54-8813-7905-0a89-f777aba5c3ef.jsonl",
    "variant nibble 0 — not RFC 9562 [89ab]",
  ],
  [
    "2026-08-10T06-20-36-243Z_019fea54-8813-7905-9a89-f777aba5c3ef.jsonl.bak",
    "not a .jsonl tail",
  ],
];

let failures = 0;

for (const name of ADMITTED) {
  try {
    assert.equal(isNativePiSessionFile(name), true);
    console.log(`  ok   admit   ${name}`);
  } catch {
    failures++;
    console.error(`  FAIL admit   ${name}`);
  }
}

for (const [name, why] of REJECTED) {
  try {
    assert.equal(isNativePiSessionFile(name), false);
    console.log(`  ok   reject  ${name}  (${why})`);
  } catch {
    failures++;
    console.error(`  FAIL reject  ${name}  (${why})`);
  }
}

// tmp exclusion is unchanged by this ruling — pinned so the two filters stay
// independent.
for (const [dir, expected] of [
  ["--tmp-claude-1000--home-junghan--", true],
  ["-tmp-scratch", true],
  ["--home-junghan-repos-gh-agent-config--", false],
] as Array<[string, boolean]>) {
  try {
    assert.equal(isExcludedProjectDir(dir), expected);
    console.log(`  ok   tmp     ${dir} → ${expected}`);
  } catch {
    failures++;
    console.error(`  FAIL tmp     ${dir}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nsession-filename: all passed");
