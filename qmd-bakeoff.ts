#!/usr/bin/env npx tsx
/**
 * qmd vs andenken minimal bake-off — Stage 3 of issue #1.
 *
 * Goal: open the smallest possible experimental surface for comparing the
 * existing andenken search-knowledge path with a qmd-backed retrieval over
 * the memory-md export from Stage 1. Not a quality scorer — a side-by-side
 * top-K printer so a human can read both columns and judge.
 *
 * Boundary: this module does NOT import retriever/store/embedding-provider.
 * It shells out to the existing andenken CLI for the andenken column and
 * to query-qmd's lib for the qmd column. That preserves Stage 1's seam:
 * the bake-off is an external orchestrator, not a participant in the
 * search stack.
 *
 * Sanity queries are hardcoded inline (3-5 of them). The full
 * golden-queries.ts harness can be wired in later — for now the goal is
 * "minimal experimental surface", per the user's framing.
 *
 * Usage:
 *   pnpm exec tsx qmd-bakeoff.ts                         # run all probes
 *   pnpm exec tsx qmd-bakeoff.ts --query "체화인지"       # single query
 *   pnpm exec tsx qmd-bakeoff.ts --json                   # machine-readable
 *   pnpm exec tsx qmd-bakeoff.ts --skip-andenken          # qmd only
 *   pnpm exec tsx qmd-bakeoff.ts --skip-qmd               # andenken only
 */

import * as path from "node:path";
import { execSync } from "node:child_process";
import { runQmdQuery, type ExecFn } from "./query-qmd.js";

interface BakeoffOptions {
  query?: string; // single-query override
  limit: number;
  qmdBin: string;
  collectionPrefix: string;
  collections: string[]; // bare folder names
  json: boolean;
  skipAndenken: boolean;
  skipQmd: boolean;
  scriptDir: string;
}

interface SanityProbe {
  query: string;
  reason: string;
}

// Minimal sanity probes. Picked to span: Korean concept retrieval, English
// technical, mixed-script. Easy to expand to GOLDEN_QUERIES later.
const SANITY_PROBES: SanityProbe[] = [
  { query: "체화인지 embodied cognition", reason: "ko + en concept anchor" },
  { query: "NixOS GPU cluster setup", reason: "operational recovery (en)" },
  { query: "andenken memory axis", reason: "self-referential meta query" },
];

interface ColumnResult {
  backend: "andenken" | "qmd";
  query: string;
  ok: boolean;
  hits: Array<{ score?: number; title?: string; snippet?: string; raw?: unknown }>;
  errMsg?: string;
}

function runAndenkenSearch(
  scriptDir: string,
  query: string,
  limit: number,
  exec: ExecFn,
): ColumnResult {
  // Shell out to ./run.sh knowledge so this module never imports cli.ts /
  // retriever.ts / store.ts / embedding-provider.ts. The cost is one extra
  // tsx process per probe; acceptable for a sanity bake-off.
  const cmd = `cd ${shellQuote(scriptDir)} && pnpm exec tsx cli.ts search-knowledge ${shellQuote(query)} --limit ${limit}`;
  let stdout = "";
  try {
    stdout = exec(cmd);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { backend: "andenken", query, ok: false, hits: [], errMsg: msg };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      backend: "andenken",
      query,
      ok: false,
      hits: [],
      errMsg: `non-JSON output: ${stdout.slice(0, 120)}`,
    };
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const arr = Array.isArray(obj.results) ? obj.results : [];
  const hits = arr.slice(0, limit).map((r) => {
    const item = (r ?? {}) as Record<string, unknown>;
    return {
      score: typeof item.score === "number" ? item.score : undefined,
      title:
        typeof item.title === "string"
          ? item.title
          : typeof item.project === "string"
            ? item.project
            : undefined,
      snippet:
        typeof item.text === "string"
          ? item.text.slice(0, 200)
          : typeof item.preview === "string"
            ? item.preview
            : undefined,
      raw: item,
    };
  });
  return { backend: "andenken", query, ok: true, hits };
}

