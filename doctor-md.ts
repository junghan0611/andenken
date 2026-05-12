/**
 * andenken doctor — md track triage (V1)
 *
 * Goal: explain the `manifest entries` ↔ `DB indexed_files` gap for the md
 * track so an operator never has to wonder whether the difference is missing
 * corpus or intended skips.
 *
 * Scope (V1):
 *   - Provider / DB / manifest / filesystem coverage check
 *   - Per-file skip classification via the shared `analyzeMdFile` SSOT in
 *     md-chunker.ts. The classifier matches the indexer 1:1 by construction,
 *     so doctor's breakdown can never drift from the indexer's decision.
 *   - Sample file lists (top N) per skip category.
 *
 * Deliberately deferred (V2 — separate work):
 *   - Smoke probes (requires a md-specific golden query set).
 *   - Baseline + delta tracking (only meaningful after the manifest has
 *     evolved over time).
 *   - Structure scans (Hugo-exported md is highly regular; signal-to-noise
 *     compared to org doctor's malformed-block / micro-heading checks is
 *     unclear and not worth adding pre-emptively).
 *
 * Read-only, local-only. Mirrors the doctor-org dispatch pattern so a future
 * smoke/baseline expansion can grow into the same shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VectorStore, getMdDbPath, getDataDir } from "./store.js";
import {
  findMdFiles,
  analyzeMdFile,
  type MdSkipReason,
} from "./md-chunker.js";
import { createMdProviderFromEnv } from "./embedding-provider.js";

// ── Constants ────────────────────────────────────────────────────────────

const SAMPLE_TOP_N = 10;

const ALL_REASONS: MdSkipReason[] = [
  "deleted",
  "folder_excluded",
  "noembed_tag",
  "empty_body",
  "min_body",
  "all_chunks_short",
  "unreadable",
];

// ── Types ────────────────────────────────────────────────────────────────

export type MdDoctorStatus = "OK" | "WARN" | "FAIL";

interface MdManifestEntry {
  mtimeMs: number;
  size: number;
  chunks: number;
}

interface MdManifestShape {
  files: Record<string, MdManifestEntry>;
  lastUpdated: string;
}

interface ProviderInfo {
  configured: boolean;
  reachable: boolean;
  dim: number | null;
  label: string;
  error?: string;
}

interface DbInfo {
  exists: boolean;
  chunks: number;
  indexedFiles: number;
  dim: number | null;
  error?: string;
}

interface ManifestInfo {
  exists: boolean;
  entries: number;
  zeroChunkEntries: number;
  lastUpdated: string;
}

interface FilesystemInfo {
  indexableFiles: number;
}

interface GapBreakdownEntry {
  count: number;
  samples: string[]; // top N file paths
}

interface GapBreakdown {
  // One bucket per MdSkipReason plus an `unclassified` bucket for files
  // that the manifest marks as chunks=0 but the SSOT classifier disagrees
  // about (which would mean classifier/manifest drift — the single most
  // important signal this doctor exists to surface).
  deleted: GapBreakdownEntry;
  folder_excluded: GapBreakdownEntry;
  noembed_tag: GapBreakdownEntry;
  empty_body: GapBreakdownEntry;
  min_body: GapBreakdownEntry;
  all_chunks_short: GapBreakdownEntry;
  unreadable: GapBreakdownEntry;
  unclassified: GapBreakdownEntry;
}

interface MdDoctorReport {
  track: "md";
  device: string;
  time: string;
  provider: ProviderInfo;
  db: DbInfo;
  manifest: ManifestInfo;
  filesystem: FilesystemInfo;
  gap: {
    /** manifest entries minus DB indexed_files. */
    manifest_minus_indexed: number;
    /** noembed + min_body + empty_body + deleted + folder_excluded + unreadable + all_chunks_short */
    accounted_gap: number;
    unclassified: number;
    breakdown: GapBreakdown;
  };
  verdict: MdDoctorStatus;
  reasons: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function loadMdManifest(): MdManifestShape | null {
  const manifestPath = path.join(getDataDir(), "md-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as MdManifestShape;
  } catch {
    return null;
  }
}

