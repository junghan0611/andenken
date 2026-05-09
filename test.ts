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
import { exportOrgToQmd, UnsafeOutError } from "./export-qmd.ts";
import {
  denoteIdToDate,
  buildPublicUrl,
  groupContentChunks,
  renderHeadingSection,
} from "./export-qmd-template.ts";
import type { OrgChunk } from "./org-chunker.ts";
import { WriteBuffer, type BufferedRecord } from "./write-buffer.ts";
import {
  rrfFusion,
  applyRecencyDecay,
  jinaRerank,
  retrieve,
} from "./retriever.ts";
import type { SearchResult } from "./store.ts";

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

async function testExportQmd() {
  section("Export QMD (memory-md)");

  // Build a synthetic org tree under a temp dir so findOrgFiles + folder
  // policy work end-to-end without touching ~/sync/org.
  const tmpRoot = `/tmp/andenken-export-qmd-test-${Date.now()}`;
  const orgRoot = path.join(tmpRoot, "org");
  const outRoot = path.join(tmpRoot, "out");

  // INDEXABLE_ORG_FOLDERS = {meta, bib, notes, journal, botlog}
  for (const f of ["notes", "journal", "meta"]) {
    fs.mkdirSync(path.join(orgRoot, f), { recursive: true });
  }

  const noembedFile = path.join(
    orgRoot,
    "notes/20260101T100000--noembed-only__test_noembed.org",
  );
  fs.writeFileSync(
    noembedFile,
    `#+title: Skipped Noembed\n#+filetags: :test:noembed:\n\n* Heading\nshould never appear`,
  );

  const visibleFile = path.join(
    orgRoot,
    "notes/20260101T110000--visible-note__test.org",
  );
  fs.writeFileSync(
    visibleFile,
    `#+title: Visible Note Title\n#+filetags: :test:\n\n* Parent\nParent intro text that is long enough to survive content chunking thresholds.\n** Hidden :noembed:\nsecret payload that must never reach memory-md output.\n** Archived :ARCHIVE:\narchived subtree must stay out of memory-md too.\n** Visible\nvisible body that should remain present in memory-md export output.`,
  );

  const preCutoffFile = path.join(
    orgRoot,
    "journal/20241230T000000--pre-cutoff__journal_week01.org",
  );
  fs.writeFileSync(
    preCutoffFile,
    `#+title: Pre-2025 journal\n#+filetags: :journal:\n\n* Day\nthis pre-cutoff journal must not be exported anywhere`,
  );

  const postCutoffFile = path.join(
    orgRoot,
    "journal/20250106T000000--post-cutoff__journal_week02.org",
  );
  fs.writeFileSync(
    postCutoffFile,
    `#+title: 2025 journal week\n#+filetags: :journal:\n\n* Mon\nfirst day of post-cutoff journal week, real content here for chunking.`,
  );

  // Pre-seed a stale .md that should be swept on export.
  fs.mkdirSync(path.join(outRoot, "notes"), { recursive: true });
  const staleMd = path.join(outRoot, "notes/19990101T000000.md");
  fs.writeFileSync(staleMd, "# stale\n");

  const result = exportOrgToQmd({
    out: outRoot,
    orgDir: orgRoot,
    publicUrlBase: undefined,
    dryRun: false,
    verbose: false,
  });

  assert(result.wrote >= 2, `wrote >= 2 files (got ${result.wrote})`);

  const noembedOut = path.join(outRoot, "notes/20260101T100000.md");
  assert(!fs.existsSync(noembedOut), "filetag :noembed: yields no .md");

  const preCutoffOut = path.join(outRoot, "journal/20241230T000000.md");
  assert(
    !fs.existsSync(preCutoffOut),
    "pre-2025 journal is not exported",
  );

  const postCutoffOut = path.join(outRoot, "journal/20250106T000000.md");
  assert(
    fs.existsSync(postCutoffOut),
    "post-2025 journal is exported",
  );

  const visibleOut = path.join(outRoot, "notes/20260101T110000.md");
  assert(fs.existsSync(visibleOut), "visible note is exported");

  const visibleBody = fs.readFileSync(visibleOut, "utf8");
  assert(
    visibleBody.startsWith("# Visible Note Title"),
    "first line is '# {title}'",
  );
  assert(
    visibleBody.includes("- Denote ID: 20260101T110000"),
    "Context block has Denote ID",
  );
  assert(
    visibleBody.includes("- Time axis: 2026-01-01"),
    "Time axis derived from Denote ID",
  );
  assert(
    visibleBody.includes("- Folder: notes"),
    "Folder line present",
  );
  assert(
    visibleBody.includes("- Original path: " + visibleFile),
    "Original path line present",
  );
  assert(
    !visibleBody.includes("Public URL:"),
    "Public URL omitted when --public-url-base unset",
  );
  assert(
    !visibleBody.includes("secret payload"),
    "noembed subtree text not in memory-md output",
  );
  assert(
    !visibleBody.includes("archived subtree"),
    ":ARCHIVE: subtree text not in memory-md output",
  );
  assert(
    visibleBody.includes("visible body"),
    "visible sibling body is preserved",
  );
  assert(
    visibleBody.includes("Hierarchy: Parent"),
    "Hierarchy line is rendered for content sections",
  );

  // Stale sweep
  assert(!fs.existsSync(staleMd), "reconciliation removed stale .md");

  // Idempotence
  const snapshot1 = collectMdTree(outRoot);
  const result2 = exportOrgToQmd({
    out: outRoot,
    orgDir: orgRoot,
    publicUrlBase: undefined,
    dryRun: false,
    verbose: false,
  });
  const snapshot2 = collectMdTree(outRoot);
  assert(
    JSON.stringify(snapshot1) === JSON.stringify(snapshot2),
    "second run is byte-identical (idempotent)",
  );
  assert(
    result2.removedStale === 0,
    `second run sweeps nothing (got removedStale=${result2.removedStale})`,
  );

  // Public URL opt-in
  const result3 = exportOrgToQmd({
    out: outRoot,
    orgDir: orgRoot,
    publicUrlBase: "https://notes.junghanacs.com",
    dryRun: false,
    verbose: false,
  });
  void result3;
  const visibleBodyWithUrl = fs.readFileSync(visibleOut, "utf8");
  assert(
    visibleBodyWithUrl.includes("- Public URL: https://notes.junghanacs.com/notes/20260101T110000"),
    "Public URL rendered when --public-url-base set",
  );

  // Pure helpers
  assert(
    denoteIdToDate("20250106T120000") === "2025-01-06",
    "denoteIdToDate('20250106T120000') === '2025-01-06'",
  );
  assert(
    denoteIdToDate("not-a-denote-id") === "unknown",
    "denoteIdToDate falls back to 'unknown' on bad input",
  );
  assert(
    buildPublicUrl(
      {
        identifier: "20260101T110000",
        title: "x",
        filetags: [],
        date: "",
        folder: "notes",
        references: [],
        titlePrefix: "",
        hasGptelProps: false,
      },
      "https://notes.junghanacs.com/",
    ) === "https://notes.junghanacs.com/notes/20260101T110000",
    "buildPublicUrl strips trailing slash and joins folder + id",
  );
  assert(
    buildPublicUrl(
      {
        identifier: "20260101T110000",
        title: "x",
        filetags: [],
        date: "",
        folder: "notes",
        references: [],
        titlePrefix: "",
        hasGptelProps: false,
      },
      undefined,
    ) === undefined,
    "buildPublicUrl returns undefined when base is unset",
  );

  // Multi-part grouping shape: when one heading produces multiple content
  // chunks (subChunkContent split), grouping must mark partCount>1.
  const longBody = "lorem ipsum ".repeat(800);
  const longFile = path.join(
    orgRoot,
    "notes/20260101T120000--long-body__test.org",
  );
  fs.writeFileSync(
    longFile,
    `#+title: Long body\n#+filetags: :test:\n\n* Long\n${longBody}`,
  );
  const longChunks = chunkOrgFile(fs.readFileSync(longFile, "utf8"), longFile);
  const grouped = groupContentChunks(longChunks);
  if (grouped.length > 1) {
    assert(
      grouped.every((g) => g.partCount === grouped.length),
      `multi-part: partCount === group size (${grouped.length})`,
    );
    assert(
      grouped.map((g) => g.partIndex).join(",") ===
        grouped.map((_, i) => i).join(","),
      "multi-part: partIndex is 0..N-1 in source order",
    );
  } else {
    skip("multi-part grouping: single chunk emitted (subChunkContent threshold)");
  }

  // Symlink no-follow — outRoot is a symlink to a real directory
  const realDirForLink = path.join(tmpRoot, "real-out-target");
  fs.mkdirSync(realDirForLink, { recursive: true });
  const linkOut = path.join(tmpRoot, "link-out");
  fs.symlinkSync(realDirForLink, linkOut);
  let symlinkOutRefused = false;
  try {
    exportOrgToQmd({
      out: linkOut,
      orgDir: orgRoot,
      publicUrlBase: undefined,
      dryRun: false,
      verbose: false,
    });
  } catch (e) {
    symlinkOutRefused =
      e instanceof UnsafeOutError && /symbolic link/i.test(e.message);
  }
  assert(symlinkOutRefused, "symlink --out is refused (UnsafeOutError)");
  // Confirm no .md files leaked into the link target
  let leakedMd = 0;
  try {
    leakedMd = fs.readdirSync(realDirForLink, { recursive: true }).filter(
      (n) => typeof n === "string" && n.endsWith(".md"),
    ).length;
  } catch {
    // ignore
  }
  assert(leakedMd === 0, "no writes leaked through symlinked --out");

  // Symlink no-follow — <out>/<folder> is a symlink
  const trapTarget = path.join(tmpRoot, "trap-target");
  fs.mkdirSync(trapTarget, { recursive: true });
  const trappedOut = path.join(tmpRoot, "out-with-trap");
  fs.mkdirSync(trappedOut, { recursive: true });
  fs.symlinkSync(trapTarget, path.join(trappedOut, "notes"));
  let symlinkFolderRefused = false;
  try {
    exportOrgToQmd({
      out: trappedOut,
      orgDir: orgRoot,
      publicUrlBase: undefined,
      dryRun: false,
      verbose: false,
    });
  } catch (e) {
    symlinkFolderRefused =
      e instanceof UnsafeOutError && /symbolic link/i.test(e.message);
  }
  assert(symlinkFolderRefused, "symlink <out>/<folder> is refused (UnsafeOutError)");

  // (file body) fallback — both section title AND Hierarchy context line
  // must agree when chunk.hierarchy is empty (heading-less file case).
  const fileBodyChunk: OrgChunk = {
    id: "test-fb",
    text: "raw body",
    rawText: "raw body",
    filePath: "/fake/notes/20260102T100000.org",
    folder: "notes",
    lineNumber: 1,
    endLineNumber: 1,
    chunkType: "content",
    metadata: {
      identifier: "20260102T100000",
      title: "No Headings",
      filetags: [],
      date: "",
      folder: "notes",
      references: [],
      titlePrefix: "",
      hasGptelProps: false,
    },
    hierarchy: "",
  };
  const fbSection = renderHeadingSection({
    chunk: fileBodyChunk,
    partIndex: 0,
    partCount: 1,
  });
  assert(
    fbSection.includes("## (file body)"),
    "section title falls back to '(file body)' when hierarchy empty",
  );
  assert(
    fbSection.includes("- Hierarchy: (file body)"),
    "Hierarchy context line falls back to '(file body)' (matches title)",
  );
  assert(
    !/- Hierarchy:\s*$/m.test(fbSection),
    "Hierarchy line is never empty",
  );

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function collectMdTree(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  function walk(d: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        out.push([path.relative(root, p), fs.readFileSync(p, "utf8")]);
      }
    }
  }
  walk(root);
  out.sort(([a], [b]) => a.localeCompare(b));
  return out;
}

