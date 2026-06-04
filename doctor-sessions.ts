/**
 * andenken doctor — sessions track triage (V1)
 *
 * Goal: explain the `manifest entries` ↔ `DB indexed_files` gap AND surface
 * the distribution of Phase 1 stored signals so an operator can quality-check
 * the sessions index between work sessions.
 *
 * Scope (V1):
 *   - Provider / DB / manifest / filesystem coverage check (mirrors doctor-md).
 *   - Stored-signal distribution: role, project (top N), timestamp range,
 *     null fill rate per column.
 *   - Zero-chunk manifest entries: count + sample paths (no deep skip-reason
 *     classification — sessions skips are line-level inside extractSessionChunks
 *     and re-running that for every file is too heavy for V1).
 *
 * Deliberately deferred (V2):
 *   - Per-file zero-chunk skip-reason classification (would need a cheaper
 *     replay of extractSessionChunks that returns skipReason counts only).
 *   - Smoke probes (need a sessions-specific golden query set).
 *   - Baseline + delta tracking.
 *
 * Read-only, local-only. Mirrors doctor-md dispatch shape so the surface
 * grows the same way.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VectorStore, getSessionsDbPath, getDataDir } from "./store.js";
import { findSessionFiles } from "./session-indexer.js";
import { createSessionProviderFromEnv } from "./embedding-provider.js";

// ── Constants ────────────────────────────────────────────────────────────

const SAMPLE_TOP_N = 5;
const PROJECT_TOP_N = 8;

// ── Types ────────────────────────────────────────────────────────────────

export type SessionsDoctorStatus = "OK" | "WARN" | "FAIL";

interface SessionManifestEntry {
  mtimeMs: number;
  size: number;
  chunks: number;
}

interface SessionManifestShape {
  files: Record<string, SessionManifestEntry>;
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
  piFiles: number;
  claudeFiles: number;
}

interface GapEntry {
  count: number;
  samples: string[];
}

interface StoredSignals {
  // Total rows whose `role` matches each canonical value, plus a catch-all
  // for unexpected values (would indicate indexer drift).
  roleCounts: Record<string, number>;
  // Total rows whose `source` matches each canonical value.
  sourceCounts: Record<string, number>;
  // Top-N projects by row count.
  projectTop: Array<{ project: string; count: number }>;
  projectDistinctCount: number;
  // Number of rows where the column is null / empty string.
  nullCounts: Record<string, number>;
  // Min / max timestamp seen in the table (ISO strings).
  timestampRange: { min: string | null; max: string | null };
}

interface SessionsDoctorReport {
  track: "sessions";
  device: string;
  time: string;
  provider: ProviderInfo;
  db: DbInfo;
  manifest: ManifestInfo;
  filesystem: FilesystemInfo;
  gap: {
    manifest_minus_indexed: number;
    zero_chunk_samples: GapEntry;
  };
  signals: StoredSignals;
  verdict: SessionsDoctorStatus;
  reasons: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function loadSessionManifest(): SessionManifestShape | null {
  const manifestPath = path.join(getDataDir(), "session-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SessionManifestShape;
  } catch {
    return null;
  }
}

function isNullish(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.length === 0) return true;
  return false;
}

// ── Checks ───────────────────────────────────────────────────────────────

async function probeProvider(): Promise<ProviderInfo> {
  // Sessions track has its own namespaced provider factory — same shape as
  // createMdProviderFromEnv / createOrgProviderFromEnv. Reads ANDENKEN_SESSION_*
  // (singular). Used by indexer.ts sessions path and sync-sessions.sh.
  const provider = createSessionProviderFromEnv();
  if (!provider) {
    return {
      configured: false,
      reachable: false,
      dim: null,
      label: "(unset)",
      error: "ANDENKEN_SESSION_* env not configured (see sync-sessions.sh)",
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

async function probeDb(): Promise<{ info: DbInfo; store: VectorStore | null }> {
  const dbPath = getSessionsDbPath();
  if (!fs.existsSync(dbPath)) {
    return { info: { exists: false, chunks: 0, indexedFiles: 0, dim: null }, store: null };
  }
  try {
    const store = new VectorStore(dbPath);
    await store.init();
    const chunks = await store.getCount();
    const files = await store.getIndexedFiles();
    const dim = await store.getActualVectorDim();
    return {
      info: { exists: true, chunks, indexedFiles: files.size, dim },
      store,
    };
  } catch (err) {
    return {
      info: {
        exists: true,
        chunks: 0,
        indexedFiles: 0,
        dim: null,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      },
      store: null,
    };
  }
}

function probeManifest(): { info: ManifestInfo; manifest: SessionManifestShape | null } {
  const manifest = loadSessionManifest();
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

function probeFilesystem(): FilesystemInfo {
  const all = findSessionFiles();
  const piFiles = all.filter((f) => f.includes("/.pi/agent/sessions/")).length;
  const claudeFiles = all.filter((f) => f.includes("/.claude/")).length;
  return {
    indexableFiles: all.length,
    piFiles,
    claudeFiles,
  };
}

function buildZeroChunkSamples(manifest: SessionManifestShape | null): GapEntry {
  if (!manifest) return { count: 0, samples: [] };
  const zeroFiles = Object.entries(manifest.files ?? {})
    .filter(([, v]) => (v.chunks ?? 0) === 0)
    .map(([f]) => f);
  return {
    count: zeroFiles.length,
    samples: zeroFiles.slice(0, SAMPLE_TOP_N),
  };
}

async function probeStoredSignals(store: VectorStore | null): Promise<StoredSignals> {
  const empty: StoredSignals = {
    roleCounts: {},
    sourceCounts: {},
    projectTop: [],
    projectDistinctCount: 0,
    nullCounts: {},
    timestampRange: { min: null, max: null },
  };
  if (!store) return empty;

  const cols = ["role", "source", "project", "sessionFile", "timestamp"] as const;
  let rows: Array<Record<(typeof cols)[number], unknown>>;
  try {
    rows = await store.dumpColumns([...cols]);
  } catch {
    return empty;
  }
  if (rows.length === 0) return empty;

  const roleCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const projectCounts = new Map<string, number>();
  const nullCounts: Record<string, number> = {
    role: 0,
    source: 0,
    project: 0,
    sessionFile: 0,
    timestamp: 0,
  };
  let minTs: string | null = null;
  let maxTs: string | null = null;

  for (const r of rows) {
    const role = r.role as string | null | undefined;
    if (isNullish(role)) nullCounts.role++;
    else roleCounts[role as string] = (roleCounts[role as string] ?? 0) + 1;

    const source = r.source as string | null | undefined;
    if (isNullish(source)) nullCounts.source++;
    else sourceCounts[source as string] = (sourceCounts[source as string] ?? 0) + 1;

    const project = r.project as string | null | undefined;
    if (isNullish(project)) nullCounts.project++;
    else projectCounts.set(project as string, (projectCounts.get(project as string) ?? 0) + 1);

    const sessionFile = r.sessionFile as string | null | undefined;
    if (isNullish(sessionFile)) {
      nullCounts.sessionFile++;
    }

    const timestamp = r.timestamp as string | null | undefined;
    if (isNullish(timestamp)) {
      nullCounts.timestamp++;
    } else {
      const ts = timestamp as string;
      if (minTs === null || ts < minTs) minTs = ts;
      if (maxTs === null || ts > maxTs) maxTs = ts;
    }
  }

  const projectTop = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PROJECT_TOP_N)
    .map(([project, count]) => ({ project, count }));

  return {
    roleCounts,
    sourceCounts,
    projectTop,
    projectDistinctCount: projectCounts.size,
    nullCounts,
    timestampRange: { min: minTs, max: maxTs },
  };
}

// ── Verdict ──────────────────────────────────────────────────────────────

function buildVerdict(
  report: Omit<SessionsDoctorReport, "verdict" | "reasons">,
): { verdict: SessionsDoctorStatus; reasons: string[] } {
  const reasons: string[] = [];

  const providerBroken = !report.provider.configured || !report.provider.reachable;
  const dbBroken = !report.db.exists || !!report.db.error;
  const dbEmptyUnexpected =
    report.db.exists && report.db.chunks === 0 && report.manifest.entries > 0;
  const dimMismatch =
    report.provider.dim !== null &&
    report.db.dim !== null &&
    report.provider.dim !== report.db.dim;

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

  // WARN — operational anomalies that don't break search but the operator
  // should see.
  const filesystemGap = report.filesystem.indexableFiles - report.manifest.entries;
  if (filesystemGap > 50) {
    reasons.push(
      `filesystem-manifest gap: ${filesystemGap} unindexed sessions (run sync-sessions)`,
    );
  }

  const nullProject = report.signals.nullCounts.project ?? 0;
  if (nullProject > 0 && report.db.chunks > 0) {
    const pct = ((nullProject / report.db.chunks) * 100).toFixed(1);
    reasons.push(`rows with null project: ${nullProject} (${pct}%)`);
  }
  const nullRole = report.signals.nullCounts.role ?? 0;
  if (nullRole > 0 && report.db.chunks > 0) {
    const pct = ((nullRole / report.db.chunks) * 100).toFixed(1);
    reasons.push(`rows with null role: ${nullRole} (${pct}%)`);
  }

  // Unexpected role values would indicate indexer drift.
  const knownRoles = new Set(["user", "assistant", "compaction"]);
  const unknownRoles = Object.keys(report.signals.roleCounts).filter((r) => !knownRoles.has(r));
  if (unknownRoles.length > 0) {
    reasons.push(`unexpected role values: ${unknownRoles.join(", ")}`);
  }

  if (fail) return { verdict: "FAIL", reasons };
  if (reasons.length > 0) return { verdict: "WARN", reasons };
  return { verdict: "OK", reasons: [] };
}

// ── Build report ─────────────────────────────────────────────────────────

async function buildReport(opts: { device: string; time: string }): Promise<SessionsDoctorReport> {
  const provider = await probeProvider();
  const { info: db, store } = await probeDb();
  const { info: manifest, manifest: manifestData } = probeManifest();
  const filesystem = probeFilesystem();
  const zeroChunkSamples = buildZeroChunkSamples(manifestData);
  const signals = await probeStoredSignals(store);
  if (store) await store.close();

  const partial: Omit<SessionsDoctorReport, "verdict" | "reasons"> = {
    track: "sessions",
    device: opts.device,
    time: opts.time,
    provider,
    db,
    manifest,
    filesystem,
    gap: {
      manifest_minus_indexed: manifest.entries - db.indexedFiles,
      zero_chunk_samples: zeroChunkSamples,
    },
    signals,
  };

  const { verdict, reasons } = buildVerdict(partial);
  return { ...partial, verdict, reasons };
}

// ── Render ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString();
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function renderPretty(report: SessionsDoctorReport): void {
  const icon = { OK: "✅", WARN: "⚠️", FAIL: "❌" }[report.verdict];

  console.log(`\n🩺 andenken doctor — sessions track`);
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

  const fs = report.filesystem;
  console.log(
    `  ℹ️  Filesystem        ${fmt(fs.indexableFiles)} indexable (pi=${fmt(fs.piFiles)}, claude=${fmt(fs.claudeFiles)})`,
  );

  // Gap
  const gap = report.gap;
  const gapIcon = gap.manifest_minus_indexed === gap.zero_chunk_samples.count ? "✅" : "⚠️";
  console.log(
    `  ${gapIcon} Gap analysis      manifest − indexed = ${fmt(gap.manifest_minus_indexed)}; zero-chunk manifest entries = ${fmt(gap.zero_chunk_samples.count)}`,
  );
  for (const s of gap.zero_chunk_samples.samples) {
    console.log(`            ${path.relative(process.cwd(), s)}`);
  }

  // Stored signals
  console.log("");
  console.log(`  📊 Stored signals (Phase 1 surface — row-level distribution)`);
  const total = d.chunks;

  // Role
  const r = report.signals.roleCounts;
  const roleParts = ["user", "assistant", "compaction"].map(
    (k) => `${k}=${fmt(r[k] ?? 0)} (${pct(r[k] ?? 0, total)})`,
  );
  console.log(`       role           : ${roleParts.join("  ")}`);
  const knownRoles = new Set(["user", "assistant", "compaction"]);
  const otherRoles = Object.entries(r).filter(([k]) => !knownRoles.has(k));
  if (otherRoles.length > 0) {
    console.log(
      `         ⚠ unexpected: ${otherRoles.map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}`,
    );
  }

  // Source
  const src = report.signals.sourceCounts;
  const srcParts = Object.entries(src)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${fmt(v)} (${pct(v, total)})`);
  console.log(`       source         : ${srcParts.join("  ")}`);

  // Project top
  console.log(
    `       project        : ${fmt(report.signals.projectDistinctCount)} distinct (top ${PROJECT_TOP_N}):`,
  );
  for (const { project, count } of report.signals.projectTop) {
    console.log(`         - ${project.padEnd(30)} ${fmt(count).padStart(8)}  (${pct(count, total)})`);
  }

  // Null fill
  const nc = report.signals.nullCounts;
  const nullEntries = Object.entries(nc).filter(([, v]) => v > 0);
  if (nullEntries.length === 0) {
    console.log(`       null counts    : 0 across all observed columns`);
  } else {
    console.log(
      `       null counts    : ${nullEntries.map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}`,
    );
  }

  // Timestamp range
  const ts = report.signals.timestampRange;
  console.log(
    `       timestamp      : min=${ts.min ?? "(none)"}  max=${ts.max ?? "(none)"}`,
  );

  console.log("─".repeat(70));
  console.log(`  ${icon} ${report.verdict}`);
  for (const reason of report.reasons) console.log(`     - ${reason}`);
  console.log();
}

// ── Entry ────────────────────────────────────────────────────────────────

export interface SessionsDoctorOpts {
  json: boolean;
  device: string;
  time: string;
}

export async function runSessionsDoctor(opts: SessionsDoctorOpts): Promise<number> {
  const report = await buildReport({ device: opts.device, time: opts.time });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderPretty(report);
  }

  if (report.verdict === "FAIL") return 2;
  if (report.verdict === "WARN") return 1;
  return 0;
}
