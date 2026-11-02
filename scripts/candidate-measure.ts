/**
 * candidate:sessions:measure — read-only measurement of a built candidate
 * (issue #18). API 0, no lock taken, nothing written except the optional
 * `--out` report (wx, 0600, outside the target).
 *
 *   - target: allocated / apparent bytes, per top-level part of sessions.lance
 *   - candidate DB (read-only open): rows, rows per source, dim, FTS, unique
 *     ids, S0 hits — the same checks the build ran, re-run independently
 *   - receipt / manifests: status, plan sha, manifest chunk sums vs the DB
 *   - production sessions.lance: directory METADATA only (sizes), never opened
 *
 *   tsx scripts/candidate-measure.ts --target <abs dir> [--out <abs file>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { allocatedBytes, BUILD_KIND, defaultBuildEnv, verifyCandidate, within, type BuildEnv } from "./candidate-build.ts";

export class MeasureRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MeasureRefused";
  }
}

export function parseMeasureArgs(argv: string[]): { target: string; out?: string } {
  const known = new Set(["--target", "--out"]);
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) throw new MeasureRefused("unknown-argument");
    if (a in v) throw new MeasureRefused("argument-repeated");
    const x = argv[i + 1];
    if (x === undefined || x.startsWith("--")) throw new MeasureRefused("argument-missing-value");
    v[a] = x;
    i++;
  }
  if (!v["--target"]) throw new MeasureRefused("target-required");
  return { target: v["--target"], out: v["--out"] };
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runMeasure(argv: string[], env: BuildEnv) {
  const { target, out } = parseMeasureArgs(argv);
  if (!path.isAbsolute(target) || path.resolve(target) !== target) throw new MeasureRefused("target-not-absolute-normalized");
  if (path.dirname(target) !== env.candidatesRoot) throw new MeasureRefused("target-not-directly-under-candidates-root");
  if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory() || fs.realpathSync(target) !== target) {
    throw new MeasureRefused("target-not-canonical-dir");
  }
  if (fs.existsSync(path.join(target, ".sessions-write.lock"))) throw new MeasureRefused("candidate-writer-active");
  const receipt = readJson(path.join(target, "candidate-receipt.json"));
  if (!receipt || receipt.kind !== BUILD_KIND) throw new MeasureRefused("not-a-candidate-target");
  if (out !== undefined) {
    if (!path.isAbsolute(out) || path.resolve(out) !== out) throw new MeasureRefused("out-not-absolute-normalized");
    if (within(out, target)) throw new MeasureRefused("out-inside-target");
    if (fs.existsSync(out)) throw new MeasureRefused("out-exists");
  }

  const dbPath = path.join(target, "sessions.lance");
  const parts: Record<string, { allocated: number; apparent: number; files: number }> = {};
  const tableDir = path.join(dbPath, "session_chunks.lance");
  if (fs.existsSync(tableDir)) {
    for (const name of fs.readdirSync(tableDir)) parts[name] = allocatedBytes(path.join(tableDir, name));
  }
  const db = fs.existsSync(dbPath) ? await verifyCandidate(dbPath) : null;

  const manifest = readJson(path.join(target, "session-manifest.json")) as { files?: Record<string, { chunks: number }> } | null;
  const durableManifest = readJson(path.join(target, "durable-manifest.json")) as { files?: Record<string, { chunks: number }> } | null;
  const sum = (m: { files?: Record<string, { chunks: number }> } | null) =>
    m?.files ? Object.values(m.files).reduce((n, e) => n + (e.chunks ?? 0), 0) : null;
  const jsonlManifestChunks = sum(manifest);
  const durableManifestChunks = sum(durableManifest);

  const production = path.join(env.dataDir, "sessions.lance");
  const report = {
    kind: "andenken-candidate-measure",
    measuredAt: new Date().toISOString(),
    target,
    receipt: {
      status: receipt.status,
      code: receipt.code ?? null,
      policy: receipt.policy,
      planSha: (receipt.plan as { sha256?: string } | undefined)?.sha256 ?? null,
      expected: receipt.expected ?? null,
      attempt: receipt.attempt ?? 1,
      attempts: receipt.attempts ?? [],
      resume: receipt.resume ?? null,
      api: receipt.api ?? null,
      timing: receipt.timing ?? null,
    },
    disk: {
      target: allocatedBytes(target),
      sessionsLance: fs.existsSync(dbPath) ? allocatedBytes(dbPath) : null,
      tableParts: parts,
      note: "allocated = st_blocks × 512 (symlinks not followed); apparent = file sizes",
    },
    db,
    pairs: {
      jsonlManifestChunks,
      durableManifestChunks,
      jsonlRowsInDb: db ? db.rows - (db.bySource["pi-durable"] ?? 0) : null,
      durableRowsInDb: db ? (db.bySource["pi-durable"] ?? 0) : null,
      jsonlPairOk: db !== null && jsonlManifestChunks !== null && jsonlManifestChunks === db.rows - (db.bySource["pi-durable"] ?? 0),
      durablePairOk: db !== null && (durableManifestChunks ?? 0) === (db.bySource["pi-durable"] ?? 0),
    },
    production: {
      path: production,
      sessionsLance: fs.existsSync(production) ? allocatedBytes(production) : null,
      note: "directory metadata only; the production DB was not opened",
    },
  };
  if (out !== undefined) {
    const prev = process.umask(0o077);
    try {
      fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n", { flag: "wx", mode: 0o600 });
    } finally {
      process.umask(prev);
    }
  }
  return report;
}

async function main(): Promise<number> {
  try {
    const report = await runMeasure(process.argv.slice(2), defaultBuildEnv());
    console.log(JSON.stringify(report, null, 1));
    return report.db && report.pairs.jsonlPairOk && report.pairs.durablePairOk ? 0 : 3;
  } catch (e) {
    console.error(`REFUSED candidate-measure: ${e instanceof MeasureRefused ? e.code : "error"}`);
    return 2;
  }
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  main().then((code) => process.exit(code));
}
