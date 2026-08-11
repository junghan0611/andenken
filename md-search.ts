/**
 * andenken md-search — shared retrieval core for the md (public garden) track.
 *
 * WHY THIS MODULE EXISTS
 *
 * `golden-queries.ts` exists to catch retrieval regressions on the surface
 * agents actually call. That only works if the eval runs the SAME pipeline as
 * production. The org track proved what happens otherwise: golden re-implemented
 * the org search inline with `recencyHalfLifeDays: 90` while `cli.ts` used its
 * own parameters, so the eval measured a pipeline no caller ever used.
 *
 * `cli.ts` cannot be imported (it calls `main()` at module top level), so the md
 * pipeline lives here and BOTH `cli.ts searchMd` and `golden-queries.ts` call it.
 * Any tuning change lands in one place and the eval sees it automatically.
 *
 * Callers own store lifecycle (init / dim check / close) and output formatting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { VectorStore, type SearchResult } from "./store.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import {
  retrieve,
  expandQueryForBM25,
  getShortCJKTokens,
  canonicalDocId,
  type MergeStrategy,
} from "./retriever.js";

// --- md retrieval + presentation contract (single source of truth) ---
//
// These constants are exported so `cli.ts search-md` and the pi extension's
// `knowledge_search` render the SAME screen. Three copies of a truncation
// budget is how the 500c/800c split happened in the first place (measured
// 2026-08-11: born together in commit 02eb802, never reconciled).

/** Minimum candidate pool, independent of how many rows the caller displays. */
export const MD_CANDIDATE_FLOOR = 40;
/** Upper bound on the candidate pool (LanceDB scan budget). */
export const MD_CANDIDATE_CEILING = 200;
/** Chunks of one document allowed in the capped pass before backfill. */
export const MD_MAX_CHUNKS_PER_DOC = 2;
/** Display-only body budget per chunk on the compact screen. */
export const MD_SNIPPET_CHARS = 200;
/** Display-only body budget per chunk when the caller asks for the full row. */
export const MD_FULL_CHARS = 800;
/**
 * Display budget for a document's own description.
 *
 * Frontmatter is author-written and unbounded — measured p50 is 60 chars but
 * the tail reaches 224 today and nothing stops it growing. An unbounded field
 * on the compact screen would re-open the context blow-up this screen exists to
 * close, so the budget is stated rather than assumed.
 */
export const MD_DESCRIPTION_CHARS = 240;
/** Display budget for a document title. Same reasoning, smaller field. */
export const MD_TITLE_CHARS = 120;
/** Default rows for a conceptual md query. Raise deliberately, not by habit. */
export const MD_DEFAULT_LIMIT = 5;

/**
 * Candidate depth for an md query.
 *
 * `limit` used to be the only input (`limit * 4`), which made it a RANKING
 * parameter and not just a display one: shrinking it shrank the pool, which
 * moved the max-normalisation denominators and the MMR input, which changed
 * WHICH documents could appear. Two production `knowledge_search` calls on the
 * same query 46 minutes apart returned different rows at ranks 3 and 5 for
 * exactly this reason (recall log, 2026-08-11 01:10 vs 01:56).
 *
 * The floor decouples the two ONLY up to `MD_CANDIDATE_FLOOR / 4` (limit 10
 * today): at or below that, every display limit sees the same candidate
 * universe, so lowering the default is free. Above it the pool still grows with
 * the limit and the ranking can genuinely shift — that is a real widening, not
 * a display change, and callers should be told so.
 */
export function mdCandidateCount(limit: number): number {
  return Math.min(Math.max(MD_CANDIDATE_FLOOR, limit * 4), MD_CANDIDATE_CEILING);
}

/**
 * Korean → English tag expansion via the dictcli skill binary.
 *
 * Shared by every search surface (sessions / knowledge / md) so a query is
 * enriched identically no matter which track answers it. Silent on failure:
 * dictcli is an optional local skill, and its absence must degrade retrieval
 * quality rather than break search.
 */
