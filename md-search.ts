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
  type MergeStrategy,
} from "./retriever.js";

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
  const expanded = useExpand ? dictcliExpand(query) : [];
  const enrichedQuery =
    expanded.length > 0 ? `${query} ${expanded.join(" ")}` : query;

  const candidates = Math.min(limit * 4, 200);
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
  });

  return { results: results.slice(0, limit), expanded };
}
