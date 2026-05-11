#!/usr/bin/env tsx
/**
 * window-dryrun — C2.0 parse-only transcript-window verification.
 *
 * Compares current message-per-chunk session indexing with an OpenClaw-style
 * transcript-window prototype. API 0, DB 0, network 0.
 *
 * Usage:
 *   pnpm exec tsx scripts/window-dryrun.ts
 *   pnpm exec tsx scripts/window-dryrun.ts --source pi|claude|all
 *   pnpm exec tsx scripts/window-dryrun.ts --tokens 400 --overlap 80
 *   pnpm exec tsx scripts/window-dryrun.ts --limit 200 --json
 */

import {
  extractSessionChunks,
  findSessionFiles,
  findSessionFilesBySource,
  parseSourceArg,
  type SourceFilter,
} from "../session-indexer.ts";
import {
  buildSessionTranscriptEntry,
  buildWindowChunks,
  estimateTokens,
  type CompactionMode,
  type WindowChunk,
} from "../session-window.ts";

interface CliArgs {
  source: SourceFilter;
  limit: number | null;
  json: boolean;
  tokens: number;
  overlap: number;
  compactionMode: CompactionMode;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    source: "all",
    limit: null,
    json: false,
    tokens: 400,
    overlap: 80,
    compactionMode: "skip",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") {
      args.source = parseSourceArg(argv[++i]);
    } else if (a === "--limit") {
      args.limit = Number(argv[++i]);
      if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error("--limit must be positive int");
    } else if (a === "--tokens") {
      args.tokens = Number(argv[++i]);
      if (!Number.isFinite(args.tokens) || args.tokens <= 0) throw new Error("--tokens must be positive int");
    } else if (a === "--overlap") {
      args.overlap = Number(argv[++i]);
      if (!Number.isFinite(args.overlap) || args.overlap < 0) throw new Error("--overlap must be non-negative int");
    } else if (a === "--compaction") {
      const v = argv[++i];
      if (v !== "skip" && v !== "inline") throw new Error("--compaction must be skip|inline");
      args.compactionMode = v;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      console.error("Usage: window-dryrun [--source pi|claude|all] [--limit N] [--tokens N] [--overlap N] [--compaction skip|inline] [--json]");
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

interface Sample {
  sessionFile: string;
  windowIndex: number;
  startLine: number;
  endLine: number;
  messageCount: number;
  roles: string[];
  estimatedTokens: number;
  text: string;
}

interface Stats {
  filesScanned: number;
  filesWithError: number;
  filesWithOldChunks: number;
  filesWithWindowChunks: number;
  oldChunks: number;
  oldCompactionChunks: number;
  windowChunks: number;
  transcriptLines: number;
  compactionLines: number;
  zeroWindowFiles: number;
  oldChars: number;
  windowChars: number;
  windowEstimatedTokens: number;
  lineSpanValues: number[];
  messageCountValues: number[];
  chunkCharValues: number[];
  skipped: Record<string, number>;
  samples: Sample[];
}

function addCount(map: Record<string, number>, key: string, count = 1): void {
  map[key] = (map[key] ?? 0) + count;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function pickReservoir<T>(arr: T[], item: T, k: number, seen: number): void {
  if (arr.length < k) {
    arr.push(item);
    return;
  }
  const j = Math.floor(Math.random() * seen);
  if (j < k) arr[j] = item;
}

function sampleFromChunk(chunk: WindowChunk): Sample {
  return {
    sessionFile: chunk.sessionFile,
    windowIndex: chunk.windowIndex,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    messageCount: chunk.messageCount,
    roles: chunk.roles,
    estimatedTokens: chunk.estimatedTokens,
    text: chunk.text.slice(0, 700),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let files = args.source === "all" ? findSessionFiles() : findSessionFilesBySource(args.source);
  if (args.limit !== null) files = files.slice(0, args.limit);

  const stats: Stats = {
    filesScanned: 0,
    filesWithError: 0,
    filesWithOldChunks: 0,
    filesWithWindowChunks: 0,
    oldChunks: 0,
    oldCompactionChunks: 0,
    windowChunks: 0,
    transcriptLines: 0,
    compactionLines: 0,
    zeroWindowFiles: 0,
    oldChars: 0,
    windowChars: 0,
    windowEstimatedTokens: 0,
    lineSpanValues: [],
    messageCountValues: [],
    chunkCharValues: [],
    skipped: {},
    samples: [],
  };

  const startedAt = Date.now();
  if (!args.json) process.stderr.write(`Scanning ${files.length} session file(s)...\n`);
  let sampleSeen = 0;

  for (const file of files) {
    stats.filesScanned++;
    try {
      const oldChunks = await extractSessionChunks(file);
      stats.oldChunks += oldChunks.length;
      stats.oldCompactionChunks += oldChunks.filter((c) => c.role === "compaction").length;
      stats.oldChars += oldChunks.reduce((sum, c) => sum + c.text.length, 0);
      if (oldChunks.length > 0) stats.filesWithOldChunks++;

      const entry = await buildSessionTranscriptEntry(file, { compactionMode: args.compactionMode });
      const windows = buildWindowChunks(entry, { tokens: args.tokens, overlap: args.overlap });
      stats.transcriptLines += entry.lines.length;
      stats.compactionLines += entry.compactionLines;
      for (const [reason, count] of Object.entries(entry.skipped)) addCount(stats.skipped, reason, count);
      stats.windowChunks += windows.length;
      if (windows.length > 0) stats.filesWithWindowChunks++;
      if (oldChunks.length > 0 && windows.length === 0) stats.zeroWindowFiles++;

      for (const chunk of windows) {
        stats.windowChars += chunk.text.length;
        stats.windowEstimatedTokens += chunk.estimatedTokens;
        stats.lineSpanValues.push(Math.max(0, chunk.endLine - chunk.startLine + 1));
        stats.messageCountValues.push(chunk.messageCount);
        stats.chunkCharValues.push(chunk.text.length);
        sampleSeen++;
        pickReservoir(stats.samples, sampleFromChunk(chunk), 40, sampleSeen);
      }
    } catch (err) {
      stats.filesWithError++;
      if (!args.json) process.stderr.write(`  ! ${file}: ${String(err)}\n`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const costUsd = (stats.windowEstimatedTokens / 1_000_000) * 0.01;
  const summary = {
    ...stats,
    source: args.source,
    fileLimit: args.limit,
    tokens: args.tokens,
    overlap: args.overlap,
    compactionMode: args.compactionMode,
    elapsedMs,
    chunkDelta: stats.windowChunks - stats.oldChunks,
    chunkDeltaPct: stats.oldChunks === 0 ? 0 : Number((((stats.windowChunks - stats.oldChunks) / stats.oldChunks) * 100).toFixed(2)),
    avgWindowChars: stats.windowChunks === 0 ? 0 : Math.round(stats.windowChars / stats.windowChunks),
    p50WindowChars: percentile(stats.chunkCharValues, 50),
    p95WindowChars: percentile(stats.chunkCharValues, 95),
    avgMessageCount: stats.windowChunks === 0 ? 0 : Number((stats.messageCountValues.reduce((a, b) => a + b, 0) / stats.windowChunks).toFixed(2)),
    p50MessageCount: percentile(stats.messageCountValues, 50),
    p95MessageCount: percentile(stats.messageCountValues, 95),
    p50LineSpan: percentile(stats.lineSpanValues, 50),
    p95LineSpan: percentile(stats.lineSpanValues, 95),
    estimatedCostUsdAtOpenRouter8B: Number(costUsd.toFixed(4)),
    notes: [
      "API 0 / DB 0 / network 0 parse-only prototype.",
      "windowEstimatedTokens is based on CJK-aware chars/4 estimate, not provider tokenizer.",
      "C2.0 does not justify rebuild by itself; C2.1 implementation decision comes after sample review.",
    ],
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("\n=== transcript-window dry-run (C2.0) ===");
  console.log(`  source:             ${args.source}`);
  console.log(`  files scanned:      ${stats.filesScanned}`);
  console.log(`  files w/ error:     ${stats.filesWithError}`);
  console.log(`  chunking:           ${args.tokens} tokens / ${args.overlap} overlap`);
  console.log(`  compaction mode:    ${args.compactionMode}`);
  console.log(`  old chunks:         ${stats.oldChunks}  (compaction chunks: ${stats.oldCompactionChunks})`);
  console.log(`  window chunks:      ${stats.windowChunks}`);
  console.log(`  chunk delta:        ${summary.chunkDelta >= 0 ? "+" : ""}${summary.chunkDelta} (${summary.chunkDeltaPct}%)`);
  console.log(`  transcript lines:   ${stats.transcriptLines}`);
  console.log(`  zero-window files:  ${stats.zeroWindowFiles}`);
  console.log(`  avg chars/window:   ${summary.avgWindowChars}`);
  console.log(`  p50/p95 chars:      ${summary.p50WindowChars} / ${summary.p95WindowChars}`);
  console.log(`  avg msg/window:     ${summary.avgMessageCount}`);
  console.log(`  p50/p95 messages:   ${summary.p50MessageCount} / ${summary.p95MessageCount}`);
  console.log(`  p50/p95 line span:  ${summary.p50LineSpan} / ${summary.p95LineSpan}`);
  console.log(`  est tokens:         ${stats.windowEstimatedTokens.toLocaleString()}`);
  console.log(`  est 8B cost:        $${summary.estimatedCostUsdAtOpenRouter8B}`);
  console.log(`  elapsed:            ${(elapsedMs / 1000).toFixed(2)}s`);

  console.log("\n  skipped during transcript build:");
  const skipped = Object.entries(stats.skipped).sort((a, b) => b[1] - a[1]);
  if (skipped.length === 0) console.log("    (none)");
  for (const [reason, count] of skipped) console.log(`    ${reason.padEnd(34)} ${count}`);

  console.log(`\n  samples (n=${stats.samples.length}):`);
  for (let i = 0; i < stats.samples.length; i++) {
    const s = stats.samples[i];
    console.log(`\n  --- sample ${i + 1} ${s.sessionFile.split("/").pop()}:${s.startLine}-${s.endLine} window=${s.windowIndex} roles=${s.roles.join(",")} messages=${s.messageCount} estTok=${s.estimatedTokens} ---`);
    console.log(s.text.slice(0, 700));
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
