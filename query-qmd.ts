#!/usr/bin/env npx tsx
/**
 * qmd query wrapper — Stage 3 of issue #1 (minimal experimental surface).
 *
 * Thin wrapper around `qmd query`. Default invocation runs qmd via execSync
 * and parses the JSON result; the underlying execution function is
 * injectable so tests can assert command shape without requiring qmd
 * installed.
 *
 * Boundary: zero imports from cli/store/retriever/embedding-provider/
 * session-indexer/write-buffer/lancedb. The point of this module is to
 * route queries to a black-box retrieval engine, not to participate in
 * the existing andenken search stack.
 *
 * The exact qmd CLI surface is treated as best-effort guess from issue #1
 * body; until validated against a real qmd install, callers should pass
 * --extra-args to inject any flag tweaks.
 *
 * Usage:
 *   pnpm exec tsx query-qmd.ts "체화인지" --collection garden-notes --limit 5
 *   pnpm exec tsx query-qmd.ts "..." --collection-prefix garden
 *                              --collections notes,bib
 */

import { execSync } from "node:child_process";
import * as path from "node:path";

export interface QueryOptions {
  query: string;
  collections: string[]; // already-resolved collection names (no qmd:// prefix here)
  limit: number;
  qmdBin: string;
  extraArgs: string[];
}

export interface QmdHit {
  // Best-effort shape; whatever qmd emits beyond these fields is preserved
  // verbatim under raw.
  path?: string;
  title?: string;
  score?: number;
  snippet?: string;
  raw: Record<string, unknown>;
}

export interface QmdQueryResult {
  query: string;
  collection: string | null;
  hits: QmdHit[];
  rawStdout: string;
  command: string;
}

export type ExecFn = (cmd: string) => string;

const defaultExec: ExecFn = (cmd) =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function shellQuote(arg: string): string {
  if (/^[\w./@:+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildQueryCommand(
  collection: string | null,
  opts: Pick<QueryOptions, "query" | "limit" | "qmdBin" | "extraArgs">,
): string {
  const tokens: string[] = [];
  tokens.push(opts.qmdBin);
  tokens.push("query");
  if (collection) tokens.push("--collection", `qmd://${collection}`);
  tokens.push("--limit", String(opts.limit));
  tokens.push("--json");
  for (const extra of opts.extraArgs) tokens.push(extra);
  tokens.push(opts.query);
  return tokens.map(shellQuote).join(" ");
}

function parseHits(stdout: string): QmdHit[] {
  // qmd's exact JSON shape is not pinned; try a few common shapes
  // (top-level array, {results: [...]}, {hits: [...]}, etc.) and degrade
  // gracefully so the wrapper is useful even before pinning the contract.
  let obj: unknown;
  try {
    obj = JSON.parse(stdout);
  } catch {
    return [];
  }
  let arr: unknown[] | undefined;
  if (Array.isArray(obj)) arr = obj;
  else if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.results)) arr = o.results;
    else if (Array.isArray(o.hits)) arr = o.hits;
    else if (Array.isArray(o.matches)) arr = o.matches;
  }
  if (!arr) return [];
  return arr.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      path: typeof e.path === "string" ? e.path : undefined,
      title: typeof e.title === "string" ? e.title : undefined,
      score:
        typeof e.score === "number"
          ? e.score
          : typeof e.rank === "number"
            ? e.rank
            : undefined,
      snippet:
        typeof e.snippet === "string"
          ? e.snippet
          : typeof e.preview === "string"
            ? e.preview
            : undefined,
      raw: e,
    };
  });
}

export function runQmdQuery(
  opts: QueryOptions,
  exec: ExecFn = defaultExec,
): QmdQueryResult[] {
  // Per-collection invocation so the caller sees results bucketed by
  // collection. If no collections specified, run once with no --collection
  // flag (qmd's default scope).
  const buckets = opts.collections.length > 0 ? opts.collections : [null];
  const results: QmdQueryResult[] = [];
  for (const coll of buckets) {
    const command = buildQueryCommand(coll, {
      query: opts.query,
      limit: opts.limit,
      qmdBin: opts.qmdBin,
      extraArgs: opts.extraArgs,
    });
    let rawStdout = "";
    try {
      rawStdout = exec(command);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        query: opts.query,
        collection: coll,
        hits: [],
        rawStdout: `ERROR: ${msg}`,
        command,
      });
      continue;
    }
    results.push({
      query: opts.query,
      collection: coll,
      hits: parseHits(rawStdout),
      rawStdout,
      command,
    });
  }
  return results;
}

interface CliArgs extends QueryOptions {
  collectionPrefix: string;
  collectionsBare: string[]; // pre-prefix folder list, for ergonomics
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    query: "",
    collections: [],
    collectionsBare: [],
    collectionPrefix: "garden",
    limit: 5,
    qmdBin: process.env.ANDENKEN_QMD_BIN ?? "qmd",
    extraArgs: [],
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--collection":
        out.collections.push(requireValue(argv, ++i, a));
        break;
      case "--collections":
        out.collectionsBare = requireValue(argv, ++i, a)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--collection-prefix":
        out.collectionPrefix = requireValue(argv, ++i, a);
        break;
      case "--limit":
        out.limit = parseInt(requireValue(argv, ++i, a), 10);
        break;
      case "--qmd-bin":
        out.qmdBin = requireValue(argv, ++i, a);
        break;
      case "--":
        out.extraArgs = argv.slice(i + 1);
        i = argv.length;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("--")) {
          console.error(`unknown arg: ${a}`);
          printHelp();
          process.exit(1);
        }
        positional.push(a);
    }
  }
  out.query = positional.join(" ");
  if (!out.query) {
    console.error("missing query");
    printHelp();
    process.exit(1);
  }
  // Resolve --collections (bare folder names) using prefix.
  for (const bare of out.collectionsBare) {
    out.collections.push(`${out.collectionPrefix}-${bare}`);
  }
  return out;
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
  console.log(`andenken qmd query — thin wrapper over \`qmd query\`

Usage: pnpm exec tsx query-qmd.ts <query> [flags]

Flags:
  --collection NAME             Resolved qmd collection name (repeatable)
  --collections a,b,c           Bare folder names; combined with prefix
  --collection-prefix STR       Prefix for --collections (default: garden)
  --limit N                     Top-K (default: 5)
  --qmd-bin PATH                qmd executable
  --                            Pass remaining args directly to qmd

Examples:
  query-qmd.ts "체화인지" --collections notes,bib --limit 5
  query-qmd.ts "..." --collection garden-notes
`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const results = runQmdQuery(opts);
  console.log(JSON.stringify({ query: opts.query, results }, null, 2));
}

const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  return invoked.endsWith("query-qmd.ts") || invoked.endsWith("query-qmd.js");
})();

if (isDirectInvocation) {
  main();
}
