#!/usr/bin/env node --input-type=module
/**
 * Semantic Memory Test Suite
 *
 * Usage:
 *   cd pi-extensions/semantic-memory
 *   source ~/.env.local
 *   node test.ts                    # all tests
 *   node test.ts unit               # unit tests only (no API)
 *   node test.ts integration        # integration tests (needs API)
 *   node test.ts search "query"     # live search test
 *
 * Environment:
 *   GEMINI_API_KEY — required for integration tests
 *   JINA_API_KEY   — optional, tests rerank if set
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VectorStore, getSessionsDbPath } from "./store.ts";
import {
  findSessionFiles,
  findSessionFilesBySource,
  extractSessionChunks,
  extractProjectName,
  detectSource,
} from "./session-indexer.ts";
import { chunkOrgFile, shouldIndexOrgFile } from "./org-chunker.ts";
import type { OrgChunk } from "./org-chunker.ts";
import {
  chunkMdContent,
  parseFrontmatter,
  parseDenoteId,
  getMdFolder,
  findMdFiles,
  mdChunkToStoreRow,
  estimateStringChars,
  estimateTokensFromChars,
  CHARS_PER_TOKEN_ESTIMATE,
  INDEXABLE_MD_FOLDERS,
  MD_SOURCE_LABEL,
  MD_ROLE_LABEL,
} from "./md-chunker.ts";
import { WriteBuffer, type BufferedRecord } from "./write-buffer.ts";
import {
  getMdStaleFiles,
  computeMdPayloadHash,
  classifySuspect,
} from "./indexer.ts";
import { chunkMdFile } from "./md-chunker.ts";
import {
  rrfFusion,
  applyRecencyDecay,
  jinaRerank,
  retrieve,
  canonicalDocId,
  capPerDocumentWithBackfill,
} from "./retriever.ts";
import {
  searchMdCore,
  mdCandidateCount,
  groupMdResultsByDocument,
  formatMdScreen,
  mdResultToJson,
  stripMdDisplayScaffold,
  mdSnippet,
  mdDisplayField,
  MD_CANDIDATE_FLOOR,
  MD_MAX_CHUNKS_PER_DOC,
  MD_SNIPPET_CHARS,
  MD_DESCRIPTION_CHARS,
  MD_TITLE_CHARS,
} from "./md-search.ts";
import type { SearchResult } from "./store.ts";
import type { EmbeddingProvider } from "./embedding-provider.ts";

// --- Test Framework ---

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

function skip(msg: string) {
  skipped++;
  console.log(`  ⏭  ${msg}`);
}

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// --- Unit Tests (no API needed) ---

async function testSessionIndexer() {
  section("Session Indexer");

  // findSessionFiles
  const files = findSessionFiles();
  assert(files.length > 0, `findSessionFiles: found ${files.length} files`);
  assert(
    files.every((f) => f.endsWith(".jsonl")),
    "all files are .jsonl",
  );

  // extractProjectName — pi format
  assert(
    extractProjectName(
      "/home/user/.pi/agent/sessions/--home-user-repos-gh-agent-config--/file.jsonl",
    ) === "agent-config",
    'extractProjectName pi: "agent-config"',
  );
  assert(
    extractProjectName(
      "/home/user/.pi/agent/sessions/--home-user--/file.jsonl",
    ) === "home",
    'extractProjectName pi: "home" from home dir',
  );
  // extractProjectName — claude format
  assert(
    extractProjectName(
      "/home/user/.claude/projects/-home-user-repos-gh-andenken/abc.jsonl",
    ) === "andenken",
    'extractProjectName claude: "andenken"',
  );
  assert(
    extractProjectName(
      "/home/user/.claude/projects/-home-user/abc.jsonl",
    ) === "home",
    'extractProjectName claude: "home" from home dir',
  );
  assert(
    extractProjectName(
      "/home/junghan/.claude/projects/-home-junghan-repos-work-sks-hub-zig/abc.jsonl",
    ) === "sks-hub-zig",
    'extractProjectName claude: "sks-hub-zig" (work repo)',
  );

  // detectSource
  assert(
    detectSource("/home/user/.pi/agent/sessions/--x--/f.jsonl") === "pi",
    'detectSource: pi path → "pi"',
  );
  assert(
    detectSource("/home/user/.claude/projects/-x/f.jsonl") === "claude",
    'detectSource: claude path → "claude"',
  );

  // findSessionFilesBySource
  const piFiles = findSessionFilesBySource("pi");
  const claudeFiles = findSessionFilesBySource("claude");
  assert(piFiles.length > 0, `pi sessions: ${piFiles.length} files`);
  assert(claudeFiles.length > 0, `claude sessions: ${claudeFiles.length} files`);
  assert(
    files.length === piFiles.length + claudeFiles.length,
    `total (${files.length}) = pi (${piFiles.length}) + claude (${claudeFiles.length})`,
  );

  // extractSessionChunks — test pi session
  if (piFiles.length > 0) {
    const piChunks = await extractSessionChunks(piFiles[0]);
    if (piChunks.length > 0) {
      assert(piChunks[0].source === "pi", 'pi chunk has source="pi"');
    }
  }

  // extractSessionChunks — test claude session (find one with content)
  if (claudeFiles.length > 0) {
    let claudeChunks: Awaited<ReturnType<typeof extractSessionChunks>> = [];
    for (const cf of claudeFiles.slice(0, 10)) {
      claudeChunks = await extractSessionChunks(cf);
      if (claudeChunks.length > 0) break;
    }
    if (claudeChunks.length > 0) {
      assert(claudeChunks[0].source === "claude", 'claude chunk has source="claude"');
      assert(claudeChunks[0].role === "user" || claudeChunks[0].role === "assistant",
        `claude chunk role: "${claudeChunks[0].role}"`,
      );
    } else {
      skip("claude sessions found but no extractable chunks in first 10");
    }
  }

  // extractSessionChunks — test with first file (backward compat)
  if (files.length > 0) {
    const chunks = await extractSessionChunks(files[0]);
    assert(chunks.length > 0, `extractSessionChunks: ${chunks.length} chunks from first file`);

    // Validate chunk structure
    const c = chunks[0];
    assert(typeof c.id === "string" && c.id.length > 0, "chunk has id");
    assert(typeof c.text === "string" && c.text.length > 0, "chunk has text");
    assert(typeof c.sessionFile === "string", "chunk has sessionFile");
    assert(typeof c.project === "string", "chunk has project");
    assert(typeof c.lineNumber === "number", "chunk has lineNumber");
    assert(typeof c.role === "string", "chunk has role");
    assert(
      ["user", "assistant", "compaction"].includes(c.role),
      `chunk role is valid: "${c.role}"`,
    );

    // Text truncation
    assert(
      chunks.every((ch) => ch.text.length <= 2003), // 2000 + "..."
      "all chunks ≤ 2000 chars",
    );

    // Short messages filtered
    assert(
      chunks.filter((ch) => ch.role === "user").every((ch) => ch.text.length > 20),
      "user chunks > 20 chars (short filtered)",
    );
  }
}

// ---------------------------------------------------------------------------
// Session Indexer — sanitize integration (production path).
//
// session-sanitize.test.ts covers the sanitizer helpers in isolation.
// This section runs extractSessionChunks() end-to-end against a temp JSONL
// file, so the actual parser + sanitize + length + isNoise + truncate
// decision tree is exercised together. Modeled after OpenClaw's
// buildSessionEntry tests.
// ---------------------------------------------------------------------------

async function testSessionIndexerSanitize() {
  section("Session Indexer (sanitize integration)");

  const tmpDir = path.join(
    process.env.TMPDIR ?? "/tmp",
    `andenken-sanitize-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  const sessionFile = path.join(tmpDir, "fixture.jsonl");

  // Helper: pi JSONL line for a single message
  const piLine = (
    role: "user" | "assistant",
    text: string,
    timestamp = 1700000000000,
  ): string =>
    JSON.stringify({
      type: "message",
      timestamp,
      message: {
        role,
        content: [{ type: "text", text }],
      },
    });

  // Helper: pad text to comfortably exceed assistant length filter (>100).
  const long = (head: string): string =>
    head +
    " " +
    "본문 내용 추가 — 길이 필터(>100)를 통과시키기 위한 더미 텍스트. 이 부분은 검색 가치가 거의 없는 padding이다.";

  const lines: string[] = [
    // L1: user with inbound metadata envelope + real body
    piLine(
      "user",
      [
        "Sender (untrusted metadata):",
        "```json",
        '{"name":"telegram-user","label":"foo"}',
        "```",
        "",
        "실제 user question — 환경변수 ANDENKEN_SESSION_*는 어디서 정의되나요?",
      ].join("\n"),
    ),
    // L2: assistant whose body coincidentally contains a sentinel-shaped line
    piLine(
      "assistant",
      long(
        "Conversation info (untrusted metadata): 이 문구를 답변 본문에서 인용해 설명합니다.",
      ),
    ),
    // L3: envelope-only user message (no body) — must produce no chunk
    piLine(
      "user",
      [
        "Conversation info (untrusted metadata):",
        "```json",
        '{"id":"abc"}',
        "```",
      ].join("\n"),
    ),
    // L4: System (untrusted) wrapper user message — drop
    piLine("user", "System (untrusted): [tool error: ECONNREFUSED]"),
    // L5: cron-prompt user message — drop
    piLine("user", "[cron:daily-check] run health probe"),
    // L6: ordinary user message — keep
    piLine("user", "이 세션은 새 검색 평가 기준에 대한 토론을 이어가려고 합니다."),
    // L7: ordinary assistant message — keep
    piLine(
      "assistant",
      long("좋습니다 — 검색 평가 기준 후보 4가지를 정리하겠습니다."),
    ),
    // L8: assistant with internal runtime context block + body
    piLine(
      "assistant",
      [
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "private internal state, must not be embedded",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        "",
        long("이 답변은 runtime context를 strip한 후 본문만 남아야 합니다."),
      ].join("\n"),
    ),
  ];
  fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

  // detectSource depends on /.pi/agent/sessions/ or /.claude/ in path.
  // tmpDir doesn't include either, so we exercise the default branch (pi).
  // That's the production code path used in this test.
  const chunks = await extractSessionChunks(sessionFile);

  // Map by lineNumber for assertions
  const byLine: Record<number, typeof chunks[number] | undefined> = {};
  for (const c of chunks) byLine[c.lineNumber] = c;

  // L1: user envelope stripped, body kept, "Sender (untrusted" must NOT remain
  const l1 = byLine[1];
  assert(!!l1, "L1: envelope+body user produces chunk");
  if (l1) {
    assert(l1.role === "user", "L1: chunk role=user");
    assert(
      !l1.text.includes("Sender (untrusted metadata):"),
      "L1: sentinel removed from user chunk",
    );
    assert(
      l1.text.includes("실제 user question"),
      "L1: user body preserved",
    );
  }

  // L2: assistant — sentinel-shaped text is content, must be preserved
  const l2 = byLine[2];
  assert(!!l2, "L2: assistant sentinel-shaped content produces chunk");
  if (l2) {
    assert(l2.role === "assistant", "L2: chunk role=assistant");
    assert(
      l2.text.includes("Conversation info (untrusted metadata):"),
      "L2: sentinel text preserved verbatim in assistant chunk",
    );
  }

  // L3: envelope-only user → no chunk
  assert(byLine[3] === undefined, "L3: envelope-only user produces NO chunk");

  // L4: System (untrusted) wrapper → no chunk
  assert(byLine[4] === undefined, "L4: System (untrusted) wrapper produces NO chunk");

  // L5: cron prompt → no chunk
  assert(byLine[5] === undefined, "L5: [cron:...] prompt produces NO chunk");

  // L6: ordinary user → chunk produced, text unchanged
  const l6 = byLine[6];
  assert(!!l6, "L6: ordinary user produces chunk");
  if (l6) {
    assert(
      l6.text === "이 세션은 새 검색 평가 기준에 대한 토론을 이어가려고 합니다.",
      "L6: ordinary user text unchanged",
    );
  }

  // L7: ordinary assistant → chunk produced
  const l7 = byLine[7];
  assert(!!l7, "L7: ordinary assistant produces chunk");

  // L8: assistant with runtime context block → block stripped, body kept
  const l8 = byLine[8];
  assert(!!l8, "L8: assistant with runtime context produces chunk");
  if (l8) {
    assert(
      !l8.text.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"),
      "L8: runtime context delimiter removed",
    );
    assert(
      !l8.text.includes("private internal state"),
      "L8: runtime context body removed",
    );
    assert(
      l8.text.includes("이 답변은 runtime context를 strip한 후"),
      "L8: assistant body preserved after runtime strip",
    );
  }

  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function testOrgChunker() {
  section("Org Chunker");

  assert(
    shouldIndexOrgFile("/home/junghan/sync/org/journal/20241230T000000--2024-12-30__journal_week01.org") === false,
    "journal before 2025 is excluded",
  );
  assert(
    shouldIndexOrgFile("/home/junghan/sync/org/journal/20250106T000000--2025-01-06__journal_week02.org") === true,
    "journal from 2025 is included",
  );

  const noembedFile = "/home/junghan/sync/org/notes/20260417T100000--test__test.org";
  const noembedContent = `#+title: Test\n#+filetags: :test:noembed:\n\n* Heading\nVisible text`;
  assert(
    chunkOrgFile(noembedContent, noembedFile).length === 0,
    "filetag :noembed: skips entire file",
  );

  const taggedFile = "/home/junghan/sync/org/notes/20260417T100001--test__test.org";
  const taggedContent = `#+title: Tagged document for semantic indexing\n#+filetags: :test:\n\n* Parent\nParent intro text that is long enough for content chunk generation.\n** Hidden :noembed:\nsecret payload that must never reach embeddings.\n** Speech :TTS:\nthis transcript-like subtree should also stay out of embeddings.\n** Archived :ARCHIVE:\narchived subtree must stay out too.\n** Trace :LLMLOG:\nagent trace should also be excluded.\n** Visible\nvisible body that should remain searchable after filtering.`;
  const taggedChunks = chunkOrgFile(taggedContent, taggedFile);
  const contentTexts = taggedChunks.filter((c) => c.chunkType === "content").map((c) => c.rawText);
  const headingTexts = taggedChunks.filter((c) => c.chunkType === "heading").map((c) => c.rawText);

  assert(
    contentTexts.some((t) => t.includes("Parent intro")) && !contentTexts.some((t) => t.includes("secret payload")),
    "excluded subtree content does not leak into parent chunk",
  );
  assert(
    contentTexts.some((t) => t.includes("visible body")) && !contentTexts.some((t) => t.includes("transcript-like subtree")),
    "visible sibling remains while :TTS: subtree is skipped",
  );
  assert(
    !contentTexts.some((t) => t.includes("archived subtree")) && !contentTexts.some((t) => t.includes("agent trace")),
    ":ARCHIVE: and :LLMLOG: subtrees are skipped from content tier",
  );
  assert(
    !headingTexts.includes("Hidden") && !headingTexts.includes("Speech") && !headingTexts.includes("Archived") && !headingTexts.includes("Trace") && headingTexts.includes("Visible"),
    "excluded headings are omitted from heading tier",
  );
}

async function testMdChunker() {
  section("MD Chunker (issue #8, OpenClaw port + CJK)");

  // --- parseFrontmatter (YAML) ---
  const yaml = `---
title: "테스트 노트"
description: "샘플 설명"
date: 2024-01-15T09:00:00+09:00
tags: ["notes", "test", "md"]
categories: ["Noname"]
draft: false
---

## 본문 시작

본문 텍스트.
`;
  const { frontmatter, bodyOffset } = parseFrontmatter(yaml);
  assert(frontmatter.title === "테스트 노트", "YAML title parsed");
  assert(frontmatter.description === "샘플 설명", "YAML description parsed");
  assert(
    frontmatter.tags.length === 3 && frontmatter.tags[0] === "notes",
    "YAML tags parsed as list",
  );
  assert(frontmatter.draft === false, "YAML draft=false parsed");
  assert(bodyOffset > 0, "bodyOffset positive when frontmatter present");

  // --- parseFrontmatter (TOML key=value) ---
  const toml = `+++
title = "TOML 노트"
tags = ["a", "b"]
+++

본문 텍스트가 충분히 길어서 미니멈을 통과한다. 한글 본문 길이 채우기.`;
  const fmToml = parseFrontmatter(toml).frontmatter;
  assert(fmToml.title === "TOML 노트", "TOML title parsed via = delimiter");
  assert(fmToml.tags.length === 2 && fmToml.tags[1] === "b", "TOML tags parsed");

  // --- parseDenoteId ---
  assert(
    parseDenoteId("/garden/notes/20211117T190700.md") === "20211117T190700",
    "denote-id parsed from filename",
  );
  assert(
    parseDenoteId("/garden/notes/just-a-slug.md") === undefined,
    "non-denote filename returns undefined",
  );

  // --- getMdFolder ---
  assert(
    getMdFolder(
      "/home/u/repos/gh/notes/content/notes/foo.md",
      "/home/u/repos/gh/notes/content",
    ) === "notes",
    "getMdFolder picks first segment after root",
  );

  // --- INDEXABLE_MD_FOLDERS contract ---
  assert(
    INDEXABLE_MD_FOLDERS.has("notes")
      && INDEXABLE_MD_FOLDERS.has("bib")
      && INDEXABLE_MD_FOLDERS.has("meta")
      && INDEXABLE_MD_FOLDERS.has("journal")
      && INDEXABLE_MD_FOLDERS.has("botlog"),
    "INDEXABLE_MD_FOLDERS includes all five baseline folders",
  );
  assert(
    !INDEXABLE_MD_FOLDERS.has("images")
      && !INDEXABLE_MD_FOLDERS.has("talks")
      && !INDEXABLE_MD_FOLDERS.has("test")
      && !INDEXABLE_MD_FOLDERS.has("tmp"),
    "INDEXABLE_MD_FOLDERS excludes images/talks/test/tmp",
  );

  // --- CJK weighting (ported from OpenClaw cjk-chars.ts) ---
  assert(
    estimateStringChars("abcd") === 4,
    "ASCII: estimateStringChars equals length",
  );
  assert(
    estimateStringChars("가") === CHARS_PER_TOKEN_ESTIMATE,
    `CJK single Hangul: weighted to ${CHARS_PER_TOKEN_ESTIMATE} (1 char → 1 token but accounted as 4 for the chars/4 formula)`,
  );
  assert(
    estimateStringChars("a가") === 1 + CHARS_PER_TOKEN_ESTIMATE,
    "mixed Latin+Hangul: 1 + 4",
  );
  assert(
    estimateTokensFromChars(estimateStringChars("가나다라마")) === 5,
    "5 Hangul chars → 5 tokens via chars/4 formula",
  );
  assert(
    estimateTokensFromChars(estimateStringChars("hello world")) === 3,
    '"hello world" (11 chars) → 3 tokens',
  );

  // --- chunkMdContent: basic body + FTS-vs-embedding split (gpt-5.5 #1) ---
  // Build a body big enough to clear MIN_FILE_BODY_CHARS=250 with margin.
  const filler =
    "본문은 충분히 길어야 MIN_FILE_BODY_CHARS=250 임계를 통과합니다. 한글 텍스트를 충분히 채워서 미니멈을 넘기는 샘플 본문. ";
  const body = yaml + filler.repeat(5);
  const chunks = chunkMdContent(
    body,
    "/garden/notes/20211117T190700.md",
    "notes",
  );
  assert(chunks.length >= 1, `chunkMdContent emits ≥1 chunk (got ${chunks.length})`);
  if (chunks.length > 0) {
    const c = chunks[0];
    assert(c.filePath === "/garden/notes/20211117T190700.md", "chunk filePath preserved");
    assert(c.folder === "notes", "chunk folder=notes");
    assert(c.denoteId === "20211117T190700", "chunk denoteId extracted");
    assert(typeof c.hash === "string" && c.hash.length === 64, "chunk has sha256 hash");
    assert(c.frontmatter.title === "테스트 노트", "chunk frontmatter preserved");

    // FTS-side text: Title + Tags + body
    assert(c.text.startsWith("Title:"), "chunk.text starts with Title: prefix (FTS-side)");
    assert(c.text.includes("Tags:"), "chunk.text contains Tags: line (FTS-side)");
    assert(c.text.includes(c.embeddingInput), "chunk.text contains chunk.embeddingInput");
    // Embedding-side: body only, no prefix
    assert(
      !c.embeddingInput.includes("Title:") && !c.embeddingInput.includes("Tags:"),
      "chunk.embeddingInput is body-only — no prefix (OpenClaw style)",
    );
    assert(c.embeddingInput === c.rawText, "chunk.embeddingInput === chunk.rawText");
    // FTS surface is strictly larger than vector surface because of the prefix.
    assert(c.text.length > c.embeddingInput.length, "FTS text > embedding input");
    assert(c.startLine > 1, `chunk.startLine offset past frontmatter (got ${c.startLine})`);
  }

  // --- chunkMdContent: tiny body skipped (MIN_FILE_BODY_CHARS = 250) ---
  const tiny = `---
title: "Tiny"
tags: []
---
ok`;
  const tinyChunks = chunkMdContent(tiny, "/g/notes/c.md", "notes");
  assert(tinyChunks.length === 0, `tiny body skipped via MIN_FILE_BODY_CHARS (got ${tinyChunks.length})`);

  // --- chunkMdContent: noembed tag opt-out ---
  const optout = `---
title: "Hidden"
tags: ["noembed"]
---

본문이 충분히 길어도 noembed 태그면 스킵된다. 가든 페이지 단위 opt-out. 한국어 본문 길이 보장.`.repeat(2);
  const optoutChunks = chunkMdContent(optout, "/g/notes/h.md", "notes");
  assert(
    optoutChunks.length === 0,
    `noembed tag → 0 chunks (got ${optoutChunks.length})`,
  );

  // --- chunkMdContent: bibliography tail stripped (journal CITATIONS shape) ---
  //
  // The tail strip only fires when the heading sits past the 50% char mark
  // of the sanitized body — bib pages that LEAD with BIBLIOGRAPHY are
  // preserved. We size the body large enough for the tail to be clearly
  // late.
  const longParas = `${"한국어 본문 단락의 임베딩 가치가 있는 실제 컨텐츠. ".repeat(40)}\n\n${"두 번째 단락도 충분히 길게 채워서 본문이 50% 이상 차지하도록 만든다. ".repeat(40)}`;
  const journal = `---
title: "Journal Entry"
tags: ["journal"]
---

${longParas}

## CITATIONS

<a href="#citeproc_bib_item_1">citeproc anchor 1</a>
<a href="#citeproc_bib_item_2">citeproc anchor 2</a>
<a href="#citeproc_bib_item_3">citeproc anchor 3</a>

## BIBLIOGRAPHY

bibliography entry 1
bibliography entry 2
`;
  const journalChunks = chunkMdContent(journal, "/g/journal/x.md", "journal");
  assert(
    journalChunks.length >= 1,
    `journal body still produces chunks after tail strip (got ${journalChunks.length})`,
  );
  assert(
    journalChunks.every((c) =>
      !c.embeddingInput.includes("citeproc_bib_item") &&
      !c.embeddingInput.includes("bibliography entry"),
    ),
    "CITATIONS / BIBLIOGRAPHY tail stripped from embeddingInput",
  );

  // --- chunkMdContent: bibliography in early half is preserved (bib pages) ---
  // A bib page might lead with `## BIBLIOGRAPHY` directly under the
  // frontmatter (the entire body IS the bibliography). The strip must NOT
  // eat that content.
  const bibTop = `---
title: "Book"
tags: ["bib"]
---

## BIBLIOGRAPHY

매우 길고 의미 있는 참고문헌 블록. ${"실제 인용 내용을 포함한 참고문헌 텍스트. ".repeat(50)}

## 그 다음 섹션

후속 본문도 충분히 길게 채워서 BIBLIOGRAPHY 헤딩이 전체의 절반 이전에 등장하도록 만든다. ${"후속 본문 채우기. ".repeat(30)}`;
  const bibChunks = chunkMdContent(bibTop, "/g/bib/y.md", "bib");
  assert(
    bibChunks.some((c) => c.embeddingInput.includes("참고문헌")),
    "BIBLIOGRAPHY heading in early half preserved (bib pages)",
  );

  // --- chunkMdContent: large body produces multiple chunks via OpenClaw budget ---
  // notes folder: 1000 tokens × 4 = 4000 chars budget for Latin; with CJK
  // weighting Korean text fills faster. Build a body that should split.
  const para = "한국어 본문 단락. 가든 노트의 한 단락. 충분히 길어서 청크 budget을 넘긴다. ".repeat(20);
  const big = `---
title: "Big"
tags: []
---
${para}

${para}

${para}
`;
  const bigChunks = chunkMdContent(big, "/g/notes/big.md", "notes");
  assert(
    bigChunks.length >= 2,
    `large Korean body splits into ≥2 chunks (got ${bigChunks.length})`,
  );
  assert(
    bigChunks.every((c) => c.text.length >= 40),
    "every chunk passes MIN_CHUNK_CHARS",
  );

  // --- chunkMdContent: chunk index monotonic and start/end lines sorted ---
  for (let i = 1; i < bigChunks.length; i++) {
    assert(
      bigChunks[i].chunkIndex === bigChunks[i - 1].chunkIndex + 1,
      `chunkIndex monotonic at i=${i}`,
    );
    assert(
      bigChunks[i].startLine >= bigChunks[i - 1].startLine,
      `startLine non-decreasing at i=${i}`,
    );
  }

  // --- mdChunkToStoreRow shape ---
  if (chunks.length > 0) {
    const row = mdChunkToStoreRow(chunks[0], [0, 0, 0], "2024-01-15T00:00:00.000Z");
    assert(row.source === MD_SOURCE_LABEL, 'storeRow.source = "md"');
    assert(row.role === MD_ROLE_LABEL, `storeRow.role = "${MD_ROLE_LABEL}" (was "" — changed to allow union search)`);
    assert(row.sessionFile === chunks[0].filePath, "storeRow.sessionFile = md file path");
    assert(row.project === "notes", "storeRow.project = folder");
    assert(typeof row.metadata.hash === "string", "storeRow.metadata.hash present");
    assert(!row.metadata.hierarchy, "storeRow.metadata.hierarchy removed (heading-aware design retired)");
    // gpt-5.5 #1: store row text is the enriched FTS-side string.
    assert(row.text === chunks[0].text, "storeRow.text = chunk.text (FTS-enriched)");
    assert(row.text.startsWith("Title:"), "storeRow.text carries Title prefix for FTS");
  }

  // --- findMdFiles smoke (no-throw on a non-existent root) ---
  const nope = findMdFiles("/tmp/__definitely_not_here__");
  assert(Array.isArray(nope) && nope.length === 0, "findMdFiles returns [] for missing root");
}

async function testMdStalePolicy() {
  section("MD Stale Policy (2026-05-20 size-guard + payload-hash)");

  // --- classifySuspect (pure) ---
  // The most safety-critical helper: a "missing prior hash" outcome must
  // never collapse to skip-embed, otherwise a legacy manifest entry coupled
  // with a same-size body change would never reach LanceDB.
  assert(
    classifySuspect(undefined, "h1") === "stale_missing_hash",
    "missing prior hash → stale_missing_hash (conservative re-embed)",
  );
  assert(
    classifySuspect("h1", "h1") === "unchanged_hash_match",
    "matching prior hash → unchanged_hash_match (skip embed)",
  );
  assert(
    classifySuspect("h1", "h2") === "stale_hash_mismatch",
    "different prior hash → stale_hash_mismatch (re-embed)",
  );

  // --- computeMdPayloadHash (pure) ---
  const h1 = computeMdPayloadHash([{ embeddingInput: "AB" }, { embeddingInput: "CD" }]);
  const h2 = computeMdPayloadHash([{ embeddingInput: "AB" }, { embeddingInput: "CD" }]);
  const h3 = computeMdPayloadHash([{ embeddingInput: "ABCD" }]);
  const h4 = computeMdPayloadHash([{ embeddingInput: "AB" }, { embeddingInput: "C" }, { embeddingInput: "D" }]);
  assert(h1 === h2, "computeMdPayloadHash deterministic for same chunks");
  assert(h1 !== h3, "different chunk boundaries → different hash (boundary-sensitive)");
  assert(h1 !== h4, "different chunk count at same total chars → different hash");

  // --- Integration: legacy entry + same-size body change (Finding 1 regression) ---
  // Scenario: a manifest carried over from before payloadHash existed has
  // mtime/size/chunks but no payloadHash. The garden file gets a body edit
  // that happens to keep byte size identical (e.g. "hello" → "hella").
  // Expected: getMdStaleFiles classifies the file as suspect, and the
  // classifier returns stale_missing_hash so the indexer re-embeds.
  const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "andenken-md-stale-"));
  try {
    const filePath = path.join(tmpRoot, "legacy.md");
    // Body must be long enough to clear the chunker's min_body floor.
    // Body must clear chunker thresholds (MIN_FILE_BODY_CHARS=250, MIN_CHUNK_CHARS=100).
    const bodyOriginal = "본문 텍스트가 충분히 길어서 미니멈을 통과한다. ".repeat(20);
    const bodyEdited =   "본문 데스트가 충분히 길어서 미니멈을 통과한다. ".repeat(20); // same length, one char differs
    assert(bodyOriginal.length === bodyEdited.length, "test fixture: edits preserve byte size");
    const wrap = (body: string) => `---\ntitle: legacy\n---\n\n${body}\n`;
    fs.writeFileSync(filePath, wrap(bodyOriginal));

    // Hash the ORIGINAL body so we can later verify the edit produces a
    // different hash through chunkMdFile (the chunker is the SSOT — we do
    // not pre-compute hashes from raw body to avoid shadowing the test).
    const originalChunks = chunkMdFile(filePath, { bypassFolderPolicy: true });
    assert(originalChunks.length > 0, "chunker emits chunks for fixture body");
    const originalHash = computeMdPayloadHash(originalChunks);

    // Snapshot the legacy manifest entry: mtime/size/chunks present, no
    // payloadHash. Pretend the entry was recorded an hour ago.
    const statBefore = fs.statSync(filePath);
    const legacyEntry = {
      mtimeMs: statBefore.mtimeMs,
      size: statBefore.size,
      chunks: originalChunks.length,
    };
    const manifest = { files: { [filePath]: legacyEntry }, lastUpdated: "" };

    // Edit the body in place — same length, different content. Then bump
    // mtime forward so getMdStaleFiles flags it as suspect.
    fs.writeFileSync(filePath, wrap(bodyEdited));
    const futureSecs = (statBefore.mtimeMs / 1000) + 60;
    fs.utimesSync(filePath, futureSecs, futureSecs);
    const statAfter = fs.statSync(filePath);
    assert(statAfter.size === statBefore.size, "edited file: size identical");
    assert(statAfter.mtimeMs > statBefore.mtimeMs, "edited file: mtime newer");

    // Classify and verify.
    const indexed = new Set<string>([filePath]);
    const result = getMdStaleFiles([filePath], indexed, manifest);
    assert(result.suspectFiles.length === 1 && result.suspectFiles[0] === filePath,
      "same-size body change goes to suspectFiles (not unchanged, not staleByMeta)");
    assert(result.staleByMeta.length === 0, "size-same path does not produce staleByMeta");

    const newChunks = chunkMdFile(filePath, { bypassFolderPolicy: true });
    const newHash = computeMdPayloadHash(newChunks);
    assert(newHash !== originalHash, "edited body produces different payload hash");

    const outcome = classifySuspect(legacyEntry.payloadHash, newHash);
    assert(outcome === "stale_missing_hash",
      "legacy entry (no prior hash) + same-size body change → stale_missing_hash (re-embed required)");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testRetriever() {
  section("Retriever");

  // Mock results for testing.
  //
  // `sessionFile` is derived from the id rather than hard-coded: every mock used
  // to share `/test/file.jsonl`, which made document identity untestable —
  // a per-document cap would have collapsed the whole fixture into one row and
  // nobody would have noticed either the bug or its fix.
  const makeResult = (
    id: string,
    score: number,
    timestamp?: string,
    sessionFile?: string,
  ): SearchResult => ({
    id,
    text: `text for ${id}`,
    sessionFile: sessionFile ?? `/test/${id}.jsonl`,
    project: "test",
    lineNumber: 1,
    timestamp: timestamp ?? new Date().toISOString(),
    role: "user",
    metadata: {},
    score,
  });

  // RRF Fusion
  const vecResults = [makeResult("a", 0.9), makeResult("b", 0.7), makeResult("c", 0.5)];
  const ftsResults = [makeResult("b", 0.8), makeResult("d", 0.6), makeResult("a", 0.4)];

  const fused = rrfFusion(vecResults, ftsResults, 0.7, 0.3);
  assert(fused.length === 4, `RRF fusion: 4 unique results from 3+3`);
  assert(fused[0].id === "b" || fused[0].id === "a", `RRF: top result is overlapping (a or b)`);

  // Check that overlapping items get higher scores
  const aScore = fused.find((r) => r.id === "a")!.score;
  const dScore = fused.find((r) => r.id === "d")!.score;
  assert(aScore > dScore, `RRF: overlapping "a" (${aScore.toFixed(4)}) > unique "d" (${dScore.toFixed(4)})`);

  // Recency Decay
  const now = new Date();
  const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  const recentResults = [
    makeResult("recent", 1.0, now.toISOString()),
    makeResult("old", 1.0, oldDate.toISOString()),
  ];

  const decayed = applyRecencyDecay(recentResults, 14);
  const recentScore = decayed.find((r) => r.id === "recent")!.score;
  const oldScore = decayed.find((r) => r.id === "old")!.score;
  assert(
    recentScore > oldScore,
    `Decay: recent (${recentScore.toFixed(3)}) > old (${oldScore.toFixed(3)})`,
  );
  assert(
    oldScore < 0.5,
    `Decay: 30-day-old with halfLife=14 should be < 0.5 (got ${oldScore.toFixed(3)})`,
  );

  // Full retrieve pipeline (without rerank)
  const retrieved = await retrieve("test", vecResults, ftsResults, {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    recencyHalfLifeDays: 14,
  });
  assert(retrieved.length > 0, `Retrieve pipeline: ${retrieved.length} results`);
  assert(
    retrieved[0].score >= retrieved[retrieved.length - 1].score,
    "Retrieve: sorted descending by score",
  );

  // --- Document identity across the three real id shapes -------------------
  //
  // The legacy `fileDedup` regex (`:[ch]\d+`) collapsed only the org shape, so
  // it was a no-op for BOTH production tracks. Document identity now comes from
  // the stored `sessionFile` column, which every track populates.
  const docShapes: Array<[string, string, string]> = [
    ["md", "/home/x/notes/content/notes/garden2wikidocs.md#3", "/home/x/notes/content/notes/garden2wikidocs.md"],
    ["md", "/home/x/notes/content/notes/garden2wikidocs.md#11", "/home/x/notes/content/notes/garden2wikidocs.md"],
    ["session", "/home/x/.pi/agent/sessions/p/20260810_a.jsonl:4521", "/home/x/.pi/agent/sessions/p/20260810_a.jsonl"],
    ["org", "/home/x/org/notes/20250214T145957.org:c12", "/home/x/org/notes/20250214T145957.org"],
  ];
  for (const [track, id, file] of docShapes) {
    const r = makeResult(id, 1, undefined, file);
    assert(canonicalDocId(r) === file, `docId (${track}): ${id} → document path`);
  }
  // Legacy rows with no stored sessionFile fall back to the id — and the
  // fallback must strip ALL THREE real suffixes, not just the org one. A
  // fallback that handles a single shape is how the original defect hid.
  const legacyShapes: Array<[string, string, string]> = [
    ["md #N", "/g/a.md#3", "/g/a.md"],
    ["md #NN", "/g/a.md#11", "/g/a.md"],
    ["session :line", "/s/a.jsonl:4521", "/s/a.jsonl"],
    ["org :cN", "/o/n.org:c12", "/o/n.org"],
    ["org :hN", "/o/n.org:h44", "/o/n.org"],
    ["org :cN:mN", "/o/n.org:c12:m3", "/o/n.org"],
  ];
  for (const [shape, id, doc] of legacyShapes) {
    const row = { ...makeResult("x", 1), sessionFile: "", id };
    assert(canonicalDocId(row) === doc, `docId fallback (${shape}): ${id} → ${doc}`);
  }
  const twoChunks = ["/g/a.md#3", "/g/a.md#11"].map((id) => ({
    ...makeResult(id, 1),
    sessionFile: "",
    id,
  }));
  assert(
    canonicalDocId(twoChunks[0]) === canonicalDocId(twoChunks[1]),
    "docId fallback: two md chunks of one document collapse to the same key",
  );

  // --- Per-document cap is lossless ---------------------------------------
  const docA = "/g/a.md";
  const docB = "/g/b.md";
  const monopoly = [
    makeResult(`${docA}#1`, 0.9, undefined, docA),
    makeResult(`${docA}#2`, 0.8, undefined, docA),
    makeResult(`${docA}#3`, 0.7, undefined, docA),
    makeResult(`${docB}#1`, 0.6, undefined, docB),
    makeResult(`${docA}#4`, 0.5, undefined, docA),
  ];
  const capped = capPerDocumentWithBackfill(monopoly, MD_MAX_CHUNKS_PER_DOC);
  assert(capped.length === monopoly.length, "cap: no candidate is lost");
  assert(
    new Set(capped.map((r) => r.id)).size === new Set(monopoly.map((r) => r.id)).size &&
      capped.every((r) => monopoly.some((m) => m.id === r.id)),
    "cap: output is a permutation of the input — recall is unchanged",
  );
  assert(
    capped.slice(0, 3).filter((r) => r.sessionFile === docA).length === 2,
    "cap: one document holds at most 2 rows while an alternative remains",
  );
  assert(capped[2].sessionFile === docB, "cap: the other document is pulled onto the first screen");
  assert(
    capped[3].sessionFile === docA && capped[4].sessionFile === docA,
    "cap: over-cap chunks backfill behind the capped pass, in score order",
  );
  const narrow = [
    makeResult(`${docA}#1`, 0.9, undefined, docA),
    makeResult(`${docA}#2`, 0.8, undefined, docA),
    makeResult(`${docA}#3`, 0.7, undefined, docA),
  ];
  assert(
    capPerDocumentWithBackfill(narrow, MD_MAX_CHUNKS_PER_DOC).map((r) => r.id).join() ===
      narrow.map((r) => r.id).join(),
    "cap: a narrow lookup with one document keeps its full screen, unreordered",
  );

  // Sessions must not acquire a document cap: `retrieve` without documentCap
  // keeps the legacy path, which is a no-op for `path.jsonl:<line>` ids.
  const sessDoc = "/s/deep.jsonl";
  const deep = [1, 2, 3, 4, 5].map((i) =>
    makeResult(`${sessDoc}:${i * 100}`, 1 - i * 0.1, undefined, sessDoc),
  );
  const sessOut = await retrieve("q", deep, [], {
    mergeStrategy: "rrf",
    recencyHalfLifeDays: 0,
    minScore: 0,
    mmr: { enabled: false, lambda: 0.7 },
  });
  assert(
    sessOut.length === deep.length,
    `sessions: a deep single-session result set is not truncated (${sessOut.length}/${deep.length})`,
  );
}

async function testMdSurface() {
  section("MD retrieval surface (candidate floor · doc grouping · compact screen)");

  // --- Candidate floor: limit stops being a ranking parameter --------------
  assert(mdCandidateCount(5) === MD_CANDIDATE_FLOOR, "candidates: limit 5 sits on the floor");
  assert(mdCandidateCount(10) === MD_CANDIDATE_FLOOR, "candidates: limit 10 sits on the same floor");
  assert(
    mdCandidateCount(5) === mdCandidateCount(10),
    "limit invariance: display limit 5 and 10 see the SAME candidate universe",
  );
  assert(mdCandidateCount(100) === 200, "candidates: ceiling still applies for wide limits");
  assert(mdCandidateCount(30) === 120, "candidates: above the floor, limit × 4 still governs");

  const mk = (doc: string, chunk: number, score: number): SearchResult => ({
    id: `${doc}#${chunk}`,
    text: `Title: ${doc}\nTags: a, b\n\nbody of ${doc} chunk ${chunk}`,
    sessionFile: doc,
    project: "notes",
    lineNumber: chunk * 10,
    timestamp: "2026-07-27T04:05:52.100Z",
    role: "doc",
    source: "md",
    metadata: { title: `T ${doc}`, denoteId: `2026010${chunk}T000000`, description: `desc ${doc}`, chunkIndex: String(chunk) },
    score,
  });
  const universe = [
    mk("/g/a.md", 1, 0.99), mk("/g/a.md", 2, 0.95), mk("/g/b.md", 1, 0.90),
    mk("/g/a.md", 3, 0.85), mk("/g/c.md", 1, 0.80), mk("/g/d.md", 1, 0.75),
    mk("/g/b.md", 2, 0.70), mk("/g/e.md", 1, 0.65), mk("/g/f.md", 1, 0.60),
    mk("/g/g.md", 1, 0.55),
  ];
  const ordered = capPerDocumentWithBackfill(universe, MD_MAX_CHUNKS_PER_DOC);

  // --- Limit invariance, through the REAL pipeline --------------------------
  //
  // Asserting `slice(0,5) === slice(0,10).slice(0,5)` proves nothing — it is
  // true of any array. The claim that matters is about `searchMdCore`: two
  // display limits must issue the SAME candidate requests and therefore produce
  // the same first screen after merge/MMR/document ordering. So this drives the
  // real function with a stub store and a stub provider (no API, no DB) and
  // records what the store was actually asked for.
  //
  // The stub honours the requested candidate count (`slice(0, n)`), which is
  // what makes the test non-trivial: without the floor, limit 5 would ask for
  // 20 of these 44 rows and a different set would survive.
  const bigUniverse: SearchResult[] = [];
  for (let d = 0; d < 22; d++) {
    for (let c = 1; c <= 2; c++) {
      bigUniverse.push(mk(`/g/doc${String(d).padStart(2, "0")}.md`, c, 1 - d * 0.04 - c * 0.005));
    }
  }
  const asked: { vector: number[]; fts: number[] } = { vector: [], fts: [] };
  const stubStore = {
    async search(_v: number[], n: number) {
      asked.vector.push(n);
      return bigUniverse.slice(0, n);
    },
    async fullTextSearch(_q: string, n: number) {
      asked.fts.push(n);
      // Offset so vector and FTS buckets differ — the merge must do real work.
      return bigUniverse.slice(2, n);
    },
    async substringSearch(_t: string, n: number) {
      return bigUniverse.slice(0, Math.min(2, n));
    },
  };
  let embedCalls = 0;
  const stubProvider = {
    name: "stub",
    dimensions: 4096,
    async embedQuery(_q: string) {
      embedCalls++;
      return [0.1, 0.2, 0.3];
    },
  };
  const runCore = async (limit: number) =>
    searchMdCore(
      stubStore as unknown as VectorStore,
      stubProvider as unknown as EmbeddingProvider,
      "embodied cognition garden",
      limit,
      { expand: false }, // no dictcli subprocess in a unit test
    );
  const at5 = await runCore(5);
  const at10 = await runCore(10);
  assert(
    asked.vector.join() === "40,40" && asked.fts.join() === "40,40",
    `limit invariance: both limits request the same candidate depth (vector ${asked.vector.join("/")}, fts ${asked.fts.join("/")})`,
  );
  assert(at5.results.length === 5 && at10.results.length === 10, "searchMdCore honours the display limit");
  assert(
    at5.results.map((r) => r.id).join() === at10.results.slice(0, 5).map((r) => r.id).join(),
    "limit invariance: top-5 ids identical at limit 5 and limit 10, through the real retrieve pipeline",
  );
  assert(embedCalls === 2, "searchMdCore issues exactly one query embedding per call");
  const capViolation = at10.results
    .slice(0, 5)
    .filter((r, _i, arr) => arr.filter((x) => x.sessionFile === r.sessionFile).length > MD_MAX_CHUNKS_PER_DOC);
  assert(capViolation.length === 0, "searchMdCore applies the md document cap to its own output");

  // --- Document grouping ---------------------------------------------------
  const groups = groupMdResultsByDocument(ordered.slice(0, 5));
  assert(groups[0].file === "/g/a.md", "grouping: rank order is preserved by first appearance");
  assert(groups[0].chunks.length === 2, "grouping: a document's adjacent chunks collapse into one group");
  assert(
    groups.length === new Set(ordered.slice(0, 5).map((r) => r.sessionFile)).size,
    "grouping: one group per distinct document",
  );

  // --- Display scaffold stripping (display only) ---------------------------
  const noisy =
    'Title: X\nTags: a, b\n\nsee [n]({{< relref "/botlog/2026.md" >}}) and ' +
    '<span class="timestamp-wrapper"><span class="timestamp">[2026-07-18 Sat]</span></span> ' +
    "## Heading {#heading-anchor} &lt;kept&gt;";
  const stripped = stripMdDisplayScaffold(noisy);
  assert(!stripped.includes("relref"), "display: Hugo relref shortcodes are stripped");
  assert(!stripped.includes("<span"), "display: export span wrappers are stripped");
  assert(!stripped.includes("{#heading-anchor}"), "display: heading anchors are stripped");
  assert(!stripped.startsWith("Title:"), "display: the FTS Title/Tags preamble is not re-shown per chunk");
  assert(stripped.includes("<kept>"), "display: entity-escaped prose survives as prose");
  assert(
    stripped.includes("see n and") && !stripped.includes("]()"),
    "display: a de-linked relref keeps the neighbour's title and drops the empty parens",
  );

  assert(mdSnippet("x".repeat(500)).length === MD_SNIPPET_CHARS + 1, "snippet: budget is enforced (+ellipsis)");
  assert(mdSnippet("short body").endsWith("body"), "snippet: short bodies are not padded or truncated");

  // --- Author-written fields are budgeted ----------------------------------
  assert(
    mdDisplayField("x".repeat(900), MD_DESCRIPTION_CHARS).length === MD_DESCRIPTION_CHARS + 1,
    "description: an unbounded frontmatter field is truncated to its budget (+ellipsis)",
  );
  assert(
    mdDisplayField("short", MD_DESCRIPTION_CHARS) === "short",
    "description: a short field is passed through untouched",
  );
  assert(
    !mdDisplayField('a {{< relref "/x.md" >}} b', MD_DESCRIPTION_CHARS).includes("relref"),
    "description: display scaffold is stripped before the budget applies",
  );
  const longDoc = "/g/long.md";
  const longRow: SearchResult = {
    ...mk(longDoc, 1, 0.9),
    metadata: {
      title: "T".repeat(400),
      denoteId: "20260101T000000",
      description: "D".repeat(900),
      chunkIndex: "1",
    },
  };
  const longScreen = formatMdScreen("q", [longRow, { ...longRow, id: `${longDoc}#2`, metadata: { ...longRow.metadata, chunkIndex: "2" } }]);
  assert(
    longScreen.split("\n").filter((l) => /^ {3}D+…?$/.test(l)).length === 1,
    "screen: an oversized description is printed once per document, not once per chunk",
  );
  assert(
    !longScreen.includes("D".repeat(MD_DESCRIPTION_CHARS + 1)),
    `screen: description never exceeds ${MD_DESCRIPTION_CHARS} chars`,
  );
  assert(
    !longScreen.includes("T".repeat(MD_TITLE_CHARS + 1)),
    `screen: title never exceeds ${MD_TITLE_CHARS} chars`,
  );

  // --- Compact screen ------------------------------------------------------
  const screen = formatMdScreen("q", ordered.slice(0, 5));
  assert(screen.includes("across 4 documents"), "screen: document count is stated, not just chunk count");
  assert(!screen.includes("[md]") && !/\bdoc\b\s*\(score/.test(screen), "screen: the constant [md] doc tag is gone");
  assert(!screen.includes("2026-07-27T04:05:52.100Z"), "screen: the export mtime is never shown as semantic time");
  assert(screen.includes("2026010"), "screen: the Denote ID is shown as the note's coordinate");
  assert(screen.includes("/g/a.md"), "screen: the openable source path is shown once per document");
  assert((screen.match(/desc \/g\/a\.md/g) ?? []).length === 1, "screen: the description is printed once per document, not per chunk");
  assert(
    !/·\s*0\.\d\d(\s|$)/m.test(screen) && !screen.includes("score"),
    "screen: no numeric score reaches model-visible content — a normalized rank is not a confidence",
  );
  const legacyBytes = ordered.slice(0, 10).reduce((n, r) => n + Math.min(r.text.length, 500) + 120, 0);
  assert(screen.length < legacyBytes, `screen: compact form is smaller than the legacy limit-10 form (${screen.length} < ${legacyBytes})`);

  // --- JSON row ------------------------------------------------------------
  const row = mdResultToJson(ordered[0]);
  assert(row.denoteId === "20260101T000000", "json: Denote ID is exposed");
  assert(row.indexedAt === "2026-07-27T04:05:52.100Z", "json: the mtime survives, named `indexedAt` for what it is");
  assert(!("timestamp" in row), "json: no `timestamp` key that could be read as the note's date");
  assert(typeof row.file === "string" && (row.file as string).endsWith(".md"), "json: the openable path is the document path");
  const full = mdResultToJson(ordered[0], { full: true });
  assert(
    (full.text as string).length >= (row.text as string).length,
    "json: --full widens the body budget",
  );
}

async function testWriteBuffer() {
  section("WriteBuffer");

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  class FakeStore {
    deletedFiles: string[] = [];
    insertedIds: string[] = [];
    batches: string[][] = [];

    async deleteByFile(filePath: string): Promise<void> {
      this.deletedFiles.push(filePath);
    }

    async addChunksRaw(chunks: BufferedRecord[]): Promise<void> {
      // Delay snapshot on purpose: the old non-serialized WriteBuffer mutated
      // the same in-flight array, which produced duplicate inserts.
      await sleep(20);
      const ids = chunks.map((c) => c.id);
      this.batches.push(ids);
      this.insertedIds.push(...ids);
    }
  }

  const makeRecord = (id: string, sessionFile: string): BufferedRecord => ({
    id,
    text: `text:${id}`,
    vector: [0.1, 0.2, 0.3, 0.4],
    sessionFile,
    project: "test",
    lineNumber: 1,
    timestamp: new Date().toISOString(),
    role: "user",
    metadata: {},
  });

  const store = new FakeStore();
  const wb = new WriteBuffer(store, 2);

  await Promise.all([
    wb.add([
      makeRecord("a1", "/tmp/a.jsonl"),
      makeRecord("a2", "/tmp/a.jsonl"),
    ]),
    wb.add([
      makeRecord("b1", "/tmp/b.jsonl"),
      makeRecord("b2", "/tmp/b.jsonl"),
    ]),
  ]);
  await wb.flush();

  const idCounts = new Map<string, number>();
  for (const id of store.insertedIds) {
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  assert(store.insertedIds.length === 4, `concurrent add: inserted 4 rows (got ${store.insertedIds.length})`);
  assert(
    [...idCounts.values()].every((count) => count === 1),
    "concurrent add: no duplicate IDs after delayed flush",
  );
  assert(
    store.deletedFiles.filter((f) => f === "/tmp/a.jsonl").length === 1 &&
      store.deletedFiles.filter((f) => f === "/tmp/b.jsonl").length === 1,
    "deleteByFile runs once per file",
  );

  const store2 = new FakeStore();
  const wb2 = new WriteBuffer(store2, 10);
  await wb2.add([makeRecord("c1", "/tmp/c.jsonl")]);
  await wb2.add([makeRecord("c2", "/tmp/c.jsonl")]);
  await wb2.flush();

  assert(
    store2.deletedFiles.filter((f) => f === "/tmp/c.jsonl").length === 1,
    "same file across multiple add calls: pre-delete still once",
  );

  const store3 = new FakeStore();
  const wb3 = new WriteBuffer(store3, 10);
  await wb3.markFile("/tmp/d.jsonl");
  await wb3.markFile("/tmp/d.jsonl");
  await wb3.flush();

  assert(
    store3.deletedFiles.filter((f) => f === "/tmp/d.jsonl").length === 1,
    "markFile deletes existing rows once for zero-chunk files",
  );
  assert(store3.insertedIds.length === 0, "markFile does not insert rows");
}

async function testVectorStore() {
  section("Vector Store (local)");

  // Test with temp DB
  const tmpDir = `/tmp/semantic-memory-test-${Date.now()}`;
  const store = new VectorStore(tmpDir, 8); // 8-dim for speed
  await store.init();
  await store.ensureTable();

  // Count starts at 0 (dummy deleted)
  const initialCount = await store.getCount();
  assert(initialCount === 0, `Initial count: ${initialCount} (dummy deleted)`);

  // Add chunks
  await store.addChunks([
    {
      id: "test-1",
      text: "NixOS configuration with flake",
      vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      sessionFile: "/test/session1.jsonl",
      project: "nixos-config",
      lineNumber: 10,
      timestamp: new Date().toISOString(),
      role: "user",
      metadata: { type: "test" },
    },
    {
      id: "test-2",
      text: "Emacs doom configuration setup",
      vector: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
      sessionFile: "/test/session2.jsonl",
      project: "doomemacs-config",
      lineNumber: 20,
      timestamp: new Date().toISOString(),
      role: "assistant",
      metadata: { type: "test" },
    },
  ]);

  const count = await store.getCount();
  assert(count === 2, `After add: ${count} chunks`);

  // Vector search
  const results = await store.search(
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    5,
    0,
  );
  assert(results.length === 2, `Vector search: ${results.length} results`);
  assert(results[0].id === "test-1", `Nearest: test-1 (same vector)`);
  assert(results[0].score > results[1].score, "Nearest has higher score");

  // Indexed session files
  const indexed = await store.getIndexedSessionFiles();
  assert(indexed.size === 2, `Indexed files: ${indexed.size}`);
  assert(indexed.has("/test/session1.jsonl"), "Has session1");

  // FTS (create index first)
  await store.createFtsIndex();
  const ftsResults = await store.fullTextSearch("NixOS", 5);
  assert(ftsResults.length >= 1, `FTS "NixOS": ${ftsResults.length} results`);

  // Reset
  await store.reset();
  const afterReset = await store.getCount();
  assert(afterReset === 0, `After reset: ${afterReset}`);

  await store.close();

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Integration Tests (needs API) ---
//
// The Gemini embedding suite is retired (2026-07-14). Nothing live embeds through
// Gemini: model-presets.ts carries no gemini preset, and both axes — sessions and the
// garden md index — run OpenRouter Qwen3-Embedding-8B at 4096d. gemini-embeddings.ts
// and GeminiProvider survive only as an unreferenced back-compat shim.
//
// The suite pinned 768d ("outputDimensionality: fixed 768d (cost control)"). Gemini
// later changed that default to 3072, so the assertions went red and stayed red — no
// live consumer noticed, because there is no live consumer. A gate that always fails
// teaches you to ignore the gate, which is how a real failure gets to walk past. So it
// goes, rather than being nursed against an API this repo no longer calls.

async function testLiveSearch() {
  section("Live Search (existing DB)");

  const dbPath = getSessionsDbPath();
  if (!fs.existsSync(dbPath)) {
    skip("No existing DB at " + dbPath);
    return;
  }

  const store = new VectorStore(dbPath, 768);
  await store.init();

  const count = await store.getCount();
  assert(count > 0, `Live DB: ${count} chunks`);

  // FTS searches
  for (const q of ["memory", "NixOS", "botlog"]) {
    const results = await store.fullTextSearch(q, 5);
    console.log(`    FTS "${q}": ${results.length} results`);
  }

  // Indexed sessions
  const indexed = await store.getIndexedSessionFiles();
  assert(indexed.size > 0, `Indexed sessions: ${indexed.size}`);

  await store.close();
}

async function testJinaRerank() {
  section("Jina Rerank (API)");

  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) {
    skip("JINA_API_KEY not set — rerank disabled (optional)");
    return;
  }

  const results: SearchResult[] = [
    {
      id: "1",
      text: "NixOS 설정에서 flake.nix를 사용하는 방법",
      sessionFile: "",
      project: "test",
      lineNumber: 1,
      timestamp: "",
      role: "user",
      metadata: {},
      score: 0.5,
    },
    {
      id: "2",
      text: "오늘 점심 뭐 먹을까",
      sessionFile: "",
      project: "test",
      lineNumber: 1,
      timestamp: "",
      role: "user",
      metadata: {},
      score: 0.5,
    },
  ];

  try {
    const reranked = await jinaRerank("NixOS flake 설정", results, apiKey);
    assert(reranked.length > 0, `Rerank: ${reranked.length} results`);
    assert(
      reranked[0].text.includes("NixOS"),
      "Rerank: NixOS 관련이 1위",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    skip(`Jina API error: ${msg.slice(0, 80)}`);
  }
}

async function testSearchQuery(query: string) {
  section(`Live Search: "${query}"`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    skip("GEMINI_API_KEY not set");
    return;
  }

  const dbPath = getSessionsDbPath();
  if (!fs.existsSync(dbPath)) {
    skip("No existing DB");
    return;
  }

  const { embedQuery } = await import("./gemini-embeddings.js");
  const config = { apiKey, model: "gemini-embedding-2-preview" };
  const store = new VectorStore(dbPath, 768);
  await store.init();

  try {
    const qVec = await embedQuery(query, config);
    const vecResults = await store.search(qVec, 20, 0.1);
    const ftsResults = await store.fullTextSearch(query, 20);

    const results = await retrieve(query, vecResults, ftsResults, {
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      recencyHalfLifeDays: 14,
      jinaApiKey: process.env.JINA_API_KEY,
    });

    console.log(`  Vector: ${vecResults.length}, FTS: ${ftsResults.length}, Hybrid: ${results.length}`);
    console.log();
    for (const r of results.slice(0, 5)) {
      console.log(`  [${r.project}] ${r.role} (${r.score.toFixed(3)})`);
      console.log(`    ${r.text.slice(0, 120)}`);
      console.log();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429") || msg.includes("spending")) {
      skip(`API rate limited: ${msg.slice(0, 80)}`);
    } else {
      assert(false, `Search error: ${msg.slice(0, 120)}`);
    }
  }

  await store.close();
}

// --- Main ---

const args = process.argv.slice(2);
const mode = args[0] ?? "all";

console.log("🧠 andenken Test Suite\n");

if (mode === "unit" || mode === "all") {
  await testSessionIndexer();
  await testSessionIndexerSanitize();
  await testOrgChunker();
  await testMdChunker();
  await testRetriever();
  await testMdSurface();
  await testWriteBuffer();
  await testVectorStore();
  await testMdStalePolicy();
}

if (mode === "integration" || mode === "all") {
  await testJinaRerank();
  await testLiveSearch();
}

if (mode === "search") {
  const query = args.slice(1).join(" ") || "semantic memory extension";
  await testSearchQuery(query);
}

console.log(`\n${"─".repeat(40)}`);
console.log(`✅ ${passed} passed  ❌ ${failed} failed  ⏭  ${skipped} skipped`);

if (failed > 0) process.exit(1);
