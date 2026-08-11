/**
 * Hybrid Retriever
 *
 * OpenClaw-aligned pipeline:
 * 1. Weighted sum merge (vector × 0.7 + text × 0.3)
 * 2. Temporal decay (exponential, configurable halfLife)
 * 3. MMR diversity re-ranking (Jaccard-based, optional)
 * 4. Jina Rerank (optional, for when multilingual cross-encoder improves)
 *
 * Benchmark finding: Jina reranker v3 hurts Korean+English mixed docs
 * (MRR 0.754 → 0.642). Disabled by default. MMR used instead for diversity.
 */

import type { SearchResult } from "./store.js";

export interface RetrieverConfig {
  vectorWeight: number;
  bm25Weight: number;
  recencyHalfLifeDays: number;
  minScore: number;
  mmr: {
    enabled: boolean;
    lambda: number; // 0=max diversity, 1=max relevance
  };
  jinaApiKey?: string;
  jinaModel?: string;
  /**
   * Multiplier applied to scaffold chunks (History/KEYWORDS/Related-Notes
   * sections) during ranking. < 1 demotes them. Intent-aware: definition
   * queries (누구였지/뭐였지/시작점/왜 중요) trigger a stronger penalty.
   * Set to 1 to disable.
   */
  scaffoldPenalty: number;
  scaffoldPenaltyDefinition: number;
  /**
   * Document-level ordering, opt-in per track (see `capPerDocumentWithBackfill`).
   *
   * Absent = legacy behaviour: step 6 runs the id-shaped `fileDedup()` exactly
   * as before. The md core is the only caller that sets this today; sessions
   * must keep their existing ordering, so they do NOT pass it.
   */
  documentCap?: { maxPerDoc: number };
}

const DEFAULT_CONFIG: RetrieverConfig = {
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  recencyHalfLifeDays: 90, // org notes span years
  minScore: 0.05,
  mmr: {
    enabled: true,
    lambda: 0.7, // OpenClaw default
  },
  scaffoldPenalty: 0.65,
  scaffoldPenaltyDefinition: 0.5,
};

// --- Scaffold & Intent ---
//
// Org notes carry structural sections that surface in retrieval as low-signal
// "scaffold" chunks: History, KEYWORDS, Related-Notes. They are useful for
// navigation but bad as top results for definition queries. Damping is applied
// multiplicatively after merge so MMR/decay still operate on damped scores.

export const SCAFFOLD_MARKERS: readonly string[] = Object.freeze([
  "> History",
  "> KEYWORDS",
  "> Related-Notes",
  "> Related Notes",
  "> 히스토리",
  "> 관련노트",
  "> 연결노트",
]);

export function isScaffoldChunk(text: string): boolean {
  return SCAFFOLD_MARKERS.some((m) => text.includes(m));
}

/**
 * Markdown-track scaffold markers (public garden, `~/repos/gh/notes/content`).
 *
 * The org markers above are blockquote-shaped (`> History`) because that is how
 * Denote org files carry their generated sections. The Hugo export rewrites the
 * same sections as markdown headings (`## 히스토리 {#히스토리}`), so
 * `isScaffoldChunk()` matches NOTHING on the md track — measured 2026-07-27
 * against md.lance: 862 garden files carry `## 히스토리`, 864 `## 관련메타`,
 * 586 `## History`, 1570 `## BIBLIOGRAPHY`, and none were being detected.
 *
 * Kept as a SEPARATE list rather than merged into SCAFFOLD_MARKERS: merging
 * would silently change `applyScaffoldDamping()` behaviour for every track at
 * the same time as the golden eval that is supposed to measure it. This list is
 * observation-only for now — `golden-queries.ts` reports md scaffold density so
 * a damping change can be argued from numbers instead of intuition.
 */
export const MD_SCAFFOLD_MARKERS: readonly string[] = Object.freeze([
  "## History",
  "## Related-Notes",
  "## Related Notes",
  "## KEYWORDS",
  "## BIBLIOGRAPHY",
  "## CITATIONS",
  "## References",
  "## NEWNOTES",
  "## UPDATENOTES",
  "## PREVIOUS",
  "## PREV",
  "## REFILED",
  "## ARCHIVE",
  "## 히스토리",
  "## 관련메타",
  "## 관련노트",
  "## 연결노트",
]);

export function isMdScaffoldChunk(text: string): boolean {
  return MD_SCAFFOLD_MARKERS.some((m) => text.includes(m));
}

