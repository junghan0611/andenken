#!/usr/bin/env npx tsx
/**
 * Semantic Memory CLI
 *
 * Thin CLI wrapper over the existing semantic-memory modules.
 * Designed for Claude Code skill invocation.
 *
 * Usage:
 *   cli.ts search-sessions <query> [--limit N]
 *   cli.ts search-knowledge <query> [--limit N]  # compatibility alias for search-md
 *   cli.ts status
 *   cli.ts reindex [--force]
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import {
  createSessionProviderFromEnv,
  createOrgProviderFromEnv,
  createMdProviderFromEnv,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getSessionsDbPath, getOrgDbPath, getMdDbPath, getDataDir, type SearchResult } from "./store.js";
import { findSessionFiles, extractSessionChunks, normalizeSourceFilter } from "./session-indexer.js";
import { retrieve, expandQueryForBM25, getShortCJKTokens, type MergeStrategy } from "./retriever.js";
import { readSessionExcerpt, type SessionExcerpt } from "./session-excerpt.js";

// --- Recall Tracking (memory consolidation stage 2) ---

function recordRecall(query: string, tool: string, results: SearchResult[]): void {
  try {
    const recallPath = path.join(getDataDir(), "recalls.jsonl");
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      query,
      tool,
      resultIds: results.slice(0, 5).map(r => r.id),
      topScore: results[0]?.score ?? 0,
    });
    fs.appendFileSync(recallPath, entry + "\n");
  } catch {
    // best-effort — never block search
  }
}

// --- Config ---

/**
 * Track-aware provider getters.
 *
 * searchSessions and searchMd each pick the provider that matches the corpus
 * they're querying. Sessions and md both use 4096d today, but they remain
 * separate stores/providers so costs and lifecycle do not bleed across tracks.
 *
 * Sessions and md are namespaced (ANDENKEN_SESSION_* / ANDENKEN_MD_*) with no
 * legacy fallback. Org provider/search remains only for upstream R&D paths.
 */
function getSessionsProvider(): EmbeddingProvider {
  // PR-B: legacy fallback removed. Sessions track requires explicit
  // ANDENKEN_SESSION_PROVIDER namespace. Operators on the old ANDENKEN_VLLM_*
  // slot must migrate (see ROADMAP.md / NEXT.md for cutover guidance).
  const p = createSessionProviderFromEnv();
  if (!p) {
    console.error(
      JSON.stringify({
        error:
          "No sessions embedding provider available. Set ANDENKEN_SESSION_PROVIDER " +
          "(and ANDENKEN_SESSION_ENDPOINT / _MODEL / _API_KEY). " +
          "PR-A's transitional ANDENKEN_VLLM_* fallback was removed in PR-B.",
      }),
    );
    process.exit(1);
  }
  return p;
}

function getOrgProvider(): EmbeddingProvider {
  const p = createOrgProviderFromEnv();
  if (!p) {
    console.error(
      JSON.stringify({
        error: "No org embedding provider available — set ANDENKEN_ORG_PROVIDER " +
               "(or the legacy ANDENKEN_PROVIDER+ANDENKEN_VLLM_* slot)",
      }),
    );
    process.exit(1);
  }
  return p;
}

function getMdProvider(): EmbeddingProvider {
  const p = createMdProviderFromEnv();
  if (!p) {
    console.error(
      JSON.stringify({
        error: "No md embedding provider available — set ANDENKEN_MD_PROVIDER " +
               "(and ANDENKEN_MD_ENDPOINT / _MODEL / _API_KEY).",
      }),
    );
    process.exit(1);
  }
  return p;
}

/**
 * Sessions-track alias used by the in-CLI `reindex` command, which only
 * touches sessions.lance. Kept as a thin alias so the call site stays terse;
 * the underlying provider is identical to getSessionsProvider().
 */
function getProvider(): EmbeddingProvider {
  return getSessionsProvider();
}

// --- dictcli expand ---

