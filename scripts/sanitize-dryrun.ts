#!/usr/bin/env tsx
/**
 * sanitize-dryrun — A3 C1 parse-only verification.
 *
 * Reproduces the exact parseMessageContent decision tree for both the OLD
 * pipeline (extract → length → noise → truncate) and the NEW pipeline
 * (extract → sanitize → length → noise → truncate), then reports the diff.
 *
 *   emitted (old):  text passes oldLength && !isNoise(text)
 *   emitted (new):  sanitize.ok && newLength(sanitized) && !isNoise(sanitized)
 *
 * Drop reasons (only counted when oldEmit=true && newEmit=false, i.e.
 * actual emit loss from the new pipeline):
 *   sanitize.<reason>          — sanitizer dropped it
 *   under_length_after_strip   — passed old length but post-strip too short
 *   noise_after_strip          — passed old noise but trim revealed a noise prefix
 *
 * "changed-in-emit" only counts chunks that BOTH pipelines emit but whose
 * stored text differs (real impact on future full-rebuild output).
 *
 * NO embedding API calls. NO DB writes. NO network.
 *
 * Usage:
 *   pnpm exec tsx scripts/sanitize-dryrun.ts            # all sessions
 *   pnpm exec tsx scripts/sanitize-dryrun.ts --source pi
 *   pnpm exec tsx scripts/sanitize-dryrun.ts --limit 200
 *   pnpm exec tsx scripts/sanitize-dryrun.ts --json
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  findSessionFilesBySource,
  findSessionFiles,
  detectSource,
  isNoise,
  passesLengthFilter,
  parseSourceArg,
  type SessionSource,
  type SourceFilter,
} from "../session-indexer.ts";
import { sanitizeSessionChunkText } from "../session-sanitize.ts";

interface CliArgs {
  source: SourceFilter;
  limit: number | null;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let source: CliArgs["source"] = "all";
  let limit: number | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") {
      source = parseSourceArg(argv[++i]);
    } else if (a === "--limit") {
      limit = Number(argv[++i]);
      if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be positive int");
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      console.error("Usage: sanitize-dryrun [--source pi|claude|all] [--limit N] [--json]");
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { source, limit, json };
}

interface Sample {
  kind: "drop" | "change_in_emit" | "newly_emitted";
  role: "user" | "assistant";
  source: SessionSource;
  reason?: string;
  before: string;
  after?: string;
  sessionFile: string;
  lineNumber: number;
}

interface Stats {
  filesScanned: number;
  filesWithImpact: number;       // file changes that affect the new pipeline's emit set
  filesWithError: number;
  totalMessages: number;
  emittedOld: number;
  emittedNew: number;
  newDrops: number;              // oldEmit=true && newEmit=false
  newDropReasons: Record<string, number>;
  newlyEmitted: number;          // oldEmit=false && newEmit=true (e.g. sanitize revealed valid text)
  changedInEmit: number;         // oldEmit=true && newEmit=true && stored text differs
  samples: { drops: Sample[]; changes: Sample[]; additions: Sample[] };
}

async function* iterMessages(
  sessionFile: string,
): AsyncGenerator<{
  role: "user" | "assistant";
  text: string;
  lineNumber: number;
}> {
  const source = detectSource(sessionFile);
  const fileStream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    let role: string | undefined;
    let content: unknown;
    const p = parsed as Record<string, unknown>;

    if (source === "claude") {
      const t = p.type;
      if (t !== "user" && t !== "assistant") continue;
      const msg = p.message as { content?: unknown } | undefined;
      if (!msg) continue;
      role = typeof t === "string" ? t : undefined;
      content = msg.content;
    } else {
      if (p.type !== "message") continue;
      const msg = p.message as { role?: unknown; content?: unknown } | undefined;
      if (!msg) continue;
      role = typeof msg.role === "string" ? msg.role : undefined;
      content = msg.content;
    }

    if (role !== "user" && role !== "assistant") continue;

    // Same extractTextContent as session-indexer.ts
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === "text" && typeof b.text === "string") {
            parts.push(b.text);
          }
        }
      }
      text = parts.join("\n");
    }

    yield { role, text, lineNumber };
  }
}

function pickReservoir<T>(arr: T[], item: T, k: number, seen: number): void {
  if (arr.length < k) {
    arr.push(item);
    return;
  }
  const j = Math.floor(Math.random() * seen);
  if (j < k) arr[j] = item;
}

function truncate(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n) + "...";
}

// Replicate session-indexer.ts pipelines exactly.
// OLD: text → lengthFilter → !isNoise → truncate2000 → emit
// NEW: text → sanitize.ok → lengthFilter(sanitized) → !isNoise(sanitized) → truncate2000 → emit
function decideOld(
  rawText: string,
  role: "user" | "assistant",
): { emit: boolean; stored?: string; noise?: boolean } {
  if (!rawText) return { emit: false };
  if (!passesLengthFilter(rawText, role)) return { emit: false };
  if (isNoise(rawText)) return { emit: false, noise: true };
  return { emit: true, stored: truncate(rawText, 2000) };
}

function decideNew(
  rawText: string,
  role: "user" | "assistant",
  source: SessionSource,
):
  | { emit: false; reason: string }
  | { emit: true; stored: string; changedVsRaw: boolean } {
  if (!rawText) return { emit: false, reason: "empty_input" };
  const r = sanitizeSessionChunkText(rawText, role, source);
  if (!r.ok) return { emit: false, reason: `sanitize.${r.dropReason}` };
  if (!passesLengthFilter(r.text, role)) return { emit: false, reason: "under_length_after_strip" };
  if (isNoise(r.text)) return { emit: false, reason: "noise_after_strip" };
  return { emit: true, stored: truncate(r.text, 2000), changedVsRaw: r.changed };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let files: string[];
  if (args.source === "all") {
    files = findSessionFiles();
  } else {
    files = findSessionFilesBySource(args.source);
  }
  if (args.limit !== null) files = files.slice(0, args.limit);

  const stats: Stats = {
    filesScanned: 0,
    filesWithImpact: 0,
    filesWithError: 0,
    totalMessages: 0,
    emittedOld: 0,
    emittedNew: 0,
    newDrops: 0,
    newDropReasons: {},
    newlyEmitted: 0,
    changedInEmit: 0,
    samples: { drops: [], changes: [], additions: [] },
  };

  const SAMPLE_PER_KIND = 10;
  let seenDrop = 0;
  let seenChange = 0;
  let seenAdd = 0;

  const startedAt = Date.now();
  if (!args.json) {
    process.stderr.write(`Scanning ${files.length} session file(s)...\n`);
  }

  for (const sessionFile of files) {
    stats.filesScanned++;
    let fileImpactful = false;
    try {
      const source = detectSource(sessionFile);
      for await (const { role, text, lineNumber } of iterMessages(sessionFile)) {
        stats.totalMessages++;

        const oldD = decideOld(text, role);
        const newD = decideNew(text, role, source);

        if (oldD.emit) stats.emittedOld++;
        if (newD.emit) stats.emittedNew++;

        if (oldD.emit && !newD.emit) {
          // Real emit loss
          stats.newDrops++;
          const reason = (newD as { reason: string }).reason;
          stats.newDropReasons[reason] = (stats.newDropReasons[reason] ?? 0) + 1;
          fileImpactful = true;
          seenDrop++;
          pickReservoir(
            stats.samples.drops,
            {
              kind: "drop",
              role,
              source,
              reason,
              before: truncate(text, 360),
              sessionFile,
              lineNumber,
            },
            SAMPLE_PER_KIND,
            seenDrop,
          );
        } else if (!oldD.emit && newD.emit) {
          // Sanitize revealed a chunk OLD would have skipped (e.g. trim removed
          // a leading noise prefix that matched isNoise patterns).
          stats.newlyEmitted++;
          fileImpactful = true;
          seenAdd++;
          pickReservoir(
            stats.samples.additions,
            {
              kind: "newly_emitted",
              role,
              source,
              before: truncate(text, 360),
              after: truncate((newD as { stored: string }).stored, 360),
              sessionFile,
              lineNumber,
            },
            SAMPLE_PER_KIND,
            seenAdd,
          );
        } else if (oldD.emit && newD.emit) {
          // Both emit; compare the stored text (post-truncate). This is the
          // metric that matters for "future full rebuild would change DB".
          const oldStored = oldD.stored!;
          const newStored = (newD as { stored: string }).stored;
          if (oldStored !== newStored) {
            stats.changedInEmit++;
            fileImpactful = true;
            seenChange++;
            pickReservoir(
              stats.samples.changes,
              {
                kind: "change_in_emit",
                role,
                source,
                before: truncate(oldStored, 360),
                after: truncate(newStored, 360),
                sessionFile,
                lineNumber,
              },
              SAMPLE_PER_KIND,
              seenChange,
            );
          }
        }
      }
    } catch (err) {
      stats.filesWithError++;
      if (!args.json) {
        process.stderr.write(`  ! error reading ${sessionFile}: ${String(err)}\n`);
      }
    }
    if (fileImpactful) stats.filesWithImpact++;
  }

  const elapsedMs = Date.now() - startedAt;
  const netDelta = stats.emittedNew - stats.emittedOld;
  const pctOfOld = stats.emittedOld === 0 ? 0 : (Math.abs(netDelta) / stats.emittedOld) * 100;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ...stats,
          netDelta,
          netDeltaPctOfOld: Number(pctOfOld.toFixed(4)),
          elapsedMs,
          source: args.source,
          fileLimit: args.limit,
          pipelineNote:
            "emittedOld/emittedNew reproduce session-indexer's full decision tree " +
            "(length + isNoise + truncate). Drops are counted only when OLD emits " +
            "and NEW does not, so they reflect actual future-rebuild emit loss.",
          manifestNote:
            "Manifest is mtime/size based. Incremental sync alone will NOT apply " +
            "historical sanitizer changes to chunks already in the DB; the " +
            "filesWithImpact figure is a theoretical impact estimate for a future " +
            "full rebuild (separate GLG-approved step), not an auto-trigger count.",
          changedInEmitNote:
            "changedInEmit counts only chunks that BOTH pipelines emit but whose " +
            "stored text differs. It is dominated by leading-whitespace trim and " +
            "should NOT be read as a search-quality improvement signal.",
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("\n=== sanitize dry-run ===");
  console.log(`  source:           ${args.source}`);
  console.log(`  files scanned:    ${stats.filesScanned}`);
  console.log(`  files w/ impact:  ${stats.filesWithImpact}  (theoretical full-rebuild affected)`);
  console.log(`  files w/ error:   ${stats.filesWithError}`);
  console.log(`  total messages:   ${stats.totalMessages}`);
  console.log(`  emitted (old):    ${stats.emittedOld}`);
  console.log(`  emitted (new):    ${stats.emittedNew}`);
  console.log(
    `  net delta:        ${netDelta >= 0 ? "+" : ""}${netDelta}  (${pctOfOld.toFixed(2)}% of old emit)`,
  );
  console.log(`  new drops:        ${stats.newDrops}  (OLD emitted, NEW skipped)`);
  console.log(`  newly emitted:    ${stats.newlyEmitted}  (NEW emits what OLD skipped)`);
  console.log(`  changed in emit:  ${stats.changedInEmit}  (both emit, stored text differs)`);
  console.log(`     ↳ NOTE: changed-in-emit is dominated by leading-whitespace trim,`);
  console.log(`             not envelope strip. Do not read this as a search-quality`);
  console.log(`             improvement signal — it is mostly cosmetic body shrink.`);
  console.log(`  elapsed:          ${(elapsedMs / 1000).toFixed(2)}s`);

  console.log(`\n  new drop reasons:`);
  const reasons = Object.entries(stats.newDropReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) {
    console.log(`    (none)`);
  } else {
    for (const [reason, count] of reasons) {
      console.log(`    ${reason.padEnd(34)} ${count}`);
    }
  }

  console.log(`\n  !! Manifest is mtime/size based (not content-hash).`);
  console.log(`     Editing session-sanitize.ts does NOT change JSONL mtime/size,`);
  console.log(`     so incremental sync alone will NOT apply historical sanitizer`);
  console.log(`     changes to chunks already in the DB. Apply to historical data`);
  console.log(`     requires a full sessions rebuild (separate GLG-approved step).`);
  console.log(`     The 'files w/ impact' number above is a theoretical estimate`);
  console.log(`     for that future rebuild, not an auto-trigger count.`);

  const renderSamples = (label: string, samples: Sample[]): void => {
    console.log(`\n  --- ${label} (n=${samples.length}) ---`);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const tag = `[${s.source}/${s.role}]`;
      const where = `${s.sessionFile.split("/").pop()}:${s.lineNumber}`;
      console.log(`\n  ${label} #${i + 1} ${tag} ${where}${s.reason ? "  reason=" + s.reason : ""}`);
      console.log(`    BEFORE: ${JSON.stringify(s.before).slice(0, 360)}`);
      if (s.after !== undefined) {
        console.log(`    AFTER:  ${JSON.stringify(s.after).slice(0, 360)}`);
      }
    }
  };
  renderSamples("DROP", stats.samples.drops);
  renderSamples("CHANGE_IN_EMIT", stats.samples.changes);
  renderSamples("NEWLY_EMITTED", stats.samples.additions);
  console.log("");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