export function dictcliExpand(query: string): string[] {
  const koreanWords = query.match(/[가-힯]+/g) ?? [];
  if (koreanWords.length === 0) return [];

  const dictcliDir = path.join(
    process.env.HOME ?? "",
    ".pi",
    "agent",
    "skills",
    "pi-skills",
    "dictcli",
  );
  const dictcliBin = path.join(dictcliDir, "dictcli");
  if (!fs.existsSync(dictcliBin)) return [];

  const expanded: string[] = [];
  for (const word of koreanWords) {
    try {
      const out = execSync(`./dictcli expand "${word}" --json`, {
        timeout: 1000,
        encoding: "utf-8",
        cwd: dictcliDir,
      }).trim();
      if (out.startsWith("[")) {
        expanded.push(...(JSON.parse(out) as string[]));
      }
    } catch {
      // silent
    }
  }
  return [...new Set(expanded)];
}

export interface MdSearchOutcome {
  /** Ranked results, already truncated to `limit`. */
  results: SearchResult[];
  /** dictcli expansion terms actually applied (empty when expand is off). */
  expanded: string[];
}

export interface MdSearchOptions {
  /** Set false to measure the raw query without dictcli expansion. */
  expand?: boolean;
  /**
   * Override the expansion function. The pi extension keeps a 30-minute
   * in-memory cache in front of `dictcliExpand`; without this hook, routing
   * `knowledge_search` through the shared core would silently trade that cache
   * for a subprocess call on every query. Defaults to the uncached export.
   */
  expandFn?: (query: string) => string[];
}

/**
 * Run the md-track retrieval pipeline.
 *
 * Store must already be `init()`-ed and dim-checked by the caller — this
 * function issues a paid embedding call and must never run against a stale
 * index.
 */
export async function searchMdCore(
  store: VectorStore,
  provider: EmbeddingProvider,
  query: string,
  limit: number,
  options: MdSearchOptions = {},
): Promise<MdSearchOutcome> {
  const useExpand = options.expand !== false;
  const expandWith = options.expandFn ?? dictcliExpand;
  const expanded = useExpand ? expandWith(query) : [];
  const enrichedQuery =
    expanded.length > 0 ? `${query} ${expanded.join(" ")}` : query;

  const candidates = mdCandidateCount(limit);
  const queryVector = await provider.embedQuery(enrichedQuery);
  const bm25Query = expandQueryForBM25(enrichedQuery);
  const vectorResults = await store.search(queryVector, candidates, 0.05);
  const ftsResults = await store.fullTextSearch(bm25Query, candidates);

  // gpt-5.5 review #2 (2026-05-12): short-CJK substring fallback.
  // LanceDB FTS drops 1-2 char Hangul/CJK tokens below the match threshold,
  // so queries like "힣", "맘", "갑" return 0 FTS hits even when the body
  // clearly contains the term. Mirrors the searchSessions path: pull short
  // CJK runs from the query, hit substringSearch(), interleave into the
  // FTS bucket so RRF/weighted merge keeps them in rank order.
  //
  // No source filter — md store rows already carry source="md" by the
  // store-row adapter, and there is no in-track variant to filter on.
  const shortTokens = getShortCJKTokens(query);
  if (shortTokens.length > 0) {
    const ftsIds = new Set(ftsResults.map((r) => r.id));
    const subLists = await Promise.all(
      shortTokens.map((t) => store.substringSearch(t, candidates)),
    );
    const subFlat: typeof ftsResults = [];
    const subSeen = new Set<string>();
    for (const list of subLists) {
      for (const r of list) {
        if (ftsIds.has(r.id) || subSeen.has(r.id)) continue;
        subFlat.push(r);
        subSeen.add(r.id);
      }
    }
    if (subFlat.length > 0) {
      const ftsCopy = ftsResults.slice();
      ftsResults.length = 0;
      let i = 0;
      let j = 0;
      while (i < ftsCopy.length || j < subFlat.length) {
        if (i < ftsCopy.length) ftsResults.push(ftsCopy[i++]);
        if (j < subFlat.length) ftsResults.push(subFlat[j++]);
      }
    }
  }

  // gpt-5.5 review #8 + GLG decision (2026-05-12): no recency decay for md.
  // Garden is not chronological — a 2021 long-form note is as relevant as a
  // 2025 one when the query asks for the concept itself. applyRecencyDecay
  // short-circuits on halfLifeDays <= 0, so this skips the decay branch
  // entirely without touching retriever code.
  const results = await retrieve(query, vectorResults, ftsResults, {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    recencyHalfLifeDays: 0,
    minScore: 0.05,
    mmr: { enabled: true, lambda: 0.7 },
    mergeStrategy: "weighted" as MergeStrategy,
    // md-only, lossless: a document may hold 2 rows of the capped pass; its
    // remaining chunks move behind that pass in the ranked order they arrived
    // in, rather than being dropped, so a narrow lookup whose answer really is
    // one document still fills the screen.
    documentCap: { maxPerDoc: MD_MAX_CHUNKS_PER_DOC },
  });

  return { results: results.slice(0, limit), expanded };
}

