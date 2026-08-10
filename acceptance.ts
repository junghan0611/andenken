#!/usr/bin/env npx tsx
/**
 * andenken acceptance — the user-facing quality surface.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `golden`
 *
 * `golden-queries.ts` is a component gate: vocabulary probes over one pipeline,
 * judged boolean, reported as one number. It answers "did a retrieval component
 * regress". It cannot answer the question a steward has to answer after a
 * retrieval change:
 *
 *     what became better for the person using this?
 *
 * Three layers, deliberately not summed together:
 *
 *   L1  index / operator health   — is the index even caught up? (API 0)
 *   L2  andenken retrieval        — rank of canonical evidence, document
 *                                   diversity, honest miss classification
 *   L3  harness / user usefulness — NOT automated, NOT derivable from L1+L2.
 *                                   A human verdict slot, and the only layer
 *                                   that can say "usable".
 *
 * L1 is a PREREQUISITE and a DIAGNOSIS. It is not acceptance. A green
 * diagnostics tally is not acceptance either. Nothing in this file may set the
 * steward verdict.
 *
 * Hard boundaries:
 *
 * - Never claims timeline fidelity. A similarity score is not a date, and a day
 *   with no retrievable session is an honest miss, never an empty day. KST
 *   coordinates and source status belong to the harness `timeline` skill.
 * - Never compares scores across tracks. Sessions and md run different fusion
 *   strategies over different distributions; cross-track results are LABELLED
 *   and GROUPED, never merged into one ranking.
 * - Never treats private session text as garden knowledge. Every row carries a
 *   visibility label, and saved reports redact private excerpts.
 * - Never writes to LanceDB or to any manifest. The only write is its own
 *   report under `--save`, into the gitignored data directory.
 * - Never pollutes the recall log. Probes are real searches, so child processes
 *   run with `ANDENKEN_DISABLE_RECALL_TRACKING=1`, and the run VERIFIES the log
 *   did not grow.
 *
 * WHAT IS MEASURED, PRECISELY
 *
 * Probes shell out to `cli.ts`, so the measured surface is `cli:*` and nothing
 * else. The pi extension (`index.ts`) still carries inline retrieval paths —
 * `knowledge_search` calls `retrieve()` directly rather than `searchMdCore()` —
 * so CLI results do NOT prove the pi tool surface. That gap is reported as
 * `productionPathParity: unproven`, and closing it is a separate refactor.
 * Automated CLI diagnostics cannot close L3 in any case; the skill carries a
 * manual production-tool verification step for the steward.
 *
 * COST. Default run is API 0: L1 plus probes with `mode: "recent"` (stored-
 * signal scans, no embedding call). Probes needing a query embedding are
 * SKIPPED unless `--retrieval`; each then costs one paid remote query embedding
 * (plus a second if the sessions cross-track fallback fires).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getDataDir, getSessionsDbPath, getMdDbPath } from "./store.js";
import { findSessionFiles } from "./session-indexer.js";
// The md freshness policy is the indexer's, not ours. Reusing its chunker and
// its fingerprint is what keeps this check aligned instead of merely plausible.
import { chunkMdFile } from "./md-chunker.js";
import { computeMdPayloadHash } from "./indexer.js";
import { RECALL_TRACKING_ENV, getRecallLogPath } from "./recall-log.js";

export const ACCEPTANCE_SCHEMA_VERSION = 2;

/**
 * Hand-maintained marker for the retrieval CONTRACT this runner assumes.
 * Bump it when merge strategy, weights, decay, or MMR change meaning. It is a
 * label, not a guarantee — the automatic `pipelineDigest` below is what
 * actually notices source drift.
 */
export const PIPELINE_CONTRACT_VERSION = "2026-08-10.a";

/** Files whose content defines retrieval behaviour, hashed into pipelineDigest. */
const PIPELINE_SOURCES = ["retriever.ts", "md-search.ts", "cli.ts", "store.ts"];

/** A file appended to within this window cannot fairly be called a stale index. */
export const LIVE_APPEND_WINDOW_MS = 15 * 60 * 1000;

// --- Case pack types -------------------------------------------------------

export type CaseType = "lookup" | "explore" | "time-probe";
export type ProbeSurface = "search-sessions" | "search-md";
export type ProbeGrader = "default" | "labeled-groups";

export interface EvidenceLabels {
  /** The document the steward was actually after. */
  canonical?: string[];
  /** Different documents that genuinely advance the same question. Human-labeled. */
  helpfulNeighbors?: string[];
  /** Documents observed to crowd the screen without advancing the question. */
  knownDistractors?: string[];
}

export interface Probe {
  id: string;
  surface: ProbeSurface;
  query: string;
  limit?: number;
  /** sessions only. "recent" = stored-signal scan, no embedding call (API 0). */
  mode?: "semantic" | "hybrid" | "recent";
  dateFrom?: string;
  dateTo?: string;
  source?: string;
  windowNote?: string;
  labelNote?: string;
  /**
   * Canonical title/subtitle wording the query must NOT contain. A query that
   * repeats the title measures string overlap, not retrieval, so a rank-1 hit
   * would be meaningless. Enforced by a fixture test, not by convention.
   */
  forbiddenQueryTokens?: string[];
  queryProvenance?: string;
  rankThreshold?: number;
  guardrails?: { minUniqueDocs?: number; maxChunksPerDoc?: number };
  evidence?: EvidenceLabels;
  grader?: ProbeGrader;
}

export interface AcceptanceCase {
  id: string;
  type: CaseType;
  title: string;
  userQuestion: string;
  why?: string;
  layers?: string[];
  ownership?: { timeline?: string; andenken?: string; harness?: string };
  freshnessAnchors?: string[];
  requiresLocalBinding?: boolean;
  evidenceType?: string;
  bindingHint?: string;
  boundAt?: string;
  boundNote?: string;
  expiresAfterDays?: number;
  probes?: Probe[];
  humanPrompt?: string;
  harnessGrades?: string;
}

export interface CasePack {
  schemaVersion: number;
  cases: AcceptanceCase[];
}

/**
 * Merge a local (gitignored) pack over the committed one: by case id, then by
 * probe id. The committed pack owns intent and durable structure; the local
 * pack owns volatile bindings — session UUIDs, machine paths — which must never
 * be committed.
 */
export function mergeCasePacks(packs: CasePack[]): AcceptanceCase[] {
  const byId = new Map<string, AcceptanceCase>();
  for (const pack of packs) {
    for (const incoming of pack.cases) {
      const existing = byId.get(incoming.id);
      if (!existing) {
        byId.set(incoming.id, incoming);
        continue;
      }
      const probes = mergeProbes(existing.probes ?? [], incoming.probes ?? []);
      byId.set(incoming.id, { ...existing, ...incoming, probes });
    }
  }
  return [...byId.values()];
}

function mergeProbes(base: Probe[], overlay: Probe[]): Probe[] {
  const out = base.map((p) => ({ ...p }));
  for (const inc of overlay) {
    const i = out.findIndex((p) => p.id === inc.id);
    if (i < 0) out.push(inc);
    else
      out[i] = {
        ...out[i],
        ...inc,
        evidence: { ...(out[i].evidence ?? {}), ...(inc.evidence ?? {}) },
        guardrails: { ...(out[i].guardrails ?? {}), ...(inc.guardrails ?? {}) },
      };
  }
  return out;
}

// --- Score semantics -------------------------------------------------------

/**
 * The FORMULA and the STRATEGY are stable facts about the code. An observed
 * range is not: it moves with the corpus, with recency decay, with MMR damping,
 * and with the query. The two are printed in different places on purpose.
 *
 * An earlier draft of this file hard-coded "sessions 0.008–0.053" from a
 * document comment. A single measured top score of ~0.066 contradicts it. That
 * is precisely why no band is baked in here: a stale band read as a calibrated
 * range is worse than no band at all. Observed ranges are computed per run,
 * from that run, and labeled as such.
 */
export const SCORE_SEMANTICS = {
  calibratedConfidence: false,
  crossTrackScoreComparison: false,
  vectorTransform:
    "1/(1+L2_distance) — an L2 distance folded into a similarity. NOT a cosine, despite the legacy 'OpenClaw pattern' comment in store.ts.",
  lexicalScore: "LanceDB BM25 `_score` — positive, higher-is-better.",
  strategies: {
    sessions: {
      mergeStrategy: "rrf",
      formula: "reciprocal rank fusion over (vector, lexical) candidate lists",
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      recencyHalfLifeDays: 14,
      note: "Ordinal fusion. The magnitude carries no similarity meaning at all; only the order does. Recency decay further rescales it, so no fixed band is meaningful.",
    },
    md: {
      mergeStrategy: "weighted",
      formula: "vectorWeight * (score/maxVector) + bm25Weight * (score/maxLexical), then MMR",
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      recencyHalfLifeDays: 0,
      note: "Max-relative normalization: the top candidate is normalized to 1 by construction, so the absolute value describes the candidate set, not the match.",
    },
  },
  sentinels: {
    mdVectorOnlyTop: {
      value: 0.7,
      scope: "implementation- and version-specific to the current md weighted merge",
      meaning:
        "An md top score at exactly vectorWeight indicates a vector-only top candidate under max normalization. Treat as SUSPICIOUS / weak-review only — never a universal confidence and never an automatic verdict.",
    },
  },
  timelineFidelity:
    "NOT claimed. andenken never derives a date, an event identity, or a source status from a score. That axis belongs to the harness `timeline` skill.",
} as const;

// --- Canonical document identity ------------------------------------------

export type Track = "sessions" | "md" | "other";
export type Visibility = "private-session" | "public-garden" | "unknown";

export interface DocIdentity {
  track: Track;
  docId: string;
  visibility: Visibility;
}

const DENOTE_ID = /^\d{8}T\d{6}/;

/**
 * Collapse a chunk's file path to the document a human would say they opened.
 *
 * Diversity measured on chunk ids is meaningless — adjacent chunks of one note
 * are different ids and the same document. The garden's Denote ID is durable
 * (survives a rename); sessions key on the session file basename, which is the
 * garden session id since pi-shell-acp 0.9.0.
 */
