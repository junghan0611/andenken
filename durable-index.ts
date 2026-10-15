/**
 * Incremental indexing of corpus pi-durable snapshots into sessions.lance
 * (issue #15, purpose 1). Driven by `./run.sh index:durable [--dry-run]`.
 *
 * Its own manifest, `data/durable-manifest.json` — never session-manifest.json,
 * whose consumers (status, doctor, estimate) count JSONL files. Per corpus
 * snapshot it keeps:
 *
 *   lineage      root pi.provider sessionId the rows came from
 *   policy       admission policy version (DURABLE_POLICY); another is refused
 *   processedId  every entry ≤ this was decided and its included rows flushed
 *   witness      the last entry ≤ processedId and the sha256 of its record
 *
 * One file's run, in order:
 *   1. lineage, policy and witness must match the manifest, and the snapshot
 *      must not have fewer entries — else a named refusal, nothing deleted
 *   2. delete the file's rows above processedId (only a failed run's leftovers)
 *   3. extract B.1 includes in (processedId, safeProcessedId] — entries of a
 *      run still open in this snapshot wait for a later one
 *   4. embed, append, flush
 *   5. only then advance processedId + witness and save the manifest atomically
 * A failure in 2–5 leaves the manifest where it was; the next run repeats from
 * step 2 and ends with the same rows.
 *
 * Duplicates: one lineage found under several corpus paths is indexed once —
 * the copy with the most entries (ties: the smaller path); the rest are
 * reported as aliases.
 *
 * `dryRun` touches neither provider, store nor manifest.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DurableReadRefused } from "./durable-reader.js";
import { CHARS_PER_TOKEN, DURABLE_POLICY, planDurable, type DurablePlan } from "./durable-plan.js";
import {
  durableIdentity,
  extractDurableRows,
  findDurableSnapshots,
  witnessAt,
  witnessHolds,
  type DurableCorpusFile,
  type DurableRow,
  type DurableWitness,
} from "./durable-source.js";
import { WriteBuffer } from "./write-buffer.js";

export interface DurableManifestEntry {
  lineage: string | null;
  device: string;
  bucket: string;
  session: string;
  policy: string;
  processedId: number;
  witness: DurableWitness | null;
  chunks: number;
  updatedAt: string;
}

export interface DurableManifest {
  version: 1;
  files: Record<string, DurableManifestEntry>;
  lastUpdated: string;
}

export function loadDurableManifest(file: string): DurableManifest {
  if (!fs.existsSync(file)) return { version: 1, files: {}, lastUpdated: "" };
  const m = JSON.parse(fs.readFileSync(file, "utf-8")) as DurableManifest;
  if (m.version !== 1 || typeof m.files !== "object") throw new Error(`${file} is not a durable manifest v1`);
  return m;
}

/** Write-to-temp, fsync, rename: a reader sees the old manifest or the new one, never half of one. */
export function saveDurableManifest(file: string, manifest: DurableManifest): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o644);
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * The durable checkpoint must never outlive the rows it describes. Called by
 * every path that wipes sessions.lance (index:sessions --force, pi /memory
 * force) while holding the sessions writer lock.
 */
export function invalidateDurableManifest(manifestPath: string): void {
  fs.rmSync(manifestPath, { force: true });
}

/** Drop the checkpoints of files whose rows were deleted (cleanup orphans); a re-admitted copy re-indexes from 0. */
export function forgetDurableFiles(manifestPath: string, files: Iterable<string>): string[] {
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = loadDurableManifest(manifestPath);
  const dropped = [...files].filter((f) => f in manifest.files);
  if (dropped.length === 0) return [];
  for (const f of dropped) delete manifest.files[f];
  manifest.lastUpdated = new Date().toISOString();
  saveDurableManifest(manifestPath, manifest);
  return dropped;
}

export interface DurableStore {
  deleteByFile(file: string): Promise<void>;
  deleteByFileAbove(file: string, lineNumber: number): Promise<void>;
  addChunksRaw(rows: Array<DurableRow & { vector: number[] }>): Promise<void>;
}

export interface DurableProvider {
  embedDocumentBatch(texts: string[]): Promise<number[][]>;
}

export interface DurableIndexDeps {
  corpus: string;
  manifestPath: string;
  dryRun: boolean;
  store?: DurableStore;
  provider?: DurableProvider;
  liveRoots?: string[];
  batchSize?: number;
  /** Test seam for the manifest write; defaults to saveDurableManifest. */
  saveManifest?: (file: string, manifest: DurableManifest) => void;
}

export interface DurableFileReport {
  file: string;
  device: string;
  session: string;
  lineage: string | null;
  status: "indexed" | "planned" | "up-to-date" | "refused" | "failed";
  reason?: string;
  range: { after: number; upTo: number };
  maxEntryId: number;
  heldBy: number | null;
  rows: number;
  chars: number;
  estTokens: number;
  candidates: number;
  sanitizeDrops: Record<string, number>;
  /** Entry ids (no text) the policy did not embed for a reason the reader should see. */
  ambiguous: number[];
  held: number[];
  compare: { B: number; C: number };
  /** Turns after this snapshot are not collected until a newer snapshot is admitted. */
  freshness: { maxEntryId: number; snapshotMtime: string };
}

