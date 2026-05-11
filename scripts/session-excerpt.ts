#!/usr/bin/env tsx
/**
 * session-excerpt CLI — C2.1a read-only excerpt around a search hit.
 *
 * Reads a session JSONL file, renders the surrounding user/assistant flow
 * for a given centerLine. API 0. DB 0. Network 0.
 *
 * Usage:
 *   pnpm exec tsx scripts/session-excerpt.ts <sessionFile> <line> \
 *     [--before N --after N --max N --no-tool --no-session --json]
 */

import { readSessionExcerpt, type ExcerptOptions } from "../session-excerpt.ts";

interface CliArgs {
  sessionFile: string;
  centerLine: number;
  json: boolean;
  options: ExcerptOptions;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 2) {
    throw new Error(
      "usage: session-excerpt <sessionFile> <line> [--before N --after N --max N --no-tool --no-session --json]",
    );
  }
  const sessionFile = argv[0]!;
  const centerLine = Number(argv[1]);
  if (!Number.isInteger(centerLine) || centerLine < 1) {
    throw new Error(`<line> must be a positive integer, got: ${argv[1]}`);
  }

  const args: CliArgs = {
    sessionFile,
    centerLine,
    json: false,
    options: {},
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--before") {
      args.options.beforeLines = Number(argv[++i]);
      if (!Number.isFinite(args.options.beforeLines) || args.options.beforeLines < 0) {
        throw new Error("--before must be non-negative int");
      }
    } else if (a === "--after") {
      args.options.afterLines = Number(argv[++i]);
      if (!Number.isFinite(args.options.afterLines) || args.options.afterLines < 0) {
        throw new Error("--after must be non-negative int");
      }
    } else if (a === "--max") {
      args.options.maxChars = Number(argv[++i]);
      if (!Number.isFinite(args.options.maxChars) || args.options.maxChars < 100) {
        throw new Error("--max must be int >= 100");
      }
    } else if (a === "--no-tool") {
      args.options.includeToolResults = false;
    } else if (a === "--no-session") {
      args.options.includeSessionMessages = false;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      console.error(
        "usage: session-excerpt <sessionFile> <line> [--before N --after N --max N --no-tool --no-session --json]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ex = await readSessionExcerpt(args.sessionFile, args.centerLine, args.options);

  // CLI-only bounds enforcement: readSessionExcerpt itself silently returns an
  // empty window when centerLine is past EOF, so callers like other scripts
  // can probe without throwing. For an interactive CLI we want a hard error.
  if (ex.totalLines === 0) {
    throw new Error(`session file is empty: ${args.sessionFile}`);
  }
  if (args.centerLine > ex.totalLines) {
    throw new Error(
      `centerLine ${args.centerLine} out of file bounds (file has ${ex.totalLines} line(s))`,
    );
  }

  if (args.json) {
    console.log(JSON.stringify(ex, null, 2));
    return;
  }

  const fileShort = ex.sessionFile.split("/").slice(-2).join("/");
  console.log(`=== excerpt ${fileShort}:${ex.centerLine} ===`);
  console.log(
    `  project=${ex.project}  source=${ex.source}  range=L${ex.startLine}-L${ex.endLine}`,
  );
  console.log(
    `  truncated=${ex.truncated}  totalCharsBefore=${ex.totalCharsBeforeTruncation}  rendered=${ex.text.length}`,
  );

  const skipKeys = Object.keys(ex.skippedCounts);
  if (skipKeys.length > 0) {
    const summary = skipKeys
      .map((k) => `${k}=${ex.skippedCounts[k]}`)
      .join(" ");
    console.log(`  skipped: ${summary}`);
  }
  console.log("");
  console.log(ex.text);

  if (ex.truncated) {
    const droppedCount = ex.lines.filter((l) => l.truncated).length;
    console.log(`\n[note] ${droppedCount} line(s) dropped by maxChars (center preserved)`);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
