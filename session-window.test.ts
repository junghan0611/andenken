#!/usr/bin/env tsx
/**
 * Fixture tests for C2.0 session-window prototype.
 *
 * API 0. DB 0. Pure temp JSONL parsing + window chunking.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSessionTranscriptEntry,
  buildWindowChunks,
  chunkTranscriptContent,
  extractSessionWindowChunks,
} from "./session-window.ts";

let passed = 0;
let failed = 0;

function eq<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
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

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function writeTempSession(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-window-test-"));
  const sessionDir = path.join(dir, ".pi", "agent", "sessions", "--home-test-repos-gh-demo--");
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, "session.jsonl");
  fs.writeFileSync(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"),
  );
  return file;
}

section("buildSessionTranscriptEntry");

{
  const file = writeTempSession([
    { type: "custom", customType: "model-snapshot", data: {} },
    "not valid json",
    {
      type: "message",
      timestamp: 1_700_000_000_000,
      message: { role: "user", content: "This is a sufficiently long user question." },
    },
    {
      type: "message",
      timestamp: 1_700_000_001_000,
      message: { role: "assistant", content: "This is a sufficiently long assistant answer that passes the length threshold and includes enough explanatory detail to exceed one hundred characters." },
    },
  ]);
  const entry = await buildSessionTranscriptEntry(file);
  eq(entry.project, "demo", "project extracted");
  eq(entry.lineMap, [3, 4], "lineMap tracks original JSONL lines despite invalid/metadata records");
  truthy(entry.content.startsWith("User: This is"), "content rendered with role label");
  truthy(entry.content.includes("Assistant:"), "assistant rendered with role label");
}

{
  const file = writeTempSession([
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Conversation info (untrusted metadata):" },
          { type: "text", text: "```json" },
          { type: "text", text: '{"message_id":"m1"}' },
          { type: "text", text: "```" },
          { type: "text", text: "" },
          { type: "text", text: "Actual user question that is long enough." },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Conversation info (untrusted metadata):" },
          { type: "text", text: "```json" },
          { type: "text", text: '{"message_id":"m2"}' },
          { type: "text", text: "```" },
          { type: "text", text: "Assistant text intentionally preserves sentinel content and is long enough." },
        ],
      },
    },
    {
      type: "message",
      message: { role: "user", content: "System (untrusted): [generated wrapper]" },
    },
    {
      type: "message",
      message: { role: "user", content: "[cron:daily] generated cron prompt" },
    },
  ]);
  const entry = await buildSessionTranscriptEntry(file);
  eq(entry.lines.length, 6, "user envelope body plus assistant physical lines only; generated wrappers skipped");
  eq(entry.lines[0]?.text, "User: Actual user question that is long enough.", "user envelope stripped to body");
  truthy(entry.lines[1]?.text.includes("Conversation info"), "assistant sentinel preserved");
  eq(entry.skipped["sanitize.generated_system_wrapper"], 1, "system wrapper skipped count");
  eq(entry.skipped["sanitize.generated_cron_prompt"], 1, "cron wrapper skipped count");
}

{
  const file = writeTempSession([
    { type: "compaction", timestamp: 1_700_000_002_000, compaction: { summary: "Compaction summary retained inline when requested." } },
    { type: "message", message: { role: "user", content: "Actual user question that is long enough." } },
  ]);
  const skipped = await buildSessionTranscriptEntry(file, { compactionMode: "skip" });
  const inline = await buildSessionTranscriptEntry(file, { compactionMode: "inline" });
  eq(skipped.compactionLines, 0, "compaction skipped by default option");
  eq(inline.compactionLines, 1, "compaction inline option adds a transcript line");
  truthy(inline.content.includes("Compaction:"), "inline compaction rendered with label");
}

section("chunkTranscriptContent / buildWindowChunks");

{
  const chunks = chunkTranscriptContent("User: one\nAssistant: two\nUser: three", { tokens: 400, overlap: 0 });
  eq(chunks.length, 1, "short transcript stays one chunk");
  eq(chunks[0]?.startLine, 1, "content startLine 1");
  eq(chunks[0]?.endLine, 3, "content endLine 3");
}

{
  const cjk = "𠀀".repeat(180);
  const chunks = chunkTranscriptContent(cjk, { tokens: 31, overlap: 0 });
  truthy(chunks.length > 1, "CJK surrogate-heavy line splits into multiple chunks");
  truthy(chunks.every((c) => !c.text.includes("\uFFFD")), "surrogate pairs are not broken");
}

{
  const file = writeTempSession([
    { type: "message", message: { role: "user", content: "First user question that is long enough for indexing." } },
    { type: "message", message: { role: "assistant", content: "First assistant answer that is long enough for indexing and explains the decision with enough detail to exceed one hundred characters." } },
    { type: "message", message: { role: "user", content: "Second user follow-up that is long enough for indexing." } },
  ]);
  const entry = await buildSessionTranscriptEntry(file);
  const chunks = buildWindowChunks(entry, { tokens: 400, overlap: 0 });
  eq(chunks.length, 1, "small session becomes one window");
  eq(chunks[0]?.startLine, 1, "window startLine remapped to original JSONL line 1");
  eq(chunks[0]?.endLine, 3, "window endLine remapped to original JSONL line 3");
  eq(chunks[0]?.messageCount, 3, "messageCount tracks transcript lines in window");
  eq(chunks[0]?.roles, ["user", "assistant"], "roles deduped in first-seen order");
}

{
  const file = writeTempSession(
    Array.from({ length: 30 }, (_, i) => ({
      type: "message",
      message: {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${i % 2 === 0 ? "User" : "Assistant"} message ${i} ` + "한글과 English mixed text. ".repeat(10),
      },
    })),
  );
  const chunks = await extractSessionWindowChunks(file, { tokens: 60, overlap: 10 });
  truthy(chunks.length > 1, "long transcript creates multiple overlapping windows");
  truthy(chunks.every((c) => c.startLine <= c.endLine), "window line ranges never reverse");
  truthy(chunks.every((c) => c.estimatedTokens > 0), "estimated tokens populated");
}

console.log(`\n=== summary ===`);
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