/**
 * Fraction of a chunk occupied by generated scaffold.
 *
 * Garden chunks routinely mix real prose with scaffold — a note's `> [!abstract]`
 * summary and its `## 히스토리` log land in the same chunk. A flat boolean would
 * condemn genuinely useful chunks, so retrieval quality is judged on how much of
 * the chunk is scaffold: everything from the FIRST scaffold heading to the end.
 * Returns 0 when no marker is present.
 */
export function mdScaffoldRatio(text: string): number {
  if (text.length === 0) return 0;
  let firstIdx = -1;
  for (const m of MD_SCAFFOLD_MARKERS) {
    const i = text.indexOf(m);
    if (i >= 0 && (firstIdx < 0 || i < firstIdx)) firstIdx = i;
  }
  if (firstIdx < 0) return 0;
  return (text.length - firstIdx) / text.length;
}

// Definition intent: "누구였지", "뭐였지", "시작점", "왜 중요", "소개", "이란",
// or query ending with bare "뭐지/누구지".
const DEFINITION_INTENT_RE =
  /누구였지|누구지$|누구야$|뭐였지|뭐지$|뭐야$|시작점|왜\s*중요|소개$|소개야$|이란\?|란\s*뭐/;

export function isDefinitionQuery(query: string): boolean {
  return DEFINITION_INTENT_RE.test(query);
}

export function applyScaffoldDamping(
  results: SearchResult[],
  penalty: number,
): SearchResult[] {
  if (penalty >= 1) return results;
  return results.map((r) =>
    isScaffoldChunk(r.text) ? { ...r, score: r.score * penalty } : r,
  );
}

// --- Document identity ---
//
// `sessionFile` is the document path on EVERY track — sessions store the JSONL
// path (`session-indexer.ts`), md stores the markdown path (`md-chunker.ts
// mdChunkToStoreRow`), org stores the org path (`indexer.ts indexOrg`). It is
// also what `acceptance.ts diversityOf()` already grades on.
//
// Chunk ids are NOT a reliable document key: they carry three different shapes
// (`path.md#3`, `path.jsonl:4521`, `path.org:c12`) and the legacy regex below
// only ever collapsed the org one. Parse ids only as a last resort, for rows
// that predate the stored `sessionFile` column — and when we do, strip ALL
// THREE suffixes, not just the org one. A fallback that handles one shape is
// how the original defect stayed invisible.

