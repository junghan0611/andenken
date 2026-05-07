/**
 * andenken doctor — org triage (stage 1)
 *
 * Usage (via doctor.ts):
 *   npx tsx doctor.ts --org
 *   npx tsx doctor.ts --org --json
 *   npx tsx doctor.ts --org --no-smoke
 *   npx tsx doctor.ts --org --save-baseline
 *
 * Scope (stage 1, read-only, local-only):
 *   1. Retrieval smoke — 6 representative probes
 *   2. Chunk health    — DB-level stats
 *   3. Org structure   — cheap file-level scan
 *
 * doctor is NOT a replacement for ./run.sh verify or golden-queries.
 * It is the operator triage layer that sits between them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VectorStore, getOrgDbPath, getDataDir } from "./store.js";
import {
  findOrgFiles,
  shouldIndexOrgFile,
  parseOrgFrontMatter,
  parseOrgHeadings,
} from "./org-chunker.js";
import {
  createProviderFromEnv,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import {
  retrieve,
  expandQueryForBM25,
  isScaffoldChunk,
  type MergeStrategy,
} from "./retriever.js";

// ── Types ─────────────────────────────────────────────────────────────

export type OrgStatus = "OK" | "WARN" | "FAIL" | "SKIP";

export interface ProbeResult {
  id: string;
  kind: "cross-lingual" | "stem" | "local-concept" | "definition" | "hard-negative";
  query: string;
  status: OrgStatus;
  resultCount: number;
  top1Snippet: string;
  vectorHit: boolean;
  ftsHit: boolean;
  top1Scaffold: boolean;
  failReason?: string;
}

export interface ChunkHealth {
  total: number;
  indexedFiles: number;
  headingChunks: number;
  contentChunks: number;
  headingRatio: number;   // heading / (heading+content)
  zeroChunkUnexpected: number;
  concentrationTop: Array<{ file: string; count: number }>;
  hardGuardSkipTotal: number;
  hardGuardSkipFiles: number;
  hardGuardSkipTop: Array<{ file: string; skipped: number }>;
}

export interface StructureHealth {
  orgFiles: number;
  malformedBlockFiles: Array<{ file: string; imbalances: string[] }>;
  oversizeRiskFiles: Array<{ file: string; chars: number }>;
  microHeadingChainFiles: Array<{ file: string; chainLen: number; startLine: number }>;
  maxHeadingDepth: number;
  zeroChunkUnexpectedFiles: string[];
}

export interface Baseline {
  savedAt: string;
  device: string;
  chunk: {
    total: number;
    indexedFiles: number;
    headingChunks: number;
    contentChunks: number;
    zeroChunkUnexpected: number;
    hardGuardSkipTotal: number;
    hardGuardSkipFiles: number;
  };
  structure: {
    orgFiles: number;
    malformedBlockFiles: number;
    oversizeRiskFiles: number;
    microHeadingChainFiles: number;
    maxHeadingDepth: number;
  };
}

export interface OrgReport {
  device: string;
  time: string;
  baseline: { savedAt: string; ageDays: number } | null;
  probes: ProbeResult[];
  chunk: ChunkHealth;
  structure: StructureHealth;
  delta: {
    chunkTotal: number | null;
    indexedFiles: number | null;
    zeroChunkUnexpected: number | null;
    hardGuardSkipTotal: number | null;
    hardGuardSkipFiles: number | null;
    orgFiles: number | null;
    malformedBlockFiles: number | null;
    oversizeRiskFiles: number | null;
    microHeadingChainFiles: number | null;
  };
  verdict: OrgStatus;
  /**
   * Human-readable reasons for the current verdict.
   *
   * Operator triage tool — the verdict alone ("WARN") doesn't help, the
   * operator needs to know which signals tripped it. Empty array on OK.
   */
  reasons: string[];
}

// ── Config ────────────────────────────────────────────────────────────

const OVERSIZE_CHARS = 20_000;        // matches garden maintenance risk threshold
const MICRO_CHAIN_MIN_LEN = 4;        // 4+ consecutive L4+ micro-headings = suspicious chain
const CONCENTRATION_TOP_N = 5;
const STRUCTURE_TOP_N = 10;
const BASELINE_PATH = () => path.join(getDataDir(), "doctor-org-baseline.json");

// ── Smoke probes ──────────────────────────────────────────────────────

