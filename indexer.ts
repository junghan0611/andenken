/**
 * Unified Indexer — Sessions + Org (dim follows active provider; runtime 2560d with Qwen3-4B)
 *
 * Parallel embedding + batched DB writes to minimize LanceDB fragments.
 *
 * Usage:
 *   npx tsx indexer.ts sessions [--force]
 *   npx tsx indexer.ts org [--force]
 *   npx tsx indexer.ts compact [sessions|org]
 *   npx tsx indexer.ts status
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  createSessionProviderFromEnv,
  createOrgProviderFromEnv,
  runWithConcurrency,
  DEFAULT_CONCURRENCY,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getSessionsDbPath, getOrgDbPath, getDataDir } from "./store.js";
import { findSessionFiles, extractSessionChunks } from "./session-indexer.js";
import { findOrgFiles, chunkOrgFile, shouldIndexOrgFile } from "./org-chunker.js";
import { WriteBuffer } from "./write-buffer.js";

// --- dictcli stem integration (Layer 3 → Layer 1 bridge) ---

function getDictcliDir(): string {
  return path.join(process.env.HOME ?? "", "repos", "gh", "dictcli");
}

/**
 * Batch stem Korean text via dictcli stem --batch (Kiwi morphological analysis).
 * Input: array of text strings. Output: array of stem arrays.
 * JVM starts once (~2.7s), then processes at ~160 lines/sec.
 * Falls back to empty arrays if dictcli unavailable.
 */