async function testRetriever() {
  section("Retriever");

  // Mock results for testing
  const makeResult = (
    id: string,
    score: number,
    timestamp?: string,
  ): SearchResult => ({
    id,
    text: `text for ${id}`,
    sessionFile: "/test/file.jsonl",
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

async function testGeminiEmbeddings() {
  section("Gemini Embeddings (API)");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    skip("GEMINI_API_KEY not set");
    return;
  }

  const { embedQuery, embedDocument, embedDocumentBatch } = await import(
    "./gemini-embeddings.js"
  );
  const config = { apiKey, model: "gemini-embedding-2-preview" };

  try {
    // Single query embed
    const qVec = await embedQuery("NixOS 설정 방법", config);
    assert(qVec.length === 768, `embedQuery: ${qVec.length} dims`);
    assert(typeof qVec[0] === "number", "embedQuery: values are numbers");

    // Single document embed
    const dVec = await embedDocument("NixOS 설정 가이드 문서", config);
    assert(dVec.length === 768, `embedDocument: ${dVec.length} dims`);

    // Batch embed
    const batch = await embedDocumentBatch(
      ["첫 번째 문장", "두 번째 문장", "세 번째 문장"],
      config,
    );
    assert(batch.length === 3, `embedBatch: ${batch.length} vectors`);
    assert(batch[0].length === 768, `embedBatch[0]: ${batch[0].length} dims`);

    // Empty batch
    const empty = await embedDocumentBatch([], config);
    assert(empty.length === 0, "embedBatch empty: 0 vectors");

    // Matryoshka dimensions
    const config768 = { ...config, dimensions: 768 as const };
    const smallVec = await embedQuery("test", config768);
    assert(smallVec.length === 768, `Matryoshka 768: ${smallVec.length} dims`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429") || msg.includes("spending")) {
      skip(`API rate limited: ${msg.slice(0, 80)}`);
    } else {
      assert(false, `Gemini API error: ${msg.slice(0, 120)}`);
    }
  }
}

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
  await testOrgChunker();
  await testExportQmd();
  await testRetriever();
  await testWriteBuffer();
  await testVectorStore();
}

if (mode === "integration" || mode === "all") {
  await testGeminiEmbeddings();
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