interface ProbeSpec {
  id: string;
  kind: ProbeResult["kind"];
  query: string;
  expectKeywords?: string[];
  top1NoScaffold?: boolean;
  forbidTopK?: string[];
  topK?: number;
}

const PROBES: ProbeSpec[] = [
  {
    id: "cross-lingual",
    kind: "cross-lingual",
    query: "보편 학문",
    expectKeywords: ["보편", "paideia", "universalism", "학문"],
  },
  {
    id: "stem",
    kind: "stem",
    query: "설계했다",
    expectKeywords: ["설계"],
  },
  {
    id: "local-concept-ereignis",
    kind: "local-concept",
    query: "존재사건",
    expectKeywords: ["존재", "사건", "Ereignis"],
  },
  {
    id: "local-concept-ddeutsaegim",
    kind: "local-concept",
    query: "뜻새김",
  },
  {
    id: "definition-andenken",
    kind: "definition",
    query: "Andenken 뜻",
    expectKeywords: ["Andenken", "뜻새김", "Heidegger", "recollective"],
    top1NoScaffold: true,
  },
  {
    id: "hard-negative-piutuseong",
    kind: "hard-negative",
    query: "피투성",
    forbidTopK: [":ARCHIVE:", ":LLMLOG:"],
    topK: 10,
  },
];

async function runProbe(
  spec: ProbeSpec,
  provider: EmbeddingProvider,
  store: VectorStore,
): Promise<ProbeResult> {
  const topK = spec.topK ?? 5;
  const bm25Query = expandQueryForBM25(spec.query);

  const qv = await provider.embedQuery(spec.query);
  const vec = await store.search(qv, 20, 0.05);
  const fts = await store.fullTextSearch(bm25Query, 20);

  const merged = await retrieve(spec.query, vec, fts, {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    recencyHalfLifeDays: 90,
    minScore: 0.05,
    mergeStrategy: "weighted" as MergeStrategy,
    mmr: { enabled: true, lambda: 0.7 },
  });

  const top = merged.slice(0, topK);
  const top1 = top[0];
  const top1Text = top1?.text ?? "";
  const top1Snippet = top1Text.slice(0, 120).replace(/\n/g, " ");
  const top1Scaffold = top1 ? isScaffoldChunk(top1Text) : false;

  // vector/FTS signal presence: did the unfiltered raw searches return rows?
  const vectorHit = vec.length > 0;
  const ftsHit = fts.length > 0;

  let status: OrgStatus = "OK";
  let failReason: string | undefined;

  if (top.length === 0) {
    status = "FAIL";
    failReason = "no results";
  } else if (spec.expectKeywords && spec.expectKeywords.length > 0) {
    const joined = top.map((r) => r.text.toLowerCase()).join(" ");
    if (!spec.expectKeywords.some((k) => joined.includes(k.toLowerCase()))) {
      status = "WARN";
      failReason = `no expected keyword in top-${topK}`;
    }
  }

  if (status === "OK" && spec.top1NoScaffold && top1Scaffold) {
    status = "WARN";
    failReason = "top-1 is a scaffold chunk";
  }

  if (status === "OK" && spec.forbidTopK && spec.forbidTopK.length > 0) {
    for (let i = 0; i < top.length; i++) {
      const hit = spec.forbidTopK.find((kw) => top[i].text.includes(kw));
      if (hit !== undefined) {
        status = "FAIL";
        failReason = `top${i + 1} contains forbidden "${hit}"`;
        break;
      }
    }
  }

  return {
    id: spec.id,
    kind: spec.kind,
    query: spec.query,
    status,
    resultCount: top.length,
    top1Snippet,
    vectorHit,
    ftsHit,
    top1Scaffold,
    failReason,
  };
}

async function runSmokeProbes(): Promise<ProbeResult[] | null> {
  const provider = createProviderFromEnv();
  if (!provider) return null;

  const dbPath = getOrgDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const store = new VectorStore(dbPath, provider.dimensions || 2560);
  await store.init();
  const results: ProbeResult[] = [];
  try {
    for (const spec of PROBES) {
      try {
        results.push(await runProbe(spec, provider, store));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({
          id: spec.id,
          kind: spec.kind,
          query: spec.query,
          status: "FAIL",
          resultCount: 0,
          top1Snippet: "",
          vectorHit: false,
          ftsHit: false,
          top1Scaffold: false,
          failReason: msg.slice(0, 100),
        });
      }
    }
  } finally {
    await store.close();
  }
  return results;
}