export function canonicalDocId(file: string): DocIdentity {
  if (!file) return { track: "other", docId: "other:", visibility: "unknown" };
  const base = path.basename(file);

  if (base.endsWith(".jsonl")) {
    return {
      track: "sessions",
      docId: `session:${base.replace(/\.jsonl$/, "")}`,
      visibility: "private-session",
    };
  }
  if (base.endsWith(".md")) {
    const stem = base.replace(/\.md$/, "");
    const id = DENOTE_ID.test(stem) ? stem.slice(0, 15) : stem;
    return { track: "md", docId: `md:${id}`, visibility: "public-garden" };
  }
  if (base.endsWith(".org")) {
    const stem = base.replace(/\.org$/, "");
    const id = DENOTE_ID.test(stem) ? stem.slice(0, 15) : stem;
    return { track: "other", docId: `org:${id}`, visibility: "unknown" };
  }
  return { track: "other", docId: `other:${base}`, visibility: "unknown" };
}

export interface Diversity {
  uniqueDocs: number;
  maxChunksPerDoc: number;
  /** maxChunksPerDoc / rows — 1.0 means one document owns the whole screen. */
  monopolyRatio: number;
  docIds: string[];
}

export function diversityOf(files: string[]): Diversity {
  const counts = new Map<string, number>();
  for (const f of files) {
    const { docId } = canonicalDocId(f);
    counts.set(docId, (counts.get(docId) ?? 0) + 1);
  }
  const max = counts.size > 0 ? Math.max(...counts.values()) : 0;
  return {
    uniqueDocs: counts.size,
    maxChunksPerDoc: max,
    monopolyRatio: files.length > 0 ? max / files.length : 0,
    docIds: [...counts.keys()],
  };
}

// --- Layer 1: index / operator health -------------------------------------

export type FreshnessStatus =
  | "fresh"
  /** Content genuinely changed since indexing. */
  | "stale"
  /**
   * Cannot be decided at API 0: same size, moved mtime, and no prior payload
   * hash to settle it (or the hash could not be computed). Never used to excuse
   * a retrieval miss and never reported as healthy.
   */
  | "unknown"
  | "unindexed"
  | "source-missing"
  | "no-manifest";

export interface ManifestEntry {
  mtimeMs: number;
  size: number;
  chunks?: number;
  /** md only — fingerprint of what the embedding API received for this file. */
  payloadHash?: string;
}

export interface StatLike {
  size: number;
  mtimeMs: number;
}

/**
 * Compare one source file against its manifest entry, following the SAME
 * policy the indexer uses for that track. Getting this wrong in either
 * direction is expensive: over-warning puts a permanent red light on a
 * correctly indexed corpus, and under-warning lets a stale index be blamed on
 * the ranker.
 *
 * **sessions — size growth.** Transcripts are append-only, so a size change is
 * the change. Equal size means equal content in practice.
 *
 * **md — payload hash.** An equal byte size does NOT prove the embedding
 * payload is unchanged, and the indexer knows it: `classifySuspect()` treats a
 * same-size mtime move as *suspect*, computes `computeMdPayloadHash()`, and
 * re-embeds on mismatch OR on a missing prior hash. This function mirrors that
 * exactly. Callers pass `payloadHash`:
 *
 *   - a string  → the current payload fingerprint; compared against the manifest
 *   - `null`    → could not be computed → `unknown`, decided by nobody
 *   - omitted   → this track has no hash policy (sessions)
 *
 * A manifest entry with no stored `payloadHash` is `unknown`, never `fresh` —
 * the indexer would re-embed it, so acceptance must not call it healthy.
 *
 * mtime comparison keeps a 1ms tolerance: manifests store fractional `mtimeMs`
 * and a JSON round-trip is not bit-exact.
 */
export function classifyFreshness(
  entry: ManifestEntry | undefined,
  stat: StatLike | undefined,
  manifestPresent: boolean,
  opts: { payloadHash?: string | null } = {},
): FreshnessStatus {
  if (!stat) return "source-missing";
  if (!manifestPresent) return "no-manifest";
  if (!entry) return "unindexed";
  if (entry.size !== stat.size) return "stale";
  if (Math.abs(entry.mtimeMs - stat.mtimeMs) <= 1) return "fresh";

  // Same size, moved mtime — the suspect case.
  if (!("payloadHash" in opts)) return "fresh"; // sessions: size growth policy
  if (opts.payloadHash === null || opts.payloadHash === undefined) return "unknown";
  if (!entry.payloadHash) return "unknown"; // legacy entry; indexer re-embeds
  return entry.payloadHash === opts.payloadHash ? "fresh" : "stale";
}

/**
 * A session being appended to right now is not a neglected index. Separating
 * "live append" from "stale" keeps the freshness signal from degenerating into
 * a permanent red light on every active conversation.
 */
