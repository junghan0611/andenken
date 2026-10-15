/**
 * Report vocabulary for the shape of a LanceDB table (issue #16).
 *
 * Reports used to print four different measures under one word, "fragments":
 *
 * - **logical fragments**: `table.stats().fragmentStats`. These are what
 *   compaction merges, and `numSmallFragments` counts the uncompacted ones.
 * - **physical data files**: entries in `<store>/session_chunks.lance/data/`,
 *   which is what `ls` counts.
 * - **on-disk size**: `du` over the store, old versions included.
 * - **manifest-reported bytes**: `table.stats().totalBytes`. This is the size of
 *   the data, index and overlay files the current manifest references, without
 *   deletion files or manifests. It is not disk usage, and a 0 here does not
 *   mean an empty disk.
 *
 * `optimize()` returns its own `OptimizeStats` (compaction fragments and files
 * removed/added; prune bytes and old versions removed). That is the only
 * measure of what one optimize call did.
 *
 * Every reader here is total: a value that could not be measured is reported as
 * `unknown`, never as 0. A failed measurement therefore cannot be read as a
 * healthy one, and it cannot fail the optimize call it describes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { OptimizeStats, TableStatistics } from "@lancedb/lancedb";

/** Each field is null when that one value was not measured. */
export interface LogicalShape {
  rows: number | null;
  fragments: number | null;
  smallFragments: number | null;
  manifestBytes: number | null;
  indices: number | null;
}

function measured(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function show(x: number | null, fmt: (n: number) => string = String): string {
  return x === null ? "unknown" : fmt(x);
}

/** `table.stats()` as a logical shape, or null when it cannot be read at all. */
export async function readLogicalShape(table: { stats(): Promise<TableStatistics> }): Promise<LogicalShape | null> {
  try {
    const s = await table.stats();
    return {
      rows: measured(s?.numRows),
      fragments: measured(s?.fragmentStats?.numFragments),
      smallFragments: measured(s?.fragmentStats?.numSmallFragments),
      manifestBytes: measured(s?.totalBytes),
      indices: measured(s?.numIndices),
    };
  } catch {
    return null;
  }
}

/** Entries in the table's data directory, or null when it cannot be listed. */
export function countDataFiles(dbPath: string): number | null {
  try {
    return fs.readdirSync(path.join(dbPath, "session_chunks.lance", "data")).length;
  } catch {
    return null;
  }
}

export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

/** One line that keeps logical and physical measures apart. */
export function formatShape(logical: LogicalShape | null, dataFiles: number | null, du: string | null): string {
  const lg = logical
    ? `logical: ${show(logical.fragments)} fragments (${show(logical.smallFragments)} small), ${show(logical.rows, (n) => n.toLocaleString())} rows, manifest-reported ${show(logical.manifestBytes, formatBytes)}`
    : "logical: unknown";
  const ph = `physical: ${dataFiles ?? "unknown"} data files, du ${du ?? "unknown"}`;
  return `${lg} | ${ph}`;
}

/** What one optimize call reported, with its wall time. */
export function formatOptimizeStats(stats: OptimizeStats | null | undefined, elapsedMs: number): string {
  const secs = `${(elapsedMs / 1000).toFixed(1)}s`;
  if (!stats?.compaction && !stats?.prune) return `optimize (${secs}): stats unknown`;
  const c = stats.compaction;
  const p = stats.prune;
  const n = (x: unknown, fmt?: (v: number) => string) => show(measured(x), fmt);
  return `optimize (${secs}): fragments -${n(c?.fragmentsRemoved)}/+${n(c?.fragmentsAdded)}, data files -${n(c?.filesRemoved)}/+${n(c?.filesAdded)}; pruned ${n(p?.oldVersionsRemoved)} old versions, ${n(p?.bytesRemoved, formatBytes)}`;
}