// ── Chunk health ──────────────────────────────────────────────────────

async function collectChunkHealth(
  manifestZeroChunkUnexpected: string[],
  hardGuard: { total: number; files: number; top: Array<{ file: string; skipped: number }> },
): Promise<ChunkHealth> {
  const dbPath = getOrgDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      total: 0,
      indexedFiles: 0,
      headingChunks: 0,
      contentChunks: 0,
      headingRatio: 0,
      zeroChunkUnexpected: manifestZeroChunkUnexpected.length,
      concentrationTop: [],
      hardGuardSkipTotal: hardGuard.total,
      hardGuardSkipFiles: hardGuard.files,
      hardGuardSkipTop: hardGuard.top,
    };
  }

  const store = new VectorStore(dbPath, 2560);
  await store.init();
  const count = await store.getCount();

  // Single pass: pull (sessionFile, role) from all rows — cheap vs fetching vectors.
  const table = (store as any).table;
  const rows: Array<{ sessionFile: string; role: string }> =
    table
      ? await table.query().select(["sessionFile", "role"]).limit(count + 1000).toArray()
      : [];
  await store.close();

  const fileCounts = new Map<string, number>();
  let headingChunks = 0;
  let contentChunks = 0;

  for (const r of rows) {
    fileCounts.set(r.sessionFile, (fileCounts.get(r.sessionFile) ?? 0) + 1);
    if (r.role === "heading") headingChunks++;
    else if (r.role === "content") contentChunks++;
  }

  const concentrationTop = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONCENTRATION_TOP_N)
    .map(([file, c]) => ({ file, count: c }));

  const total = count;
  const split = headingChunks + contentChunks;
  const headingRatio = split > 0 ? headingChunks / split : 0;

  return {
    total,
    indexedFiles: fileCounts.size,
    headingChunks,
    contentChunks,
    headingRatio,
    zeroChunkUnexpected: manifestZeroChunkUnexpected.length,
    concentrationTop,
    hardGuardSkipTotal: hardGuard.total,
    hardGuardSkipFiles: hardGuard.files,
    hardGuardSkipTop: hardGuard.top,
  };
}

// ── Structure health ──────────────────────────────────────────────────

const BLOCK_BEGIN_RE = /^\s*#\+begin_([a-zA-Z]+)/i;
const BLOCK_END_RE = /^\s*#\+end_([a-zA-Z]+)/i;

function scanBlockPairing(lines: string[]): string[] {
  const stack: string[] = [];
  const issues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const b = BLOCK_BEGIN_RE.exec(line);
    if (b) {
      stack.push(b[1].toLowerCase());
      continue;
    }
    const e = BLOCK_END_RE.exec(line);
    if (e) {
      const kind = e[1].toLowerCase();
      const topIdx = stack.lastIndexOf(kind);
      if (topIdx === -1) {
        issues.push(`L${i + 1}: stray #+end_${kind}`);
      } else {
        // close and drop anything stacked above (unclosed nested blocks)
        for (let k = stack.length - 1; k > topIdx; k--) {
          issues.push(`unclosed #+begin_${stack[k]}`);
        }
        stack.length = topIdx;
      }
    }
  }
  for (const k of stack) issues.push(`unclosed #+begin_${k}`);
  return issues;
}

function scanMicroHeadingChains(
  content: string,
): { chainLen: number; startLine: number } | null {
  const headings = parseOrgHeadings(content);
  if (headings.length < MICRO_CHAIN_MIN_LEN) return null;

  let best: { chainLen: number; startLine: number } | null = null;
  let run = 0;
  let runStart = -1;
  for (const h of headings) {
    if (h.level >= 4) {
      if (run === 0) runStart = h.lineNumber;
      run++;
      if (!best || run > best.chainLen) {
        best = { chainLen: run, startLine: runStart };
      }
    } else {
      run = 0;
    }
  }
  return best && best.chainLen >= MICRO_CHAIN_MIN_LEN ? best : null;
}

