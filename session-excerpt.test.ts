#!/usr/bin/env tsx
/**
 * Fixture tests for C2.1a session-excerpt.
 *
 * API 0. DB 0. Pure temp-JSONL parsing + rendering + truncation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSessionExcerpt, __test } from "./session-excerpt.ts";

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

function falsy(actual: unknown, msg: string): void {
  truthy(!actual, msg);
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function writeTempPiSession(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-excerpt-test-"));
  const sessionDir = path.join(dir, ".pi", "agent", "sessions", "--home-test-repos-gh-demo--");
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, "session.jsonl");
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
  );
  return file;
}

function writeTempClaudeSession(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-excerpt-claude-"));
  const sessionDir = path.join(dir, ".claude", "projects", "-home-test-repos-gh-demo");
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, "session.jsonl");
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
  );
  return file;
}

// ---------------------------------------------------------------------------
section("renderJsonlLine — primitive dispatch");
// ---------------------------------------------------------------------------

{
  const r = __test.renderJsonlLine("not json", 1, {
    source: "pi",
    options: {
      beforeLines: 3,
      afterLines: 3,
      maxChars: 4000,
      includeToolResults: true,
      includeSessionMessages: true,
      toolResultPreviewChars: 200,
    },
  });
  eq(r.line, null, "invalid JSON returns null line");
  eq(r.skipReason, "invalid_json", "invalid_json reason recorded");
}

{
  const r = __test.renderJsonlLine("", 1, {
    source: "pi",
    options: {
      beforeLines: 3,
      afterLines: 3,
      maxChars: 4000,
      includeToolResults: true,
      includeSessionMessages: true,
      toolResultPreviewChars: 200,
    },
  });
  eq(r.skipReason, "blank", "blank line skipped");
}

// ---------------------------------------------------------------------------
section("user / assistant text rendering (pi)");
// ---------------------------------------------------------------------------

{
  const file = writeTempPiSession([
    {
      type: "message",
      timestamp: 1_700_000_000_000,
      message: { role: "user", content: "Tell me about excerpt design." },
    },
    {
      type: "message",
      timestamp: 1_700_000_001_000,
      message: { role: "assistant", content: "Here is the design." },
    },
  ]);

  const ex = await readSessionExcerpt(file, 1, { beforeLines: 0, afterLines: 1 });
  eq(ex.startLine, 1, "startLine clamped at 1");
  eq(ex.endLine, 2, "endLine extends 1 line after");
  eq(ex.lines.length, 2, "two rendered lines");
  eq(ex.lines[0]!.kind, "user", "first kind=user");
  eq(ex.lines[1]!.kind, "assistant", "second kind=assistant");
  truthy(ex.text.startsWith("User: Tell me"), "text starts with User: label");
  truthy(ex.text.includes("Assistant: Here is the design."), "text contains assistant body");
  eq(ex.truncated, false, "no truncation under maxChars");
  eq(ex.skippedCounts, {}, "no skipped");
  eq(ex.project, "demo", "project extracted from session dir");
  eq(ex.source, "pi", "source detected as pi");
}

// ---------------------------------------------------------------------------
section("toolResult one-line summary with toolName + isError");
// ---------------------------------------------------------------------------

{
  const longContent = "a".repeat(500);
  const file = writeTempPiSession([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: longContent }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "ENOENT: no such file" }],
      },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, { beforeLines: 0, afterLines: 1 });
  eq(ex.lines.length, 2, "two tool result lines rendered");
  truthy(
    ex.lines[0]!.text.startsWith("→ tool result [read]:"),
    "first toolResult labeled with toolName, no ERROR flag",
  );
  truthy(
    ex.lines[0]!.text.endsWith(`[${longContent.length} chars total]`),
    "first toolResult shows total chars",
  );
  truthy(
    ex.lines[1]!.text.includes("[bash ERROR]"),
    "second toolResult shows ERROR flag",
  );
}

{
  // includeToolResults=false skips them.
  const file = writeTempPiSession([
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", isError: false, content: "x" },
    },
    {
      type: "message",
      message: { role: "user", content: "centered user message right here." },
    },
  ]);
  const ex = await readSessionExcerpt(file, 2, {
    beforeLines: 1,
    afterLines: 0,
    includeToolResults: false,
  });
  eq(ex.lines.length, 1, "tool result excluded when includeToolResults=false");
  eq(ex.lines[0]!.kind, "user", "only user line remains");
  truthy(
    (ex.skippedCounts.tool_results_disabled ?? 0) >= 1,
    "skip reason recorded for disabled tool results",
  );
}

// ---------------------------------------------------------------------------
section("assistant tool-only renders multiple toolCalls compactly");
// ---------------------------------------------------------------------------

{
  const file = writeTempPiSession([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "1", name: "read", arguments: { path: "/tmp/foo" } },
          {
            type: "toolCall",
            id: "2",
            name: "bash",
            arguments: { command: "ls -la /var/log" },
          },
        ],
      },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, { beforeLines: 0, afterLines: 0 });
  eq(ex.lines.length, 1, "one tool-only assistant line");
  eq(ex.lines[0]!.kind, "assistant-tool", "kind=assistant-tool");
  truthy(ex.lines[0]!.text.includes("[tool: read(path=/tmp/foo)]"), "first toolCall rendered");
  truthy(
    ex.lines[0]!.text.includes("[tool: bash(command=ls -la /var/log)]"),
    "second toolCall rendered",
  );
}

{
  // claude-format tool_use should also render.
  const file = writeTempClaudeSession([
    {
      type: "assistant",
      timestamp: "2026-05-11T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } },
        ],
      },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, { beforeLines: 0, afterLines: 0 });
  eq(ex.source, "claude", "source detected as claude");
  truthy(
    ex.lines[0]!.text.includes("[tool: Read(file_path=/x)]"),
    "claude tool_use rendered as toolCall",
  );
}

{
  // Assistant with BOTH text and toolCall — text rendered, then tail.
  const file = writeTempPiSession([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file now to understand layout." },
          { type: "toolCall", id: "1", name: "read", arguments: { path: "/etc/hosts" } },
        ],
      },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, { beforeLines: 0, afterLines: 0 });
  eq(ex.lines[0]!.kind, "assistant", "text-bearing assistant kept as 'assistant'");
  truthy(ex.lines[0]!.text.startsWith("Assistant: Reading the file"), "text body rendered first");
  truthy(ex.lines[0]!.text.includes("[tool: read(path=/etc/hosts)]"), "tool tail appended");
}

// ---------------------------------------------------------------------------
section("custom_message — entwurf-message inclusion");
// ---------------------------------------------------------------------------

{
  const file = writeTempPiSession([
    {
      type: "custom_message",
      customType: "entwurf-message",
      display: true,
      content:
        "ack — done. <sender_info>{\"agentId\":\"openai-codex/gpt-5.5\",\"sessionId\":\"abc\"}</sender_info><receiver_info>{\"agentId\":\"pi-shell-acp/claude-opus-4-7\"}</receiver_info>",
      timestamp: "2026-05-11T01:00:00Z",
    },
    {
      type: "custom_message",
      customType: "session-info",
      display: false,
      content: "device=thinkpad",
    },
    {
      type: "custom",
      customType: "context:skill_loaded",
      data: { name: "agenda" },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, { beforeLines: 0, afterLines: 2 });
  eq(ex.lines.length, 1, "only entwurf-message rendered (display=false + custom type skipped)");
  eq(ex.lines[0]!.kind, "entwurf", "kind=entwurf");
  truthy(
    ex.lines[0]!.text.startsWith("Entwurf[gpt-5.5→claude-o]:"),
    "sender/receiver short ids extracted",
  );
  truthy(
    (ex.skippedCounts.display_false ?? 0) >= 1,
    "display=false counted as skipped",
  );
  truthy(
    Object.keys(ex.skippedCounts).some((k) => k.startsWith("type:")),
    "custom (non-message) line counted under type:custom",
  );
}

{
  // includeSessionMessages=false drops entwurf entirely.
  const file = writeTempPiSession([
    {
      type: "custom_message",
      customType: "entwurf-message",
      display: true,
      content: "would-be entwurf message",
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, {
    beforeLines: 0,
    afterLines: 0,
    includeSessionMessages: false,
  });
  eq(ex.lines.length, 0, "no rendered lines when includeSessionMessages=false");
  truthy(
    (ex.skippedCounts.session_messages_disabled ?? 0) >= 1,
    "skip reason recorded for disabled session messages",
  );
}

// ---------------------------------------------------------------------------
section("claude tool_result blocks (Claude Code format)");
// ---------------------------------------------------------------------------

{
  // Claude Code flattens tool results into user-role messages whose content
  // array carries `{type: "tool_result", tool_use_id, is_error, content}`.
  const file = writeTempClaudeSession([
    {
      type: "assistant",
      timestamp: "2026-05-11T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_01ABCDEFGHIJKLMNOP", name: "Read", input: { file_path: "/tmp/x" } },
        ],
      },
    },
    {
      type: "user",
      timestamp: "2026-05-11T00:00:01Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01ABCDEFGHIJKLMNOP",
            is_error: false,
            content: "file contents on a single line of text here.",
          },
        ],
      },
    },
    {
      type: "user",
      timestamp: "2026-05-11T00:00:02Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_02ZYXWVUTSRQPONMLK",
            is_error: true,
            content: "ENOENT: no such file or directory",
          },
        ],
      },
    },
  ]);

  const ex = await readSessionExcerpt(file, 2, { beforeLines: 1, afterLines: 1 });
  eq(ex.source, "claude", "source detected as claude");
  eq(ex.lines.length, 3, "three rendered lines (assistant + 2 tool_result)");
  eq(ex.lines[1]!.kind, "tool-result", "user message with tool_result rendered as tool-result kind");
  truthy(
    ex.lines[1]!.text.startsWith("→ tool result [01ABCDEF]"),
    "tool_use_id short prefix included (sans toolu_ prefix)",
  );
  truthy(
    ex.lines[1]!.text.includes("file contents on a single line"),
    "tool_result content preview included",
  );
  truthy(
    ex.lines[1]!.text.endsWith("[44 chars total]"),
    "tool_result total chars trailer",
  );
  truthy(
    ex.lines[2]!.text.includes("[02ZYXWVU ERROR]"),
    "is_error=true flagged in claude tool_result render",
  );
  // CRITICAL: must NOT be skipped as empty:user
  falsy(
    Object.keys(ex.skippedCounts).some((k) => k.startsWith("empty:user")),
    "claude tool_result NOT misclassified as empty:user",
  );
}

{
  // claude tool_result content as array of {type:"text",text}
  const file = writeTempClaudeSession([
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01XYZ",
            is_error: false,
            content: [
              { type: "text", text: "first chunk of result " },
              { type: "text", text: "second chunk of result" },
            ],
          },
        ],
      },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, { beforeLines: 0, afterLines: 0 });
  eq(ex.lines[0]!.kind, "tool-result", "array-content tool_result still rendered");
  truthy(
    ex.lines[0]!.text.includes("first chunk of result second chunk"),
    "array text blocks joined and preview rendered",
  );
}

{
  // includeToolResults=false drops claude tool_result too (not just pi)
  const file = writeTempClaudeSession([
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_x", is_error: false, content: "ignored" },
        ],
      },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, {
    beforeLines: 0,
    afterLines: 0,
    includeToolResults: false,
  });
  eq(ex.lines.length, 0, "claude tool_result skipped when disabled");
  truthy(
    (ex.skippedCounts.tool_results_disabled ?? 0) >= 1,
    "skip reason recorded for claude tool_result disable",
  );
}

// ---------------------------------------------------------------------------
section("totalLines + bounds metadata");
// ---------------------------------------------------------------------------

{
  const file = writeTempPiSession([
    { type: "message", message: { role: "user", content: "first user line text content." } },
    { type: "message", message: { role: "user", content: "second user line text content." } },
    { type: "message", message: { role: "user", content: "third user line text content." } },
  ]);
  const ex = await readSessionExcerpt(file, 2);
  eq(ex.totalLines, 3, "totalLines reflects file line count");
}

{
  // out-of-bounds centerLine: clamps silently (CLI handles the throw)
  const file = writeTempPiSession([
    { type: "message", message: { role: "user", content: "only line in this small file." } },
  ]);
  const ex = await readSessionExcerpt(file, 999, { beforeLines: 3, afterLines: 3 });
  eq(ex.totalLines, 1, "totalLines for out-of-bounds case");
  eq(ex.lines.length, 0, "no lines rendered when centerLine past EOF");
  // startLine > endLine when out-of-bounds
  truthy(ex.startLine > ex.endLine, "startLine > endLine signals out-of-bounds");
}

{
  // empty file
  const file = writeTempPiSession([]);
  const ex = await readSessionExcerpt(file, 1);
  eq(ex.totalLines, 0, "empty file totalLines=0");
  eq(ex.skippedCounts.empty_file, 1, "empty_file skip count");
}

// ---------------------------------------------------------------------------
section("center-preserving truncation");
// ---------------------------------------------------------------------------

{
  // 5 user messages, each ~600 chars, total ~3000 chars + labels.
  // maxChars=1200 should keep center plus minimum surrounding.
  const big = "x".repeat(600);
  const lines: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    lines.push({
      type: "message",
      message: { role: "user", content: `${i}-${big}` },
    });
  }
  const file = writeTempPiSession(lines);
  const ex = await readSessionExcerpt(file, 3, {
    beforeLines: 2,
    afterLines: 2,
    maxChars: 1500,
  });
  eq(ex.truncated, true, "truncated flag set");
  truthy(ex.text.length <= 1500, `text within maxChars (${ex.text.length} <= 1500)`);
  // centerLine=3 must survive; check that some kept line has sourceLine===3
  const keptCenter = ex.lines.find((l) => l.sourceLine === 3 && !l.truncated);
  truthy(keptCenter, "centerLine preserved (sourceLine=3 kept)");
  truthy(
    ex.totalCharsBeforeTruncation > ex.text.length,
    "totalCharsBeforeTruncation > kept text length",
  );
}

{
  // Pure unit: __test.applyCenterPreservingTruncation
  const lines = [
    { sourceLine: 1, kind: "user" as const, text: "a".repeat(100) },
    { sourceLine: 5, kind: "user" as const, text: "center".repeat(20) },
    { sourceLine: 9, kind: "user" as const, text: "b".repeat(100) },
  ];
  const out = __test.applyCenterPreservingTruncation(lines, 5, 200);
  truthy(out.truncated, "applyCenterPreservingTruncation marks truncated");
  const keptCenter = out.kept.find((l) => l.sourceLine === 5);
  truthy(keptCenter, "applyCenterPreservingTruncation never drops center");
}

// ---------------------------------------------------------------------------
section("compaction and boundary clamping");
// ---------------------------------------------------------------------------

{
  const file = writeTempPiSession([
    {
      type: "compaction",
      compaction: { summary: "earlier session summary text here." },
      timestamp: 1_700_000_000_000,
    },
    {
      type: "message",
      message: { role: "user", content: "After compaction question content." },
    },
  ]);
  const ex = await readSessionExcerpt(file, 1, { beforeLines: 5, afterLines: 5 });
  eq(ex.startLine, 1, "startLine clamped to 1 even with beforeLines=5");
  eq(ex.endLine, 2, "endLine clamped to file size");
  eq(ex.lines[0]!.kind, "compaction", "compaction line kind");
  truthy(
    ex.lines[0]!.text.startsWith("[Compaction summary]"),
    "compaction prefix used",
  );
}

// ---------------------------------------------------------------------------
section("skipped counts — invalid JSON and non-target types");
// ---------------------------------------------------------------------------

{
  const file = writeTempPiSession([
    "not valid json",
    { type: "model_change", from: "x", to: "y" },
    { type: "message", message: { role: "user", content: "valid user line center." } },
  ]);
  const ex = await readSessionExcerpt(file, 3, { beforeLines: 2, afterLines: 0 });
  eq(ex.lines.length, 1, "only the user line rendered");
  truthy(
    (ex.skippedCounts.invalid_json ?? 0) >= 1,
    "invalid_json counted",
  );
  truthy(
    Object.keys(ex.skippedCounts).some((k) => k.startsWith("type:")),
    "non-target type counted under type:*",
  );
  // text must NOT contain noise like 'not valid json'
  falsy(
    ex.text.includes("not valid json"),
    "skipped lines do not bleed into excerpt text",
  );
}

// ---------------------------------------------------------------------------
section("argument summarization");
// ---------------------------------------------------------------------------

{
  eq(__test.summarizeToolArgs({ path: "/foo/bar.txt" }), "path=/foo/bar.txt", "path arg");
  eq(__test.summarizeToolArgs({ command: "ls -la" }), "command=ls -la", "command arg");
  eq(
    __test.summarizeToolArgs({ unknown: "x", another: "y" }),
    "unknown,another",
    "fallback to keys",
  );
  eq(__test.summarizeToolArgs({}), "", "empty args");
  eq(__test.summarizeToolArgs(null), "", "null args");
  // long path gets ellipsized
  const longPath = "/a/" + "b".repeat(120);
  const out = __test.summarizeToolArgs({ path: longPath });
  truthy(out.startsWith("path=/a/"), "long path retains prefix");
  truthy(out.endsWith("…"), "long path ellipsized");
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
