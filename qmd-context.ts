#!/usr/bin/env npx tsx
/**
 * qmd bootstrap helper — Stage 2 of issue #1.
 *
 * Translates andenken's memory-md folder layout into qmd's CLI vocabulary:
 *   - one qmd collection per INDEXABLE_ORG_FOLDER
 *   - one qmd context per collection (default blurbs from issue #1 body)
 *
 * Default mode is print: emit shell-quoted command lines to stdout so the
 * user can inspect, edit, or pipe into a shell. --execute opts in to
 * running them via execSync. This matches Stage 1's offline-pure ethos —
 * the script has zero hard dependency on qmd being installed.
 *
 * Boundary: zero imports from cli/store/retriever/embedding-provider/
 * session-indexer/write-buffer/lancedb. Org-chunker is the single policy
 * source, used only for INDEXABLE_ORG_FOLDERS.
 *
 * Usage:
 *   pnpm exec tsx qmd-context.ts                    # print commands only
 *   pnpm exec tsx qmd-context.ts --execute          # actually run them
 *   pnpm exec tsx qmd-context.ts --collection-prefix garden
 */

import * as path from "node:path";
import { execSync } from "node:child_process";
import { INDEXABLE_ORG_FOLDERS } from "./org-chunker.js";

export interface BootstrapOptions {
  cacheDir: string;
  collectionPrefix: string;
  qmdBin: string;
  execute: boolean;
}

export interface QmdCommand {
  kind: "collection" | "context";
  folder: string;
  args: string[]; // tokens passed to qmd
}

// Defaults from issue #1 body. Operator can edit context blurbs after
// running once with --execute, or pre-edit via env / future flag.
const DEFAULT_CONTEXT_BLURBS: Record<string, string> = {
  meta: "힣의 디지털가든 meta notes. Concepts, tags, structural anchors, authology vocabulary.",
  bib: "Bibliographic and person/book anchors in 힣's garden. Authors, works, intellectual lineages.",
  notes: "힣의 디지털가든 notes. Mid-axis personal knowledge entries.",
  journal: "Time-axis journal notes. Daily and weekly raw traces, post-2025 stable journal structure.",
  botlog: "Public agent collaboration logs and architecture reflections.",
};

export function buildBootstrapCommands(opts: BootstrapOptions): QmdCommand[] {
  const cmds: QmdCommand[] = [];
  // Iterate folders in a stable order so print output is deterministic.
  const folders = Array.from(INDEXABLE_ORG_FOLDERS).sort();
  for (const folder of folders) {
    const collectionPath = path.join(opts.cacheDir, folder);
    const collectionName = `${opts.collectionPrefix}-${folder}`;
    cmds.push({
      kind: "collection",
      folder,
      args: ["collection", "add", collectionPath, "--name", collectionName],
    });
    const blurb =
      DEFAULT_CONTEXT_BLURBS[folder] ?? `${folder} memory-md surface from andenken export.`;
    cmds.push({
      kind: "context",
      folder,
      args: ["context", "add", `qmd://${collectionName}`, blurb],
    });
  }
  return cmds;
}

export function shellQuote(arg: string): string {
  // Single-quote-wrap unless arg is already shell-safe alnum + path chars.
  if (/^[\w./@:+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function commandToShellString(qmdBin: string, cmd: QmdCommand): string {
  const tokens = cmd.args.map(shellQuote);
  return `${qmdBin} ${tokens.join(" ")}`;
}

function executeCommands(
  qmdBin: string,
  cmds: QmdCommand[],
  exec: (line: string) => void,
): void {
  for (const cmd of cmds) {
    const line = commandToShellString(qmdBin, cmd);
    console.log(`exec: ${line}`);
    exec(line);
  }
}

function parseArgs(argv: string[]): BootstrapOptions {
  const opts: BootstrapOptions = {
    cacheDir: path.join(process.env.HOME ?? "", ".cache", "andenken-qmd"),
    collectionPrefix: "garden",
    qmdBin: process.env.ANDENKEN_QMD_BIN ?? "qmd",
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--cache-dir":
        opts.cacheDir = requireValue(argv, ++i, a);
        break;
      case "--collection-prefix":
        opts.collectionPrefix = requireValue(argv, ++i, a);
        break;
      case "--qmd-bin":
        opts.qmdBin = requireValue(argv, ++i, a);
        break;
      case "--execute":
        opts.execute = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`unknown arg: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (!v || v.startsWith("--")) {
    console.error(`missing value for ${flag}`);
    process.exit(1);
  }
  return v;
}

function printHelp(): void {
  console.log(`andenken qmd bootstrap — register memory-md tree with qmd

Usage: pnpm exec tsx qmd-context.ts [flags]

Flags:
  --cache-dir DIR          Memory-md root (default: ~/.cache/andenken-qmd)
  --collection-prefix STR  Prefix for qmd collection names (default: garden)
  --qmd-bin PATH           qmd executable (default: qmd; env ANDENKEN_QMD_BIN)
  --execute                Actually run commands (default: print only)

Without --execute, this prints shell-quoted lines to stdout. Pipe into
\`sh -x\` if you trust them. With --execute, runs each via execSync.
`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const cmds = buildBootstrapCommands(opts);
  if (opts.execute) {
    executeCommands(opts.qmdBin, cmds, (line) => {
      execSync(line, { stdio: "inherit" });
    });
  } else {
    for (const cmd of cmds) {
      console.log(commandToShellString(opts.qmdBin, cmd));
    }
  }
}

const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  return invoked.endsWith("qmd-context.ts") || invoked.endsWith("qmd-context.js");
})();

if (isDirectInvocation) {
  main();
}