export interface DurableIndexReport {
  policy: string;
  dryRun: boolean;
  files: DurableFileReport[];
  aliases: Array<{ file: string; winner: string; lineage: string }>;
}

interface Candidate extends DurableCorpusFile {
  lineage: string | null;
  maxEntryId: number;
}

async function chooseWinners(files: DurableCorpusFile[], liveRoots?: string[]) {
  const withId: Candidate[] = [];
  const refused: Array<{ f: DurableCorpusFile; reason: string }> = [];
  for (const f of files) {
    try {
      const id = await durableIdentity(f.file, { liveRoots });
      withId.push({ ...f, lineage: id.lineage, maxEntryId: id.maxEntryId });
    } catch (err) {
      refused.push({ f, reason: err instanceof DurableReadRefused ? `${err.reason}: ${err.detail}` : String(err) });
    }
  }
  const byKey = new Map<string, Candidate[]>();
  for (const c of withId) {
    const key = c.lineage ?? `session:${c.session}`;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const winners: Candidate[] = [];
  const aliases: DurableIndexReport["aliases"] = [];
  for (const [key, group] of byKey) {
    group.sort((a, b) => b.maxEntryId - a.maxEntryId || (a.file < b.file ? -1 : 1));
    winners.push(group[0]);
    for (const g of group.slice(1)) aliases.push({ file: g.file, winner: group[0].file, lineage: key });
  }
  winners.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { winners, aliases, refused };
}

function baseReport(c: Candidate, plan: DurablePlan | null, after: number): DurableFileReport {
  return {
    file: c.file,
    device: c.device,
    session: c.session,
    lineage: c.lineage,
    status: "planned",
    range: { after, upTo: plan?.watermark.safeProcessedId ?? after },
    maxEntryId: c.maxEntryId,
    heldBy: plan?.watermark.heldBy ?? null,
    rows: 0,
    chars: 0,
    estTokens: 0,
    candidates: 0,
    sanitizeDrops: {},
    ambiguous: plan ? plan.candidates.filter((x) => x.B.decision === "ambiguous").map((x) => x.entryId) : [],
    held: plan ? plan.candidates.filter((x) => x.B.decision === "hold").map((x) => x.entryId) : [],
    compare: {
      B: plan ? plan.candidates.filter((x) => x.B.decision === "include").length : 0,
      C: plan ? plan.candidates.filter((x) => x.C.decision === "include").length : 0,
    },
    freshness: { maxEntryId: c.maxEntryId, snapshotMtime: new Date(fs.statSync(c.file).mtimeMs).toISOString() },
  };
}

/**
 * Index (or, with dryRun, plan) every corpus durable snapshot. A writing run must
 * hold the shared sessions writer lock (sessions-lock.ts) — the caller takes it.
 * Throws only on a manifest-load error.
 */
export async function runDurableIndex(deps: DurableIndexDeps): Promise<DurableIndexReport> {
  if (!deps.dryRun && (!deps.store || !deps.provider)) throw new Error("runDurableIndex: store and provider are required unless dryRun");
  const save = deps.saveManifest ?? saveDurableManifest;
  const opts = { liveRoots: deps.liveRoots };
  {
    const manifest = loadDurableManifest(deps.manifestPath);
    const { winners, aliases, refused } = await chooseWinners(findDurableSnapshots(deps.corpus), deps.liveRoots);
    const report: DurableIndexReport = { policy: DURABLE_POLICY, dryRun: deps.dryRun, files: [], aliases };
    for (const r of refused) {
      report.files.push({
        ...baseReport({ ...r.f, lineage: null, maxEntryId: 0 }, null, 0),
        status: "refused",
        reason: r.reason,
      });
    }

    for (const c of winners) {
      const prev = manifest.files[c.file];
      const after = prev?.processedId ?? 0;
      const refuse = (reason: string): void => {
        report.files.push({ ...baseReport(c, null, after), status: "refused", reason });
      };
      // One lineage, one indexed path: a copy elsewhere that becomes the winner would
      // re-embed everything beside the rows already accepted. Refuse, never migrate.
      const key = c.lineage ?? `session:${c.session}`;
      const elsewhere = Object.entries(manifest.files).find(([f, e]) => f !== c.file && (e.lineage ?? `session:${e.session}`) === key);
      if (elsewhere) {
        refuse(`durable-winner-path-changed: ${key} is already indexed from ${elsewhere[0]}; this copy is ${c.file}`);
        continue;
      }
      if (prev && prev.policy !== DURABLE_POLICY) {
        refuse(`durable-policy-changed: manifest ${prev.policy}, code ${DURABLE_POLICY}`);
        continue;
      }
      if (prev && prev.lineage !== c.lineage) {
        refuse(`durable-lineage-mismatch: manifest ${prev.lineage ?? "unknown"}, snapshot ${c.lineage ?? "unknown"}`);
        continue;
      }
      if (prev && c.maxEntryId < prev.processedId) {
        refuse(`durable-rollback: snapshot maxEntryId ${c.maxEntryId} < processedId ${prev.processedId}`);
        continue;
      }
      if (prev?.witness && !witnessHolds(c.file, prev.witness, opts)) {
        refuse(`durable-diverged: witness e${prev.witness.id} is absent or different`);
        continue;
      }

      const plan = await planDurable(c.file, opts);
      const r = baseReport(c, plan, after);
      const upTo = Math.max(after, plan.watermark.safeProcessedId);
      r.range = { after, upTo };
      const extraction = await extractDurableRows(c.file, plan, { after, upTo }, { device: c.device, session: c.session }, opts);
      r.rows = extraction.rows.length;
      r.candidates = extraction.candidates;
      r.sanitizeDrops = extraction.sanitizeDrops;
      r.chars = extraction.rows.reduce((n, x) => n + x.text.length, 0);
      r.estTokens = Math.ceil(r.chars / CHARS_PER_TOKEN);

      if (deps.dryRun) {
        r.status = upTo > after || r.rows > 0 ? "planned" : "up-to-date";
        report.files.push(r);
        continue;
      }
      if (upTo === after && r.rows === 0 && prev) {
        r.status = "up-to-date";
        report.files.push(r);
        continue;
      }

      try {
        await deps.store!.deleteByFileAbove(c.file, after);
        const wb = new WriteBuffer(deps.store!, deps.batchSize ?? 500);
        const batch = deps.batchSize ?? 64;
        for (let i = 0; i < extraction.rows.length; i += batch) {
          const slice = extraction.rows.slice(i, i + batch);
          const vectors = await deps.provider!.embedDocumentBatch(slice.map((x) => x.text));
          if (vectors.length !== slice.length) throw new Error(`provider returned ${vectors.length} vectors for ${slice.length} texts`);
          await wb.append(slice.map((x, j) => ({ ...x, vector: vectors[j] })));
        }
        await wb.flush();
        manifest.files[c.file] = {
          lineage: c.lineage,
          device: c.device,
          bucket: c.bucket,
          session: c.session,
          policy: DURABLE_POLICY,
          processedId: upTo,
          witness: witnessAt(c.file, upTo, opts),
          chunks: (prev?.chunks ?? 0) + extraction.rows.length,
          updatedAt: new Date().toISOString(),
        };
        manifest.lastUpdated = manifest.files[c.file].updatedAt;
        save(deps.manifestPath, manifest);
        r.status = "indexed";
      } catch (err) {
        // The manifest entry is restored so a later file's save cannot carry a half-done checkpoint.
        if (prev) manifest.files[c.file] = prev;
        else delete manifest.files[c.file];
        r.status = "failed";
        r.reason = err instanceof Error ? err.message : String(err);
      }
      report.files.push(r);
    }
    return report;
  }
}

/** Text summary; carries entry ids and counts, never entry text. */
export function renderDurableIndexReport(report: DurableIndexReport): string {
  const lines: string[] = [];
  lines.push(`# index:durable ${report.dryRun ? "--dry-run (API 0: no embedding, no store, no manifest)" : "(paid run)"} policy=${report.policy}`);
  for (const f of report.files) {
    lines.push("");
    lines.push(`${f.status.toUpperCase()} ${f.file}`);
    lines.push(`  device=${f.device} session=${f.session} lineage=${f.lineage ?? "unknown"}`);
    if (f.reason) lines.push(`  reason: ${f.reason}`);
    if (f.status === "refused") continue;
    lines.push(`  range e${f.range.after + 1}..e${f.range.upTo} of maxEntryId ${f.maxEntryId}${f.heldBy !== null ? ` (held from open human e${f.heldBy})` : ""}`);
    lines.push(`  rows=${f.rows} from ${f.candidates} included entries, chars=${f.chars}, estTokens=${f.estTokens} (chars/${CHARS_PER_TOKEN})`);
    const drops = Object.entries(f.sanitizeDrops);
    lines.push(`  sanitize drops: ${drops.length ? drops.map(([k, v]) => `${k}×${v}`).join(", ") : "none"}`);
    lines.push(`  ambiguous (not embedded): ${f.ambiguous.length ? f.ambiguous.map((x) => `e${x}`).join(" ") : "none"}`);
    lines.push(`  held (later snapshot): ${f.held.length ? f.held.map((x) => `e${x}`).join(" ") : "none"}`);
    lines.push(`  whole-snapshot comparison: B includes ${f.compare.B}, C includes ${f.compare.C}`);
    lines.push(`  freshness: turns after e${f.freshness.maxEntryId} (snapshot file ${f.freshness.snapshotMtime}) are not collected`);
  }
  for (const a of report.aliases) lines.push(`\nALIAS ${a.file}\n  same lineage ${a.lineage} as ${a.winner} — not indexed`);
  if (report.files.length === 0) lines.push("\n(no durable snapshots in the corpus)");
  return lines.join("\n");
}