function emptyBucket(): GapBreakdownEntry {
  return { count: 0, samples: [] };
}

function emptyBreakdown(): GapBreakdown {
  return {
    deleted: emptyBucket(),
    folder_excluded: emptyBucket(),
    noembed_tag: emptyBucket(),
    empty_body: emptyBucket(),
    min_body: emptyBucket(),
    all_chunks_short: emptyBucket(),
    unreadable: emptyBucket(),
    unclassified: emptyBucket(),
  };
}

function pushSample(b: GapBreakdownEntry, file: string): void {
  b.count++;
  if (b.samples.length < SAMPLE_TOP_N) b.samples.push(file);
}

// ── Checks ───────────────────────────────────────────────────────────────

async function probeProvider(): Promise<ProviderInfo> {
  const provider = createMdProviderFromEnv();
  if (!provider) {
    return {
      configured: false,
      reachable: false,
      dim: null,
      label: "(unset)",
      error: "ANDENKEN_MD_PROVIDER / ANDENKEN_MD_* not configured",
    };
  }
  const label = provider.constructor.name.replace("Provider", "");
  try {
    const vec = await provider.embedQuery("ping");
    return {
      configured: true,
      reachable: true,
      dim: vec?.length ?? null,
      label,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      dim: provider.dimensions ?? null,
      label,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

async function probeDb(): Promise<DbInfo> {
  const dbPath = getMdDbPath();
  if (!fs.existsSync(dbPath)) {
    return { exists: false, chunks: 0, indexedFiles: 0, dim: null };
  }
  try {
    const store = new VectorStore(dbPath);
    await store.init();
    const chunks = await store.getCount();
    const files = await store.getIndexedFiles();
    const dim = await store.getActualVectorDim();
    await store.close();
    return {
      exists: true,
      chunks,
      indexedFiles: files.size,
      dim,
    };
  } catch (err) {
    return {
      exists: true,
      chunks: 0,
      indexedFiles: 0,
      dim: null,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

function probeManifest(): { info: ManifestInfo; manifest: MdManifestShape | null } {
  const manifest = loadMdManifest();
  if (!manifest) {
    return {
      manifest: null,
      info: { exists: false, entries: 0, zeroChunkEntries: 0, lastUpdated: "" },
    };
  }
  const entries = Object.keys(manifest.files ?? {}).length;
  const zeroChunkEntries = Object.values(manifest.files ?? {}).filter(
    (v) => (v.chunks ?? 0) === 0,
  ).length;
  return {
    manifest,
    info: {
      exists: true,
      entries,
      zeroChunkEntries,
      lastUpdated: manifest.lastUpdated ?? "",
    },
  };
}

function classifyGap(
  manifest: MdManifestShape | null,
): GapBreakdown {
  const breakdown = emptyBreakdown();
  if (!manifest) return breakdown;

  // Only manifest entries with chunks=0 contribute to the gap. Files with
  // chunks>0 are accounted for in DB indexed_files, regardless of how many
  // rows actually landed (per-row deltas are a separate concern).
  const zeroChunkFiles = Object.entries(manifest.files ?? {})
    .filter(([, v]) => (v.chunks ?? 0) === 0)
    .map(([f]) => f);

  for (const file of zeroChunkFiles) {
    // bypassFolderPolicy: a manifest entry is by definition in an indexable
    // folder (the indexer's discovery already filtered). If the file's
    // folder later changed, the SSOT will still classify it correctly via
    // the deleted/min_body/etc. branches; we don't want a synthetic
    // `folder_excluded` here.
    const analysis = analyzeMdFile(file, { bypassFolderPolicy: true });
    if (analysis.skipReason === null) {
      // Manifest says zero chunks but the current chunker would produce
      // chunks for this file — a real drift signal. Either the file was
      // edited since last index (next sync will re-pick it up) or chunker
      // behavior changed since manifest was written.
      pushSample(breakdown.unclassified, file);
      continue;
    }
    pushSample(breakdown[analysis.skipReason], file);
  }

  return breakdown;
}

// ── Verdict ──────────────────────────────────────────────────────────────

function buildVerdict(
  report: Omit<MdDoctorReport, "verdict" | "reasons">,
): { verdict: MdDoctorStatus; reasons: string[] } {
  const reasons: string[] = [];

  const providerBroken = !report.provider.configured || !report.provider.reachable;
  const dbBroken = !report.db.exists || !!report.db.error;
  const dbEmptyUnexpected =
    report.db.exists && report.db.chunks === 0 && report.manifest.entries > 0;
  const dimMismatch =
    report.provider.dim !== null &&
    report.db.dim !== null &&
    report.provider.dim !== report.db.dim;

  // FAIL — production search itself is broken.
  if (providerBroken) {
    reasons.push(
      report.provider.error
        ? `provider unusable: ${report.provider.error}`
        : "provider unusable",
    );
  }
  if (dbBroken) {
    reasons.push(report.db.error ? `db unreadable: ${report.db.error}` : "db missing");
  }
  if (dbEmptyUnexpected) {
    reasons.push(`db empty but manifest has ${report.manifest.entries} entries`);
  }
  if (dimMismatch) {
    reasons.push(
      `dim mismatch: provider=${report.provider.dim}d, db=${report.db.dim}d`,
    );
  }

  const fail = providerBroken || dbBroken || dbEmptyUnexpected || dimMismatch;

  // WARN — explanation incomplete or operational anomaly. Production
  // search still works; doctor surfaces the signal so an operator can act.
  const unclassified = report.gap.unclassified;
  const reconciles =
    report.gap.manifest_minus_indexed === report.gap.accounted_gap + unclassified;
  const deletedCount = report.gap.breakdown.deleted.count;

  if (unclassified > 0) {
    reasons.push(
      `unclassified zero-chunk entries: ${unclassified} (manifest/chunker drift)`,
    );
  }
  if (!reconciles) {
    reasons.push(
      `gap arithmetic mismatch: manifest-indexed=${report.gap.manifest_minus_indexed}, accounted+unclassified=${report.gap.accounted_gap + unclassified}`,
    );
  }
  if (deletedCount > 0) {
    reasons.push(
      `deleted files still in manifest: ${deletedCount} (run sync:md to clean)`,
    );
  }

  if (fail) return { verdict: "FAIL", reasons };
  if (unclassified > 0 || !reconciles || deletedCount > 0) {
    return { verdict: "WARN", reasons };
  }
  return { verdict: "OK", reasons: [] };
}

// ── Build report ─────────────────────────────────────────────────────────

async function buildReport(opts: { device: string; time: string }): Promise<MdDoctorReport> {
  const provider = await probeProvider();
  const db = await probeDb();
  const { info: manifest, manifest: manifestData } = probeManifest();

  // Filesystem coverage: how many garden md files COULD be indexed if we
  // re-ran from scratch. Drift between this and manifest.entries tells the
  // operator new garden exports landed but sync hasn't run yet.
  const indexableFiles = findMdFiles().length;
  const filesystem: FilesystemInfo = { indexableFiles };

  const breakdown = classifyGap(manifestData);

  const accounted_gap = ALL_REASONS.reduce(
    (sum, r) => sum + breakdown[r].count,
    0,
  );
  const unclassified = breakdown.unclassified.count;

  const partial: Omit<MdDoctorReport, "verdict" | "reasons"> = {
    track: "md",
    device: opts.device,
    time: opts.time,
    provider,
    db,
    manifest,
    filesystem,
    gap: {
      manifest_minus_indexed: manifest.entries - db.indexedFiles,
      accounted_gap,
      unclassified,
      breakdown,
    },
  };

  const { verdict, reasons } = buildVerdict(partial);
  return { ...partial, verdict, reasons };
}

// ── Render ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString();
}

function renderPretty(report: MdDoctorReport): void {
  const icon = { OK: "✅", WARN: "⚠️", FAIL: "❌" }[report.verdict];

  console.log(`\n🩺 andenken doctor — md track`);
  console.log(`   device: ${report.device}  |  ${report.time}`);
  console.log("─".repeat(70));

  const p = report.provider;
  const pStatus = p.configured && p.reachable ? "✅" : "❌";
  const pDetail =
    p.configured && p.reachable
      ? `${p.label} responding, dim=${p.dim}`
      : p.error ?? "not configured";
  console.log(`  ${pStatus} Provider          ${pDetail}`);

  const d = report.db;
  const dStatus = d.exists && !d.error ? "✅" : "❌";
  const dDetail = d.exists
    ? d.error
      ? d.error
      : `${fmt(d.chunks)} chunks, ${fmt(d.indexedFiles)} files, ${d.dim ?? "?"}d`
    : "DB missing";
  console.log(`  ${dStatus} DB                ${dDetail}`);

  const m = report.manifest;
  const mStatus = m.exists ? "✅" : "❌";
  console.log(
    `  ${mStatus} Manifest          ${m.exists ? fmt(m.entries) : 0} entries${m.exists && m.lastUpdated ? `  (lastUpdated ${m.lastUpdated.slice(0, 19)})` : ""}`,
  );

  console.log(
    `  ℹ️  Filesystem        ${fmt(report.filesystem.indexableFiles)} indexable files in garden`,
  );

  // Gap line
  const gap = report.gap;
  const gapIcon =
    gap.manifest_minus_indexed === gap.accounted_gap + gap.unclassified
      ? gap.unclassified === 0
        ? "✅"
        : "⚠️"
      : "⚠️";
  console.log(
    `  ${gapIcon} Gap analysis      manifest − indexed = ${fmt(gap.manifest_minus_indexed)}; accounted = ${fmt(gap.accounted_gap)}; unclassified = ${fmt(gap.unclassified)}`,
  );

  // Breakdown — one line per category, only show non-zero plus
  // `unclassified` (which we always print so operator notices when it's 0).
  const b = gap.breakdown;
  const order: MdSkipReason[] = [
    "noembed_tag",
    "min_body",
    "empty_body",
    "all_chunks_short",
    "deleted",
    "folder_excluded",
    "unreadable",
  ];
  for (const r of order) {
    if (b[r].count === 0) continue;
    console.log(`       └─ ${r.padEnd(18)} : ${fmt(b[r].count)} files`);
    for (const s of b[r].samples.slice(0, 5)) {
      console.log(`            ${path.relative(process.cwd(), s)}`);
    }
  }
  // Always print unclassified — it's the drift signal.
  console.log(
    `       └─ ${"unclassified".padEnd(18)} : ${fmt(b.unclassified.count)} files${b.unclassified.count > 0 ? "  ← drift signal" : ""}`,
  );
  for (const s of b.unclassified.samples.slice(0, 5)) {
    console.log(`            ${path.relative(process.cwd(), s)}`);
  }

  console.log("─".repeat(70));
  console.log(`  ${icon} ${report.verdict}`);
  for (const r of report.reasons) console.log(`     - ${r}`);
  console.log();
}

// ── Entry ────────────────────────────────────────────────────────────────

export interface MdDoctorOpts {
  json: boolean;
  device: string;
  time: string;
}

export async function runMdDoctor(opts: MdDoctorOpts): Promise<number> {
  const report = await buildReport({ device: opts.device, time: opts.time });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderPretty(report);
  }

  // Exit code: 0 OK, 1 WARN, 2 FAIL — same convention as doctor-org.
  if (report.verdict === "FAIL") return 2;
  if (report.verdict === "WARN") return 1;
  return 0;
}