function collectStructureHealth(
  zeroChunkUnexpectedFiles: string[],
): StructureHealth {
  const files = findOrgFiles().filter((f) => shouldIndexOrgFile(f));

  const malformed: Array<{ file: string; imbalances: string[] }> = [];
  const oversize: Array<{ file: string; chars: number }> = [];
  const microChains: Array<{ file: string; chainLen: number; startLine: number }> = [];
  let maxDepth = 0;

  for (const f of files) {
    let content: string;
    try {
      content = fs.readFileSync(f, "utf-8");
    } catch {
      continue;
    }

    if (content.length >= OVERSIZE_CHARS) {
      oversize.push({ file: f, chars: content.length });
    }

    const lines = content.split("\n");
    const issues = scanBlockPairing(lines);
    if (issues.length > 0) malformed.push({ file: f, imbalances: issues });

    const headings = parseOrgHeadings(content);
    for (const h of headings) if (h.level > maxDepth) maxDepth = h.level;

    const chain = scanMicroHeadingChains(content);
    if (chain) microChains.push({ file: f, ...chain });
  }

  oversize.sort((a, b) => b.chars - a.chars);
  microChains.sort((a, b) => b.chainLen - a.chainLen);

  return {
    orgFiles: files.length,
    malformedBlockFiles: malformed.slice(0, STRUCTURE_TOP_N),
    oversizeRiskFiles: oversize.slice(0, STRUCTURE_TOP_N),
    microHeadingChainFiles: microChains.slice(0, STRUCTURE_TOP_N),
    maxHeadingDepth: maxDepth,
    zeroChunkUnexpectedFiles: zeroChunkUnexpectedFiles.slice(0, STRUCTURE_TOP_N),
  };
}

interface OrgManifestEntry {
  chunks: number;
  skippedOversize?: number;
}

interface OrgManifestShape {
  files: Record<string, OrgManifestEntry>;
}

function loadOrgManifest(): OrgManifestShape | null {
  const manifestPath = path.join(getDataDir(), "org-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as OrgManifestShape;
  } catch {
    return null;
  }
}

// Zero-chunk unexpected = manifest entry has chunks=0 AND file has no exclusion tag.
// Source: org-manifest.json written by the indexer.
function computeZeroChunkUnexpected(manifest: OrgManifestShape | null): string[] {
  if (!manifest) return [];
  const candidates = Object.entries(manifest.files ?? {})
    .filter(([, v]) => (v.chunks ?? 0) === 0)
    .map(([f]) => f);

  const unexpected: string[] = [];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;        // deleted — not unexpected
    if (!shouldIndexOrgFile(f)) continue;   // folder/filter excluded — expected
    try {
      const content = fs.readFileSync(f, "utf-8");
      const meta = parseOrgFrontMatter(content, f);
      const tags = meta.filetags.map((t) => t.toLowerCase());
      const hasSkipTag = ["noexport", "tts", "noembed", "llmlog", "archive"].some((t) =>
        tags.includes(t),
      );
      if (hasSkipTag) continue;             // tag-excluded — expected
      unexpected.push(f);
    } catch {
      // unreadable — skip
    }
  }
  return unexpected;
}

function computeHardGuardSkips(manifest: OrgManifestShape | null): {
  total: number;
  files: number;
  top: Array<{ file: string; skipped: number }>;
} {
  if (!manifest) return { total: 0, files: 0, top: [] };
  const entries = Object.entries(manifest.files ?? {})
    .map(([file, v]) => ({ file, skipped: v.skippedOversize ?? 0 }))
    .filter((e) => e.skipped > 0);
  const total = entries.reduce((s, e) => s + e.skipped, 0);
  entries.sort((a, b) => b.skipped - a.skipped);
  return { total, files: entries.length, top: entries.slice(0, STRUCTURE_TOP_N) };
}

// ── Baseline ──────────────────────────────────────────────────────────

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH(), "utf-8"));
  } catch {
    return null;
  }
}

function saveBaseline(b: Baseline): void {
  fs.writeFileSync(BASELINE_PATH(), JSON.stringify(b, null, 2));
}

function makeBaseline(device: string, chunk: ChunkHealth, structure: StructureHealth): Baseline {
  return {
    savedAt: new Date().toISOString(),
    device,
    chunk: {
      total: chunk.total,
      indexedFiles: chunk.indexedFiles,
      headingChunks: chunk.headingChunks,
      contentChunks: chunk.contentChunks,
      zeroChunkUnexpected: chunk.zeroChunkUnexpected,
      hardGuardSkipTotal: chunk.hardGuardSkipTotal,
      hardGuardSkipFiles: chunk.hardGuardSkipFiles,
    },
    structure: {
      orgFiles: structure.orgFiles,
      malformedBlockFiles: structure.malformedBlockFiles.length,
      oversizeRiskFiles: structure.oversizeRiskFiles.length,
      microHeadingChainFiles: structure.microHeadingChainFiles.length,
      maxHeadingDepth: structure.maxHeadingDepth,
    },
  };
}