function dictcliExpand(query: string): string[] {
  const koreanWords = query.match(/[\uAC00-\uD7AF]+/g) ?? [];
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

// --- Paths ---

const sessionDbPath = getSessionsDbPath();
const orgDbPath = getOrgDbPath();
const mdDbPath = getMdDbPath();

// --- Commands ---

interface SessionSearchOpts {
  source?: string;
  withExcerpt?: boolean;
  excerptLimit?: number;
}

async function searchSessions(
  query: string,
  limit: number,
  opts: SessionSearchOpts = {},
): Promise<void> {
  const source = normalizeSourceFilter(opts.source);
  const provider = getSessionsProvider();
  const dim = provider.dimensions || 2560;

  const store = new VectorStore(sessionDbPath, dim);
  await store.init();

  // PR-D: dim safety MUST run before any embedQuery() call.
  //
  // Scenario this prevents: PR-B switches sessions to OpenRouter
  // qwen/qwen3-embedding-8b (4096d) while data/sessions.lance still holds
  // the old 2560d index. Without this guard the configured 4096d would
  // trigger a paid OpenRouter call FIRST, then LanceDB would silently fall
  // back to FTS-only (store.ts:237). Fail-loud is the right answer:
  // operator must run rebuild-sessions-full.sh.
  //
  // Mirrors searchKnowledge / knowledge_search dim guards. Empty/fresh DB
  // passes through (checkCompatibleDim returns ok with actual=null).
  const sessionDimCheck = await store.checkCompatibleDim();
  if (!sessionDimCheck.ok) {
    console.error(
      JSON.stringify({
        error: `session search refused: ${sessionDimCheck.reason ?? "sessions dim incompatible"}. Run scripts/rebuild-sessions-full.sh first or fix ANDENKEN_SESSION_*.`,
        configured: sessionDimCheck.configured,
        actual: sessionDimCheck.actual,
      }),
    );
    await store.close();
    process.exit(1);
  }

  const expanded = dictcliExpand(query);
  const enrichedQuery =
    expanded.length > 0 ? `${query} ${expanded.join(" ")}` : query;

  const candidates = Math.min(limit * 4, 200); // openclaw candidateMultiplier pattern
  const queryVector = await provider.embedQuery(enrichedQuery);
  const bm25Query = expandQueryForBM25(enrichedQuery); // include dictcli expand terms in FTS
  const vectorResults = await store.search(queryVector, candidates, 0.1, source);
  const ftsResults = await store.fullTextSearch(bm25Query, candidates, source);

  // Track 1 — CJK substring fallback (mirrors index.ts session_search path).
  // Short Hangul tokens like "맘", "갑", "쟈" return 0 hits via LanceDB FTS;
  // augment via `contains()` so the hybrid merger can still surface them.
  //
  // Round-robin interleave (FTS, sub, FTS, sub, ...) so substring hits keep
  // a real RRF rank rather than being appended past `candidates`.
  const shortTokens = getShortCJKTokens(query);
  if (shortTokens.length > 0) {
    const ftsIds = new Set(ftsResults.map((r) => r.id));
    const subLists = await Promise.all(
      shortTokens.map((t) => store.substringSearch(t, candidates, source)),
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

  let results = await retrieve(query, vectorResults, ftsResults, {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    recencyHalfLifeDays: 14,
    minScore: 0.001,
    mergeStrategy: "rrf" as MergeStrategy,
    mmr: { enabled: false, lambda: 0.7 },
  });

  // Source filter is pushed down to LanceDB before retrieval so the candidate
  // pool is source-specific. Keep this defensive filter for older DB rows.
  if (source) {
    results = results.filter((r) => r.source === source);
  }

  // PR-D cross-track fallback (mirrors index.ts session_search).
  //
  // When sessions results are thin, supplement with hits from the org corpus.
  // Two safety boundaries: re-embed the query through orgProvider (NOT
  // through `provider` which is the sessions provider — different dim),
  // and confirm dim compatibility before issuing the search. If either
  // boundary fails, sessions results are still returned with a diagnostic.
  let fallback = false;
  let fallbackDiagnostic: string | undefined;
  const topScore = results[0]?.score ?? 0;
  const wantsFallback =
    !source && fs.existsSync(orgDbPath) && (results.length < 3 || topScore < 0.005);
  if (wantsFallback) {
    let orgProvider: EmbeddingProvider | null = null;
    try {
      orgProvider = createOrgProviderFromEnv();
    } catch (err) {
      fallbackDiagnostic = `knowledge fallback skipped: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    }
    if (!orgProvider) {
      fallbackDiagnostic = fallbackDiagnostic ?? "knowledge fallback skipped: no org provider";
    } else {
      const orgDim = orgProvider.dimensions || 2560;
      const orgStore = new VectorStore(orgDbPath, orgDim);
      await orgStore.init();
      const dimCheck = await orgStore.checkCompatibleDim();
      if (!dimCheck.ok) {
        fallbackDiagnostic = `knowledge fallback skipped: ${dimCheck.reason ?? "org dim incompatible"}`;
        await orgStore.close();
      } else {
        const orgCandidates = Math.min(limit * 4, 200);
        const orgQueryVector = await orgProvider.embedQuery(enrichedQuery);
        const orgVec = await orgStore.search(orgQueryVector, orgCandidates, 0.05);
        const orgFts = await orgStore.fullTextSearch(bm25Query, orgCandidates);
        const orgResults = await retrieve(query, orgVec, orgFts, {
          vectorWeight: 0.7,
          bm25Weight: 0.3,
          recencyHalfLifeDays: 90,
          minScore: 0.05,
          mmr: { enabled: true, lambda: 0.7 },
          mergeStrategy: "weighted" as MergeStrategy,
        });
        if (orgResults.length > 0) {
          results = [
            ...results.slice(0, limit - 3),
            ...orgResults.slice(0, 3),
          ];
          fallback = true;
        }
        await orgStore.close();
      }
    }
  }

  const finalResults = results.slice(0, limit);
  recordRecall(query, "search-sessions", finalResults);

  // C2.1c — opt-in excerpt attachment for top hits.
  let excerpts: Map<string, SessionExcerpt> | undefined;
  if (opts.withExcerpt) {
    const n = Math.max(0, Math.min(opts.excerptLimit ?? 3, finalResults.length));
    excerpts = new Map();
    for (const r of finalResults.slice(0, n)) {
      if ((r.source !== "pi" && r.source !== "claude") || !r.sessionFile.endsWith(".jsonl")) continue;
      try {
        excerpts.set(r.id, await readSessionExcerpt(r.sessionFile, r.lineNumber));
      } catch {
        /* skip silently — file may have rotated since indexing */
      }
    }
  }

  console.log(
    JSON.stringify({
      query,
      expanded: expanded.length > 0 ? expanded : undefined,
      fallback,
      diagnostic: fallbackDiagnostic,
      count: finalResults.length,
      results: finalResults.map((r) => formatResult(r, excerpts?.get(r.id))),
    }),
  );

  await store.close();
}

async function searchKnowledge(query: string, limit: number): Promise<void> {
  if (!fs.existsSync(orgDbPath)) {
    console.error(
      JSON.stringify({ error: "Org knowledge base not indexed. Run: cd ~/repos/gh/agent-config && ./run.sh index:org" }),
    );
    process.exit(1);
  }

  // PR-D: knowledge search must use the ORG provider, not the sessions one.
  const provider = getOrgProvider();
  const dim = provider.dimensions || 2560;

  const store = new VectorStore(orgDbPath, dim);
  await store.init();

  // Dim safety: a misconfigured org provider should fail loudly before we
  // issue a search whose ranking would be silently corrupted.
  const dimCheck = await store.checkCompatibleDim();
  if (!dimCheck.ok) {
    console.error(
      JSON.stringify({
        error: `knowledge search refused: ${dimCheck.reason ?? "org dim incompatible"}`,
        configured: dimCheck.configured,
        actual: dimCheck.actual,
      }),
    );
    process.exit(1);
  }

  const expanded = dictcliExpand(query);
  const enrichedQuery =
    expanded.length > 0 ? `${query} ${expanded.join(" ")}` : query;

  const candidates = Math.min(limit * 4, 200); // openclaw candidateMultiplier pattern
  const queryVector = await provider.embedQuery(enrichedQuery);
  const bm25Query = expandQueryForBM25(enrichedQuery); // include dictcli expand terms in FTS
  const vectorResults = await store.search(queryVector, candidates, 0.05);
  const ftsResults = await store.fullTextSearch(bm25Query, candidates);

  const results = await retrieve(query, vectorResults, ftsResults, {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    recencyHalfLifeDays: 90,
    minScore: 0.05,
    mmr: { enabled: true, lambda: 0.7 },
    mergeStrategy: "weighted" as MergeStrategy,
  });

  const finalResults = results.slice(0, limit);
  recordRecall(query, "search-knowledge", finalResults);
  console.log(
    JSON.stringify({
      query,
      expanded: expanded.length > 0 ? expanded : undefined,
      count: finalResults.length,
      results: finalResults.map((r) => formatResult(r)),
    }),
  );

  await store.close();
}

/**
 * Search the md track (public garden direct embedding).
 *
 * Mirrors searchKnowledge: dict expand, hybrid (vector + BM25), MMR. The
 * recency decay half-life is longer than sessions (90 days) because the
 * garden is intentionally not chronological — most retrieval value is in
 * the long-form notes, not the freshest mtime.
 */
async function searchMd(query: string, limit: number): Promise<void> {
  if (!fs.existsSync(mdDbPath)) {
    console.error(
      JSON.stringify({
        error: "md track not indexed. Run: ./run.sh index:md",
      }),
    );
    process.exit(1);
  }

  const provider = getMdProvider();
  const dim = provider.dimensions || 4096;

  const store = new VectorStore(mdDbPath, dim);
  await store.init();

  const dimCheck = await store.checkCompatibleDim();
  if (!dimCheck.ok) {
    console.error(
      JSON.stringify({
        error: `md search refused: ${dimCheck.reason ?? "md dim incompatible"}`,
        configured: dimCheck.configured,
        actual: dimCheck.actual,
      }),
    );
    process.exit(1);
  }

  const expanded = dictcliExpand(query);
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

  const finalResults = results.slice(0, limit);
  recordRecall(query, "search-md", finalResults);
  console.log(
    JSON.stringify({
      query,
      expanded: expanded.length > 0 ? expanded : undefined,
      count: finalResults.length,
      results: finalResults.map((r) => formatResult(r)),
    }),
  );

  await store.close();
}

async function status(): Promise<void> {
  const sessionStore = new VectorStore(sessionDbPath);
  let sessionCount = 0;
  let sessionFiles = 0;
  try {
    await sessionStore.init();
    sessionCount = await sessionStore.getCount();
    sessionFiles = (await sessionStore.getIndexedFiles()).size;
    await sessionStore.close();
  } catch {
    // not initialized
  }

  // gpt-5.5 review (non-blocker #2): md was missing from the CLI JSON
  // surface. The text-mode `./run.sh status` covers it via indexer.ts, but
  // tools that read the JSON (skills, MCP wrappers) need it here too.
  let mdCount = 0;
  let mdFiles = 0;
  const mdExists = fs.existsSync(mdDbPath);
  if (mdExists) {
    const mdStore = new VectorStore(mdDbPath, 4096);
    try {
      await mdStore.init();
      mdCount = await mdStore.getCount();
      mdFiles = (await mdStore.getIndexedFiles()).size;
      await mdStore.close();
    } catch {
      // not initialized
    }
  }

  let orgCount = 0;
  const orgExists = fs.existsSync(orgDbPath);
  if (orgExists) {
    const orgStore = new VectorStore(orgDbPath, 2560);
    try {
      await orgStore.init();
      orgCount = await orgStore.getCount();
      await orgStore.close();
    } catch {
      // not initialized
    }
  }

  const totalSessionFiles = findSessionFiles().length;

  console.log(
    JSON.stringify({
      sessions: {
        chunks: sessionCount,
        indexed_files: sessionFiles,
        total_files: totalSessionFiles,
      },
      md: {
        chunks: mdCount,
        indexed_files: mdFiles,
        indexed: mdExists,
      },
      knowledge: {
        chunks: mdCount,
        indexed_files: mdFiles,
        indexed: mdExists,
        source: "md",
      },
      org: {
        chunks: orgCount,
        indexed: orgExists,
        production: "disabled",
      },
    }),
  );
}

async function reindex(force: boolean): Promise<void> {
  const provider = getProvider();
  const dim = provider.dimensions || 2560;

  const store = new VectorStore(sessionDbPath, dim);
  await store.init();

  if (force) await store.reset();
  await store.ensureTable();

  const files = findSessionFiles();
  const indexed = force ? new Set<string>() : await store.getIndexedFiles();
  const toIndex = files.filter((f) => !indexed.has(f));

  if (toIndex.length === 0) {
    console.log(JSON.stringify({ message: "All sessions already indexed", total: await store.getCount() }));
    await store.close();
    return;
  }

  process.stderr.write(`Indexing ${toIndex.length} sessions...\n`);
  let totalChunks = 0;

  for (let i = 0; i < toIndex.length; i++) {
    const chunks = await extractSessionChunks(toIndex[i]);
    if (chunks.length === 0) continue;

    const vectors = await provider.embedDocumentBatch(
      chunks.map((c) => c.text),
    );
    await store.addChunks(
      chunks.map((c, j) => ({ ...c, vector: vectors[j] })),
    );
    totalChunks += chunks.length;

    if ((i + 1) % 10 === 0) {
      process.stderr.write(`${i + 1}/${toIndex.length} sessions, ${totalChunks} chunks...\n`);
    }
  }

  try {
    await store.createFtsIndex();
  } catch {
    // index might exist
  }

  const total = await store.getCount();
  console.log(
    JSON.stringify({
      indexed_sessions: toIndex.length,
      new_chunks: totalChunks,
      total_chunks: total,
    }),
  );

  await store.close();
}

// --- Helpers ---

function formatResult(r: SearchResult, excerpt?: SessionExcerpt) {
  const base: Record<string, unknown> = {
    project: r.project,
    role: r.role,
    source: r.source || undefined,
    score: Number(r.score.toFixed(4)),
    file: r.sessionFile,
    line: r.lineNumber,
    timestamp: r.timestamp,
    text: r.text.slice(0, 800) + (r.text.length > 800 ? "..." : ""),
  };
  if (excerpt) {
    base.excerpt = {
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      truncated: excerpt.truncated,
      text: excerpt.text,
    };
  }
  return base;
}

// --- Arg parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1] ?? "true";
      if (args[i + 1] && !args[i + 1].startsWith("--")) i++;
    } else {
      positional.push(args[i]);
    }
  }

  return { cmd, positional, flags };
}

// --- Main ---

async function main() {
  const { cmd, positional, flags } = parseArgs();
  const limit = parseInt(flags.limit ?? "10", 10);

  switch (cmd) {
    case "search-sessions":
    case "search": {
      const query = positional.join(" ");
      if (!query) {
        console.error(
          JSON.stringify({
            error:
              "Usage: search-sessions <query> [--limit N] [--source pi|claude|all] [--with-excerpt] [--excerpt-limit N]",
          }),
        );
        process.exit(1);
      }
      // parseArgs is presence-based for boolean flags: any of `--with-excerpt`,
      // `--with-excerpt true`, or `--with-excerpt --next-flag` should enable it.
      const withExcerpt = "with-excerpt" in flags && flags["with-excerpt"] !== "false";
      const excerptLimit =
        "excerpt-limit" in flags && flags["excerpt-limit"] && !flags["excerpt-limit"].startsWith("--")
          ? parseInt(flags["excerpt-limit"], 10)
          : undefined;
      await searchSessions(query, limit, {
        source: flags.source,
        withExcerpt,
        excerptLimit,
      });
      break;
    }
    case "search-md":
    case "md": {
      const query = positional.join(" ");
      if (!query) {
        console.error(JSON.stringify({ error: "Usage: search-md <query> [--limit N]" }));
        process.exit(1);
      }
      await searchMd(query, limit);
      break;
    }

    case "search-knowledge":
    case "knowledge": {
      const query = positional.join(" ");
      if (!query) {
        console.error(JSON.stringify({ error: "Usage: search-knowledge <query> [--limit N]" }));
        process.exit(1);
      }
      // Compatibility alias: production knowledge axis is md.lance. The old
      // org-backed searchKnowledge() remains in this file for R&D/manual use
      // only; agent-facing `knowledge` now follows search-md.
      await searchMd(query, limit);
      break;
    }
    case "status":
      await status();
      break;
    case "reindex":
      await reindex(flags.force === "true" || flags.force === undefined && "force" in flags);
      break;
    default:
      console.error(
        JSON.stringify({
          error: "Unknown command",
          usage: "cli.ts <search-sessions|search-md|search-knowledge|status|reindex> [args]",
        }),
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