// --- Presentation ---------------------------------------------------------
//
// The md corpus is a Hugo/org export, so the stored `text` carries export
// scaffold that is noise on screen: `{{< relref … >}}` wrappers, timestamp
// `<span>` tags, `{#heading-anchor}` suffixes, HTML entities. Measured
// 2026-08-11: 14.7% of the visible window on real hits. Stripped for DISPLAY
// ONLY — the stored text, the FTS index, and the vectors are untouched.

const MD_DISPLAY_NOISE: readonly RegExp[] = Object.freeze([
  /\{\{<\s*relref\s+"[^"]*"\s*>\}\}/g,
  /\{\{%\s*relref\s+"[^"]*"\s*%\}\}/g,
  /<span class="[^"]*">|<\/span>/g,
  /\{#[^}\n]*\}/g,
]);

/** The `Title: …\nTags: …` FTS preamble `mdChunkToStoreRow` prepends to `text`. */
const MD_TEXT_PREAMBLE = /^Title:.*\n(?:Tags:.*\n)?\n?/;

export function stripMdDisplayScaffold(text: string): string {
  let out = text.replace(MD_TEXT_PREAMBLE, "");
  for (const re of MD_DISPLAY_NOISE) out = out.replace(re, "");
  return out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    // A relref link loses its target above, leaving `[title]()`. Keep the
    // title — it is often the only name of a neighbouring note on the screen —
    // and drop the empty parens.
    .replace(/\[([^\]]*)\]\(\s*\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Bound any display string. Every string that reaches the compact screen goes
 * through a budget — the screen's size must be a property of the format, not of
 * what someone typed into frontmatter or how long a chunk happens to be.
 */
export function mdDisplayField(value: string, budget: number): string {
  const clean = stripMdDisplayScaffold(value).replace(/\n+/g, " ");
  return clean.length > budget ? `${clean.slice(0, budget)}…` : clean;
}

/**
 * One chunk, reduced to what a caller needs to accept or reject the document.
 * Same contract as `mdDisplayField` — a body is just the longest display field
 * on the screen — so it is the same function with the chunk budget as default.
 */
export function mdSnippet(text: string, budget: number = MD_SNIPPET_CHARS): string {
  return mdDisplayField(text, budget);
}

export interface MdDocGroup {
  /** Canonical document path — openable as-is. */
  file: string;
  title: string;
  denoteId: string;
  description: string;
  /** Top-level folder the export assigns (notes / botlog / journal / …). */
  project: string;
  /**
   * Chunks in rank order. Deliberately no group-level score: a document's
   * position IS its rank, and a normalized rank rendered as a number is the
   * confidence illusion this screen exists to remove. Per-chunk scores stay on
   * `SearchResult` for `details` / the CLI JSON.
   */
  chunks: SearchResult[];
}

/**
 * Group a ranked md result list by document, preserving rank order.
 *
 * Rank order is the order the retriever produced; a document takes the position
 * of its FIRST chunk. This is what makes the compact screen cheaper without
 * re-ranking anything: the document header (title, Denote ID, the author's own
 * description) is printed once instead of once per adjacent chunk.
 */
export function groupMdResultsByDocument(results: SearchResult[]): MdDocGroup[] {
  const byDoc = new Map<string, MdDocGroup>();
  const order: string[] = [];
  for (const r of results) {
    const key = canonicalDocId(r);
    let g = byDoc.get(key);
    if (!g) {
      g = {
        file: r.sessionFile || key,
        title: r.metadata?.title ?? "",
        denoteId: r.metadata?.denoteId ?? "",
        description: r.metadata?.description ?? "",
        project: r.project ?? "",
        chunks: [],
      };
      byDoc.set(key, g);
      order.push(key);
    }
    g.chunks.push(r);
  }
  return order.map((k) => byDoc.get(k)!);
}

export interface MdFormatOptions {
  /** Full body instead of the compact snippet (CLI `--full`). */
  full?: boolean;
}

/**
 * The md first screen, shared by `cli.ts search-md` and `knowledge_search`.
 *
 * Deliberately absent from the model-visible screen:
 *
 * - **the numeric score.** `weightedMerge` max-normalises per query, so the top
 *   md hit lands near 1.0 whatever the match quality (measured over 240 real
 *   calls: p50 1.060, 98.3% inside [0.70, 1.10]). Printing it invites a reader
 *   to treat a within-query rank as a confidence. Rank is already carried by
 *   document order; the number stays in `details` / the CLI JSON for tooling.
 * - **the constant `[md] doc` role/source tag** — every md row carries it.
 * - **the stored `timestamp`** — for md that column is the export FILE MTIME,
 *   not the note's date, so printing it as "Time" invites an agent to read an
 *   indexing artefact as a temporal fact. The Denote ID is the note's real
 *   coordinate and is printed instead.
 * - **expansion terms.** The caller's own query is echoed; `expanded` belongs in
 *   `details`, where it is free and cannot grow the context.
 *
 * Every author-written field on this screen is budgeted, so the screen's size is
 * a property of the format rather than of the corpus. The one unbounded field is
 * the document PATH, which is deliberate: it is the openable identity and a
 * truncated path cannot be opened.
 */
export function formatMdScreen(
  query: string,
  results: SearchResult[],
  options: MdFormatOptions = {},
): string {
  if (results.length === 0) return `No results for: "${query}"`;
  const budget = options.full ? MD_FULL_CHARS : MD_SNIPPET_CHARS;
  const groups = groupMdResultsByDocument(results);
  const lines: string[] = [
    `Found ${results.length} chunks across ${groups.length} documents for: "${query}"`,
    "",
  ];
  groups.forEach((g, i) => {
    const title = mdDisplayField(g.title, MD_TITLE_CHARS) || "(untitled)";
    const head = [`${i + 1}. ${title}`];
    const coord = [g.project, g.denoteId].filter(Boolean).join("/");
    if (coord) head.push(coord);
    lines.push(head.join(" · "));
    const description = mdDisplayField(g.description, MD_DESCRIPTION_CHARS);
    if (description) lines.push(`   ${description}`);
    lines.push(`   ${g.file}`);
    for (const c of g.chunks) {
      const idx = c.metadata?.chunkIndex ?? "?";
      lines.push(`   #${idx} L${c.lineNumber} › ${mdSnippet(c.text, budget)}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/**
 * Machine-readable md row. Carries the identity a caller needs to open or cite
 * the note, plus `indexedAt` — named for what it is, so nobody mistakes the
 * export mtime for the note's date the way `timestamp` invited.
 */
export function mdResultToJson(
  r: SearchResult,
  options: MdFormatOptions = {},
): Record<string, unknown> {
  const budget = options.full ? MD_FULL_CHARS : MD_SNIPPET_CHARS;
  return {
    title: r.metadata?.title ?? "",
    denoteId: r.metadata?.denoteId ?? "",
    description: r.metadata?.description ?? "",
    project: r.project,
    score: Number(r.score.toFixed(4)),
    file: r.sessionFile,
    line: r.lineNumber,
    chunkIndex: r.metadata?.chunkIndex ?? "",
    indexedAt: r.timestamp,
    text: mdSnippet(r.text, budget),
  };
}