function computeDelta(baseline: Baseline | null, chunk: ChunkHealth, structure: StructureHealth) {
  if (!baseline) {
    return {
      chunkTotal: null,
      indexedFiles: null,
      zeroChunkUnexpected: null,
      hardGuardSkipTotal: null,
      hardGuardSkipFiles: null,
      orgFiles: null,
      malformedBlockFiles: null,
      oversizeRiskFiles: null,
      microHeadingChainFiles: null,
    };
  }
  // Guard legacy baselines that pre-date hardGuardSkip fields.
  const baseSkipTotal = baseline.chunk.hardGuardSkipTotal ?? 0;
  const baseSkipFiles = baseline.chunk.hardGuardSkipFiles ?? 0;
  return {
    chunkTotal: chunk.total - baseline.chunk.total,
    indexedFiles: chunk.indexedFiles - baseline.chunk.indexedFiles,
    zeroChunkUnexpected: chunk.zeroChunkUnexpected - baseline.chunk.zeroChunkUnexpected,
    hardGuardSkipTotal: chunk.hardGuardSkipTotal - baseSkipTotal,
    hardGuardSkipFiles: chunk.hardGuardSkipFiles - baseSkipFiles,
    orgFiles: structure.orgFiles - baseline.structure.orgFiles,
    malformedBlockFiles:
      structure.malformedBlockFiles.length - baseline.structure.malformedBlockFiles,
    oversizeRiskFiles:
      structure.oversizeRiskFiles.length - baseline.structure.oversizeRiskFiles,
    microHeadingChainFiles:
      structure.microHeadingChainFiles.length - baseline.structure.microHeadingChainFiles,
  };
}

// ── Verdict ───────────────────────────────────────────────────────────

function verdict(report: Omit<OrgReport, "verdict" | "reasons">): { status: OrgStatus; reasons: string[] } {
  const reasons: string[] = [];

  const probeFail = report.probes.some((p) => p.status === "FAIL");
  const probeWarn = report.probes.some((p) => p.status === "WARN");
  const failedProbes = report.probes.filter((p) => p.status === "FAIL").map((p) => p.id);
  const warnedProbes = report.probes.filter((p) => p.status === "WARN").map((p) => p.id);

  const structFail =
    report.structure.malformedBlockFiles.length > 0 ||
    report.structure.zeroChunkUnexpectedFiles.length > 0;

  const chunkFail = report.chunk.total === 0 || report.chunk.indexedFiles === 0;

  // Baseline-driven regression signals
  const d = report.delta;
  const regressionItems: string[] = [];
  if (d.chunkTotal !== null && d.chunkTotal < -50)
    regressionItems.push(`chunkTotal Δ${signed(d.chunkTotal)}`);
  if (d.indexedFiles !== null && d.indexedFiles < -2)
    regressionItems.push(`indexedFiles Δ${signed(d.indexedFiles)}`);
  if (d.malformedBlockFiles !== null && d.malformedBlockFiles > 0)
    regressionItems.push(`malformedBlockFiles Δ${signed(d.malformedBlockFiles)}`);
  if (d.zeroChunkUnexpected !== null && d.zeroChunkUnexpected > 0)
    regressionItems.push(`zeroChunkUnexpected Δ${signed(d.zeroChunkUnexpected)}`);
  if (d.hardGuardSkipTotal !== null && d.hardGuardSkipTotal > 0)
    regressionItems.push(`hardGuardSkipTotal Δ${signed(d.hardGuardSkipTotal)}`);
  const regressed = regressionItems.length > 0;

  // Build human-readable reasons in the same priority order verdict uses
  if (chunkFail) {
    if (report.chunk.total === 0) reasons.push("chunk total = 0 (DB empty)");
    if (report.chunk.indexedFiles === 0) reasons.push("indexedFiles = 0");
  }
  if (probeFail) {
    reasons.push(`smoke probe FAIL: ${failedProbes.join(", ")}`);
  }
  if (report.structure.malformedBlockFiles.length > 0) {
    reasons.push(`malformedBlockFiles=${report.structure.malformedBlockFiles.length}`);
  }
  if (report.structure.zeroChunkUnexpectedFiles.length > 0) {
    reasons.push(`zeroChunkUnexpectedFiles=${report.structure.zeroChunkUnexpectedFiles.length}`);
  }
  if (regressed) {
    reasons.push(`baseline regression: ${regressionItems.join(", ")}`);
  }
  if (probeWarn && reasons.length === 0) {
    reasons.push(`smoke probe WARN: ${warnedProbes.join(", ")}`);
  }

  let status: OrgStatus;
  if (probeFail || chunkFail) status = "FAIL";
  else if (structFail || regressed) status = "WARN";
  else if (probeWarn) status = "WARN";
  else status = "OK";

  return { status, reasons };
}

