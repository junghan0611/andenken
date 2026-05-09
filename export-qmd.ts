#!/usr/bin/env npx tsx
/**
 * memory-md export — Stage 1 of issue #1.
 *
 * Walk org notes that pass shouldIndexOrgFile(), reuse chunkOrgFile()'s
 * exclusion-applied output, and serialize one markdown file per org note into
 *   ${out}/<folder>/<denote-id>.md
 *
 * Stage 1 invariants (do not break):
 * - No imports from embedding-provider / store / retriever / write-buffer /
 *   gemini-embeddings / lancedb. Export is offline; that boundary is the whole
 *   point of issue #1's repositioning.
 * - All policy comes from org-chunker.ts. We do not re-implement journal
 *   cutoff or exclusion-tag walking here.
 * - Idempotent full rewrite + sweep. No manifest. The on-disk tree must equal
 *   a deterministic function of (org corpus, flags) on every run.
 *
 * Usage:
 *   pnpm exec tsx export-qmd.ts [--out DIR] [--org-dir DIR] [--public-url-base URL]
 *                               [--dry-run] [--verbose] [--force]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  chunkOrgFile,
  findOrgFiles,
  shouldIndexOrgFile,
  INDEXABLE_ORG_FOLDERS,
  type OrgChunk,
} from "./org-chunker.js";
import { renderNoteFile } from "./export-qmd-template.js";

interface CliOptions {
  out: string;
  orgDir?: string;
  publicUrlBase?: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    out: defaultOutDir(),
    dryRun: false,
    verbose: false,
    publicUrlBase: process.env.ANDENKEN_PUBLIC_URL_BASE,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out":
        opts.out = requireValue(argv, ++i, a);
        break;
      case "--org-dir":
        opts.orgDir = requireValue(argv, ++i, a);
        break;
      case "--public-url-base":
        opts.publicUrlBase = requireValue(argv, ++i, a);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--force":
        // Reserved no-op: rewrite is always idempotent in v1. Accepted so
        // scripts can pass it without failing once incremental mode lands.
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

function defaultOutDir(): string {
  return path.join(process.env.HOME ?? "", ".cache", "andenken-qmd");
}

function printHelp(): void {
  console.log(`andenken export-qmd — org → memory-md

Usage: pnpm exec tsx export-qmd.ts [flags]

Flags:
  --out DIR              Output root (default: ~/.cache/andenken-qmd)
  --org-dir DIR          Org source root (default: ~/sync/org)
  --public-url-base URL  Render Public URL line as URL/<folder>/<denote-id>
                         (also reads ANDENKEN_PUBLIC_URL_BASE env)
  --dry-run              Plan only — no writes, no deletes
  --verbose              Per-file logging
  --force                Reserved no-op (rewrite is always idempotent in v1)
`);
}

/**
 * Sweep safety: only delete inside the configured out root, only at the
 * <out>/<folder>/<name>.md depth, where folder is in INDEXABLE_ORG_FOLDERS.
 * Never follow symlinks, never recurse outside.
 */
function rejectUnsafeOut(out: string): void {
  const resolved = path.resolve(out);
  const home = path.resolve(process.env.HOME ?? "");
  if (resolved === "/" || (home && resolved === home)) {
    console.error(`refusing --out=${out}: resolves to ${resolved}`);
    process.exit(2);
  }
}

function sweepStaleFiles(
  outRoot: string,
  expected: Set<string>,
  dryRun: boolean,
  verbose: boolean,
): number {
  let removed = 0;
  for (const folder of INDEXABLE_ORG_FOLDERS) {
    const folderPath = path.join(outRoot, folder);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch {
      continue; // folder may not exist yet
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const full = path.join(folderPath, entry.name);
      if (expected.has(full)) continue;
      if (verbose) console.log(`sweep: ${full}`);
      if (!dryRun) fs.unlinkSync(full);
      removed++;
    }
  }
  return removed;
}

interface ExportResult {
  wrote: number;
  skippedZeroChunk: number;
  removedStale: number;
  expected: number;
  collisions: number;
}

function buildOutPath(
  outRoot: string,
  folder: string,
  identifier: string,
  expected: Set<string>,
): { path: string; collided: boolean } {
  const base = path.join(outRoot, folder, `${identifier}.md`);
  if (!expected.has(base)) return { path: base, collided: false };

  // Denote IDs are unique by construction; this guard exists so a stray
  // collision (e.g. two folders ever sharing an identifier) keeps both files
  // instead of silently overwriting.
  let i = 2;
  while (true) {
    const alt = path.join(outRoot, folder, `${identifier}-collision-${i}.md`);
    if (!expected.has(alt)) return { path: alt, collided: true };
    i++;
  }
}

function exportOrgToQmd(opts: CliOptions): ExportResult {
  rejectUnsafeOut(opts.out);

  const files = findOrgFiles(opts.orgDir).filter(shouldIndexOrgFile);
  const expected = new Set<string>();
  let wrote = 0;
  let skippedZeroChunk = 0;
  let collisions = 0;

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`read failed: ${file}: ${msg}`);
      continue;
    }

    let chunks: OrgChunk[];
    try {
      chunks = chunkOrgFile(content, file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`chunk failed: ${file}: ${msg}`);
      continue;
    }

    if (chunks.length === 0) {
      skippedZeroChunk++;
      if (opts.verbose) console.log(`skip (zero-chunk): ${file}`);
      continue;
    }

    const contentChunks = chunks.filter((c) => c.chunkType === "content");
    if (contentChunks.length === 0) {
      // Heading-only file: chunker produced structural chunks but no body.
      // memory-md is a body-oriented surface; emit nothing.
      skippedZeroChunk++;
      if (opts.verbose) console.log(`skip (heading-only): ${file}`);
      continue;
    }

    const metadata = chunks[0].metadata;
    const { path: outPath, collided } = buildOutPath(
      opts.out,
      metadata.folder,
      metadata.identifier,
      expected,
    );
    if (collided) {
      collisions++;
      console.warn(
        `denote-id collision in folder=${metadata.folder} id=${metadata.identifier}: ${file} → ${outPath}`,
      );
    }
    expected.add(outPath);

    const body = renderNoteFile(metadata, contentChunks, file, {
      publicUrlBase: opts.publicUrlBase,
    });

    if (opts.verbose) console.log(`write: ${outPath}`);
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, body);
    }
    wrote++;
  }

  const removedStale = sweepStaleFiles(opts.out, expected, opts.dryRun, opts.verbose);

  return { wrote, skippedZeroChunk, removedStale, expected: expected.size, collisions };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const r = exportOrgToQmd(opts);
  const dryTag = opts.dryRun ? " (dry-run)" : "";
  console.log(
    JSON.stringify({
      out: opts.out,
      wrote: r.wrote,
      skippedZeroChunk: r.skippedZeroChunk,
      removedStale: r.removedStale,
      expected: r.expected,
      collisions: r.collisions,
      dryRun: opts.dryRun,
    }),
  );
  if (opts.verbose) {
    console.log(
      `done${dryTag}: wrote=${r.wrote} skipped=${r.skippedZeroChunk} removed=${r.removedStale} expected=${r.expected}`,
    );
  }
}

export { exportOrgToQmd, parseArgs, type CliOptions, type ExportResult };

// Run when invoked directly via tsx (not when imported by tests).
const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  // Match either the .ts source (tsx) or the compiled .js (dist/) entry.
  return invoked.endsWith("export-qmd.ts") || invoked.endsWith("export-qmd.js");
})();

if (isDirectInvocation) {
  main();
}
