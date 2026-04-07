/**
 * Unified Indexer — Sessions (768d) + Org (768d)
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
  embedDocumentBatch,
  runWithConcurrency,
  DEFAULT_CONCURRENCY,
  getApiStats,
  resetApiStats,
  type GeminiEmbeddingConfig,
} from "./gemini-embeddings.js";
import { VectorStore, getSessionsDbPath, getOrgDbPath, getDataDir } from "./store.js";
import { findSessionFiles, extractSessionChunks } from "./session-indexer.js";
import { findOrgFiles, chunkOrgFile } from "./org-chunker.js";

// --- Config ---

const ORG_FOLDERS = new Set(["meta", "bib", "notes", "journal", "botlog"]);

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
    const input = texts.join("\n");
    const output = execSync(`./run.sh stem --batch`, {
      input,
      cwd: dictcliDir,
      timeout: 300_000, // 5 min for large batches
      maxBuffer: 50 * 1024 * 1024, // 50MB
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Parse JSON lines: each line is ["stem1", "stem2", ...]
    const lines = output.trim().split("\n");
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
const CANDIDATE_MULTIPLIER = 4; // openclaw pattern: fetch 4x candidates for better MMR

// --- Org Manifest (mtime-based stale detection) ---

interface OrgFileManifest {
  files: Record<string, { mtimeMs: number; size: number; chunks: number }>;
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
      newFiles.push(f);
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

function getGeminiConfig(dimensions: 768 = 768): GeminiEmbeddingConfig {
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY (or GOOGLE_AI_API_KEY / GOOGLE_API_KEY) not set");
  return {
    apiKey,
    model: "gemini-embedding-2-preview",
    ...(dimensions ? { dimensions } : {}),
  };
}

function getOrgFolder(filePath: string): string {
  const parts = filePath.split("/");
  const orgIdx = parts.findIndex((p) => p === "org");
  return orgIdx >= 0 && orgIdx + 1 < parts.length ? parts[orgIdx + 1] : "";
}

// --- Write Buffer ---

interface PendingRecord {
  id: string;
  text: string;
  vector: number[];
  sessionFile: string;
  project: string;
  lineNumber: number;
  timestamp: string;
  role: string;
  metadata: Record<string, string>;
}

class WriteBuffer {
  private buffer: PendingRecord[] = [];
  private flushed = 0;
  private deletedFiles = new Set<string>(); // track files already cleaned

  constructor(
    private store: VectorStore,
    private batchSize: number,
  ) {}

  async add(records: PendingRecord[]) {
    // Pre-delete old chunks for each new file before buffering
    // This ensures no duplicates even when flush batches span multiple files
    for (const r of records) {
      if (r.sessionFile && !this.deletedFiles.has(r.sessionFile)) {
        await this.store.deleteByFile(r.sessionFile);
        this.deletedFiles.add(r.sessionFile);
      }
    }
    this.buffer.push(...records);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    await this.store.addChunksRaw(this.buffer); // skip per-file delete (already done)
    this.flushed += this.buffer.length;
    this.buffer = [];
  }

  get totalFlushed() {
    return this.flushed + this.buffer.length;
  }
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

// --- Session Indexing (768d) ---

async function indexSessions(force: boolean) {
  const config = getGeminiConfig();
  const store = new VectorStore(undefined, 768);
  await store.init();
  if (force) await store.reset();
  await store.ensureTable();

  const files = findSessionFiles();
  const indexed = force ? new Set<string>() : await store.getIndexedFiles();
  const toIndex = files.filter((f) => !indexed.has(f));

  console.log(
    `Sessions: ${files.length} | indexed: ${indexed.size} | to index: ${toIndex.length} | concurrency: ${CONCURRENCY}`,
  );
  if (toIndex.length === 0) {
    console.log("✅ All sessions indexed.");
    await store.close();
    return;
  }

  const progress = new Progress(toIndex.length, "Sessions");
  const wb = new WriteBuffer(store, DB_WRITE_BATCH);

  const tasks = toIndex.map((file) => async () => {
    const chunks = await extractSessionChunks(file);
    if (chunks.length === 0) {
      progress.tick(0);
      return;
    }
    const vectors = await embedDocumentBatch(
      chunks.map((c) => c.text),
      config,
    );
    await wb.add(chunks.map((c, j) => ({ ...c, vector: vectors[j] })));
    progress.tick(chunks.length);
  });

  await runWithConcurrency(tasks, CONCURRENCY);
  await wb.flush(); // final flush

  try {
    await store.createFtsIndex();
  } catch {}
  const total = await store.getCount();
  const stats = getApiStats();
  console.log(progress.summary());
  console.log(`💰 API: ${stats.calls} calls, ~${(stats.estimatedTokens / 1000).toFixed(0)}K tokens, ~$${stats.estimatedCostUSD.toFixed(3)}`);
  console.log(`Total in DB: ${total}`);
  await store.close();
}

// --- Org Indexing (768d) ---

async function indexOrg(force: boolean) {
  const config = getGeminiConfig(768);
  const store = new VectorStore(getOrgDbPath(), 768);
  await store.init();
  if (force) await store.reset();
  await store.ensureTable();

  const allFiles = findOrgFiles();
  const files = allFiles.filter((f) => ORG_FOLDERS.has(getOrgFolder(f)));
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

  // --- Batch stem: collect all chunks first, then stem in one JVM call ---
  console.log("Collecting chunks for stem enrichment...");
  const fileChunks: Array<{ file: string; chunks: ReturnType<typeof chunkOrgFile> }> = [];
  for (const file of toIndex) {
    const content = fs.readFileSync(file, "utf-8");
    const chunks = chunkOrgFile(content, file);
    // Update manifest even for 0-chunk files
    try {
      const stat = fs.statSync(file);
      manifest.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, chunks: chunks.length };
    } catch { /* file may have been deleted */ }
    fileChunks.push({ file, chunks });
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
  if (estCost > 1.0) {
    console.log(`⚠️  Estimated cost > $1. Use Ctrl+C to abort.`);
    await new Promise(r => setTimeout(r, 5000)); // 5s grace period
  }
  resetApiStats();

  const CHECKPOINT_INTERVAL = 50;
  let filesProcessed = 0;

  const progress = new Progress(enrichedFileChunks.length, "Org");
  const wb = new WriteBuffer(store, DB_WRITE_BATCH);

  const tasks = enrichedFileChunks.map(({ chunks }) => async () => {
    if (chunks.length === 0) {
      filesProcessed++;
      progress.tick(0);
      return;
    }

    // Embed in batches of 100 (API limit) — use ORIGINAL text for embeddings
    for (let b = 0; b < chunks.length; b += 100) {
      const batch = chunks.slice(b, b + 100);
      const vectors = await embedDocumentBatch(
        batch.map((c) => c.text), // original text for vector embedding
        config,
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
    filesProcessed++;
    progress.tick(chunks.length);

    // Periodic manifest checkpoint to reduce re-work after interruption
    if (filesProcessed % CHECKPOINT_INTERVAL === 0) {
      saveManifest(manifest);
      console.log(`  📌 Manifest checkpoint at ${filesProcessed}/${enrichedFileChunks.length} files`);
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);
  await wb.flush(); // final flush

  // Final manifest save
  saveManifest(manifest);

  try {
    await store.createFtsIndex();
  } catch {}
  const total = await store.getCount();
  const orgStats = getApiStats();
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

async function status() {
  const { execSync } = await import("node:child_process");

  const sessionStore = new VectorStore(undefined, 768);
  await sessionStore.init();
  const sCount = await sessionStore.getCount();
  const sIndexed = await sessionStore.getIndexedFiles();
  const sFiles = findSessionFiles();
  const sDbPath = getSessionsDbPath();
  const sSize = fs.existsSync(sDbPath)
    ? execSync(`du -sh ${sDbPath}`).toString().split("\t")[0]
    : "N/A";
  const sFragDir = path.join(sDbPath, "session_chunks.lance", "data");
  const sFrags = fs.existsSync(sFragDir)
    ? fs.readdirSync(sFragDir).length
    : 0;
  console.log(
    `🧠 Sessions (768d): ${sCount} chunks | ${sIndexed.size}/${sFiles.length} files | ${sFrags} frags | ${sSize}`,
  );
  await sessionStore.close();

  const orgDbPath = getOrgDbPath();
  if (fs.existsSync(orgDbPath)) {
    const orgStore = new VectorStore(orgDbPath, 768);
    await orgStore.init();
    const oCount = await orgStore.getCount();
    const oIndexed = await orgStore.getIndexedFiles();
    const oFiles = findOrgFiles().filter((f) => ORG_FOLDERS.has(getOrgFolder(f)));
    const oSize = execSync(`du -sh ${orgDbPath}`).toString().split("\t")[0];
    const oFragDir = path.join(orgDbPath, "session_chunks.lance", "data");
    const oFrags = fs.existsSync(oFragDir)
      ? fs.readdirSync(oFragDir).length
      : 0;

    // Manifest-based stale detection for accurate status
    const manifest = loadManifest();
    const { newFiles, staleFiles } = getStaleFiles(oFiles, oIndexed, manifest);
    const manifestEntries = Object.keys(manifest.files).length;
    const oFileSet = new Set(oFiles);
    const deletedCount = Object.keys(manifest.files).filter((f) => !oFileSet.has(f)).length;

    console.log(
      `📚 Org (768d): ${oCount} chunks | ${oIndexed.size}/${oFiles.length} files | ${oFrags} frags | ${oSize}`,
    );
    console.log(
      `   ↳ manifest: ${manifestEntries} entries | new: ${newFiles.length} | stale: ${staleFiles.length} | deleted: ${deletedCount} | to-index: ${newFiles.length + staleFiles.length}`,
    );
    if (manifest.lastUpdated) {
      console.log(`   ↳ last indexed: ${manifest.lastUpdated}`);
    }
    await orgStore.close();
  } else {
    console.log("📚 Org: not indexed yet");
  }
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
  case "status":
    await status();
    break;
  default:
    console.log("Usage: npx tsx indexer.ts <sessions|org|compact|status> [--force]");
    console.log("  INDEX_CONCURRENCY=2 npx tsx indexer.ts org --force");
    console.log("  npx tsx indexer.ts compact org    # defragment DB");
}
