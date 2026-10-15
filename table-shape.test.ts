#!/usr/bin/env tsx
/**
 * Report vocabulary for a table's shape (table-shape.ts, issue #16).
 *
 * API 0. No optimize is run: OptimizeStats are mocked, and `table.stats()` is
 * read from one synthetic temp table.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { VectorStore } from "./store.ts";
import { countDataFiles, formatBytes, formatOptimizeStats, formatShape, readLogicalShape } from "./table-shape.ts";

let passed = 0;
let failed = 0;
function eq<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-table-shape-"));
fs.chmodSync(tmp, 0o700);

const prevUmask = process.umask(0o077);
try {
  console.log("\n# mocked measures");
  {
    const stats = {
      totalBytes: 0,
      numRows: 107656,
      numIndices: 1,
      fragmentStats: { numFragments: 25, numSmallFragments: 24, lengths: { min: 1, max: 9, mean: 4, p25: 2, p50: 4, p75: 6, p99: 9 } },
    };
    const shape = await readLogicalShape({ stats: async () => stats });
    eq(shape, { rows: 107656, fragments: 25, smallFragments: 24, manifestBytes: 0, indices: 1 }, "table.stats() maps to logical fragments, small fragments, rows and manifest bytes");
    eq(
      formatShape(shape, 358, "4.7G"),
      "logical: 25 fragments (24 small), 107,656 rows, manifest-reported 0 B | physical: 358 data files, du 4.7G",
      "logical and physical are printed apart; manifest-reported 0 B stands beside du, not instead of it",
    );
    eq(await readLogicalShape({ stats: async () => { throw new Error("native"); } }), null, "an unreadable stats() is null, not zeros");
    eq(formatShape(null, null, null), "logical: unknown | physical: unknown data files, du unknown", "every unmeasured value prints as unknown");
    eq(countDataFiles(path.join(tmp, "missing.lance")), null, "a data directory that cannot be listed is unknown, not 0");
    eq([formatBytes(0), formatBytes(1536), formatBytes(5 * 1024 ** 3)], ["0 B", "1.5 KiB", "5.0 GiB"], "byte formatting");

    const optimize = { compaction: { fragmentsRemoved: 24, fragmentsAdded: 1, filesRemoved: 30, filesAdded: 2 }, prune: { bytesRemoved: 1024 ** 3, oldVersionsRemoved: 7 } };
    eq(
      formatOptimizeStats(optimize, 12_345),
      "optimize (12.3s): fragments -24/+1, data files -30/+2; pruned 7 old versions, 1.0 GiB",
      "OptimizeStats reports what one call compacted and pruned, with its wall time",
    );
    eq(formatOptimizeStats(undefined, 600_000), "optimize (600.0s): stats unknown", "missing OptimizeStats print as unknown, never as zeros");
    eq(formatOptimizeStats({ compaction: undefined } as never, 1000), "optimize (1.0s): stats unknown", "an OptimizeStats with neither part is unknown");

    // Partial measures: each missing field is unknown on its own, never undefined/NaN.
    const partial = await readLogicalShape({ stats: async () => ({ numRows: 5 }) as never });
    eq(partial, { rows: 5, fragments: null, smallFragments: null, manifestBytes: null, indices: null }, "a partial stats() keeps what it has and marks the rest unmeasured");
    const partialLine = formatShape(partial, 3, "1M");
    eq(partialLine, "logical: unknown fragments (unknown small), 5 rows, manifest-reported unknown | physical: 3 data files, du 1M", "…and prints each missing field as unknown");
    const nanShape = await readLogicalShape({ stats: async () => ({ numRows: Number.NaN, totalBytes: "12", fragmentStats: { numFragments: 2 } }) as never });
    eq(nanShape, { rows: null, fragments: 2, smallFragments: null, manifestBytes: null, indices: null }, "NaN and non-number values are unmeasured, not numbers");
    const partialOptimize = formatOptimizeStats({ compaction: { fragmentsRemoved: 2 } } as never, 500);
    eq(partialOptimize, "optimize (0.5s): fragments -2/+unknown, data files -unknown/+unknown; pruned unknown old versions, unknown", "a partial OptimizeStats prints each missing field as unknown");
    eq([partialLine, partialOptimize].some((l) => /NaN|undefined/.test(l)), false, "no report line ever says NaN or undefined");
  }

  console.log("\n# a synthetic table (read only; no optimize)");
  {
    const dbPath = path.join(tmp, "sessions.lance");
    const store = new VectorStore(dbPath, 4);
    await store.ensureTable();
    const row = (id: string, v: number[]) => ({ id, text: `synthetic ${id}`, vector: v, sessionFile: `/synthetic/${id}.jsonl`, project: "synthetic", lineNumber: 1, timestamp: "2026-10-15T00:00:00Z", role: "user", source: "pi", metadata: {} });
    await store.addChunks([row("a", [1, 0, 0, 0])]);
    await store.addChunks([row("b", [0, 1, 0, 0])]);
    await store.close();
    const table = await (await lancedb.connect(dbPath)).openTable("session_chunks");
    const shape = await readLogicalShape(table);
    eq(shape?.rows, 2, "a real table.stats(): row count");
    const frags = shape?.fragments ?? null;
    const small = shape?.smallFragments ?? null;
    eq(frags !== null && small !== null && frags >= 1 && small <= frags, true, "a real table.stats(): fragment counts are measured and small ≤ total");
    const files = countDataFiles(dbPath);
    eq(typeof files === "number" && files >= 1, true, "the physical data-file count is read from the data directory");
    eq(formatShape(shape, files, null).startsWith(`logical: ${shape!.fragments} fragments`), true, "the line leads with the logical measure");
    table.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.umask(prevUmask);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