/** md `#12` · session `:4521` · org `:c12` / `:h44` / `:c12:m3`. */
const CHUNK_ID_SUFFIX = /(?:#\d+|:[ch]\d+(?:[:.].*)?|:\d+)$/;

export function canonicalDocId(r: SearchResult): string {
  if (r.sessionFile) return r.sessionFile;
  return r.id.replace(CHUNK_ID_SUFFIX, "");
}

/**
 * Cap a ranked list at `maxPerDoc` chunks per document WITHOUT losing anything.
 *
 * Over-cap chunks are not dropped; they are appended after the capped pass in
 * their original INPUT order — which is the ranked order this function receives,
 * not raw score order, because MMR has already re-ordered the list by the time
 * it gets here. The output is therefore a PERMUTATION of the input — same ids,
 * same count — so recall is provably unchanged and a narrow lookup whose answer
 * genuinely lives in one document still fills the screen. Only the ORDER
 * changes, which is what a first-screen monopoly actually is.
 */
export function capPerDocumentWithBackfill(
  results: SearchResult[],
  maxPerDoc: number,
): SearchResult[] {
  if (maxPerDoc <= 0 || results.length <= 1) return [...results];
  const counts = new Map<string, number>();
  const primary: SearchResult[] = [];
  const overflow: SearchResult[] = [];
  for (const r of results) {
    const doc = canonicalDocId(r);
    const n = counts.get(doc) ?? 0;
    if (n < maxPerDoc) {
      counts.set(doc, n + 1);
      primary.push(r);
    } else {
      overflow.push(r);
    }
  }
  return [...primary, ...overflow];
}

// --- File-level dedup (LEGACY, id-shaped) ---
//
// Vector search on dense embeddings returns many chunks from the SAME file
// (e.g., 10/10 from one document). This kills diversity in the merge.
// Keep only top-K chunks per file before merge to let other files surface.
//
// KNOWN SCOPE (measured 2026-08-11): the regex matches `:c12` / `:h44` only, so
// this is a NO-OP for md (`path.md#3`) and for sessions (`path.jsonl:4521`).
// The only track it actually caps is org, which is disabled in production.
// It is retained unchanged so the org weighted path and the session ordering
// keep their existing behaviour; the md track opts into
// `capPerDocumentWithBackfill` instead, which is lossless.
function fileDedup(results: SearchResult[], maxPerFile: number = 3): SearchResult[] {
  const fileCounts = new Map<string, number>();
  return results.filter(r => {
    // Extract file path from chunk ID (format: /path/to/file.org:cN:M or :hN)
    const file = r.id.replace(/:[ch]\d+.*$/, "");
    const count = fileCounts.get(file) ?? 0;
    if (count >= maxPerFile) return false;
    fileCounts.set(file, count + 1);
    return true;
  });
}

// --- Weighted Sum Merge (OpenClaw pattern + score normalization) ---
//
// LanceDB FTS _score (~10-25) vs vector 1/(1+distance) (~0.4-0.65).
// Without normalization, FTS dominates ~90% of the weighted sum,
// making vector semantic search effectively useless.
// Max-normalization brings both to [0, 1] so weights are meaningful.

export function weightedMerge(
  vectorResults: SearchResult[],
  ftsResults: SearchResult[],
  vectorWeight: number,
  textWeight: number,
): SearchResult[] {
  // File-level dedup: prevent one file from monopolizing either signal
  const vecDeduped = fileDedup(vectorResults);
  const ftsDeduped = fileDedup(ftsResults);
  const maxVec = vecDeduped.length > 0
    ? Math.max(...vecDeduped.map(r => r.score))
    : 1;
  const maxFts = ftsDeduped.length > 0
    ? Math.max(...ftsDeduped.map(r => r.score))
    : 1;

  const byId = new Map<string, { result: SearchResult; vecNorm: number; ftsNorm: number; inBoth: boolean }>();

  for (const r of vecDeduped) {
    byId.set(r.id, {
      result: r,
      vecNorm: maxVec > 0 ? r.score / maxVec : 0,
      ftsNorm: 0,
      inBoth: false,
    });
  }

  for (const r of ftsDeduped) {
    const existing = byId.get(r.id);
    const norm = maxFts > 0 ? r.score / maxFts : 0;
    if (existing) {
      existing.ftsNorm = norm;
      existing.inBoth = true;
    } else {
      byId.set(r.id, { result: r, vecNorm: 0, ftsNorm: norm, inBoth: false });
    }
  }

  return Array.from(byId.values())
    .map(({ result, vecNorm, ftsNorm, inBoth }) => {
      let score = vectorWeight * vecNorm + textWeight * ftsNorm;
      // Cross-signal agreement: both vector AND FTS found this result
      if (inBoth) score *= 1.1;
      return { ...result, score };
    })
    .sort((a, b) => b.score - a.score);
}

// --- RRF (kept for session search where it works well) ---
// Top-rank bonus: results ranking #1 in any list get score boost.

export function rrfFusion(
  vectorResults: SearchResult[],
  ftsResults: SearchResult[],
  vectorWeight: number,
  bm25Weight: number,
  k: number = 60,
): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; score: number; topRank: number }>();

  vectorResults.forEach((r, rank) => {
    const s = vectorWeight / (k + rank + 1);
    const e = scoreMap.get(r.id);
    if (e) {
      e.score += s;
      e.topRank = Math.min(e.topRank, rank);
    } else {
      scoreMap.set(r.id, { result: r, score: s, topRank: rank });
    }
  });

  ftsResults.forEach((r, rank) => {
    const s = bm25Weight / (k + rank + 1);
    const e = scoreMap.get(r.id);
    if (e) {
      e.score += s;
      e.topRank = Math.min(e.topRank, rank);
    } else {
      scoreMap.set(r.id, { result: r, score: s, topRank: rank });
    }
  });

  // Top-rank bonus
  for (const entry of scoreMap.values()) {
    if (entry.topRank === 0) entry.score += 0.05;
    else if (entry.topRank <= 2) entry.score += 0.02;
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

// --- Timestamp-DESC sort (Phase 1 — mode="recent") ---
//
// For timestamp-primary surfaces, the caller has already applied hard
// filters (dateFrom/dateTo/project/role/source/sessionFile) and now wants
// results ordered by timestamp DESC. Score is only a tie-break when present;
// mode="recent" typically feeds filter-only rows with score=0. This is NOT
// a time decay — it is a primary sort.
//
// Empty / unparseable timestamps sort last (treated as epoch 0).

export function sortByTimestampDesc(
  results: SearchResult[],
): SearchResult[] {
  return [...results].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    const tA = isNaN(ta) ? 0 : ta;
    const tB = isNaN(tb) ? 0 : tb;
    if (tB !== tA) return tB - tA;
    return b.score - a.score; // tie-break on relevance
  });
}

