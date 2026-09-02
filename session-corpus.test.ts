#!/usr/bin/env tsx
/**
 * Fixture tests for corpus-backed session discovery.
 *
 * API 0. DB 0. Builds a throwaway `<tmp>/<device>/…` tree, points
 * `ANDENKEN_SESSION_CORPUS` at it, and checks the two things the corpus adds:
 * per-device roots, and cross-device dedup.
 *
 * Why this file exists: the corpus is meant to be path-transparent — the live
 * path with `<corpus>/<device>` bolted on the front — so that `detectSource` and
 * `extractProjectName` keep working untouched. If that transparency ever breaks,
 * the failure is silent (wrong project name, everything labelled `pi`), so it is
 * pinned here rather than left to the indexing run to discover.
 *
 * Run it: `./run.sh test:corpus`.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __test, detectSource, extractProjectName } from "./session-indexer.ts";

const { getPiSessionsDirs, getClaudeProjectsDirs, dedupeByBasename } = __test;

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

// --- fixture corpus ---------------------------------------------------------

const CLAUDE_PROJECT = "-home-junghan-repos-gh-entwurf";
const PI_PROJECT = "--home-junghan-repos-gh-entwurf--";
const CLAUDE_SESSION = "d47977bc-57e5-4737-a10b-47b9456cb113.jsonl";
const PI_SESSION = "2026-08-10T06-20-36-243Z_019fea54-8813-7905-9a89-f777aba5c3ef.jsonl";

const corpus = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-corpus-test-"));
const written: string[] = [];

function write(device: string, rel: string, bytes: number): string {
  const full = path.join(corpus, device, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "x".repeat(bytes));
  written.push(full);
  return full;
}

// Same claude session on both devices — the shape left behind by the manual
// `rsync -a` the two machines already exchanged. Oracle's copy is longer, so it
// is the one that must survive: a transcript only grows.
const thinkpadDup = write("thinkpad", `.claude/projects/${CLAUDE_PROJECT}/${CLAUDE_SESSION}`, 400);
const oracleDup = write("oracle", `.claude/projects/${CLAUDE_PROJECT}/${CLAUDE_SESSION}`, 900);
// A pi session only oracle has.
const oraclePi = write("oracle", `.pi/agent/sessions/${PI_PROJECT}/${PI_SESSION}`, 700);

process.env.ANDENKEN_SESSION_CORPUS = corpus;

try {
  // --- per-device roots ---
  const piDirs = getPiSessionsDirs();
  const claudeDirs = getClaudeProjectsDirs();
  ok(`pi roots: one per device (${piDirs.length})`, piDirs.length === 2);
  ok(
    "pi roots sorted oracle-then-thinkpad (deterministic order)",
    piDirs[0] === path.join(corpus, "oracle", ".pi", "agent", "sessions") &&
      piDirs[1] === path.join(corpus, "thinkpad", ".pi", "agent", "sessions"),
  );
  ok(
    "claude roots keep the runtime path shape",
    claudeDirs[0] === path.join(corpus, "oracle", ".claude", "projects"),
  );

  // --- path transparency: the two functions the layout is designed to protect ---
  ok("detectSource still reads claude from the corpus path", detectSource(oracleDup) === "claude");
  ok("detectSource still reads pi from the corpus path", detectSource(oraclePi) === "pi");
  ok(
    "extractProjectName unaffected by the device prefix (claude)",
    extractProjectName(oracleDup) === "entwurf",
  );
  ok(
    "extractProjectName unaffected by the device prefix (pi)",
    extractProjectName(oraclePi) === "entwurf",
  );

  // --- dedup ---
  const deduped = dedupeByBasename([thinkpadDup, oracleDup, oraclePi]);
  ok(`dedup collapses the cross-device copy (${deduped.length} of 3)`, deduped.length === 2);
  ok("dedup keeps the larger copy", deduped.includes(oracleDup) && !deduped.includes(thinkpadDup));
  ok("dedup keeps the unique session", deduped.includes(oraclePi));

  // Order of arrival must not change the winner, or the manifest churns and
  // re-embeds on every run.
  const reversed = dedupeByBasename([oracleDup, thinkpadDup, oraclePi]);
  ok("dedup is order-independent", reversed.includes(oracleDup) && reversed.length === 2);

  // Equal sizes tie-break on the lexicographically smaller path — also stable.
  const a = write("alpha", `.claude/projects/${CLAUDE_PROJECT}/tie-${CLAUDE_SESSION}`, 500);
  const b = write("beta", `.claude/projects/${CLAUDE_PROJECT}/tie-${CLAUDE_SESSION}`, 500);
  const tie = dedupeByBasename([b, a]);
  ok("size tie breaks on the smaller path", tie.length === 1 && tie[0] === a);

  // --- fallback ---
  delete process.env.ANDENKEN_SESSION_CORPUS;
  ok(
    "unset corpus falls back to the live pi store",
    getPiSessionsDirs().length === 1 &&
      getPiSessionsDirs()[0] === path.join(process.env.HOME ?? "", ".pi", "agent", "sessions"),
  );

  process.env.ANDENKEN_SESSION_CORPUS = path.join(corpus, "does-not-exist");
  ok(
    "missing corpus dir falls back rather than discovering nothing",
    getClaudeProjectsDirs()[0] === path.join(process.env.HOME ?? "", ".claude", "projects"),
  );
} finally {
  delete process.env.ANDENKEN_SESSION_CORPUS;
  fs.rmSync(corpus, { recursive: true, force: true });
}

console.log(`\nsession-corpus: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