export function isLiveAppend(stat: StatLike | undefined, observedAtMs: number): boolean {
  if (!stat) return false;
  return observedAtMs - stat.mtimeMs <= LIVE_APPEND_WINDOW_MS;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

interface Manifest {
  files: Record<string, ManifestEntry>;
  lastUpdated?: string;
}

function readManifestFile(file: string): { manifest: Manifest | null; digest?: string } {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Manifest;
    if (!parsed || typeof parsed !== "object" || !parsed.files) return { manifest: null };
    return { manifest: parsed, digest: sha256(raw) };
  } catch {
    return { manifest: null };
  }
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export interface AnchorHealth {
  anchor: string;
  resolved: string;
  track: Track;
  docId: string;
  status: FreshnessStatus;
  liveAppend: boolean;
  indexedChunks?: number;
  lagBytes?: number;
  lagMtimeMs?: number;
  observedAt: string;
  /** How the status was decided — `size-growth` (sessions) or `payload-hash` (md). */
  policy: "size-growth" | "payload-hash";
  detail?: string;
}

export interface TrackHealth {
  track: Track;
  dbPath: string;
  dbPresent: boolean;
  manifestPath: string;
  manifestPresent: boolean;
  manifestFiles: number;
  manifestDigest?: string;
  manifestLastUpdated?: string;
  manifestAgeHours?: number;
  providerConfigured: boolean;
  providerModel?: string;
  providerDimensions?: string;
}

export interface RecentCoverage {
  windowHours: number;
  observedAt: string;
  sourceFiles: number;
  fresh: number;
  /** Behind the source AND not being appended to right now — an operator gap. */
  stale: number;
  /** Behind the source but appended within LIVE_APPEND_WINDOW_MS — expected. */
  liveAppend: number;
  unindexed: number;
  totalLagBytes: number;
  worst?: { docId: string; lagBytes: number; lagMinutes: number };
}

export interface IndexHealth {
  tracks: TrackHealth[];
  anchors: AnchorHealth[];
  recentCoverage?: RecentCoverage;
}

function trackHealth(track: "sessions" | "md"): TrackHealth {
  const dbPath = track === "sessions" ? getSessionsDbPath() : getMdDbPath();
  const manifestPath = path.join(
    getDataDir(),
    track === "sessions" ? "session-manifest.json" : "md-manifest.json",
  );
  const { manifest, digest } = readManifestFile(manifestPath);
  const lastUpdated = manifest?.lastUpdated;
  const ageHours = lastUpdated ? (Date.now() - Date.parse(lastUpdated)) / 3_600_000 : undefined;
  const ns = track === "sessions" ? "ANDENKEN_SESSION_" : "ANDENKEN_MD_";
  return {
    track,
    dbPath,
    dbPresent: fs.existsSync(dbPath),
    manifestPath,
    manifestPresent: manifest !== null,
    manifestFiles: manifest ? Object.keys(manifest.files).length : 0,
    manifestDigest: digest,
    manifestLastUpdated: lastUpdated,
    manifestAgeHours: ageHours !== undefined ? Number(ageHours.toFixed(1)) : undefined,
    // Env presence only — reading a name is not an API call.
    providerConfigured: Boolean(process.env[`${ns}PROVIDER`]),
    providerModel: process.env[`${ns}MODEL`],
    providerDimensions: process.env[`${ns}DIMENSIONS`],
  };
}

function statOf(file: string): StatLike | undefined {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

function anchorHealth(anchors: string[], observedAtMs: number): AnchorHealth[] {
  const manifests = {
    sessions: readManifestFile(path.join(getDataDir(), "session-manifest.json")).manifest,
    md: readManifestFile(path.join(getDataDir(), "md-manifest.json")).manifest,
  };

  return anchors.map((anchor) => {
    const resolved = expandHome(anchor);
    const { track, docId } = canonicalDocId(resolved);
    const manifest =
      track === "sessions" ? manifests.sessions : track === "md" ? manifests.md : null;
    const stat = statOf(resolved);
    const entry = manifest?.files[resolved];

    // md decides by payload hash, exactly as the indexer does. Computing it is
    // local parsing only — no API call — and only for the handful of anchors.
    const policy: AnchorHealth["policy"] = track === "md" ? "payload-hash" : "size-growth";
    let detail: string | undefined;
    let status: FreshnessStatus;
    if (policy === "payload-hash") {
      let currentHash: string | null = null;
      if (stat) {
        try {
          currentHash = computeMdPayloadHash(chunkMdFile(resolved));
        } catch (err) {
          currentHash = null;
          detail = `payload hash uncomputable: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`;
        }
      }
      status = classifyFreshness(entry, stat, manifest !== null, { payloadHash: currentHash });
      if (status === "unknown" && detail === undefined) {
        detail = entry?.payloadHash
          ? "same size, moved mtime, hash uncomputable"
          : "same size, moved mtime, and the manifest entry predates payloadHash — the indexer would re-embed it";
      }
    } else {
      status = classifyFreshness(entry, stat, manifest !== null);
    }

    return {
      anchor,
      resolved,
      track,
      docId,
      status,
      liveAppend:
        (status === "stale" || status === "unindexed") && isLiveAppend(stat, observedAtMs),
      indexedChunks: entry?.chunks,
      lagBytes: entry && stat ? stat.size - entry.size : undefined,
      lagMtimeMs: entry && stat ? Math.round(stat.mtimeMs - entry.mtimeMs) : undefined,
      observedAt: new Date(observedAtMs).toISOString(),
      policy,
      detail,
    };
  });
}

/**
 * How much of what was written recently has reached the index.
 *
 * The durable companion to per-case anchors: anchors go stale as cases age, but
 * "sessions touched today the index has not seen" is always the same question,
 * and it decides whether a freshness miss is the operator's or the ranker's.
 * Lag is reported in bytes and minutes rather than as a verdict — an append in
 * progress is not a quality failure.
 */
export function recentSessionCoverage(windowHours = 24, nowMs = Date.now()): RecentCoverage {
  const manifest = readManifestFile(path.join(getDataDir(), "session-manifest.json")).manifest;
  const cutoff = nowMs - windowHours * 3_600_000;
  const out: RecentCoverage = {
    windowHours,
    observedAt: new Date(nowMs).toISOString(),
    sourceFiles: 0,
    fresh: 0,
    stale: 0,
    liveAppend: 0,
    unindexed: 0,
    totalLagBytes: 0,
  };
  let files: string[] = [];
  try {
    files = findSessionFiles();
  } catch {
    return out;
  }
  for (const f of files) {
    const stat = statOf(f);
    if (!stat || stat.mtimeMs < cutoff) continue;
    out.sourceFiles++;
    const entry = manifest?.files[f];
    const status = classifyFreshness(entry, stat, manifest !== null);
    if (status === "fresh") {
      out.fresh++;
      continue;
    }
    const live = isLiveAppend(stat, nowMs);
    if (status === "unindexed") out.unindexed++;
    else if (live) out.liveAppend++;
    else out.stale++;

    const lag = entry ? stat.size - entry.size : stat.size;
    out.totalLagBytes += Math.max(0, lag);
    if (!live && (!out.worst || lag > out.worst.lagBytes)) {
      out.worst = {
        docId: canonicalDocId(f).docId,
        lagBytes: lag,
        lagMinutes: Math.round((nowMs - stat.mtimeMs) / 60000),
      };
    }
  }
  return out;
}

// --- Layer 1b: recall-log readiness ---------------------------------------

export interface RecallLogReadiness {
  path: string;
  present: boolean;
  entries: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  fields: Record<
    string,
    "stored" | "derivable" | "derivable-partial" | "inferable-ambiguous" | "absent"
  >;
  promotionGateReady: false;
  reasons: string[];
}

/**
 * Audit what the recall log COULD support, without pretending it already does.
 *
 * OpenClaw's dreaming promotes on recall statistics — recall count and unique
 * queries — which is the evidence-gated design worth copying (COMPARISON §14.4).
 * That gate needs fields this log does not carry. Reporting readiness is in
 * scope; adding the fields is not, and the existing entries must never be used
 * as a promotion-quality gate: they predate the field decisions entirely.
 */
export function auditRecallLog(file: string, sample = 300): RecallLogReadiness {
  const out: RecallLogReadiness = {
    path: file,
    present: false,
    entries: 0,
    fields: {},
    promotionGateReady: false,
    reasons: [],
  };
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "");
    out.present = true;
  } catch {
    out.reasons.push("recall log absent — nothing to promote from");
    return out;
  }
  out.entries = lines.length;

  const parse = (l: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  out.firstTimestamp = parse(lines[0])?.timestamp as string | undefined;
  out.lastTimestamp = parse(lines[lines.length - 1])?.timestamp as string | undefined;

  const tail = lines
    .slice(-sample)
    .map(parse)
    .filter((x): x is Record<string, unknown> => x !== null);
  const has = (k: string) => tail.length > 0 && tail.every((e) => e[k] !== undefined);

  out.fields.query = has("query") ? "stored" : "absent";
  out.fields.tool = has("tool") ? "stored" : "absent";
  out.fields.topScore = has("topScore") ? "stored" : "absent";
  out.fields.resultIds = has("resultIds") ? "stored" : "absent";
  out.fields.canonicalDocId = has("resultIds") ? "derivable" : "absent";
  out.fields.withinQueryUniqueness = has("resultIds") ? "derivable-partial" : "absent";
  out.fields.rank = has("resultIds") ? "derivable-partial" : "absent";
  out.fields.track = has("tool") ? "inferable-ambiguous" : "absent";
  out.fields.mergeStrategy = "absent";
  out.fields.pipelineVersion = "absent";
  out.fields.schemaVersion = "absent";

  if (out.fields.canonicalDocId === "derivable") {
    out.reasons.push(
      "canonical document ID is derivable from `resultIds` but not stored — a change to the id format silently rewrites history",
    );
  }
  if (out.fields.withinQueryUniqueness !== "absent") {
    out.reasons.push(
      "within-query uniqueness is only partial: entries keep the top-5 ids, so unique-document counts over a larger K cannot be reconstructed",
    );
  }
  out.reasons.push(
    "`track` is inferable from `tool` only ambiguously: `search-knowledge` historically hit org.lance and later md.lance under the same name",
  );
  out.reasons.push(
    "no pipeline/schema version and no merge strategy — entries produced under different fusion behaviour are indistinguishable",
  );
  out.reasons.push(
    `do NOT use the ${out.entries} existing entries as a promotion-quality gate; they predate these field decisions`,
  );
  return out;
}

// --- Layer 2: retrieval probes --------------------------------------------

export interface CliResultRow {
  file: string;
  score: number;
  project?: string;
  role?: string;
  source?: string;
  timestamp?: string;
  line?: number;
  text?: string;
}

export interface CliSearchOutput {
  query: string;
  count: number;
  fallback?: boolean;
  diagnostic?: string;
  results: CliResultRow[];
}

export interface GroupedEvidence {
  track: Track;
  visibility: Visibility;
  rows: number;
  uniqueDocs: number;
  docIds: string[];
}

export type ProbeVerdict =
  | "pass"
  | "weak-pass"
  | "fail"
  /** Retrieval answered honestly that it has nothing. Not green, not a defect. */
  | "honest-miss"
  /** Cannot be judged this run — unbound case, unlabeled semantics, live append. */
  | "abstain"
  /** A volatile local binding aged out. Rebind before reading anything into it. */
  | "expired"
  | "skipped"
  | "error";

export type MissReason =
  | "stale-index"
  | "unindexed-source"
  | "corpus-miss"
  /** Zero rows, but the window path itself is unproven this run — see windowControl. */
  | "corpus-miss-candidate"
  | "ranking-miss"
  | "none";

export interface EvidenceRow {
  rank: number;
  track: Track;
  visibility: Visibility;
  docId: string;
  score: number;
  /** One line, truncated. Never a full chunk. Redacted for private rows on save. */
  excerpt: string;
  label?: "canonical" | "helpful-neighbor" | "known-distractor";
}

export interface ProbeOutcome {
  caseId: string;
  caseType: CaseType;
  probeId: string;
  surface: ProbeSurface;
  measuredSurface: string;
  query: string;
  apiCost: "none" | "paid-query-embedding";
  verdict: ProbeVerdict;
  missReason: MissReason;
  /** False for structural/diagnostic probes that can never mean "usable". */
  countsTowardUsable: boolean;
  warnings: string[];
  notes: string[];
  rows: number;
  expectedRank: number | null;
  rankThreshold: number;
  /** Observed score range for THIS run — not a calibrated band. */
  observedScoreRange?: { min: number; max: number };
  diversity?: Diversity;
  groups?: GroupedEvidence[];
  crossTrackFallback?: boolean;
  evidence?: EvidenceRow[];
  error?: string;
}

export function probeApiCost(probe: Probe): "none" | "paid-query-embedding" {
  return probe.mode === "recent" ? "none" : "paid-query-embedding";
}

export function groupByTrack(rows: Array<{ file: string }>): GroupedEvidence[] {
  const byTrack = new Map<Track, { visibility: Visibility; docIds: Set<string>; rows: number }>();
  for (const r of rows) {
    const { track, docId, visibility } = canonicalDocId(r.file);
    const g = byTrack.get(track) ?? { visibility, docIds: new Set<string>(), rows: 0 };
    g.docIds.add(docId);
    g.rows++;
    byTrack.set(track, g);
  }
  return [...byTrack.entries()].map(([track, g]) => ({
    track,
    visibility: g.visibility,
    rows: g.rows,
    uniqueDocs: g.docIds.size,
    docIds: [...g.docIds],
  }));
}

/** One line the steward can scan. Never a full chunk — this is a screen, not a dump. */
export function oneLineExcerpt(text: string | undefined, max = 100): string {
  if (!text) return "";
  const titled = /^Title:\s*(.+)$/m.exec(text);
  const raw = titled ? titled[1] : text;
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function matchesAny(file: string, needles: string[] | undefined): boolean {
  return (needles ?? []).some((n) => n !== "" && file.includes(n));
}

function labelOf(file: string, ev: EvidenceLabels | undefined): EvidenceRow["label"] {
  if (matchesAny(file, ev?.canonical)) return "canonical";
  if (matchesAny(file, ev?.helpfulNeighbors)) return "helpful-neighbor";
  if (matchesAny(file, ev?.knownDistractors)) return "known-distractor";
  return undefined;
}

export interface EvaluateContext {
  caseType: CaseType;
  anchors: AnchorHealth[];
  fallback?: boolean;
  /** Local binding aged out — grade `expired` regardless of results. */
  expired?: boolean;
  /** Case declares it needs a local binding that is not present. */
  unbound?: boolean;
  /**
   * Did a control window over a known-populated range return rows this run?
   * Without it, zero rows prove nothing about the corpus — only that the query
   * returned nothing, which could equally be a broken filter or path.
   */
  windowPathProven?: boolean;
}

/**
 * Grade one probe from its rows plus what layer 1 already knows.
 *
 * The important part is the miss classification. "The answer was not in the top
 * five" is three unrelated defects wearing one coat: the index never saw the
 * source, the source does not exist, or the ranker buried it. Only the third is
 * retrieval's. Layer 1 is what tells them apart, so its warning is emitted
 * BEFORE any ranking interpretation.
 */
export function evaluateProbe(
  caseId: string,
  probe: Probe,
  rows: CliResultRow[],
  ctx: EvaluateContext,
): ProbeOutcome {
  const rankThreshold = probe.rankThreshold ?? 3;
  const warnings: string[] = [];
  const notes: string[] = [];
  const div = diversityOf(rows.map((r) => r.file));
  const groups = groupByTrack(rows);
  const scores = rows.map((r) => r.score).filter((n) => Number.isFinite(n));

  const evidence: EvidenceRow[] = rows.map((r, i) => {
    const id = canonicalDocId(r.file);
    return {
      rank: i + 1,
      track: id.track,
      visibility: id.visibility,
      docId: id.docId,
      score: r.score,
      excerpt: oneLineExcerpt(r.text),
      label: labelOf(r.file, probe.evidence),
    };
  });

  const canonicalRank = evidence.find((e) => e.label === "canonical")?.rank ?? null;
  const distractorRank = evidence.find((e) => e.label === "known-distractor")?.rank ?? null;
  const neighbourDocs = new Set(
    evidence.filter((e) => e.label === "helpful-neighbor").map((e) => e.docId),
  );

  const out: ProbeOutcome = {
    caseId,
    caseType: ctx.caseType,
    probeId: probe.id,
    surface: probe.surface,
    measuredSurface: `cli:${probe.surface}`,
    query: probe.query,
    apiCost: probeApiCost(probe),
    verdict: "pass",
    missReason: "none",
    countsTowardUsable: ctx.caseType !== "time-probe" && probe.grader !== "labeled-groups",
    warnings,
    notes,
    rows: rows.length,
    expectedRank: canonicalRank,
    rankThreshold,
    observedScoreRange:
      scores.length > 0 ? { min: Math.min(...scores), max: Math.max(...scores) } : undefined,
    diversity: div,
    groups,
    crossTrackFallback: ctx.fallback,
    evidence,
  };

  // ---- Gates that precede any ranking reading ----
  if (ctx.expired) {
    out.verdict = "expired";
    notes.push(
      "local binding aged out — rebind the anchor and the query together before reading anything into this probe",
    );
    return out;
  }
  if (ctx.unbound) {
    out.verdict = "abstain";
    notes.push(
      "case requires a local binding (session UUID / machine path) that is not present — see acceptance-cases.local.json. Not a pass and not a failure.",
    );
    return out;
  }

  // Freshness warning ALWAYS precedes ranking interpretation, including when the
  // canonical evidence was in fact found.
  const relevant = ctx.anchors.filter(
    (a) =>
      matchesAny(a.resolved, probe.evidence?.canonical) ||
      matchesAny(a.anchor, probe.evidence?.canonical),
  );
  const staleAnchors = relevant.filter((a) => a.status === "stale" || a.status === "unindexed");
  for (const a of staleAnchors) {
    warnings.push(
      `INDEX BEHIND SOURCE for \`${a.docId}\` (${a.status}${a.liveAppend ? ", live append in progress" : ""}${
        a.lagBytes !== undefined ? `, +${a.lagBytes} bytes unindexed` : ""
      }) — read this before any ranking conclusion; run \`./run.sh sync:sessions\` / \`sync:md\` and re-run.`,
    );
  }

  // ---- Structural grader: cross-track attribution ----
  if (probe.grader === "labeled-groups") {
    // No merged ranking is computed here on purpose: the tracks' scores are
    // incomparable, so the only honest grade is whether evidence arrives
    // attributed.
    if (rows.length === 0) {
      out.verdict = "honest-miss";
      notes.push("no evidence returned on either track");
    } else if (groups.length < 2) {
      out.verdict = "weak-pass";
      notes.push(
        `only the ${groups[0].track} track answered — usable, but the cross-track claim is unproven this run`,
      );
    } else {
      notes.push(
        `evidence labeled across ${groups.length} tracks; scores NOT compared across them`,
      );
    }
    notes.push("structural check — never counts toward user acceptance on its own");
    return out;
  }

  // ---- time-probe: window scan, honest miss, never a usable claim ----
  if (ctx.caseType === "time-probe") {
    if (rows.length === 0) {
      out.verdict = "honest-miss";
      // A zero is only evidence about the corpus if the window path itself is
      // known to work this run. Otherwise it is a candidate, not a finding.
      out.missReason = ctx.windowPathProven ? "corpus-miss" : "corpus-miss-candidate";
      notes.push(
        "no session evidence inside the supplied ISO window. This is NOT an empty day — the timeline skill owns whether the day was lived, and andenken must not infer it.",
      );
      notes.push(
        ctx.windowPathProven
          ? "the stored-signal window path returned rows on a control window this run, so this zero is a genuine corpus gap"
          : "the control window returned nothing either, so the window path is UNPROVEN this run — this zero does not establish a corpus gap",
      );
    } else {
      notes.push(
        `${rows.length} rows recoverable inside the window across ${div.uniqueDocs} sessions; the coordinate itself remains the timeline's claim, not this report's`,
      );
    }
    notes.push("diagnostic only — a time-probe never counts toward user acceptance");
    return out;
  }

  // ---- Anchor-bearing graders (lookup / explore) ----
  if ((probe.evidence?.canonical ?? []).length === 0) {
    out.verdict = "abstain";
    notes.push(
      "no canonical evidence labeled for this probe — nothing to grade a rank against. Label it from an observed run rather than guessing.",
    );
    return out;
  }

  if (canonicalRank === null) {
    // Classify WHY before calling it a retrieval failure.
    const anyStaleLive = staleAnchors.some((a) => a.liveAppend);
    const anyStale = staleAnchors.some((a) => !a.liveAppend);
    const missingSource = relevant.some((a) => a.status === "source-missing");
    const anyUnknown = relevant.some((a) => a.status === "unknown" || a.status === "no-manifest");

    if (anyUnknown) {
      // The index state itself is undecided, so blaming the ranker would be
      // false certainty. The indexer would re-embed this file; until it does,
      // nobody can say whether the miss is retrieval's.
      out.verdict = "abstain";
      notes.push(
        "the anchor's index state could not be decided at API 0 (same size, moved mtime, no usable payload hash) — the indexer treats this as re-embed-worthy, so this miss cannot be attributed to ranking",
      );
      return out;
    }
    if (anyStaleLive) {
      out.verdict = "abstain";
      out.missReason = "stale-index";
      notes.push(
        "the anchor's source is being appended to right now, so the index cannot be expected to hold it yet — not evaluable as a retrieval result",
      );
    } else if (anyStale) {
      out.verdict = "fail";
      out.missReason = staleAnchors.some((a) => a.status === "unindexed")
        ? "unindexed-source"
        : "stale-index";
      notes.push(
        "canonical evidence missing because the INDEX IS BEHIND the source, not because ranking failed — operator action, not a ranker change",
      );
    } else if (missingSource) {
      out.verdict = "honest-miss";
      out.missReason = "corpus-miss";
      notes.push("canonical source does not exist on disk — honest corpus miss");
    } else {
      out.verdict = "fail";
      out.missReason = "ranking-miss";
      notes.push(
        `canonical evidence is indexed and fresh but absent from top-${rows.length} — this one is genuinely retrieval's`,
      );
    }
    return out;
  }

  // Canonical evidence recovered. Rank first.
  if (canonicalRank > rankThreshold) {
    out.verdict = "weak-pass";
    notes.push(
      `canonical evidence at rank ${canonicalRank}, threshold ${rankThreshold} — recovered but pushed down`,
    );
  }

  const cap = (v: ProbeVerdict) => {
    if (out.verdict === "pass") out.verdict = v;
  };

  // A known distractor ahead of canonical is at most partial, whatever the rank.
  if (distractorRank !== null && distractorRank < canonicalRank) {
    cap("weak-pass");
    notes.push(
      `a known distractor ranks ahead of canonical (${distractorRank} < ${canonicalRank}) — at most partial`,
    );
  }

  const minUnique = probe.guardrails?.minUniqueDocs;
  const maxPerDoc = probe.guardrails?.maxChunksPerDoc;

  if (ctx.caseType === "explore") {
    if (typeof minUnique === "number" && div.uniqueDocs < minUnique) {
      cap("weak-pass");
      notes.push(
        `only ${div.uniqueDocs} distinct documents in top-${rows.length} (want ≥ ${minUnique})`,
      );
    }
    if (typeof maxPerDoc === "number" && div.maxChunksPerDoc > maxPerDoc) {
      cap("weak-pass");
      notes.push(
        `one document takes ${div.maxChunksPerDoc}/${rows.length} rows (explore guardrail ${maxPerDoc}) — recommended guardrail, not a universal law`,
      );
    }
    // Numeric diversity is necessary and not sufficient. Without human-labeled
    // neighbors there is no machine evidence that the other documents are
    // USEFUL, so the automated verdict cannot reach pass.
    if ((probe.evidence?.helpfulNeighbors ?? []).length === 0) {
      cap("weak-pass");
      notes.push(
        "semantic usefulness of the other documents is unlabeled — numeric diversity alone cannot pass user acceptance. Label helpfulNeighbors from an observed run, or let the steward judge at layer 3.",
      );
    } else if (neighbourDocs.size < 1) {
      cap("weak-pass");
      notes.push(
        "no labeled helpful neighbor reached the first screen — diverse, but not demonstrably useful",
      );
    }
  } else if (ctx.caseType === "lookup") {
    // A narrow lookup legitimately returns one document, so monopoly can never
    // fail the case. It is still worth saying out loud: a first screen where one
    // document holds most rows is a smaller screen than it looks.
    const monopolyLimit = maxPerDoc ?? Math.ceil(rows.length / 2);
    if (rows.length > 1 && div.maxChunksPerDoc > monopolyLimit) {
      warnings.push(
        `one document holds ${div.maxChunksPerDoc}/${rows.length} rows (${(div.monopolyRatio * 100).toFixed(0)}% of the screen) — for a narrow lookup this is a warning, not a failure, but the steward sees fewer distinct options than the row count suggests`,
      );
    }
  }

  return out;
}

// --- Production-path contract (measured, not asserted) ---------------------

export type Exposure = "exposed" | "implicit" | "absent";

export interface ProductionContract {
  measuredSurface: string;
  /** CLI results do not prove the pi extension surface — see file header. */
  productionPathParity: "unproven";
  parityNote: string;
  exposes: Record<string, Exposure>;
  note: string;
}

/**
 * Grade what the PRODUCTION RESPONSE itself carries — separately from whatever
 * explanation this runner adds on top.
 *
 * The distinction matters: a report that explains freshness and score semantics
 * does not make the product expose them. Conflating the two would let the
 * runner's own prose satisfy a readiness it is only describing.
 */
export function assessProductionContract(
  surface: string,
  raw: CliSearchOutput | null,
): ProductionContract {
  const rows = raw?.results ?? [];
  const first = rows[0];
  const exposes: Record<string, Exposure> = {
    track:
      rows.length === 0
        ? "absent"
        : rows.every((r) => typeof r.source === "string" && r.source !== "")
          ? "exposed"
          : "implicit",
    openableSourcePath:
      first && typeof first.file === "string" && path.isAbsolute(first.file) ? "exposed" : "absent",
    rankOrder: rows.length > 0 ? "implicit" : "absent",
    excerpt: first && typeof first.text === "string" && first.text.length > 0 ? "exposed" : "absent",
    freshnessWarning: "absent",
    scoreSemantics: "absent",
  };
  return {
    measuredSurface: surface,
    productionPathParity: "unproven",
    parityNote:
      "Measured through cli.ts only. The pi extension still carries inline retrieval paths (knowledge_search calls retrieve() directly rather than searchMdCore()), so these results do not prove the pi tool surface. A shared-core refactor is separate work.",
    exposes,
    note:
      "Measured from the production response payload itself. `implicit` means the information exists but the consumer must infer it (array order for rank; source strings that do not name the track). `absent` means the response cannot convey it at all. The explanations this report adds are DIAGNOSTIC and do not satisfy these rows.",
  };
}

// --- Probe execution -------------------------------------------------------

export function buildProbeArgs(probe: Probe): string[] {
  const args = ["cli.ts", probe.surface];
  // An empty query is legitimate for a stored-signal window scan, but cli.ts
  // requires a positional; the recent path never embeds or tokenizes it.
  args.push(probe.query.trim() === "" ? "*" : probe.query);
  args.push("--limit", String(probe.limit ?? 5));
  if (probe.surface === "search-sessions") {
    if (probe.mode) args.push("--mode", probe.mode);
    if (probe.dateFrom) args.push("--date-from", probe.dateFrom);
    if (probe.dateTo) args.push("--date-to", probe.dateTo);
    if (probe.source) args.push("--source", probe.source);
  }
  return args;
}

function runCli(args: string[], repoRoot: string): CliSearchOutput {
  const out = execFileSync("pnpm", ["exec", "tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    // Probes are real searches. Without this guard they would pollute the very
    // recall statistic the log exists to support.
    env: { ...process.env, [RECALL_TRACKING_ENV]: "1" },
  });
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`no JSON in cli output: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start)) as CliSearchOutput;
}

// --- Window path control (API 0) ------------------------------------------

export interface WindowControl {
  ran: boolean;
  dateFrom: string;
  dateTo: string;
  rows: number;
  /** True when the stored-signal window path demonstrably returns rows. */
  proven: boolean;
  note: string;
  error?: string;
}

/**
 * Prove the stored-signal window path works before reading anything into a
 * zero.
 *
 * A time-probe that returns nothing has two indistinguishable explanations: the
 * corpus has nothing in that window, or the window path is broken. Manual
 * verification settles it once; only an executable control settles it every
 * run. This scans the most recent `hours` — a range the index is expected to
 * cover — through the same `--mode recent` path the time-probes use, at zero
 * API cost.
 */
export function buildWindowControlProbe(nowMs: number, hours = 48): Probe {
  return {
    id: "__window-control",
    surface: "search-sessions",
    query: "",
    limit: 1,
    mode: "recent",
    dateFrom: new Date(nowMs - hours * 3_600_000).toISOString(),
    dateTo: new Date(nowMs).toISOString(),
  };
}

export function interpretWindowControl(
  probe: Probe,
  rows: number,
  error?: string,
): WindowControl {
  const proven = error === undefined && rows > 0;
  return {
    ran: true,
    dateFrom: probe.dateFrom!,
    dateTo: probe.dateTo!,
    rows,
    proven,
    note: proven
      ? "the stored-signal window path returned rows over a recent control range, so a zero elsewhere is a corpus statement"
      : "the control range returned nothing (or errored), so the window path is unproven — every zero this run is a candidate, not a finding",
    error,
  };
}

// --- Run identity, digests, comparison ------------------------------------

export interface RunIdentity {
  schemaVersion: number;
  pipelineContractVersion: string;
  /** Digest of the source files that define retrieval — catches silent drift. */
  pipelineDigest: string;
  casePackDigest: string;
  measuredSurface: string;
  config: Record<string, string>;
  corpusSnapshot: Record<string, string>;
  /** Digest of the ordered evidence. Any change resets a recorded verdict. */
  resultDigest: string;
}

export function pipelineDigest(repoRoot: string): string {
  const parts: string[] = [];
  for (const f of PIPELINE_SOURCES) {
    try {
      parts.push(`${f}:${sha256(fs.readFileSync(path.join(repoRoot, f), "utf-8"))}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  return sha256(parts.join("|"));
}

export function resultDigestOf(cases: CaseOutcome[]): string {
  const parts: string[] = [];
  for (const c of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const p of [...c.probes].sort((a, b) => a.probeId.localeCompare(b.probeId))) {
      const ev = (p.evidence ?? []).map((e) => `${e.rank}:${e.docId}`).join(",");
      parts.push(`${c.id}/${p.probeId}=${p.verdict}[${ev}]`);
    }
  }
  return sha256(parts.join("|"));
}

/**
 * Verdicts that carry no usefulness signal, so no transition into or out of
 * them may be rendered as a direction.
 */
export const NO_DIRECTION_VERDICTS: ProbeVerdict[] = [
  "skipped",
  "abstain",
  "expired",
  "error",
  "honest-miss",
];

export type DeltaDirection =
  | "improved"
  | "regressed"
  | "unchanged"
  | "new"
  | "dropped"
  | "not-comparable";

export interface ProbeDelta {
  key: string;
  before: { verdict: ProbeVerdict; canonicalRank: number | null; uniqueDocs?: number };
  after: { verdict: ProbeVerdict; canonicalRank: number | null; uniqueDocs?: number };
  direction: DeltaDirection;
}

export interface ComparisonResult {
  comparable: boolean;
  blockers: string[];
  confounders: string[];
  pipelineChanged: boolean;
  verdictReset: boolean;
  deltas: ProbeDelta[];
}

/**
 * Compare two runs.
 *
 * MINIMAL COMPARABLE IDENTITY — deliberately narrower than "everything equal",
 * because an intentional reindex of the same corpus must remain comparable:
 *
 *   schemaVersion · casePackDigest · config (model + dim per track) ·
 *   measuredSurface
 *
 * A difference in any of those makes the two runs measure different things, so
 * the answer is `not-comparable` rather than a direction.
 *
 * Everything else is recorded as a CONFOUNDER rather than a blocker, and every
 * delta carries the flag:
 *
 *   - corpus snapshot differs → the corpus or index generation moved, so a rank
 *     delta cannot be attributed to a retrieval change alone.
 *   - pipeline digest UNCHANGED → the retrieval code did not move, so a delta is
 *     corpus drift or noise, never evidence that "the change worked".
 *
 * Neither is silently absorbed. Confounding is shown, never inferred away.
 */
export function compareRuns(before: AcceptanceReport, after: AcceptanceReport): ComparisonResult {
  const blockers: string[] = [];
  const confounders: string[] = [];
  const a = before.runIdentity;
  const b = after.runIdentity;

  if (a.schemaVersion !== b.schemaVersion)
    blockers.push(`schemaVersion ${a.schemaVersion} → ${b.schemaVersion}`);
  if (a.casePackDigest !== b.casePackDigest)
    blockers.push(`case pack changed (${a.casePackDigest} → ${b.casePackDigest})`);
  if (a.measuredSurface !== b.measuredSurface)
    blockers.push(`measured surface ${a.measuredSurface} → ${b.measuredSurface}`);
  for (const k of new Set([...Object.keys(a.config), ...Object.keys(b.config)])) {
    if (a.config[k] !== b.config[k])
      blockers.push(`config ${k}: ${a.config[k] ?? "—"} → ${b.config[k] ?? "—"}`);
  }

  // A moved corpus BLOCKS a direction. The rows came from a different index
  // generation, so "improved" would be unattributable. We cannot cheaply
  // separate stable source-corpus identity from index-generation identity —
  // the manifest digest moves for both a reindex and a corpus edit — so the
  // conservative reading wins: no direction rather than a hedged one.
  // Separating the two (and per-track comparison) is future refinement.
  for (const k of new Set([...Object.keys(a.corpusSnapshot), ...Object.keys(b.corpusSnapshot)])) {
    if (a.corpusSnapshot[k] !== b.corpusSnapshot[k]) {
      blockers.push(
        `corpus/index generation changed for ${k} — a rank delta cannot be attributed to retrieval alone`,
      );
    }
  }
  // An unchanged pipeline is a RUN-level caution, not a per-delta confounder:
  // it says nothing about whether these particular rows are comparable, only
  // that a delta cannot be credited to a retrieval change that did not happen.
  const pipelineChanged = a.pipelineDigest !== b.pipelineDigest;
  if (!pipelineChanged) {
    confounders.push(
      "retrieval source digest is IDENTICAL between the two runs — any delta here is corpus drift or noise, not evidence that a retrieval change worked",
    );
  }

  const comparable = blockers.length === 0;

  const index = (r: AcceptanceReport) => {
    const m = new Map<string, ProbeOutcome>();
    for (const c of r.cases) for (const p of c.probes) m.set(`${c.id}/${p.probeId}`, p);
    return m;
  };
  const x = index(before);
  const y = index(after);
  const keys = [...new Set([...x.keys(), ...y.keys()])].sort();

  const verdictScore = (v: ProbeVerdict | undefined): number =>
    v === "pass" ? 3 : v === "weak-pass" ? 2 : v === "fail" ? 1 : 0;
  const rankScore = (p: ProbeOutcome | undefined): number =>
    p?.expectedRank ?? Number.POSITIVE_INFINITY;

  const deltas: ProbeDelta[] = keys.map((key) => {
    const p = x.get(key);
    const q = y.get(key);
    let direction: DeltaDirection;
    if (!comparable) direction = "not-comparable";
    else if (!p) direction = "new";
    else if (!q) direction = "dropped";
    else if (
      // "Not measured" is not "worse", and "honestly nothing there" is not
      // "better". An API-0 run skips paid probes; an unbound or aged-out case is
      // not evaluable; an honest-miss says the corpus had nothing, which is
      // non-green and non-evaluable for usefulness. A source disappearing must
      // never read as an improvement.
      NO_DIRECTION_VERDICTS.includes(p.verdict) ||
      NO_DIRECTION_VERDICTS.includes(q.verdict)
    ) {
      direction = "not-comparable";
    } else {
      const dv = verdictScore(q.verdict) - verdictScore(p.verdict);
      const dr = rankScore(p) - rankScore(q); // smaller rank is better
      if (dv > 0 || (dv === 0 && dr > 0)) direction = "improved";
      else if (dv < 0 || (dv === 0 && dr < 0)) direction = "regressed";
      else direction = "unchanged";
    }
    const snap = (o: ProbeOutcome | undefined) => ({
      verdict: o?.verdict ?? ("skipped" as ProbeVerdict),
      canonicalRank: o?.expectedRank ?? null,
      uniqueDocs: o?.diversity?.uniqueDocs,
    });
    return { key, before: snap(p), after: snap(q), direction };
  });

  return {
    comparable,
    blockers,
    confounders,
    pipelineChanged,
    verdictReset:
      before.humanAcceptance.verdict !== "unset" && a.resultDigest !== b.resultDigest,
    deltas,
  };
}

// --- Report ---------------------------------------------------------------

export type StewardVerdict = "usable" | "partial" | "not-improved" | "unset";
export type OneLessStep = "re-query" | "exact-title-search" | "extra-file-open" | "none" | "unset";

export interface ScenarioAcceptance {
  caseId: string;
  prompt: string;
  verdict: StewardVerdict;
  oneLessStep: OneLessStep;
  /** Required only for partial / not-improved. */
  reason?: string;
}

/**
 * Layer-3 evidence recorded on a DIFFERENT surface than this run measures.
 *
 * The steward closes acceptance with the real production tools (pi
 * `session_search` / `knowledge_search`, the emacs wrapper), not with `cli.ts`.
 * Those verdicts are the only ones that can say "usable" — and precisely
 * because they came from another surface, they must never be bound to this
 * run's CLI `resultDigest` or folded into its diagnostics. The report displays
 * them side by side and says which surface produced which.
 *
 * Loaded from `data/acceptance/l3-evidence.json` (gitignored) when present.
 */
export interface L3Evidence {
  measuredSurface: string;
  recordedAt: string;
  overall: string;
  scenarios: Array<{
    caseId: string;
    verdict: StewardVerdict;
    oneLessStep: OneLessStep;
    reason?: string;
  }>;
  note?: string;
}

export function loadL3Evidence(file: string): L3Evidence | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as L3Evidence;
    if (!parsed.measuredSurface || !Array.isArray(parsed.scenarios)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface HumanAcceptance {
  verdict: StewardVerdict;
  workflowChange: string;
  scenarios: ScenarioAcceptance[];
  /** The verdict is bound to this result digest; any change resets it to unset. */
  boundToResultDigest?: string;
  contract: string;
}

export interface CaseOutcome {
  id: string;
  type: CaseType;
  title: string;
  userQuestion: string;
  humanPrompt?: string;
  harnessGrades?: string;
  ownership?: AcceptanceCase["ownership"];
  anchors: AnchorHealth[];
  probes: ProbeOutcome[];
}

export interface DiagnosticsTally {
  pass: number;
  weakPass: number;
  fail: number;
  honestMiss: number;
  abstain: number;
  expired: number;
  skipped: number;
  error: number;
}

export interface RecallSuppression {
  env: string;
  requested: boolean;
  entriesBefore: number;
  entriesAfter: number;
  verified: boolean;
  note: string;
}

export interface AcceptanceReport {
  generatedAt: string;
  label?: string;
  host: string;
  scope: { retrievalEnabled: boolean; only?: string[]; casePacks: string[] };
  runIdentity: RunIdentity;
  scoreSemantics: typeof SCORE_SEMANTICS;
  productionContract: ProductionContract;
  recallSuppression: RecallSuppression;
  windowControl?: WindowControl;
  indexHealth: IndexHealth;
  recallLog: RecallLogReadiness;
  cases: CaseOutcome[];
  diagnostics: DiagnosticsTally;
  humanAcceptance: HumanAcceptance;
  /** Recorded on another surface; never bound to this run's resultDigest. */
  l3Evidence?: L3Evidence;
}

export function tallyDiagnostics(cases: CaseOutcome[]): DiagnosticsTally {
  const t: DiagnosticsTally = {
    pass: 0,
    weakPass: 0,
    fail: 0,
    honestMiss: 0,
    abstain: 0,
    expired: 0,
    skipped: 0,
    error: 0,
  };
  for (const c of cases) {
    for (const p of c.probes) {
      if (p.verdict === "pass") t.pass++;
      else if (p.verdict === "weak-pass") t.weakPass++;
      else if (p.verdict === "fail") t.fail++;
      else if (p.verdict === "honest-miss") t.honestMiss++;
      else if (p.verdict === "abstain") t.abstain++;
      else if (p.verdict === "expired") t.expired++;
      else if (p.verdict === "skipped") t.skipped++;
      else t.error++;
    }
  }
  return t;
}

const VERDICT_ICON: Record<ProbeVerdict, string> = {
  pass: "✅",
  "weak-pass": "🟡",
  fail: "❌",
  "honest-miss": "⬜",
  abstain: "◻️",
  expired: "🕗",
  skipped: "⏭",
  error: "💥",
};

export interface RenderOptions {
  /** Replace private-session excerpts with a placeholder. Always on when saving. */
  redactPrivateExcerpts?: boolean;
  comparison?: ComparisonResult;
}

function excerptFor(e: EvidenceRow, redact: boolean): string {
  if (redact && e.visibility === "private-session") return "_[private-session excerpt withheld]_";
  return e.excerpt || "—";
}

export function renderMarkdown(r: AcceptanceReport, opts: RenderOptions = {}): string {
  const redact = opts.redactPrivateExcerpts ?? false;
  const L: string[] = [];

  L.push(`# andenken acceptance report`);
  L.push("");
  L.push(
    `- generated \`${r.generatedAt}\` · host \`${r.host}\`${r.label ? ` · label \`${r.label}\`` : ""}`,
  );
  L.push(
    `- retrieval probes: **${r.scope.retrievalEnabled ? "enabled (paid query embeddings)" : "API-0 only — pass `--retrieval` to run paid probes"}**`,
  );
  L.push(`- case packs: ${r.scope.casePacks.map((p) => `\`${p}\``).join(", ")}`);
  L.push(
    `- measured surface \`${r.runIdentity.measuredSurface}\` · pipeline \`${r.runIdentity.pipelineContractVersion}\`/\`${r.runIdentity.pipelineDigest}\` · results \`${r.runIdentity.resultDigest}\``,
  );
  L.push("");

  // --- Human acceptance first. Diagnostics can never set it. ---
  L.push(`## 0. Human acceptance (layer 3)`);
  L.push("");
  L.push(`| slot | value |`);
  L.push(`|---|---|`);
  L.push(
    `| verdict | **${r.humanAcceptance.verdict === "unset" ? "UNSET — a human must choose `usable` / `partial` / `not-improved`" : r.humanAcceptance.verdict}** |`,
  );
  L.push(`| what changed in the actual workflow | ${r.humanAcceptance.workflowChange || "_(unset)_"} |`);
  L.push(`| bound to result digest | \`${r.humanAcceptance.boundToResultDigest ?? "—"}\` |`);
  L.push("");
  if (r.humanAcceptance.scenarios.length > 0) {
    L.push(`| scenario | prompt | verdict | one fewer step | reason |`);
    L.push(`|---|---|---|---|---|`);
    for (const s of r.humanAcceptance.scenarios) {
      L.push(
        `| \`${s.caseId}\` | ${s.prompt} | ${s.verdict} | ${s.oneLessStep} | ${s.reason ?? (s.verdict === "partial" || s.verdict === "not-improved" ? "**required**" : "—")} |`,
      );
    }
    L.push("");
  }
  L.push(`> ${r.humanAcceptance.contract}`);
  L.push("");
  if (r.l3Evidence) {
    const e = r.l3Evidence;
    L.push(
      `### 0.1 Layer-3 evidence from \`${e.measuredSurface}\` (recorded ${e.recordedAt})`,
    );
    L.push("");
    L.push(`| scenario | verdict | one fewer step | reason |`);
    L.push(`|---|---|---|---|`);
    for (const s2 of e.scenarios) {
      L.push(`| \`${s2.caseId}\` | **${s2.verdict}** | ${s2.oneLessStep} | ${s2.reason ?? "—"} |`);
    }
    L.push("");
    L.push(`**Overall: ${e.overall}**`);
    if (e.note) L.push(`- ${e.note}`);
    L.push("");
    L.push(
      `> Measured on \`${e.measuredSurface}\`, NOT on the \`${r.runIdentity.measuredSurface}\` surface this report measures. These verdicts are deliberately **not** bound to this run's result digest \`${r.runIdentity.resultDigest}\` and are **not** counted in the diagnostics tally — a verdict earned on one surface cannot be inherited by another.`,
    );
    L.push("");
  }

  // --- Diagnostics, explicitly separated ---
  const d = r.diagnostics;
  L.push(`## 1. Diagnostics (layers 1–2) — not acceptance`);
  L.push("");
  L.push(
    `${d.pass} pass · ${d.weakPass} weak-pass · ${d.fail} fail · ${d.honestMiss} honest-miss · ${d.abstain} abstain · ${d.expired} expired · ${d.skipped} skipped · ${d.error} error`,
  );
  L.push("");
  L.push(
    `> Layer 1 is a **prerequisite and a diagnosis**, not acceptance. \`honest-miss\`, \`abstain\` and \`expired\` are deliberately non-green and deliberately not failures. A green tally cannot set the verdict above.`,
  );
  L.push("");
  L.push(
    `**Recall suppression:** \`${r.recallSuppression.env}=1\` requested=${r.recallSuppression.requested}, log ${r.recallSuppression.entriesBefore} → ${r.recallSuppression.entriesAfter} entries, **verified=${r.recallSuppression.verified}**. ${r.recallSuppression.note}`,
  );
  L.push("");

  if (r.windowControl) {
    const w = r.windowControl;
    L.push(
      `**Window path control (API 0):** ${w.rows} row(s) over \`${w.dateFrom}\` → \`${w.dateTo}\` · **proven=${w.proven}**. ${w.note}${w.error ? ` (error: ${w.error})` : ""}`,
    );
    L.push("");
  }

  // --- Index health ---
  L.push(`### 1.1 Index / operator health (API 0)`);
  L.push("");
  L.push(`| track | db | manifest files | last indexed | age (h) | provider env |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const t of r.indexHealth.tracks) {
    L.push(
      `| ${t.track} | ${t.dbPresent ? "present" : "**MISSING**"} | ${t.manifestFiles} | ${t.manifestLastUpdated ?? "—"} | ${t.manifestAgeHours ?? "—"} | ${t.providerConfigured ? `${t.providerModel ?? "?"} / ${t.providerDimensions ?? "?"}d` : "**unset**"} |`,
    );
  }
  L.push("");
  const c = r.indexHealth.recentCoverage;
  if (c) {
    L.push(
      `**Recent write coverage (last ${c.windowHours}h, observed ${c.observedAt}):** ${c.sourceFiles} session files touched — ${c.fresh} fresh · ${c.liveAppend} live-append · ${c.stale} stale · ${c.unindexed} unindexed · ${c.totalLagBytes} bytes not yet embedded.`,
    );
    if (c.worst) {
      L.push("");
      L.push(
        `Worst settled lag: \`${c.worst.docId}\` — ${c.worst.lagBytes} bytes, last written ${c.worst.lagMinutes} min ago.`,
      );
    }
    L.push("");
    L.push(
      `> Sessions are graded by size growth (transcripts only append). \`live-append\` is a session being written right now — the index cannot hold it yet and that is not a quality defect. Only \`stale\` and \`unindexed\` are operator signals.`,
    );
    L.push("");
  }
  if (r.indexHealth.anchors.length > 0) {
    L.push(`| case anchor | track | policy | freshness | lag / detail |`);
    L.push(`|---|---|---|---|---|`);
    for (const a of r.indexHealth.anchors) {
      const icon =
        a.status === "fresh"
          ? "✅"
          : a.status === "unknown"
            ? "❔"
            : a.status === "source-missing"
              ? "⬜"
              : a.liveAppend
                ? "🕗"
                : "⚠️";
      const lag =
        a.lagBytes !== undefined
          ? `${a.lagBytes >= 0 ? "+" : ""}${a.lagBytes} bytes${a.liveAppend ? " (live append)" : ""}`
          : a.indexedChunks !== undefined
            ? `${a.indexedChunks} chunks indexed`
            : "—";
      L.push(
        `| \`${a.docId}\` | ${a.track} | ${a.policy} | ${icon} ${a.status} | ${a.detail ?? lag} |`,
      );
    }
    L.push("");
  }

  // --- Retrieval ---
  L.push(`### 1.2 andenken retrieval behaviour`);
  L.push("");
  for (const cs of r.cases) {
    L.push(`#### ${cs.id} — ${cs.title}  \`[${cs.type}]\``);
    L.push("");
    L.push(`> ${cs.userQuestion}`);
    L.push("");
    if (cs.ownership) {
      L.push(`- **timeline owns:** ${cs.ownership.timeline ?? "—"}`);
      L.push(`- **andenken grades:** ${cs.ownership.andenken ?? "—"}`);
      L.push(`- **harness grades:** ${cs.ownership.harness ?? "—"}`);
      L.push("");
    }
    for (const p of cs.probes) {
      for (const w of p.warnings) L.push(`> ⚠️ ${w}`);
      if (p.warnings.length > 0) L.push("");
      L.push(
        `**${VERDICT_ICON[p.verdict]} ${p.verdict} · ${p.probeId}** · \`${p.measuredSurface}\` · api-cost \`${p.apiCost}\` · rows ${p.rows}` +
          (p.expectedRank !== null
            ? ` · canonical rank **${p.expectedRank}** (threshold ${p.rankThreshold})`
            : "") +
          (p.missReason !== "none" ? ` · miss \`${p.missReason}\`` : "") +
          (p.countsTowardUsable ? "" : " · _does not count toward user acceptance_"),
      );
      L.push("");
      if (p.error) L.push(`  - error: \`${p.error}\``);
      if (p.diversity && p.rows > 0) {
        L.push(
          `  - documents: ${p.diversity.uniqueDocs} unique · max ${p.diversity.maxChunksPerDoc}/${p.rows} from one document (monopoly ${(p.diversity.monopolyRatio * 100).toFixed(0)}%)`,
        );
      }
      if (p.observedScoreRange) {
        L.push(
          `  - observed score range THIS RUN: ${p.observedScoreRange.min.toFixed(4)} – ${p.observedScoreRange.max.toFixed(4)} (not a calibrated band; see §2)`,
        );
      }
      if (p.groups && p.groups.length > 0) {
        L.push(
          `  - evidence groups: ${p.groups.map((g) => `${g.track} (${g.visibility}) ${g.rows} rows / ${g.uniqueDocs} docs`).join(" · ")}`,
        );
      }
      if (p.crossTrackFallback) L.push(`  - cross-track fallback fired (sessions → md)`);
      for (const n of p.notes) L.push(`  - ${n}`);
      if (p.evidence && p.evidence.length > 0) {
        L.push("");
        L.push(`  | rank | track | visibility | document | label | score | one-line |`);
        L.push(`  |---|---|---|---|---|---|---|`);
        for (const e of p.evidence.slice(0, 8)) {
          L.push(
            `  | ${e.rank} | ${e.track} | ${e.visibility} | \`${e.docId}\` | ${e.label ?? "—"} | ${e.score.toFixed(4)} | ${excerptFor(e, redact)} |`,
          );
        }
      }
      L.push("");
    }
    if (cs.humanPrompt) {
      L.push(`_Layer 3 prompt:_ **${cs.humanPrompt}**`);
      L.push("");
    }
    if (cs.harnessGrades) {
      L.push(`_Layer 3 question:_ ${cs.harnessGrades}`);
      L.push("");
    }
  }

  // --- Score semantics ---
  L.push(`## 2. How to read the scores`);
  L.push("");
  L.push(
    `- calibrated confidence: **${SCORE_SEMANTICS.calibratedConfidence}** — these are ranking artefacts, not probabilities.`,
  );
  L.push(
    `- cross-track score comparison: **${SCORE_SEMANTICS.crossTrackScoreComparison}** — sessions and md are never sorted against each other.`,
  );
  L.push(`- vector: ${SCORE_SEMANTICS.vectorTransform}`);
  L.push(`- lexical: ${SCORE_SEMANTICS.lexicalScore}`);
  for (const [track, s] of Object.entries(SCORE_SEMANTICS.strategies)) {
    L.push(
      `- **${track}** strategy \`${s.mergeStrategy}\` — ${s.formula}; weights ${s.vectorWeight}/${s.bm25Weight}, recency half-life ${s.recencyHalfLifeDays}d. ${s.note}`,
    );
  }
  const sent = SCORE_SEMANTICS.sentinels.mdVectorOnlyTop;
  L.push(`- sentinel ${sent.value} (${sent.scope}): ${sent.meaning}`);
  L.push(`- timeline fidelity: ${SCORE_SEMANTICS.timelineFidelity}`);
  L.push("");
  L.push(
    `> **No score band is hard-coded in this runner.** Observed ranges are computed per probe, from that run only, and labeled as observations. Formula and strategy are stable facts about the code; an observed range is not.`,
  );
  L.push("");

  // --- Production contract ---
  const pc = r.productionContract;
  L.push(`## 3. Production response contract (measured, not asserted)`);
  L.push("");
  L.push(`| what a consumer needs | exposed by the production response? |`);
  L.push(`|---|---|`);
  for (const [k, v] of Object.entries(pc.exposes)) L.push(`| ${k} | ${v} |`);
  L.push("");
  L.push(`- production-path parity: **${pc.productionPathParity}** — ${pc.parityNote}`);
  L.push(`- ${pc.note}`);
  L.push("");

  // --- Recall log ---
  L.push(`## 4. Recall-log readiness`);
  L.push("");
  L.push(
    `\`${r.recallLog.path}\` — ${r.recallLog.entries} entries${r.recallLog.firstTimestamp ? ` (${r.recallLog.firstTimestamp} → ${r.recallLog.lastTimestamp})` : ""}`,
  );
  L.push("");
  L.push(`| field a promotion gate needs | availability |`);
  L.push(`|---|---|`);
  for (const [k, v] of Object.entries(r.recallLog.fields)) L.push(`| ${k} | ${v} |`);
  L.push("");
  L.push(`**promotionGateReady: ${r.recallLog.promotionGateReady}**`);
  for (const reason of r.recallLog.reasons) L.push(`- ${reason}`);
  L.push("");

  // --- Comparison ---
  const cmp = opts.comparison;
  if (cmp) {
    L.push(`## 5. Before / after`);
    L.push("");
    if (!cmp.comparable) {
      L.push(`**NOT COMPARABLE** — the two runs do not measure the same thing:`);
      for (const b of cmp.blockers) L.push(`- ${b}`);
      L.push("");
      L.push(`> No direction is reported. Re-run both sides under one identity instead.`);
      L.push("");
    }
    for (const cf of cmp.confounders) L.push(`> ⚠️ ${cf}`);
    if (cmp.confounders.length > 0) L.push("");
    if (cmp.verdictReset) {
      L.push(
        `> 🔁 The result digest changed since the recorded verdict — that verdict is **reset to unset** and must be re-made by a human.`,
      );
      L.push("");
    }
    L.push(`| probe | before | after | direction |`);
    L.push(`|---|---|---|---|`);
    for (const dd of cmp.deltas) {
      const fmt = (s: ProbeDelta["before"]) =>
        `${s.verdict}${s.canonicalRank !== null ? ` @${s.canonicalRank}` : ""}${s.uniqueDocs !== undefined ? ` · ${s.uniqueDocs} docs` : ""}`;
      const icon =
        dd.direction === "improved"
          ? "📈"
          : dd.direction === "regressed"
            ? "📉"
            : dd.direction === "unchanged"
              ? "➡️"
              : dd.direction === "not-comparable"
                ? "🚫"
                : "🆕";
      L.push(
        `| \`${dd.key}\` | ${fmt(dd.before)} | ${fmt(dd.after)} | ${icon} ${dd.direction} |`,
      );
    }
    L.push("");
  }

  L.push(`---`);
  L.push("");
  L.push(
    `Layer 3 is not automated and will not be. This file is evidence for a human judgment, not the judgment. Automated CLI diagnostics cannot close it: the steward must run the real production tools once — see the \`andenken-acceptance\` skill.`,
  );
  L.push("");
  return L.join("\n");
}