function runQmd(
  query: string,
  limit: number,
  qmdBin: string,
  collections: string[],
  exec: ExecFn,
): ColumnResult {
  try {
    const queries = runQmdQuery(
      {
        query,
        collections,
        limit,
        qmdBin,
        extraArgs: [],
      },
      exec,
    );
    // Flatten per-collection results for column display.
    const merged = queries.flatMap((q) => q.hits);
    const errMatch = queries.find((q) => q.rawStdout.startsWith("ERROR:"));
    if (errMatch) {
      return {
        backend: "qmd",
        query,
        ok: false,
        hits: [],
        errMsg: errMatch.rawStdout,
      };
    }
    return {
      backend: "qmd",
      query,
      ok: true,
      hits: merged.slice(0, limit).map((h) => ({
        score: h.score,
        title: h.title ?? h.path,
        snippet: h.snippet,
        raw: h.raw,
      })),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { backend: "qmd", query, ok: false, hits: [], errMsg: msg };
  }
}

interface ProbeResult {
  query: string;
  reason: string;
  andenken?: ColumnResult;
  qmd?: ColumnResult;
}

export function runBakeoff(
  opts: BakeoffOptions,
  exec: ExecFn = (cmd) =>
    execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
): ProbeResult[] {
  const probes: SanityProbe[] = opts.query
    ? [{ query: opts.query, reason: "user-supplied" }]
    : SANITY_PROBES;
  const collections = opts.collections.map(
    (b) => `${opts.collectionPrefix}-${b}`,
  );
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const r: ProbeResult = { query: probe.query, reason: probe.reason };
    if (!opts.skipAndenken) {
      r.andenken = runAndenkenSearch(opts.scriptDir, probe.query, opts.limit, exec);
    }
    if (!opts.skipQmd) {
      r.qmd = runQmd(
        probe.query,
        opts.limit,
        opts.qmdBin,
        opts.collections.length > 0 ? collections : [],
        exec,
      );
    }
    results.push(r);
  }
  return results;
}

function formatTable(results: ProbeResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push("");
    lines.push(`## query: ${r.query}`);
    lines.push(`   reason: ${r.reason}`);
    lines.push("");
    if (r.andenken) {
      lines.push(`andenken (${r.andenken.ok ? "ok" : "ERR: " + r.andenken.errMsg})`);
      for (const [i, h] of r.andenken.hits.entries()) {
        const sc = h.score?.toFixed(3) ?? "—";
        const ti = h.title ?? "(no title)";
        const sn = h.snippet?.replace(/\s+/g, " ").slice(0, 100) ?? "";
        lines.push(`  ${i + 1}. [${sc}] ${ti}`);
        if (sn) lines.push(`       ${sn}`);
      }
    }
    if (r.qmd) {
      lines.push(`qmd      (${r.qmd.ok ? "ok" : "ERR: " + r.qmd.errMsg})`);
      for (const [i, h] of r.qmd.hits.entries()) {
        const sc = h.score?.toFixed(3) ?? "—";
        const ti = h.title ?? "(no title)";
        const sn = h.snippet?.replace(/\s+/g, " ").slice(0, 100) ?? "";
        lines.push(`  ${i + 1}. [${sc}] ${ti}`);
        if (sn) lines.push(`       ${sn}`);
      }
    }
  }
  return lines.join("\n");
}

function shellQuote(arg: string): string {
  if (/^[\w./@:+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function parseArgs(argv: string[]): BakeoffOptions {
  // Default scriptDir is the directory containing this file (handles both
  // tsx-run from repo root and compiled-run from dist/).
  const scriptDir = path.dirname(
    path.resolve(process.argv[1] ?? __filename ?? "."),
  );
  const opts: BakeoffOptions = {
    limit: 5,
    qmdBin: process.env.ANDENKEN_QMD_BIN ?? "qmd",
    collectionPrefix: "garden",
    collections: ["notes", "meta", "bib", "journal", "botlog"],
    json: false,
    skipAndenken: false,
    skipQmd: false,
    scriptDir,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--query":
        opts.query = requireValue(argv, ++i, a);
        break;
      case "--limit":
        opts.limit = parseInt(requireValue(argv, ++i, a), 10);
        break;
      case "--qmd-bin":
        opts.qmdBin = requireValue(argv, ++i, a);
        break;
      case "--collection-prefix":
        opts.collectionPrefix = requireValue(argv, ++i, a);
        break;
      case "--collections":
        opts.collections = requireValue(argv, ++i, a)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--skip-andenken":
        opts.skipAndenken = true;
        break;
      case "--skip-qmd":
        opts.skipQmd = true;
        break;
      case "--script-dir":
        opts.scriptDir = requireValue(argv, ++i, a);
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
  console.log(`andenken qmd bake-off — side-by-side andenken vs qmd

Usage: pnpm exec tsx qmd-bakeoff.ts [flags]

Flags:
  --query "..."             Single query (overrides built-in probes)
  --limit N                 Top-K per backend (default: 5)
  --qmd-bin PATH            qmd executable
  --collection-prefix STR   Prefix for qmd collections (default: garden)
  --collections a,b,c       Bare folder names (default: all five)
  --json                    Machine-readable output
  --skip-andenken           Run qmd column only
  --skip-qmd                Run andenken column only
  --script-dir DIR          andenken repo dir (default: this file's dir)

The andenken column shells out to ./cli.ts search-knowledge so this
module never imports the existing search stack.
`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const results = runBakeoff(opts);
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatTable(results));
  }
}

export { parseArgs, formatTable, type BakeoffOptions, type ProbeResult };

const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  return invoked.endsWith("qmd-bakeoff.ts") || invoked.endsWith("qmd-bakeoff.js");
})();

if (isDirectInvocation) {
  main();
}