// --- Temporal Decay (OpenClaw pattern) ---

export function applyRecencyDecay(
  results: SearchResult[],
  halfLifeDays: number,
): SearchResult[] {
  if (halfLifeDays <= 0) return results;
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeDays;

  return results.map((r) => {
    if (!r.timestamp) return r;
    const ts = new Date(r.timestamp).getTime();
    if (isNaN(ts)) return r;
    const ageInDays = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
    return { ...r, score: r.score * Math.exp(-lambda * ageInDays) };
  });
}

// --- MMR Diversity Re-ranking (OpenClaw pattern) ---

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const t of smaller) {
    if (larger.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export function mmrRerank(
  results: SearchResult[],
  lambda: number = 0.7,
): SearchResult[] {
  if (results.length <= 1) return [...results];

  const tokenCache = new Map<string, Set<string>>();
  for (const r of results) {
    tokenCache.set(r.id, tokenize(r.text));
  }

  // Normalize scores
  const maxScore = Math.max(...results.map((r) => r.score));
  const minScore = Math.min(...results.map((r) => r.score));
  const range = maxScore - minScore;
  const norm = (s: number) => (range === 0 ? 1 : (s - minScore) / range);

  const selected: SearchResult[] = [];
  const remaining = new Set(results);

  while (remaining.size > 0) {
    let bestItem: SearchResult | null = null;
    let bestMMR = -Infinity;

    for (const candidate of remaining) {
      const relevance = norm(candidate.score);

      // Max similarity to already selected
      let maxSim = 0;
      const candTokens = tokenCache.get(candidate.id)!;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candTokens, tokenCache.get(sel.id)!);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMR || (mmrScore === bestMMR && candidate.score > (bestItem?.score ?? -Infinity))) {
        bestMMR = mmrScore;
        bestItem = candidate;
      }
    }

    if (bestItem) {
      selected.push(bestItem);
      remaining.delete(bestItem);
    } else break;
  }

  return selected;
}

// --- Jina Rerank (optional — currently hurts Korean+English) ---

export async function jinaRerank(
  query: string,
  results: SearchResult[],
  apiKey: string,
  model: string = "jina-reranker-v3",
  topN: number = 10,
): Promise<SearchResult[]> {
  if (results.length === 0) return [];

  const res = await fetch("https://api.jina.ai/v1/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      query,
      documents: results.map((r) => r.text),
      top_n: topN,
    }),
  });

  if (!res.ok) {
    return results.slice(0, topN);
  }

  const data = (await res.json()) as {
    results: Array<{ index: number; relevance_score: number }>;
  };

  return data.results.map((r) => ({
    ...results[r.index],
    score: r.relevance_score,
  }));
}

// --- Short CJK token detection (Track 1 / openclaw planKeywordSearch port) ---
//
// Hangul, Hiragana, Katakana, CJK Unified Ideographs, Jamo. CJK_RUN_RE
// extracts maximal CJK runs while ignoring whitespace, ASCII punctuation,
// parentheses, etc. ASCII_ALNUM_RE is the boundary guard.
//
// Extraction is run-based (not whitespace-split) so queries like "맘?",
// "(맘)", "맘," reduce to the bare CJK run "맘" and reach substringSearch
// as the caller intended.
//
// Boundary guard skips CJK runs that touch ASCII letters/digits. Such runs
// are almost always Korean particles or suffixes attached to English
// identifiers — "API를", "OpenClaw사", "3개" — and `contains(text, '를')`
// would match every Korean sentence, swamping the FTS bucket with noise.
// Trade-off: deliberate mixed aliases like "Qwen맘" are also skipped, but
// those are vanishingly rare in real query logs while particle-suffix noise
// is constant.
const CJK_RUN_RE =
  /[぀-ヿ㐀-鿿가-힯ㄱ-ㅣ]+/gu;
const ASCII_ALNUM_RE = /[a-zA-Z0-9]/;

/**
 * Pull short CJK runs (1–2 code points) out of a query.
 *
 * LanceDB FTS (tantivy) drops or splits tokens like "맘" / "갑" / "쟈" /
 * "맘마" — they return 0 hits via `fullTextSearch`. We surface them so the
 * caller can run `substringSearch` per run and merge into the FTS bucket.
 *
 * Mirrors openclaw's `planKeywordSearch().substringTerms` branch, but
 * applied at the application layer because LanceDB has no `LIKE` operator
 * directly — we use `contains()` instead.
 */