function batchStem(texts: string[]): string[][] {
  if (texts.length === 0) return [];
  const dictcliDir = getDictcliDir();
  const runSh = path.join(dictcliDir, "run.sh");
  if (!fs.existsSync(runSh)) {
    console.log("⚠ dictcli not found — skipping stem enrichment");
    return texts.map(() => []);
  }

  try {
    // Flatten multiline chunks to single lines — batch protocol is line-delimited
    const input = texts.map(t => t.replace(/\n/g, " ")).join("\n");
    const output = execSync(`./run.sh stem --batch`, {
      input,
      cwd: dictcliDir,
      timeout: 900_000, // 15 min for large batches (97K+ chunks @ ~160 lines/sec)
      maxBuffer: 50 * 1024 * 1024, // 50MB
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Parse JSON lines: each line is ["stem1", "stem2", ...]
    const lines = output.trim().split("\n");
    if (lines.length !== texts.length) {
      console.log(`⚠ stem line count mismatch: expected ${texts.length}, got ${lines.length}`);
    }
    return lines.map((line: string) => {
      try {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    });
  } catch (err) {
    console.log(`⚠ dictcli stem failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
    return texts.map(() => []);
  }
}

/**
 * Enrich chunk text with stems for BM25.
 * Appends stems as searchable tokens without altering the original text.
 * Vector embedding uses original text; FTS index gets stems too.
 */
function enrichTextWithStems(text: string, stems: string[]): string {
  if (stems.length === 0) return text;
  // Append stems as a searchable block at the end
  return `${text}\n[stems: ${stems.join(" ")}]`;
}
const CONCURRENCY = parseInt(process.env.INDEX_CONCURRENCY ?? "", 10) || DEFAULT_CONCURRENCY;
const DB_WRITE_BATCH = 2000; // flush to DB every N chunks → fewer fragments
const ORG_EMBED_MAX_CHARS = parseInt(process.env.ANDENKEN_ORG_EMBED_MAX_CHARS ?? "", 10) || 12000; // conservative guard for Korean + long hierarchy under 8K serving limit
const CANDIDATE_MULTIPLIER = 4; // openclaw pattern: fetch 4x candidates for better MMR

// --- Org Manifest (mtime-based stale detection) ---

interface OrgFileManifest {
  // skippedOversize: count of chunks filtered out by ORG_EMBED_MAX_CHARS hard guard during the last index of this file.
  // Omitted when 0. Surfaced by `doctor --org` so the operator can see which files are silently losing content.
  files: Record<string, { mtimeMs: number; size: number; chunks: number; skippedOversize?: number }>;
  lastUpdated: string;
}

function getManifestPath(): string {
  return path.join(getDataDir(), "org-manifest.json");
}

function loadManifest(): OrgFileManifest {
  const p = getManifestPath();
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return { files: {}, lastUpdated: "" };
  }
}

function saveManifest(manifest: OrgFileManifest): void {
  manifest.lastUpdated = new Date().toISOString();
  fs.writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

// --- Session Manifest (mirrors org pattern; same shape, different path) ---
//
// Why a session manifest?
// pi/Claude session files are append-only — a long-running session keeps
// growing in the same JSONL. Without mtime/size tracking, only-new-file
// indexing misses everything appended since first index. With this manifest
// the next sync-sessions run picks up active conversations.
type SessionFileManifest = OrgFileManifest;

function getSessionManifestPath(): string {
  return path.join(getDataDir(), "session-manifest.json");
}

function loadSessionManifest(): SessionFileManifest {
  const p = getSessionManifestPath();
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return { files: {}, lastUpdated: "" };
  }
}

function saveSessionManifest(manifest: SessionFileManifest): void {
  manifest.lastUpdated = new Date().toISOString();
  fs.writeFileSync(getSessionManifestPath(), JSON.stringify(manifest, null, 2));
}

function getStaleFiles(
  files: string[],
  indexed: Set<string>,
  manifest: OrgFileManifest,
): { newFiles: string[]; staleFiles: string[] } {
  const newFiles: string[] = [];
  const staleFiles: string[] = [];
  const hasManifest = Object.keys(manifest.files).length > 0;

  for (const f of files) {
    if (!indexed.has(f)) {
      const entry = manifest.files[f];
      if (!entry) {
        newFiles.push(f);
        continue;
      }
      try {
        const stat = fs.statSync(f);
        if (stat.mtimeMs > entry.mtimeMs || stat.size !== entry.size) {
          staleFiles.push(f);
        }
      } catch {
        // File may have been deleted
      }
      continue;
    }
    // No manifest yet — skip stale check, just initialize manifest on this run
    if (!hasManifest) continue;

    // Check mtime against manifest
    const entry = manifest.files[f];
    if (!entry) {
      // New to manifest but already indexed — just record, don't re-index
      continue;
    }
    try {
      const stat = fs.statSync(f);
      if (stat.mtimeMs > entry.mtimeMs) {
        staleFiles.push(f);
      }
    } catch {
      // File may have been deleted
    }
  }

  return { newFiles, staleFiles };
}

/**
 * Initialize manifest from current files without re-indexing.
 * Records mtime/size for all files so next run can detect changes.
 */
function initManifest(files: string[]): OrgFileManifest {
  const manifest: OrgFileManifest = { files: {}, lastUpdated: "" };
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      manifest.files[f] = { mtimeMs: stat.mtimeMs, size: stat.size, chunks: 0 };
    } catch { /* skip */ }
  }
  return manifest;
}

/**
 * PR-B: SESSIONS-track provider for the CLI indexer.
 * Reads ANDENKEN_SESSION_* exclusively. PR-A's transitional legacy fallback
 * was removed — operators must set ANDENKEN_SESSION_PROVIDER explicitly.
 */
function getSessionsProvider(): EmbeddingProvider {
  const p = createSessionProviderFromEnv();
  if (!p) {
    throw new Error(
      "No sessions embedding provider available. Set ANDENKEN_SESSION_PROVIDER " +
      "(and ANDENKEN_SESSION_ENDPOINT / _MODEL / _API_KEY). PR-A's transitional " +
      "legacy fallback was removed in PR-B.",
    );
  }
  console.log(`📡 Sessions provider: ${p.name} (${p.dimensions}d)`);
  return p;
}

/**
 * PR-B: ORG-track provider for the CLI indexer.
 * Reads ANDENKEN_ORG_* with backward-compat fallback to legacy ANDENKEN_VLLM_*.
 */
function getOrgProvider(): EmbeddingProvider {
  const p = createOrgProviderFromEnv();
  if (!p) {
    throw new Error(
      "No org embedding provider available. Set ANDENKEN_ORG_PROVIDER (or the " +
      "legacy ANDENKEN_PROVIDER + ANDENKEN_VLLM_*) for backward-compat.",
    );
  }
  console.log(`📡 Org provider: ${p.name} (${p.dimensions}d)`);
  return p;
}

/**
 * Legacy `getProvider()` removed in PR-B. Each codepath now picks the
 * track-specific provider explicitly. If an old reference shows up at
 * runtime it points at this stub which throws, so we surface the call site
 * rather than silently degrade.
 */
function getProvider(): EmbeddingProvider {
  throw new Error("getProvider() removed in PR-B; use getSessionsProvider() or getOrgProvider()");
}

// --- Progress ---

class Progress {
  private completed = 0;
  private errors = 0;
  private chunks = 0;
  private t0 = Date.now();

  constructor(
    private total: number,
    private label: string,
  ) {}

  tick(addedChunks: number) {
    this.completed++;
    this.chunks += addedChunks;
    if (this.completed % 5 === 0 || this.completed === this.total) {
      this.print();
    }
  }

  error() {
    this.completed++;
    this.errors++;
  }

  print() {
    const elapsed = ((Date.now() - this.t0) / 1000).toFixed(1);
    const rate = (this.completed / ((Date.now() - this.t0) / 1000)).toFixed(1);
    const eta = Math.round(
      (this.total - this.completed) / Math.max(0.1, parseFloat(rate)),
    );
    console.log(
      `${this.label}: ${this.completed}/${this.total} [${this.chunks} ch] ${elapsed}s (${rate}/s, ~${eta}s left) err:${this.errors}`,
    );
  }

  summary(): string {
    const elapsed = ((Date.now() - this.t0) / 1000).toFixed(1);
    return `✅ ${this.label}: ${this.chunks} chunks | ${this.errors} errors | ${elapsed}s | concurrency=${CONCURRENCY}`;
  }
}

// --- Session Indexing ---

async function indexSessions(force: boolean) {
  const provider = getSessionsProvider();

  // PR-B paidRemote guard. Prevents accidental
  //   pnpm exec tsx indexer.ts sessions --force
  // against a paid endpoint (OpenRouter) without the explicit operator
  // confirmation that scripts/rebuild-sessions-full.sh provides.
  //
  // Runs BEFORE store init / corpus extraction / API call.
  if (force && (provider as { isPaidRemote?: boolean }).isPaidRemote) {
    if (process.env.ANDENKEN_ALLOW_PAID_FULL_REBUILD !== "1") {
      throw new Error(
        "Sessions full rebuild against paid remote endpoint is gated.\n" +
        "  Use scripts/rebuild-sessions-full.sh (which sets " +
        "ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 after estimate + explicit confirmation),\n" +
        "  or set ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 yourself if you have already " +
        "reviewed the cost estimate.",
      );
    }
  }

  const store = new VectorStore(undefined, provider.dimensions || 2560);
  await store.init();
  if (force) await store.reset();
  await store.ensureTable();

  // PR-D safety: refuse to write when the existing table dim doesn't match
  // the configured provider dim. An empty/fresh table passes through. This
  // prevents a sessions-track misconfiguration (e.g. wrong endpoint pointing
  // at a 3584d model) from silently corrupting an existing 2560d index.
  await store.assertCompatibleDim();

  const files = findSessionFiles();
  const indexed = force ? new Set<string>() : await store.getIndexedFiles();
  let manifest: SessionFileManifest = force
    ? { files: {}, lastUpdated: "" }
    : loadSessionManifest();
  const hasManifest = Object.keys(manifest.files).length > 0;

  // Stale detection: new files + mtime/size-changed appended files
  const { newFiles, staleFiles } = force
    ? { newFiles: files.filter((f) => !indexed.has(f)), staleFiles: [] as string[] }
    : getStaleFiles(files, indexed, manifest);
  const toIndex = [...newFiles, ...staleFiles];

  // First run without manifest: record current mtime/size as baseline so future
  // appends are detectable. Only files already in the indexed set are baselined —
  // baselining non-indexed files would let an embed-time failure get silently
  // skipped on the next run (manifest matches, file not in indexed, classified
  // as neither new nor stale). Files that genuinely produce 0 chunks get their
  // manifest entry written from the processing path below.
  if (!hasManifest && !force) {
    let baselined = 0;
    for (const f of files) {
      if (!indexed.has(f)) continue;
      try {
        const stat = fs.statSync(f);
        manifest.files[f] = { mtimeMs: stat.mtimeMs, size: stat.size, chunks: 0 };
        baselined++;
      } catch { /* skip */ }
    }
    console.log(`📌 Initializing session manifest from ${baselined} indexed files (baseline)`);
    saveSessionManifest(manifest);
  }

  console.log(
    `Sessions: ${files.length} | indexed: ${indexed.size} | new: ${newFiles.length} | stale: ${staleFiles.length} | concurrency: ${CONCURRENCY}`,
  );
  if (toIndex.length === 0) {
    console.log("✅ All sessions indexed and up-to-date.");
    await store.close();
    return;
  }

  const progress = new Progress(toIndex.length, "Sessions");
  const wb = new WriteBuffer(store, DB_WRITE_BATCH);
  const CHECKPOINT_INTERVAL = 100;
  let filesProcessed = 0;

  // Checkpoint discipline:
  //
  //   Manifest entry must never be persisted before the corresponding DB rows
  //   are flushed. Otherwise a crash between save and flush leaves the
  //   manifest claiming the file is indexed while the rows still sit in the
  //   WriteBuffer — silent loss because getStaleFiles() then classifies the
  //   file as "indexed elsewhere, mtime matches, skip" on the next run.
  //
  //   Concrete shape: every checkpoint awaits wb.flush() before saveSessionManifest().
  //   wb.flush() is enqueued through WriteBuffer's serial tail, so concurrent
  //   tasks can only re-enter the embedding stage after the flush completes.
  const checkpointIfNeeded = async () => {
    if (filesProcessed % CHECKPOINT_INTERVAL !== 0) return;
    await wb.flush();
    saveSessionManifest(manifest);
    console.log(`  📌 Manifest checkpoint at ${filesProcessed}/${toIndex.length} files`);
  };

  const tasks = toIndex.map((file) => async () => {
    try {
      const chunks = await extractSessionChunks(file);

      // Capture mtime/size at index time for next staleness check
      let manifestEntry: { mtimeMs: number; size: number; chunks: number } | undefined;
      try {
        const stat = fs.statSync(file);
        manifestEntry = { mtimeMs: stat.mtimeMs, size: stat.size, chunks: chunks.length };
      } catch { /* file may have been deleted between scan and stat */ }

      if (chunks.length === 0) {
        // Stale file with no extractable content: ensure existing rows are removed.
        // markFile only enqueues a delete; it doesn't move buffered rows — checkpoint
        // still flushes any unrelated buffered records before saving the manifest.
        await wb.markFile(file);
        if (manifestEntry) manifest.files[file] = manifestEntry;
        filesProcessed++;
        progress.tick(0);
        await checkpointIfNeeded();
        return;
      }

      const vectors = await provider.embedDocumentBatch(
        chunks.map((c) => c.text),
      );
      // wb.add() auto-deletes existing rows for this file before re-inserting,
      // so stale chunks never linger when an active session is re-indexed.
      await wb.add(chunks.map((c, j) => ({ ...c, vector: vectors[j] })));
      if (manifestEntry) manifest.files[file] = manifestEntry;
      filesProcessed++;
      progress.tick(chunks.length);
      await checkpointIfNeeded();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[session-index-error] ${file} :: ${msg}`);
      progress.error();
      throw err;
    }
  });

  const { errors: sessionErrors } = await runWithConcurrency(tasks, CONCURRENCY);
  await wb.flush(); // final flush
  saveSessionManifest(manifest); // final persist
  if (sessionErrors > 0) {
    throw new Error(`Session indexing failed for ${sessionErrors} files`);
  }

  try {
    await store.createFtsIndex();
  } catch {}
  const total = await store.getCount();
  const stats = provider.getStats();
  console.log(progress.summary());
  console.log(`💰 API: ${stats.calls} calls, ~${(stats.estimatedTokens / 1000).toFixed(0)}K tokens, ~$${stats.estimatedCostUSD.toFixed(3)}`);
  console.log(`Total in DB: ${total}`);
  await store.close();
}

// --- Org Indexing ---

async function indexOrg(force: boolean) {
  const provider = getOrgProvider();
  const store = new VectorStore(getOrgDbPath(), provider.dimensions || 2560);
  await store.init();
  if (force) await store.reset();
  await store.ensureTable();

  // PR-D safety: same guard as indexSessions. Org has its own LanceDB file
  // (org.lance) and its own dim — refuse to write when the existing table
  // dim doesn't match the configured provider dim.
  await store.assertCompatibleDim();

  const allFiles = findOrgFiles();
  const files = allFiles.filter((f) => shouldIndexOrgFile(f));
  const indexed = force ? new Set<string>() : await store.getIndexedFiles();
  let manifest = force ? { files: {}, lastUpdated: "" } as OrgFileManifest : loadManifest();
  const hasManifest = Object.keys(manifest.files).length > 0;

  // Stale detection: new files + mtime-changed files
  const { newFiles, staleFiles } = force
    ? { newFiles: files, staleFiles: [] as string[] }
    : getStaleFiles(files, indexed, manifest);
  const toIndex = [...newFiles, ...staleFiles];

  // First run without manifest: initialize from all indexed files
  if (!hasManifest && !force) {
    console.log(`Manifest not found — initializing from ${files.length} files...`);
    manifest = initManifest(files);
    saveManifest(manifest);
    console.log(`✅ Manifest initialized. Next run will detect stale files.`);
  }

  console.log(
    `Org: ${files.length} files (${allFiles.length} total) | indexed: ${indexed.size} | new: ${newFiles.length} | stale: ${staleFiles.length} | concurrency: ${CONCURRENCY}`,
  );
  if (toIndex.length === 0) {
    console.log("✅ All org files indexed and up-to-date.");
    await store.close();
    return;
  }

  // --- Batch stem: collect chunks first, apply hard guard, then stem in one JVM call ---
  console.log("Collecting chunks for stem enrichment...");
  const fileChunks: Array<{
    file: string;
    chunks: ReturnType<typeof chunkOrgFile>;
    manifestEntry?: { mtimeMs: number; size: number; chunks: number; skippedOversize?: number };
  }> = [];
  let skippedOversizeChunks = 0;

  for (const file of toIndex) {
    const content = fs.readFileSync(file, "utf-8");
    const rawChunks = chunkOrgFile(content, file);
    let fileSkipped = 0;
    const chunks = rawChunks.filter((chunk) => {
      if (chunk.text.length <= ORG_EMBED_MAX_CHARS) return true;
      skippedOversizeChunks++;
      fileSkipped++;
      console.warn(
        `[org-embed-skip] ${file}:${chunk.lineNumber} ${chunk.chunkType} ${chunk.text.length} chars > ${ORG_EMBED_MAX_CHARS} :: ${chunk.hierarchy || chunk.metadata.title}`,
      );
      return false;
    });

    let manifestEntry: { mtimeMs: number; size: number; chunks: number; skippedOversize?: number } | undefined;
    try {
      const stat = fs.statSync(file);
      manifestEntry = { mtimeMs: stat.mtimeMs, size: stat.size, chunks: chunks.length };
      if (fileSkipped > 0) manifestEntry.skippedOversize = fileSkipped;
    } catch { /* file may have been deleted */ }

    fileChunks.push({ file, chunks, manifestEntry });
  }

  if (skippedOversizeChunks > 0) {
    console.log(`⚠️  Hard guard skipped ${skippedOversizeChunks} oversize org chunks (> ${ORG_EMBED_MAX_CHARS} chars)`);
  }

  const allChunkTexts = fileChunks.flatMap(fc => fc.chunks.map(c => c.text));
  console.log(`Stemming ${allChunkTexts.length} chunks via dictcli...`);
  const allStems = batchStem(allChunkTexts);
  console.log(`Stemming done.`);

  // Map stems back to chunks
  let stemIdx = 0;
  const enrichedFileChunks = fileChunks.map(fc => ({
    ...fc,
    chunks: fc.chunks.map(c => {
      const stems = allStems[stemIdx] ?? [];
      stemIdx++;
      return { ...c, enrichedText: enrichTextWithStems(c.text, stems) };
    }),
  }));

  const totalChunks = enrichedFileChunks.reduce((sum, fc) => sum + fc.chunks.length, 0);

  // Pre-flight cost estimate
  const totalChars = allChunkTexts.reduce((sum, t) => sum + t.length, 0);
  const estTokens = Math.ceil(totalChars / 2.5);
  const estCost = (estTokens / 1_000_000) * 0.20;
  const estBatches = Math.ceil(totalChunks / 100);
  console.log(`💰 Pre-flight: ${totalChunks} chunks, ${estBatches} API calls, ~${(estTokens / 1000).toFixed(0)}K tokens, ~$${estCost.toFixed(3)}`);
  if (estCost > 1.0 && provider.name !== "vllm") {
    console.log(`⚠️  Estimated cost > $1. Use Ctrl+C to abort.`);
    await new Promise(r => setTimeout(r, 5000)); // 5s grace period
  }
  provider.resetStats();

  const CHECKPOINT_INTERVAL = 50;
  let filesProcessed = 0;

  const progress = new Progress(enrichedFileChunks.length, "Org");
  const wb = new WriteBuffer(store, DB_WRITE_BATCH);

  const tasks = enrichedFileChunks.map(({ file, chunks, manifestEntry }) => async () => {
    try {
      if (chunks.length === 0) {
        await wb.markFile(file);
        if (manifestEntry) {
          manifest.files[file] = manifestEntry;
        }
        filesProcessed++;
        progress.tick(0);
        if (filesProcessed % CHECKPOINT_INTERVAL === 0) {
          saveManifest(manifest);
          console.log(`  📌 Manifest checkpoint at ${filesProcessed}/${enrichedFileChunks.length} files`);
        }
        return;
      }

      // Embed in batches — size from provider config (Gemini: 100 API limit, vLLM: larger)
      const embedBatch = parseInt(process.env.ANDENKEN_EMBED_BATCH ?? "", 10) || 100;
      for (let b = 0; b < chunks.length; b += embedBatch) {
        const batch = chunks.slice(b, b + embedBatch);
        const vectors = await provider.embedDocumentBatch(
          batch.map((c) => c.text), // original text for vector embedding
        );

        await wb.add(
          batch.map((c, j) => ({
            id: c.id,
            text: c.enrichedText, // stems-enriched text for FTS
            vector: vectors[j],   // vector from original text
            sessionFile: c.filePath,
            project: c.folder,
            lineNumber: c.lineNumber,
            timestamp: c.metadata.date || c.metadata.identifier || "",
            role: c.chunkType,
            metadata: {
              title: c.metadata.title,
              tags: c.metadata.filetags.join(","),
              hierarchy: c.hierarchy,
              prefix: c.metadata.titlePrefix,
              identifier: c.metadata.identifier,
            },
          })),
        );
      }
      if (manifestEntry) {
        manifest.files[file] = manifestEntry;
      }
      filesProcessed++;
      progress.tick(chunks.length);

      // Periodic manifest checkpoint to reduce re-work after interruption
      if (filesProcessed % CHECKPOINT_INTERVAL === 0) {
        saveManifest(manifest);
        console.log(`  📌 Manifest checkpoint at ${filesProcessed}/${enrichedFileChunks.length} files`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[org-index-error] ${file} :: ${msg}`);
      progress.error();
      throw err;
    }
  });

  const { errors: orgErrors } = await runWithConcurrency(tasks, CONCURRENCY);
  await wb.flush(); // final flush
  if (orgErrors > 0) {
    throw new Error(`Org indexing failed for ${orgErrors} files`);
  }

  // Final manifest save
  saveManifest(manifest);

  try {
    await store.createFtsIndex();
  } catch {}
  const total = await store.getCount();
  const orgStats = provider.getStats();
  console.log(progress.summary());
  console.log(`💰 API: ${orgStats.calls} calls, ~${(orgStats.estimatedTokens / 1000).toFixed(0)}K tokens, ~$${orgStats.estimatedCostUSD.toFixed(3)}`);
  console.log(`Total in DB: ${total}`);
  await store.close();
}

// --- Compact ---

async function compact(target: string) {
  const lancedb = await import("@lancedb/lancedb");

  const targets =
    target === "all"
      ? ["sessions", "org"]
      : [target];

  for (const t of targets) {
    const dbPath =
      t === "sessions" ? getSessionsDbPath() : getOrgDbPath();

    if (!fs.existsSync(dbPath)) {
      console.log(`${t}: not found`);
      continue;
    }

    const db = await lancedb.connect(dbPath);
    const table = await db.openTable("session_chunks");
    const rows = await table.countRows();

    const fragDir = path.join(dbPath, "session_chunks.lance", "data");
    const fragsBefore = fs.existsSync(fragDir)
      ? fs.readdirSync(fragDir).length
      : 0;

    const { execSync } = await import("node:child_process");
    const sizeBefore = execSync(`du -sh ${dbPath}`).toString().split("\t")[0];

    console.log(`${t}: ${rows} rows, ${fragsBefore} fragments, ${sizeBefore}`);
    console.log(`  compacting...`);

    await table.optimize({ cleanupOlderThan: new Date() });

    const fragsAfter = fs.readdirSync(fragDir).length;
    const sizeAfter = execSync(`du -sh ${dbPath}`).toString().split("\t")[0];
    console.log(`  → ${fragsAfter} fragments, ${sizeAfter}`);
  }
}

// --- Status ---
//
// PR-B: emits text by default and a stable JSON shape under `--json` so
// scripts/sync-sessions.sh can read everything (actual_dim, to_index, …) in
// one pass without spawning `tsx -e`. The schema is a documented contract:
//
//   {
//     "sessions": {
//       "count": <chunk count>,            // 0 if no DB
//       "files": <total session files>,
//       "indexed_files": <files reflected in DB>,
//       "manifest_entries": <files in manifest>,
//       "new": <new since manifest>,
//       "stale": <appended/changed since manifest>,
//       "deleted": <in manifest but file missing>,
//       "to_index": <new + stale>,
//       "actual_dim": <stored dim, null if empty/unreadable>,
//       "last_indexed": <ISO string or null>,
//       "exists": <bool — is data/sessions.lance present?>
//     },
//     "org": { ... same shape, "files" counts indexable org files }
//   }
//
// `provider unavailable` (no env) does NOT take down --json. Provider info is
// not part of the schema; DB truth is.

interface StatusTrack {
  count: number;
  files: number;
  indexed_files: number;
  manifest_entries: number;
  new: number;
  stale: number;
  deleted: number;
  to_index: number;
  actual_dim: number | null;
  last_indexed: string | null;
  exists: boolean;
}

interface StatusJson {
  sessions: StatusTrack;
  org: StatusTrack;
}

async function collectSessionStatus(): Promise<StatusTrack> {
  const dbPath = getSessionsDbPath();
  const exists = fs.existsSync(dbPath);
  const store = new VectorStore();
  let count = 0;
  let actualDim: number | null = null;
  let indexedFiles = new Set<string>();
  if (exists) {
    await store.init();
    count = await store.getCount();
    actualDim = await store.getActualVectorDim();
    indexedFiles = await store.getIndexedFiles();
    await store.close();
  }
  const files = findSessionFiles();
  const manifest = loadSessionManifest();
  const manifestEntries = Object.keys(manifest.files).length;
  let newCount = 0;
  let staleCount = 0;
  if (manifestEntries > 0) {
    const { newFiles, staleFiles } = getStaleFiles(files, indexedFiles, manifest);
    newCount = newFiles.length;
    staleCount = staleFiles.length;
  }
  const fileSet = new Set(files);
  const deletedCount = Object.keys(manifest.files).filter((f) => !fileSet.has(f)).length;
  return {
    count,
    files: files.length,
    indexed_files: indexedFiles.size,
    manifest_entries: manifestEntries,
    new: newCount,
    stale: staleCount,
    deleted: deletedCount,
    to_index: newCount + staleCount,
    actual_dim: actualDim,
    last_indexed: manifest.lastUpdated || null,
    exists,
  };
}

async function collectOrgStatus(): Promise<StatusTrack> {
  const dbPath = getOrgDbPath();
  const exists = fs.existsSync(dbPath);
  let count = 0;
  let actualDim: number | null = null;
  let indexedFiles = new Set<string>();
  if (exists) {
    const store = new VectorStore(dbPath);
    await store.init();
    count = await store.getCount();
    actualDim = await store.getActualVectorDim();
    indexedFiles = await store.getIndexedFiles();
    await store.close();
  }
  const files = findOrgFiles().filter((f) => shouldIndexOrgFile(f));
  const manifest = loadManifest();
  const manifestEntries = Object.keys(manifest.files).length;
  let newCount = 0;
  let staleCount = 0;
  if (manifestEntries > 0) {
    const { newFiles, staleFiles } = getStaleFiles(files, indexedFiles, manifest);
    newCount = newFiles.length;
    staleCount = staleFiles.length;
  }
  const fileSet = new Set(files);
  const deletedCount = Object.keys(manifest.files).filter((f) => !fileSet.has(f)).length;
  return {
    count,
    files: files.length,
    indexed_files: indexedFiles.size,
    manifest_entries: manifestEntries,
    new: newCount,
    stale: staleCount,
    deleted: deletedCount,
    to_index: newCount + staleCount,
    actual_dim: actualDim,
    last_indexed: manifest.lastUpdated || null,
    exists,
  };
}

async function status() {
  const json = process.argv.includes("--json");

  // Provider info is INFORMATIONAL ONLY for the text mode dim warning.
  // Failure here NEVER takes down status (PR-A hardening, preserved for both
  // text and json modes).
  let sessionsProviderDim: number | undefined;
  let orgProviderDim: number | undefined;
  try { sessionsProviderDim = createSessionProviderFromEnv()?.dimensions; } catch { /* swallow */ }
  try { orgProviderDim = createOrgProviderFromEnv()?.dimensions; } catch { /* swallow */ }

  const sessions = await collectSessionStatus();
  const org = await collectOrgStatus();

  if (json) {
    const payload: StatusJson = { sessions, org };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // --- Text mode (existing layout, kept stable for human eyeballs) ---
  const { execSync } = await import("node:child_process");
  const sDbPath = getSessionsDbPath();
  const sSize = sessions.exists
    ? execSync(`du -sh ${sDbPath}`).toString().split("\t")[0]
    : "N/A";
  const sFragDir = path.join(sDbPath, "session_chunks.lance", "data");
  const sFrags = fs.existsSync(sFragDir) ? fs.readdirSync(sFragDir).length : 0;
  const sDimLabel = sessions.actual_dim
    ? `${sessions.actual_dim}d`
    : sessionsProviderDim
      ? `empty, provider=${sessionsProviderDim}d`
      : "empty";
  console.log(
    `🧠 Sessions (${sDimLabel}): ${sessions.count} chunks | ${sessions.indexed_files}/${sessions.files} files | ${sFrags} frags | ${sSize}`,
  );
  if (sessions.manifest_entries > 0) {
    console.log(
      `   ↳ manifest: ${sessions.manifest_entries} entries | new: ${sessions.new} | stale: ${sessions.stale} | deleted: ${sessions.deleted} | to-index: ${sessions.to_index}`,
    );
    if (sessions.last_indexed) {
      console.log(`   ↳ last indexed: ${sessions.last_indexed}`);
    }
  } else if (sessions.indexed_files > 0) {
    console.log(
      `   ↳ manifest: empty (will baseline on next index:sessions — appended files won't be re-indexed yet)`,
    );
  }
  if (sessions.actual_dim && sessionsProviderDim && sessions.actual_dim !== sessionsProviderDim) {
    console.log(
      `   ⚠ sessions provider dim=${sessionsProviderDim}d differs from DB dim=${sessions.actual_dim}d — search/index paths will refuse until rebuild or config fix`,
    );
  }

  if (org.exists) {
    const orgDbPath = getOrgDbPath();
    const oSize = execSync(`du -sh ${orgDbPath}`).toString().split("\t")[0];
    const oFragDir = path.join(orgDbPath, "session_chunks.lance", "data");
    const oFrags = fs.existsSync(oFragDir) ? fs.readdirSync(oFragDir).length : 0;
    const oDimLabel = org.actual_dim
      ? `${org.actual_dim}d`
      : orgProviderDim
        ? `empty, provider=${orgProviderDim}d`
        : "empty";
    console.log(
      `📚 Org (${oDimLabel}): ${org.count} chunks | ${org.indexed_files}/${org.files} files | ${oFrags} frags | ${oSize}`,
    );
    if (org.actual_dim && orgProviderDim && org.actual_dim !== orgProviderDim) {
      console.log(
        `   ⚠ org provider dim=${orgProviderDim}d differs from DB dim=${org.actual_dim}d — search/index paths will refuse until rebuild or config fix`,
      );
    }
    console.log(
      `   ↳ manifest: ${org.manifest_entries} entries | new: ${org.new} | stale: ${org.stale} | deleted: ${org.deleted} | to-index: ${org.to_index}`,
    );
    if (org.last_indexed) {
      console.log(`   ↳ last indexed: ${org.last_indexed}`);
    }
  } else {
    console.log("📚 Org: not indexed yet");
  }
}

// --- Cleanup: dedup + orphan removal + manifest repair ---

async function cleanup(target: string) {
  const { execSync } = await import("node:child_process");
  const dryRun = process.argv.includes("--dry-run");
  const lancedb = await import("@lancedb/lancedb");

  const targets = target === "all" ? ["sessions", "org"] : [target];

  for (const t of targets) {
    const dbPath = t === "sessions" ? getSessionsDbPath() : getOrgDbPath();
    if (!fs.existsSync(dbPath)) { console.log(`${t}: not found`); continue; }

    const sizeBefore = execSync(`du -sh ${dbPath}`).toString().split("\t")[0];
    const db = await lancedb.connect(dbPath);
    const table = await db.openTable("session_chunks");
    const totalBefore = await table.countRows();

    console.log(`\n=== ${t} Cleanup ${dryRun ? "(DRY-RUN)" : ""} ===`);
    console.log(`Before: ${totalBefore.toLocaleString()} rows, ${sizeBefore}`);

    // 1. Detect duplicates
    const allRows = await table.query().select(["id", "sessionFile"]).limit(totalBefore + 1000).toArray();
    const idCounts = new Map<string, number>();
    for (const r of allRows) idCounts.set(r.id as string, (idCounts.get(r.id as string) ?? 0) + 1);
    const dupIds = [...idCounts.entries()].filter(([, c]) => c > 1);
    const extraRows = dupIds.reduce((sum, [, c]) => sum + (c - 1), 0);
    console.log(`Duplicate IDs: ${dupIds.length.toLocaleString()} (${extraRows.toLocaleString()} extra rows)`);

    // 2. Detect orphans (file not on disk)
    const orphanFiles = new Set<string>();
    for (const r of allRows) {
      const sf = r.sessionFile as string;
      if (!orphanFiles.has(sf) && !fs.existsSync(sf)) orphanFiles.add(sf);
    }
    const orphanRowCount = allRows.filter(r => orphanFiles.has(r.sessionFile as string)).length;
    console.log(`Orphan files: ${orphanFiles.size} (${orphanRowCount.toLocaleString()} rows)`);

    if (dryRun) {
      console.log(`\n→ Dry-run complete. Use without --dry-run to execute.`);
      continue;
    }

    // 3. Remove orphans
    if (orphanFiles.size > 0) {
      console.log(`Removing ${orphanFiles.size} orphan files from DB...`);
      for (const f of orphanFiles) {
        await table.delete(`\`sessionFile\` = '${f.replace(/'/g, "''")}'`);
      }
    }

    // 4. Dedup: for each file with duplicates, delete all + re-read from allRows keeping first occurrence
    if (dupIds.length > 0) {
      // Group duplicate IDs by file
      const dupFileSet = new Set<string>();
      for (const r of allRows) {
        const id = r.id as string;
        if ((idCounts.get(id) ?? 0) > 1) dupFileSet.add(r.sessionFile as string);
      }
      console.log(`Dedup: re-inserting ${dupFileSet.size} files with duplicates...`);

      for (const file of dupFileSet) {
        if (orphanFiles.has(file)) continue; // already removed
        // Get all rows for this file (with full data)
        const fileRows = await table.query()
          .where(`\`sessionFile\` = '${file.replace(/'/g, "''")}'`)
          .limit(10000)
          .toArray();

        // Keep only unique IDs (first occurrence)
        const seen = new Set<string>();
        const unique = fileRows.filter(r => {
          const id = r.id as string;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });

        if (unique.length < fileRows.length) {
          await table.delete(`\`sessionFile\` = '${file.replace(/'/g, "''")}'`);
          if (unique.length > 0) {
            await table.add(unique);
          }
        }
      }
    }

    // 5. Manifest repair (org only)
    if (t === "org") {
      const manifest = loadManifest();
      const oFiles = findOrgFiles().filter(f => shouldIndexOrgFile(f));
      const oFileSet = new Set(oFiles);
      let repaired = 0;

      // Remove deleted files from manifest
      for (const f of Object.keys(manifest.files)) {
        if (!oFileSet.has(f)) {
          delete manifest.files[f];
          repaired++;
        }
      }

      // Add ghost zone files (indexed but not in manifest).
      // PR-B: read-only manifest repair, dim parameter doesn't matter for
      // getIndexedFiles, but pass actual dim to keep the constructor honest.
      const probe = new VectorStore(dbPath);
      await probe.init();
      const actualDim = await probe.getActualVectorDim();
      await probe.close();
      const store = new VectorStore(dbPath, actualDim ?? 2560);
      await store.init();
      const indexed = await store.getIndexedFiles();
      for (const f of oFiles) {
        if (indexed.has(f) && !manifest.files[f]) {
          try {
            const stat = fs.statSync(f);
            manifest.files[f] = { mtimeMs: stat.mtimeMs, size: stat.size, chunks: 0 };
            repaired++;
          } catch {}
        }
      }
      await store.close();

      if (repaired > 0) {
        saveManifest(manifest);
        console.log(`Manifest repaired: ${repaired} entries fixed`);
      }
    }

    // 6. Compact
    console.log(`Compacting...`);
    await table.optimize({ cleanupOlderThan: new Date() });

    const totalAfter = await table.countRows();
    const sizeAfter = execSync(`du -sh ${dbPath}`).toString().split("\t")[0];
    const fragDir = path.join(dbPath, "session_chunks.lance", "data");
    const fragsAfter = fs.existsSync(fragDir) ? fs.readdirSync(fragDir).length : 0;
    console.log(`After: ${totalAfter.toLocaleString()} rows, ${fragsAfter} frags, ${sizeAfter}`);
    console.log(`Removed: ${(totalBefore - totalAfter).toLocaleString()} rows`);
  }
}

// --- Verify: post-indexing integrity check ---

async function verify(target: string) {
  const { execSync } = await import("node:child_process");
  let allPassed = true;
  const fail = (msg: string) => { console.log(`  ❌ ${msg}`); allPassed = false; };
  const pass = (msg: string) => { console.log(`  ✅ ${msg}`); };

  // PR-B target-aware dim resolution. Verify is read-only, but passing 2560 to
  // a 4096d sessions DB is misleading and would trip future assertions. Order:
  //   1. actual stored dim (DB truth)        — preferred
  //   2. configured provider dim             — informational, used only when DB is empty
  //   3. 2560                                — last-resort, backward-compat
  const safeProviderDim = (t: string): number | undefined => {
    try {
      return t === "sessions"
        ? createSessionProviderFromEnv()?.dimensions
        : createOrgProviderFromEnv()?.dimensions;
    } catch {
      return undefined;
    }
  };

  const targets = target === "all" ? ["sessions", "org"] : [target];

  for (const t of targets) {
    const dbPath = t === "sessions" ? getSessionsDbPath() : getOrgDbPath();
    if (!fs.existsSync(dbPath)) { console.log(`${t}: not found`); continue; }

    console.log(`\n=== ${t} Verification ===`);

    // First open with a probe store to read the actual stored dim. Constructor
    // dim parameter is only consulted when CREATING a table; for an existing
    // table all read paths (getCount, getIndexedFiles, raw query/select) are
    // dim-agnostic, so this probe is safe.
    const probe = new VectorStore(dbPath);
    await probe.init();
    const actualDim = await probe.getActualVectorDim();
    await probe.close();

    const configuredDim = safeProviderDim(t);
    const dim = actualDim ?? configuredDim ?? 2560;
    const dimNote =
      actualDim !== null && actualDim !== undefined
        ? `actual=${actualDim}d`
        : configuredDim
          ? `empty (provider=${configuredDim}d)`
          : `empty (default 2560d)`;
    pass(`Dim: ${dimNote}`);
    if (
      actualDim &&
      configuredDim &&
      actualDim !== configuredDim
    ) {
      // Don't fail verify on this — verify is meant to run after rebuilds and
      // should report on the DB state. A configured/actual delta means the
      // operator's env doesn't match the DB they just rebuilt; surface it
      // loudly but let other checks complete.
      console.log(
        `  ⚠ provider dim=${configuredDim}d differs from DB dim=${actualDim}d — search/index paths will refuse until rebuild or config fix`,
      );
    }

    const store = new VectorStore(dbPath, dim);
    await store.init();
    const table = (store as any).table;
    const count = await store.getCount();
    const indexed = await store.getIndexedFiles();

    // 1. Duplicate check
    const allRows = await table.query().select(["id", "sessionFile"]).limit(count + 1000).toArray();
    const idCounts = new Map<string, number>();
    for (const r of allRows) idCounts.set(r.id as string, (idCounts.get(r.id as string) ?? 0) + 1);
    const dupCount = [...idCounts.values()].filter(c => c > 1).length;
    if (dupCount === 0) pass(`No duplicate IDs (${idCounts.size.toLocaleString()} unique)`);
    else fail(`${dupCount} duplicate IDs found`);

    // 2. Orphan check
    const fileSet = new Set<string>();
    for (const r of allRows) fileSet.add(r.sessionFile as string);
    const orphans = [...fileSet].filter(f => !fs.existsSync(f));
    if (orphans.length === 0) pass(`No orphan files (${fileSet.size} files all exist)`);
    else fail(`${orphans.length} orphan files in DB`);

    // 3. Row count sanity
    if (allRows.length === count) pass(`Row count consistent: ${count.toLocaleString()}`);
    else fail(`Row count mismatch: query=${allRows.length} vs count=${count}`);

    // 4. Fragment report
    const fragDir = path.join(dbPath, "session_chunks.lance", "data");
    const frags = fs.existsSync(fragDir) ? fs.readdirSync(fragDir).length : 0;
    const dbSize = execSync(`du -sh ${dbPath}`).toString().split("\t")[0];
    pass(`${frags} fragments, ${dbSize}`);

    // 5. Org-specific: manifest consistency
    if (t === "org") {
      const manifest = loadManifest();
      const mEntries = Object.keys(manifest.files).length;
      const oFiles = findOrgFiles().filter(f => shouldIndexOrgFile(f));
      const oFileSet = new Set(oFiles);

      // Deleted in manifest
      const mDeleted = Object.keys(manifest.files).filter(f => !oFileSet.has(f));
      if (mDeleted.length === 0) pass(`Manifest clean: no deleted entries`);
      else fail(`${mDeleted.length} deleted files in manifest`);

      // Ghost zone: indexed but not in manifest
      const ghosts = oFiles.filter(f => indexed.has(f) && !manifest.files[f]);
      if (ghosts.length === 0) pass(`No ghost zone (all indexed files in manifest)`);
      else fail(`${ghosts.length} ghost zone files (indexed, not in manifest)`);

      // 0-chunk noise: manifest has file, LanceDB doesn't
      const zeroChunkNoise = oFiles.filter(f => !indexed.has(f) && manifest.files[f]?.chunks === 0);
      pass(`0-chunk files: ${zeroChunkNoise.length} (not in DB, expected)`);

      console.log(`  📊 manifest: ${mEntries} | indexed: ${indexed.size} | disk: ${oFiles.length}`);
    }

    await store.close();
  }

  console.log(allPassed ? "\n✅ All checks passed" : "\n⚠️  Some checks failed");
  process.exitCode = allPassed ? 0 : 1;
}

// --- Estimate (PR-B) ---
//
// Dry-run cost estimate. API 0 calls. Reads sessions JSONL files from disk,
// runs the same chunk extractor that indexing uses, sums chars, converts to
// approximate token count (chars / 2.5), multiplies by configured price.
//
// Modes:
//   `estimate sessions`         → INCREMENTAL (default): only stale/new files
//                                 (those that would actually be embedded by
//                                 the next sync-sessions run)
//   `estimate sessions --full`  → FULL REBUILD: every session file
//
// Price resolution (in order):
//   1. ANDENKEN_SESSION_PRICE_PER_M_TOKENS env (sessions-namespaced)
//   2. OPENROUTER_QWEN_8B_PRICE env (alias for openrouter qwen 8B)
//   3. default 0.01 USD per million tokens
//
// Caveat printed in output: chars/2.5 is an approximation; OpenRouter actual
// usage may differ ±20% depending on tokenizer.

async function estimate(target: string) {
  if (target !== "sessions") {
    console.error(`estimate: only "sessions" target supported in PR-B (got "${target}")`);
    process.exit(2);
  }

  const fullMode = process.argv.includes("--full");
  const allFiles = findSessionFiles();

  // INCREMENTAL: subtract files already in manifest with current mtime/size.
  // Use the same getStaleFiles logic indexSessions uses, so the estimate
  // reflects exactly what the next sync-sessions run would embed.
  let filesToEstimate: string[];
  if (fullMode) {
    filesToEstimate = allFiles;
  } else {
    const manifest = loadSessionManifest();
    if (Object.keys(manifest.files).length === 0) {
      // No manifest yet → be conservative: estimate ALL files (next run baselines)
      filesToEstimate = allFiles;
    } else {
      // Need indexed set to call getStaleFiles. Read it once from the DB if
      // present; otherwise treat as empty (every file becomes "new").
      let indexed = new Set<string>();
      const sDbPath = getSessionsDbPath();
      if (fs.existsSync(sDbPath)) {
        const store = new VectorStore();
        await store.init();
        indexed = await store.getIndexedFiles();
        await store.close();
      }
      const { newFiles, staleFiles } = getStaleFiles(allFiles, indexed, manifest);
      filesToEstimate = [...newFiles, ...staleFiles];
    }
  }

  // Walk files, extract chunks, sum chars. Same extractor as indexSessions
  // so the chunk count matches what would be embedded.
  let totalChunks = 0;
  let totalChars = 0;
  for (const f of filesToEstimate) {
    try {
      const chunks = await extractSessionChunks(f);
      totalChunks += chunks.length;
      for (const c of chunks) totalChars += c.text.length;
    } catch {
      // Skip unreadable files; mirrors indexer behavior of just counting errors
      // separately. Estimate is approximate by design.
    }
  }

  // chars / 2.5 — same heuristic VLLMProvider uses to populate _tokenEstimate.
  // Keeps the estimate consistent with stats once the actual rebuild runs.
  const tokens = Math.ceil(totalChars / 2.5);

  // Price precedence (matches scripts/rebuild-sessions-full.sh):
  //   1. ANDENKEN_SESSION_PRICE_PER_M_TOKENS
  //   2. OPENROUTER_QWEN_8B_PRICE
  //   3. 0.01
  const priceRaw =
    process.env.ANDENKEN_SESSION_PRICE_PER_M_TOKENS ??
    process.env.OPENROUTER_QWEN_8B_PRICE ??
    "0.01";
  const pricePerM = parseFloat(priceRaw);
  const price = Number.isFinite(pricePerM) && pricePerM > 0 ? pricePerM : 0.01;
  const cost = (tokens / 1_000_000) * price;

  const header = fullMode ? "Sessions estimate (FULL REBUILD)" : "Sessions estimate (INCREMENTAL)";
  console.log(header);
  if (fullMode) {
    console.log(`  files: ${allFiles.length}`);
  } else {
    const skipped = allFiles.length - filesToEstimate.length;
    console.log(`  files to index: ${filesToEstimate.length}` + (skipped > 0 ? ` (${skipped} already indexed → skipped)` : ""));
  }
  console.log(`  chunks (estimated): ~${totalChunks}`);
  console.log(`  chars: ~${totalChars.toLocaleString()}`);
  console.log(`  estimated tokens: ~${tokens.toLocaleString()} (chars/2.5)`);
  console.log(`  configured price: $${price}/M tokens`);
  console.log(`  estimated cost: $${cost.toFixed(4)}`);
  console.log(`  ↳ caveat: chars/2.5 is rough; OpenRouter actual usage may differ ±20%`);
  console.log(`  ↳ no API call was made for this estimate`);
}

// --- Main ---

const args = process.argv.slice(2);
const cmd = args[0];
const force = args.includes("--force");

switch (cmd) {
  case "sessions":
    await indexSessions(force);
    break;
  case "org":
    await indexOrg(force);
    break;
  case "compact":
    await compact(args[1] ?? "all");
    break;
  case "cleanup":
    await cleanup(args[1] ?? "org");
    break;
  case "verify":
    await verify(args[1] ?? "all");
    break;
  case "status":
    await status();
    break;
  case "estimate":
    await estimate(args[1] ?? "sessions");
    break;
  default:
    console.log("Usage: npx tsx indexer.ts <sessions|org|compact|cleanup|verify|status|estimate> [...]");
    console.log("  INDEX_CONCURRENCY=2 npx tsx indexer.ts org --force");
    console.log("  npx tsx indexer.ts compact org    # defragment DB");
    console.log("  npx tsx indexer.ts cleanup org    # dedup + orphan + manifest repair + compact");
    console.log("  npx tsx indexer.ts cleanup org --dry-run");
    console.log("  npx tsx indexer.ts verify all     # post-indexing integrity check");
    console.log("  npx tsx indexer.ts status [--json]   # status; --json emits machine-readable schema");
    console.log("  npx tsx indexer.ts estimate sessions [--full]   # API-0 dry-run cost estimate");
}