// --- Case loading ---------------------------------------------------------

function loadPack(file: string): { pack: CasePack; raw: string } | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  const pack = JSON.parse(raw) as CasePack;
  if (!Array.isArray(pack.cases)) throw new Error(`${file}: missing "cases" array`);
  return { pack, raw };
}

export function isBindingExpired(c: AcceptanceCase, nowMs = Date.now()): boolean {
  if (!c.boundAt || typeof c.expiresAfterDays !== "number") return false;
  const bound = Date.parse(c.boundAt);
  if (Number.isNaN(bound)) return false;
  return nowMs > bound + c.expiresAfterDays * 86_400_000;
}

export function isUnbound(c: AcceptanceCase): boolean {
  if (!c.requiresLocalBinding) return false;
  const hasAnchor = (c.freshnessAnchors ?? []).length > 0;
  const hasCanonical = (c.probes ?? []).some((p) => (p.evidence?.canonical ?? []).length > 0);
  return !(hasAnchor && hasCanonical);
}

// --- Main -----------------------------------------------------------------

interface Cli {
  retrieval: boolean;
  json: boolean;
  save: boolean;
  strict: boolean;
  only: string[];
  casesFile?: string;
  outFile?: string;
  compareFile?: string;
  label?: string;
}

export function parseCliArgs(argv: string[]): Cli {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    retrieval: argv.includes("--retrieval"),
    json: argv.includes("--json"),
    save: argv.includes("--save"),
    strict: argv.includes("--strict"),
    only: (flag("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    casesFile: flag("cases"),
    outFile: flag("out"),
    compareFile: flag("compare"),
    label: flag("label"),
  };
}

const ACCEPTANCE_CONTRACT =
  "This runner cannot set this verdict, and neither can a green diagnostics tally. " +
  "Fill it only after running the real production tools on the scenarios above and answering, per scenario: " +
  "could you choose or reject an existing room from the first screen, and did it take at least one fewer step " +
  "(re-query / exact-title search / extra file open) than before? A reason is required for `partial` and `not-improved`.";

function countLines(file: string): number {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

async function main() {
  const repoRoot = path.dirname(fileURLToPath(import.meta.url));
  const cli = parseCliArgs(process.argv.slice(2));
  const nowMs = Date.now();

  const packPaths = cli.casesFile
    ? [cli.casesFile]
    : [
        path.join(repoRoot, "acceptance-cases.json"),
        path.join(repoRoot, "acceptance-cases.local.json"),
      ];
  const packs: CasePack[] = [];
  const loadedNames: string[] = [];
  const rawParts: string[] = [];
  for (const p of packPaths) {
    const got = loadPack(p);
    if (got) {
      packs.push(got.pack);
      loadedNames.push(path.basename(p));
      rawParts.push(got.raw);
    }
  }
  if (packs.length === 0) throw new Error(`no case pack found (looked at ${packPaths.join(", ")})`);

  let cases = mergeCasePacks(packs);
  if (cli.only.length > 0) cases = cases.filter((c) => cli.only.includes(c.id));
  if (cases.length === 0) throw new Error(`no cases matched --only ${cli.only.join(",")}`);

  // ---- Layer 1 ----
  const anchors = anchorHealth([...new Set(cases.flatMap((c) => c.freshnessAnchors ?? []))], nowMs);
  const tracks = [trackHealth("sessions"), trackHealth("md")];
  const indexHealth: IndexHealth = {
    tracks,
    anchors,
    recentCoverage: recentSessionCoverage(24, nowMs),
  };
  const recallLogPath = getRecallLogPath();
  const recallEntriesBefore = countLines(recallLogPath);

  // ---- Window path control (API 0) — runs once when any time-probe exists ----
  let windowControl: WindowControl | undefined;
  if (cases.some((c) => c.type === "time-probe" && (c.probes ?? []).length > 0)) {
    const ctrl = buildWindowControlProbe(nowMs);
    try {
      const raw = runCli(buildProbeArgs(ctrl), repoRoot);
      windowControl = interpretWindowControl(ctrl, (raw.results ?? []).length);
    } catch (err) {
      windowControl = interpretWindowControl(
        ctrl,
        0,
        err instanceof Error ? err.message.slice(0, 200) : String(err),
      );
    }
  }

  // ---- Layer 2 ----
  let contractSample: CliSearchOutput | null = null;
  const caseOutcomes: CaseOutcome[] = [];
  for (const c of cases) {
    const expired = isBindingExpired(c, nowMs);
    const unbound = isUnbound(c);
    const caseAnchors = anchors.filter((a) => (c.freshnessAnchors ?? []).includes(a.anchor));
    const probeOutcomes: ProbeOutcome[] = [];

    for (const probe of c.probes ?? []) {
      const cost = probeApiCost(probe);
      const stub = (verdict: ProbeVerdict, note: string): ProbeOutcome => ({
        caseId: c.id,
        caseType: c.type,
        probeId: probe.id,
        surface: probe.surface,
        measuredSurface: `cli:${probe.surface}`,
        query: probe.query,
        apiCost: cost,
        verdict,
        missReason: "none",
        countsTowardUsable: c.type !== "time-probe" && probe.grader !== "labeled-groups",
        warnings: [],
        notes: [note],
        rows: 0,
        expectedRank: null,
        rankThreshold: probe.rankThreshold ?? 3,
      });

      if (expired) {
        probeOutcomes.push(
          stub("expired", "local binding aged out — rebind anchor and query together"),
        );
        continue;
      }
      if (unbound) {
        probeOutcomes.push(
          stub(
            "abstain",
            "case requires a local binding that is not present — see acceptance-cases.local.json",
          ),
        );
        continue;
      }
      if (cost === "paid-query-embedding" && !cli.retrieval) {
        probeOutcomes.push(
          stub("skipped", "needs a paid query embedding; pass --retrieval to run it"),
        );
        continue;
      }
      try {
        const raw = runCli(buildProbeArgs(probe), repoRoot);
        // Assess the production contract on the first response that actually
        // carried rows: a zero-row window scan would report every field
        // "absent" and slander a surface it never exercised.
        if (contractSample === null && (raw.results ?? []).length > 0) contractSample = raw;
        probeOutcomes.push(
          evaluateProbe(c.id, probe, raw.results ?? [], {
            caseType: c.type,
            anchors,
            fallback: raw.fallback,
            windowPathProven: windowControl?.proven ?? false,
          }),
        );
      } catch (err) {
        const o = stub("error", "probe execution failed");
        o.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
        probeOutcomes.push(o);
      }
    }

    caseOutcomes.push({
      id: c.id,
      type: c.type,
      title: c.title,
      userQuestion: c.userQuestion,
      humanPrompt: c.humanPrompt,
      harnessGrades: c.harnessGrades,
      ownership: c.ownership,
      anchors: caseAnchors,
      probes: probeOutcomes,
    });
  }

  const recallEntriesAfter = countLines(recallLogPath);

  const runIdentity: RunIdentity = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    pipelineContractVersion: PIPELINE_CONTRACT_VERSION,
    pipelineDigest: pipelineDigest(repoRoot),
    casePackDigest: sha256(rawParts.join(" ")),
    measuredSurface: "cli",
    config: {
      sessionsModel: process.env.ANDENKEN_SESSION_MODEL ?? "unset",
      sessionsDim: process.env.ANDENKEN_SESSION_DIMENSIONS ?? "unset",
      mdModel: process.env.ANDENKEN_MD_MODEL ?? "unset",
      mdDim: process.env.ANDENKEN_MD_DIMENSIONS ?? "unset",
    },
    corpusSnapshot: {
      sessionsManifest: tracks[0].manifestDigest ?? "absent",
      sessionsLastUpdated: tracks[0].manifestLastUpdated ?? "absent",
      mdManifest: tracks[1].manifestDigest ?? "absent",
      mdLastUpdated: tracks[1].manifestLastUpdated ?? "absent",
    },
    resultDigest: resultDigestOf(caseOutcomes),
  };

  const report: AcceptanceReport = {
    generatedAt: new Date(nowMs).toISOString(),
    label: cli.label,
    host: os.hostname(),
    scope: {
      retrievalEnabled: cli.retrieval,
      only: cli.only.length > 0 ? cli.only : undefined,
      casePacks: loadedNames,
    },
    runIdentity,
    scoreSemantics: SCORE_SEMANTICS,
    productionContract: assessProductionContract("cli", contractSample),
    recallSuppression: {
      env: RECALL_TRACKING_ENV,
      requested: true,
      entriesBefore: recallEntriesBefore,
      entriesAfter: recallEntriesAfter,
      verified: recallEntriesAfter === recallEntriesBefore,
      note:
        recallEntriesAfter === recallEntriesBefore
          ? "the recall log did not grow during this run, so acceptance traffic did not enter the promotion evidence"
          : "THE RECALL LOG GREW — acceptance traffic leaked into the promotion evidence; investigate before trusting any recall statistic",
    },
    windowControl,
    indexHealth,
    recallLog: auditRecallLog(recallLogPath),
    cases: caseOutcomes,
    diagnostics: tallyDiagnostics(caseOutcomes),
    l3Evidence: loadL3Evidence(path.join(getDataDir(), "acceptance", "l3-evidence.json")),
    humanAcceptance: {
      verdict: "unset",
      workflowChange: "",
      scenarios: caseOutcomes
        .filter((c) => c.probes.some((p) => p.countsTowardUsable))
        .map((c) => ({
          caseId: c.id,
          prompt: c.humanPrompt ?? "Could you choose or reject an existing room from this first screen?",
          verdict: "unset" as StewardVerdict,
          oneLessStep: "unset" as OneLessStep,
        })),
      boundToResultDigest: undefined,
      contract: ACCEPTANCE_CONTRACT,
    },
  };

  let comparison: ComparisonResult | undefined;
  if (cli.compareFile) {
    const before = JSON.parse(fs.readFileSync(cli.compareFile, "utf-8")) as AcceptanceReport;
    comparison = compareRuns(before, report);
  }

  if (cli.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderMarkdown(report, { comparison }));

  if (cli.save || cli.outFile) {
    const dir = path.join(getDataDir(), "acceptance");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const base = cli.outFile ?? path.join(dir, `${stamp}${cli.label ? `--${cli.label}` : ""}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    fs.writeFileSync(
      `${base}.md`,
      renderMarkdown(report, { comparison, redactPrivateExcerpts: true }),
    );
    console.error(`\n💾 saved ${base}.json / .md (private excerpts redacted)`);
  }

  if (cli.strict && (report.diagnostics.fail > 0 || report.diagnostics.error > 0)) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`❌ acceptance failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