export function getShortCJKTokens(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // matchAll yields the index of each run so we can inspect adjacent chars
  // and apply the ASCII-boundary guard documented above.
  for (const m of query.matchAll(CJK_RUN_RE)) {
    const run = m[0];
    // Array.from to count code points, not UTF-16 units
    if (Array.from(run).length >= 3) continue;
    const start = m.index ?? 0;
    const end = start + run.length;
    if (start > 0 && ASCII_ALNUM_RE.test(query[start - 1])) continue;
    if (end < query.length && ASCII_ALNUM_RE.test(query[end])) continue;
    if (seen.has(run)) continue;
    out.push(run);
    seen.add(run);
  }
  return out;
}

// --- Korean BM25 Query Preprocessing (Layer 1 optimization) ---
// Ported from OpenClaw query-expansion.ts
// Strips Korean trailing particles for better BM25 token matching.
// Uses dual-emit: original token + stripped stem both included.
// This is Layer 1 (embedding/BM25 preprocessing), NOT Layer 3 (dictcli).

// Sorted by descending length for longest-match-first
const KO_TRAILING_PARTICLES = [
  // 2-syllable (longer first)
  "에서", "으로", "에게", "한테", "처럼", "같이", "보다", "까지", "부터", "마다", "밖에", "대로",
  // 1-syllable
  "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만",
];

function stripKoreanParticle(token: string): string | null {
  for (const p of KO_TRAILING_PARTICLES) {
    if (token.length > p.length && token.endsWith(p)) {
      return token.slice(0, -p.length);
    }
  }
  return null;
}

function isUsefulKoreanStem(stem: string): boolean {
  // Prevent bogus 1-syllable stems: "논의" → "논" (bad)
  if (/[\uac00-\ud7af]/.test(stem)) return stem.length >= 2;
  // Keep ASCII stems: "API를" → "API" (good)
  return /^[a-z0-9_]+$/i.test(stem);
}

/**
 * Expand query for BM25: emit original tokens + Korean particle-stripped stems.
 * Does NOT modify the vector query (Gemini handles Korean natively).
 */
export function expandQueryForBM25(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  const expanded: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!seen.has(token)) {
      expanded.push(token);
      seen.add(token);
    }
    // Dual emit: add stripped stem if different
    const stem = stripKoreanParticle(token);
    if (stem && isUsefulKoreanStem(stem) && !seen.has(stem)) {
      expanded.push(stem);
      seen.add(stem);
    }
  }

  return expanded.join(" ");
}

// --- Full Pipeline ---

export type MergeStrategy = "weighted" | "rrf";

export async function retrieve(
  query: string,
  vectorResults: SearchResult[],
  ftsResults: SearchResult[],
  config: Partial<RetrieverConfig> & { mergeStrategy?: MergeStrategy } = {},
): Promise<SearchResult[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const strategy = config.mergeStrategy ?? "weighted";

  // 1. Merge
  let results =
    strategy === "rrf"
      ? rrfFusion(vectorResults, ftsResults, cfg.vectorWeight, cfg.bm25Weight)
      : weightedMerge(vectorResults, ftsResults, cfg.vectorWeight, cfg.bm25Weight);

  // 2. Scaffold damping (intent-aware)
  const penalty = isDefinitionQuery(query)
    ? cfg.scaffoldPenaltyDefinition
    : cfg.scaffoldPenalty;
  results = applyScaffoldDamping(results, penalty);

  // 3. Temporal decay
  results = applyRecencyDecay(results, cfg.recencyHalfLifeDays);
  results.sort((a, b) => b.score - a.score);

  // 4. Min score filter
  results = results.filter((r) => r.score >= cfg.minScore);

  // 5. MMR diversity (default on)
  if (cfg.mmr?.enabled && results.length > 1) {
    results = mmrRerank(results, cfg.mmr.lambda);
  }

  // 6. Post-merge document ordering.
  //
  // Tracks that opt in (md) get the lossless per-document cap: over-cap chunks
  // are moved behind the capped pass instead of being discarded. Tracks that do
  // not (sessions, org) keep the legacy id-shaped `fileDedup` unchanged.
  results = cfg.documentCap
    ? capPerDocumentWithBackfill(results, cfg.documentCap.maxPerDoc)
    : fileDedup(results, 3);

  // 7. Optional Jina rerank (off by default for org, on for sessions)
  if (cfg.jinaApiKey && results.length > 0) {
    results = await jinaRerank(query, results, cfg.jinaApiKey, cfg.jinaModel, 10);
  }

  return results;
}