// ── Build + render ────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function signed(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "±0";
  return n > 0 ? `+${n}` : `${n}`;
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return -1;
  return Math.round((Date.now() - t) / 86_400_000);
}

export async function buildOrgReport(opts: { smoke: boolean; device: string; time: string }): Promise<OrgReport> {
  const manifest = loadOrgManifest();
  const zeroChunkUnexpectedFiles = computeZeroChunkUnexpected(manifest);
  const hardGuard = computeHardGuardSkips(manifest);
  const chunk = await collectChunkHealth(zeroChunkUnexpectedFiles, hardGuard);
  const structure = collectStructureHealth(zeroChunkUnexpectedFiles);

  const probes = opts.smoke ? ((await runSmokeProbes()) ?? []) : [];

  const baseline = loadBaseline();
  const delta = computeDelta(baseline, chunk, structure);

  const base = {
    device: opts.device,
    time: opts.time,
    baseline: baseline ? { savedAt: baseline.savedAt, ageDays: daysSince(baseline.savedAt) } : null,
    probes,
    chunk,
    structure,
    delta,
  };
  const v = verdict(base);
  return { ...base, verdict: v.status, reasons: v.reasons };
}

export function renderOrgReport(r: OrgReport): string {
  const icon = (s: OrgStatus) =>
    s === "OK" ? "✅" : s === "WARN" ? "⚠️ " : s === "FAIL" ? "❌" : "⏭️ ";

  const out: string[] = [];
  out.push("");
  out.push("🩺 andenken doctor — org triage");
  out.push(`   device: ${r.device}  |  ${r.time}`);
  if (r.baseline) {
    out.push(`   baseline: ${r.baseline.savedAt.slice(0, 10)}  (${r.baseline.ageDays}d ago)`);
  } else {
    out.push(`   baseline: — (run with --save-baseline to establish)`);
  }
  out.push("─".repeat(68));

  // Retrieval smoke
  out.push("");
  out.push("[Retrieval smoke]");
  if (r.probes.length === 0) {
    out.push("  ⏭  skipped (no provider or --no-smoke)");
  } else {
    for (const p of r.probes) {
      const sigBits = [
        p.vectorHit ? "V" : "·",
        p.ftsHit ? "B" : "·",
        p.top1Scaffold ? "S!" : "s ",
      ].join("");
      const extra = p.failReason ? `  (${p.failReason})` : "";
      const snip = p.top1Snippet ? `  → "${p.top1Snippet}"` : "";
      out.push(
        `  ${icon(p.status)} ${p.kind.padEnd(14)} "${p.query}"  [${sigBits}] n=${p.resultCount}${extra}${snip}`,
      );
    }
    out.push("     signal: V=vector FTS=B  scaffold: S! = top-1 scaffold");
  }

  // Chunk health
  out.push("");
  out.push("[Chunk health]");
  const c = r.chunk;
  out.push(
    `  chunks:           ${c.total.toLocaleString().padStart(8)}  (Δ ${signed(r.delta.chunkTotal)})`,
  );
  out.push(
    `  indexed files:    ${c.indexedFiles.toString().padStart(8)}  (Δ ${signed(r.delta.indexedFiles)})`,
  );
  out.push(
    `  heading/content:  ${c.headingChunks}/${c.contentChunks}  (${pct(c.headingRatio)} heading)`,
  );
  out.push(
    `  zero-chunk unexpected: ${c.zeroChunkUnexpected}  (Δ ${signed(r.delta.zeroChunkUnexpected)})`,
  );
  if (c.concentrationTop.length > 0) {
    out.push(`  concentration top-${c.concentrationTop.length}:`);
    for (const f of c.concentrationTop) {
      out.push(`    - ${shortPath(f.file)}  (${f.count})`);
    }
  }
  out.push(
    `  hard-guard skips: ${c.hardGuardSkipTotal} chunks across ${c.hardGuardSkipFiles} files  ` +
      `(Δ total ${signed(r.delta.hardGuardSkipTotal)}, files ${signed(r.delta.hardGuardSkipFiles)})`,
  );
  if (c.hardGuardSkipTop.length > 0) {
    out.push(`  ── hard-guard skip top-${c.hardGuardSkipTop.length}:`);
    for (const s of c.hardGuardSkipTop) {
      out.push(`    - ${shortPath(s.file)}  (${s.skipped})`);
    }
  }

  // Structure
  out.push("");
  out.push("[Org structure]");
  const s = r.structure;
  out.push(
    `  org files (indexable):   ${s.orgFiles.toLocaleString().padStart(6)}  (Δ ${signed(r.delta.orgFiles)})`,
  );
  out.push(
    `  malformed block files:   ${s.malformedBlockFiles.length.toString().padStart(6)}  (Δ ${signed(r.delta.malformedBlockFiles)})`,
  );
  out.push(
    `  oversize (>${OVERSIZE_CHARS.toLocaleString()} chars):  ${s.oversizeRiskFiles.length.toString().padStart(6)}  (Δ ${signed(r.delta.oversizeRiskFiles)})`,
  );
  out.push(
    `  micro-heading chains:    ${s.microHeadingChainFiles.length.toString().padStart(6)}  (Δ ${signed(r.delta.microHeadingChainFiles)})`,
  );
  out.push(`  max heading depth:       ${s.maxHeadingDepth.toString().padStart(6)}`);
  out.push(`  zero-chunk unexpected:   ${s.zeroChunkUnexpectedFiles.length.toString().padStart(6)}`);

  if (s.malformedBlockFiles.length > 0) {
    out.push(`  ── malformed block files top-${s.malformedBlockFiles.length}:`);
    for (const m of s.malformedBlockFiles) {
      out.push(`    - ${shortPath(m.file)}  [${m.imbalances.slice(0, 2).join("; ")}]`);
    }
  }
  if (s.oversizeRiskFiles.length > 0) {
    out.push(`  ── oversize top-${s.oversizeRiskFiles.length}:`);
    for (const o of s.oversizeRiskFiles) {
      out.push(`    - ${shortPath(o.file)}  (${o.chars.toLocaleString()} chars)`);
    }
  }
  if (s.microHeadingChainFiles.length > 0) {
    out.push(`  ── micro-heading chains top-${s.microHeadingChainFiles.length}:`);
    for (const mc of s.microHeadingChainFiles) {
      out.push(`    - ${shortPath(mc.file)}  (len=${mc.chainLen}, L${mc.startLine})`);
    }
  }
  if (s.zeroChunkUnexpectedFiles.length > 0) {
    out.push(`  ── zero-chunk unexpected top-${s.zeroChunkUnexpectedFiles.length}:`);
    for (const f of s.zeroChunkUnexpectedFiles) {
      out.push(`    - ${shortPath(f)}`);
    }
  }

  out.push("");
  out.push("─".repeat(68));
  const finalIcon = icon(r.verdict);
  const label =
    r.verdict === "OK" ? "ALL OK — org retrieval/chunk/structure healthy"
    : r.verdict === "WARN" ? "WARN — review flagged items"
    : r.verdict === "FAIL" ? "FAIL — org triage blocked"
    : "SKIP";
  out.push(`  ${finalIcon} ${label}`);
  if (r.reasons.length > 0) {
    out.push("");
    out.push("  Why this verdict:");
    for (const reason of r.reasons) {
      out.push(`    • ${reason}`);
    }
  }
  out.push("");
  return out.join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────

export async function runOrgDoctor(opts: {
  smoke: boolean;
  json: boolean;
  saveBaseline: boolean;
  device: string;
  time: string;
}): Promise<number> {
  const report = await buildOrgReport({ smoke: opts.smoke, device: opts.device, time: opts.time });

  if (opts.saveBaseline) {
    const b = makeBaseline(opts.device, report.chunk, report.structure);
    saveBaseline(b);
    if (!opts.json) {
      console.log(`📌 Saved baseline → ${BASELINE_PATH()}`);
    } else {
      console.log(JSON.stringify({ savedBaseline: b }, null, 2));
    }
    return 0;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderOrgReport(report));
  }

  return report.verdict === "FAIL" ? 1 : 0;
}
