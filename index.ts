/**
 * Semantic Memory — pi extension
 *
 * Tools:
 * - session_search: search past pi sessions by meaning
 * - knowledge_search: search org-mode knowledge base by meaning
 *
 * Commands:
 * - /memory status: show index stats
 * - /memory search <query>: search sessions
 * - /memory reindex: rebuild session index
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import {
  createProviderFromEnv,
  createSessionProviderFromEnv,
  createOrgProviderFromEnv,
  CachingProvider,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getOrgDbPath, getDataDir } from "./store.js";
import {
  findSessionFiles,
  extractSessionChunks,
  normalizeSourceFilter,
} from "./session-indexer.js";
import { retrieve, expandQueryForBM25, getShortCJKTokens } from "./retriever.js";
import { readSessionExcerpt, type SessionExcerpt } from "./session-excerpt.js";

// Re-declare minimal SearchResult to avoid jiti-incompatible import() type syntax
interface SearchResult {
  id: string;
  text: string;
  sessionFile: string;
  project: string;
  lineNumber: number;
  timestamp: string;
  role: string;
  source: string;
  metadata: Record<string, string>;
  score: number;
}

// --- dictcli expand (3층) with in-memory cache ---

const expandCache = new Map<string, { result: string[]; expires: number }>();
const EXPAND_CACHE_TTL = 30 * 60 * 1000; // 30 min — Korean vocab doesn't change mid-session

function dictcliExpand(query: string): string[] {
  const cached = expandCache.get(query);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = dictcliExpandRaw(query);
  expandCache.set(query, { result, expires: Date.now() + EXPAND_CACHE_TTL });
  return result;
}

function dictcliExpandRaw(query: string): string[] {
  const koreanWords = query.match(/[\uAC00-\uD7AF]+/g) ?? [];
  if (koreanWords.length === 0) return [];

  // dictcli 위치: skills/dictcli/ (graph.edn과 같은 디렉토리)
  const dictcliDir = path.join(
    process.env.HOME ?? "",
    ".pi", "agent", "skills", "pi-skills", "dictcli",
  );
  const dictcliBin = path.join(dictcliDir, "dictcli");
  if (!fs.existsSync(dictcliBin)) return [];

  const expanded: string[] = [];
  for (const word of koreanWords) {
    try {
      const out = execSync(`./dictcli expand "${word}" --json`, {
        timeout: 1000,
        encoding: "utf-8",
        cwd: dictcliDir, // graph.edn이 여기에 있어야 함
      }).trim();
      if (out.startsWith("[")) {
        expanded.push(...(JSON.parse(out) as string[]));
      }
    } catch {
      // silent — dictcli not available or word not found
    }
  }
  return [...new Set(expanded)];
}

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
 * Load ~/.env.local for provider env vars.
 * Cannot rely on env-loader extension — session_start race condition.
 */
function loadEnvLocal(): void {
  // Skip if key env vars already set
  if (process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || process.env.ANDENKEN_PROVIDER) return;

  try {
    const envPath = path.join(process.env.HOME ?? "", ".env.local");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const stripped = line.trim().replace(/^export\s+/, "");
      const match = stripped.match(/^([A-Z_]+)=["']?([^"'\s]+)["']?/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // file not found
  }
}

/**
 * Wrap an inner provider for query caching (pi extension is long-lived).
 * Returns null if the inner factory returned null.
 */
function wrapForExtension(inner: EmbeddingProvider | null): EmbeddingProvider | null {
  return inner ? new CachingProvider(inner) : null;
}

/**
 * Build the SESSIONS-track provider for the extension.
 *
 * PR-B: reads ANDENKEN_SESSION_* exclusively. The transitional legacy
 * fallback was removed — operators must migrate to the namespaced env.
 * Returns null when not configured; caller surfaces a status message
 * rather than throwing during session_start.
 */
function getSessionsProviderForExtension(): EmbeddingProvider | null {
  loadEnvLocal();
  return wrapForExtension(createSessionProviderFromEnv());
}

/**
 * Build the ORG-track provider for the extension.
 * Reads ANDENKEN_ORG_*, with createOrgProviderFromEnv's built-in legacy
 * fallback. Independent from sessions — failure on one track must not
 * cascade to the other.
 */
function getOrgProviderForExtension(): EmbeddingProvider | null {
  loadEnvLocal();
  return wrapForExtension(createOrgProviderFromEnv());
}

/**
 * Legacy single-provider entry kept as a back-compat alias so any old call
 * site (and the /memory reindex sessions path below) doesn't break in this
 * PR. New code should pick sessions vs org explicitly.
 */
function getProvider(): EmbeddingProvider | null {
  return getSessionsProviderForExtension();
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // PR-D: provider/store split into two independent tracks. Failure on one
  // track must not cascade to the other (the design boundary that lets
  // sessions land on OpenRouter 8B/4096d while org stays on local 4B/2560d).
  //
  // Each track has its own provider, its own VectorStore, and its own ready
  // flag. Cross-track query in session_search → knowledge_search re-embeds
  // through the OTHER provider; sessions vectors are NEVER passed into the
  // org store and vice versa.

  let sessionsProvider: EmbeddingProvider | null = null;
  let orgProvider: EmbeddingProvider | null = null;

  /** Sessions-track provider getter — lazy, throws if not available. */
  function ensureSessionsProvider(): EmbeddingProvider {
    if (!sessionsProvider) {
      sessionsProvider = getSessionsProviderForExtension();
      if (!sessionsProvider) {
        throw new Error(
          "No sessions embedding provider available (set ANDENKEN_SESSION_PROVIDER, " +
          "or use the legacy ANDENKEN_PROVIDER fallback while migrating)",
        );
      }
    }
    return sessionsProvider;
  }

  /** Org-track provider getter — lazy, throws if not available. */
  function ensureOrgProvider(): EmbeddingProvider {
    if (!orgProvider) {
      orgProvider = getOrgProviderForExtension();
      if (!orgProvider) {
        throw new Error(
          "No org embedding provider available (set ANDENKEN_ORG_PROVIDER, " +
          "or the legacy ANDENKEN_PROVIDER+ANDENKEN_VLLM_* slot)",
        );
      }
    }
    return orgProvider;
  }

  /**
   * Backward-compat alias for the legacy single-provider call site below
   * (/memory reindex sessions). Uses the sessions track because reindex
   * targets the sessions DB.
   */
  function ensureProvider(): EmbeddingProvider {
    return ensureSessionsProvider();
  }

  let sessionStore: VectorStore | null = null;
  let orgStore: VectorStore | null = null;
  const orgDbPath = getOrgDbPath();

  function getSessionStore(): VectorStore {
    if (!sessionStore) {
      // Fallback dim 2560 only fires when sessionsProvider hasn't been
      // resolved yet (status hover, /memory before search). After
      // ensureSessionsProvider runs, store gets the real dim.
      const dim = sessionsProvider?.dimensions ?? 2560;
      sessionStore = new VectorStore(undefined, dim);
    }
    return sessionStore;
  }
  function getOrgStore(): VectorStore {
    if (!orgStore) {
      const dim = orgProvider?.dimensions ?? 2560;
      orgStore = new VectorStore(orgDbPath, dim);
    }
    return orgStore;
  }

  // Each track has its own ready flag. session init failure must not block
  // org-only operations (knowledge_search) and vice versa.
  let sessionReady = false;
  let orgReady = false;
  let sessionsInitErr: string | null = null;
  let orgInitErr: string | null = null;
  let sessionInfoInjected = false;

  // --- Session naming + context injection ---
  const device = (() => {
    try {
      return fs.readFileSync(
        path.join(process.env.HOME ?? "", ".current-device"),
        "utf-8",
      ).trim();
    } catch {
      return "unknown";
    }
  })();

  pi.on("before_agent_start", async (event, ctx) => {
    if (sessionInfoInjected) return;
    sessionInfoInjected = true;

    const timeKST = new Date().toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    return {
      message: {
        customType: "session-info",
        content: `device=${device}, time_kst=${timeKST}`,
        display: false,
      },
    };
  });

  // --- Initialize on session start ---
  // PR-D: sessions and org init are independent. A failure on one track
  // surfaces in status but does not disable the other. The two tools
  // (session_search, knowledge_search) report their own per-track readiness.
  pi.on("session_start", async (_event, ctx) => {
    let sCount: number | null = null;
    let oCount: number | null = null;

    // ---- Sessions track ----
    try {
      sessionsProvider = getSessionsProviderForExtension();
      if (sessionsProvider) {
        await getSessionStore().init();
        sessionReady = true;
        sCount = await getSessionStore().getCount();
      } else {
        sessionsInitErr = "no sessions provider configured";
      }
    } catch (err) {
      sessionsInitErr = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }

    // ---- Org track (independent) ----
    try {
      if (fs.existsSync(orgDbPath)) {
        orgProvider = getOrgProviderForExtension();
        if (orgProvider) {
          await getOrgStore().init();
          orgReady = true;
          oCount = await getOrgStore().getCount();
        } else {
          orgInitErr = "no org provider configured";
        }
      }
      // Org DB absent → not an error; knowledge_search will report when called.
    } catch (err) {
      orgInitErr = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }

    // ---- Status line summarizes whatever subset came up ----
    const parts: string[] = [];
    if (sessionReady && sCount !== null) parts.push(`🧠 ${sCount} sessions`);
    else if (sessionsInitErr) parts.push(`⚠ sessions: ${sessionsInitErr}`);
    if (orgReady && oCount !== null) parts.push(`📚 ${oCount} org chunks`);
    else if (orgInitErr) parts.push(`⚠ org: ${orgInitErr}`);
    if (parts.length === 0) {
      ctx.ui.setStatus("semantic-memory", "⚠ no embedding providers — semantic memory disabled");
    } else {
      ctx.ui.setStatus("semantic-memory", parts.join(" + "));
    }
  });

  // --- session_search tool ---
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "Search past pi sessions by meaning. Use when you need to find previous conversations, decisions, or context from past sessions.",
    promptSnippet:
      "Search past pi sessions semantically — find conversations, decisions, and context by meaning",
    promptGuidelines: [
      "Use session_search when the user asks about past conversations, decisions, or context from other sessions.",
      "Use session_search when you need context that may have been discussed in a previous session.",
      "Prefer session_search over grep for finding past discussions — it understands meaning, not just keywords.",
      "2-step search strategy: abstract queries ('what did I do last') miss concrete text. Read top-3 results, extract proper nouns/technical terms, then re-search with those specific keywords.",
      "Anti-pattern: do NOT fall back to JSONL/grep when first search is sparse. Refine the query first using hints from initial results.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Natural language search query (e.g., 'claude-config memory 정리', 'NixOS GPU cluster setup')",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results (default 10)",
          default: 10,
        }),
      ),
      source: Type.Optional(
        Type.Union(
          [Type.Literal("pi"), Type.Literal("claude"), Type.Literal("all")],
          { description: "Filter by source. Default: all (no filter)." },
        ),
      ),
      withExcerpt: Type.Optional(
        Type.Boolean({
          description:
            "If true, attach a read-only excerpt around each top result's lineNumber, expanding User/Assistant/toolResult/entwurf flow from the original JSONL. No API/DB writes. Default false.",
          default: false,
        }),
      ),
      excerptLimit: Type.Optional(
        Type.Number({
          description:
            "How many top hits get an attached excerpt when withExcerpt=true. Default 3.",
          default: 3,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const sessP = ensureSessionsProvider();

      // Lazy init
      if (!sessionReady) {
        try {
          await getSessionStore().init();
          sessionReady = true;
        } catch (err) {
          throw new Error(`Session memory init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // PR-D: dim safety MUST run before any sessP.embedQuery() call.
      //
      // Same scenario as cli.ts searchSessions: PR-B will switch sessions to
      // OpenRouter qwen/qwen3-embedding-8b (4096d). If data/sessions.lance
      // still holds the old 2560d index, an unguarded path would trigger a
      // paid OpenRouter call first, then LanceDB would silently fall back to
      // FTS-only (store.ts:237). Throw early so operators see the rebuild
      // requirement instead of paying for embeddings against a stale index.
      // Empty/fresh DB passes through.
      const sessDimCheck = await getSessionStore().checkCompatibleDim();
      if (!sessDimCheck.ok) {
        throw new Error(
          `session_search refused: ${sessDimCheck.reason ?? "sessions dim incompatible"}. ` +
          `Configured ${sessDimCheck.configured}d, stored ${sessDimCheck.actual}d. ` +
          `Run scripts/rebuild-sessions-full.sh first or fix ANDENKEN_SESSION_*.`,
        );
      }

      const limit = params.limit ?? 10;

      // 3층 dictcli expand — 한글 쿼리 확장
      const expanded = dictcliExpand(params.query);
      const enrichedQuery = expanded.length > 0
        ? `${params.query} ${expanded.join(" ")}`
        : params.query;

      const candidates = Math.min(limit * 4, 200); // openclaw candidateMultiplier
      const queryVector = await sessP.embedQuery(enrichedQuery);
      const sourceFilter = normalizeSourceFilter(params.source);
      const vectorResults = await getSessionStore().search(queryVector, candidates, 0.1, sourceFilter);
      const bm25Query = expandQueryForBM25(enrichedQuery); // include dictcli expand terms in FTS
      const ftsResults = await getSessionStore().fullTextSearch(bm25Query, candidates, sourceFilter);

      // Track 1 — CJK substring fallback for tokens LanceDB FTS drops
      // (1-2 char Hangul like "맘", "갑", "쟈", "맘마"). Augments the FTS
      // bucket so the hybrid merger sees them. No-op for English-heavy
      // queries; cheap LanceDB filter scan otherwise.
      //
      // Order policy: round-robin interleave (FTS, sub, FTS, sub, ...). RRF
      // ranks by array position, so appending substring hits at the tail
      // after FTS has already filled `candidates` makes them effectively
      // invisible. Interleaving gives short-CJK exact matches a real chance
      // to surface on mixed queries like "맘 분신" while still letting the
      // FTS top result keep its rank-0 boost.
      const shortTokens = getShortCJKTokens(params.query);
      if (shortTokens.length > 0) {
        const ftsIds = new Set(ftsResults.map((r) => r.id));
        const subLists = await Promise.all(
          shortTokens.map((t) => getSessionStore().substringSearch(t, candidates, sourceFilter)),
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

      let results = await retrieve(params.query, vectorResults, ftsResults, {
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        recencyHalfLifeDays: 14,
        minScore: 0.001,
        mergeStrategy: "rrf" as const,
        mmr: { enabled: false, lambda: 0.7 },
      });

      // Source filter is pushed down to LanceDB before retrieval so the candidate
      // pool is source-specific. Keep this defensive filter for older DB rows.
      if (sourceFilter) {
        results = results.filter((r) => r.source === sourceFilter);
      }

      // PR-D cross-track fallback (knowledge_search graceful degrade).
      //
      // When sessions results are thin, supplement with hits from the org
      // corpus. Two safety boundaries:
      //
      //   1. Re-embed the query through orgProvider, NOT through sessP.
      //      sessions and org may be on different dims (4096 vs 2560).
      //      Passing a sessions vector into orgStore.search would corrupt
      //      ranking or trigger a LanceDB error.
      //
      //   2. Confirm dim compatibility between orgStore (DB truth) and
      //      orgProvider (configured dim). If mismatched, skip the fallback
      //      and surface a diagnostic — sessions results still return.
      //
      // session_search itself NEVER fails because of org-side issues.
      const topScore = results[0]?.score ?? 0;
      let fallbackUsed = false;
      let fallbackDiagnostic: string | null = null;
      const wantsFallback = !sourceFilter && (results.length < 3 || topScore < 0.005);
      if (wantsFallback) {
        if (!orgReady) {
          fallbackDiagnostic = "knowledge fallback skipped: org store not ready";
        } else {
          let orgP: EmbeddingProvider | null = null;
          try {
            orgP = ensureOrgProvider();
          } catch (err) {
            fallbackDiagnostic = `knowledge fallback skipped: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
          }
          if (orgP) {
            const dimCheck = await getOrgStore().checkCompatibleDim();
            if (!dimCheck.ok) {
              fallbackDiagnostic = `knowledge fallback skipped: ${dimCheck.reason ?? "org dim incompatible"}`;
            } else {
              const orgCandidates = Math.min(limit * 4, 200);
              const orgQueryVector = await orgP.embedQuery(enrichedQuery);
              const orgVec = await getOrgStore().search(orgQueryVector, orgCandidates, 0.05);
              const orgFts = await getOrgStore().fullTextSearch(expandQueryForBM25(enrichedQuery), orgCandidates);
              const orgResults = await retrieve(params.query, orgVec, orgFts, {
                vectorWeight: 0.7,
                bm25Weight: 0.3,
                recencyHalfLifeDays: 90,
                minScore: 0.05,
                mmr: { enabled: true, lambda: 0.7 },
                mergeStrategy: "weighted" as const,
              });
              if (orgResults.length > 0) {
                results = [...results.slice(0, limit - 3), ...orgResults.slice(0, 3)];
                fallbackUsed = true;
              }
            }
          }
        }
      }

      const finalResults = results.slice(0, limit);
      recordRecall(params.query, "session_search", finalResults);

      // C2.1c — opt-in excerpt attachment for top hits.
      // Pure read-only: no API, no DB write. We tolerate per-file errors
      // (e.g. JSONL deleted since indexing) and just skip excerpt for that
      // hit rather than failing the whole search.
      let excerpts: Map<string, SessionExcerpt> | undefined;
      if (params.withExcerpt) {
        const excerptLimit = Math.max(0, Math.min(params.excerptLimit ?? 3, finalResults.length));
        excerpts = await fetchExcerptsForResults(finalResults.slice(0, excerptLimit));
      }

      const output = formatResults(
        expanded.length > 0 ? `${params.query} (+expand: ${expanded.join(", ")})` : params.query,
        finalResults,
        excerpts,
      );
      if (fallbackUsed) {
        output.content[0].text += "\n\n(⚡ session 결과 부족 → knowledge_search 폴백 포함)";
      } else if (fallbackDiagnostic) {
        output.content[0].text += `\n\n(ℹ ${fallbackDiagnostic})`;
      }
      return output;
    },
  });

  // --- knowledge_search tool ---
  pi.registerTool({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Search the org-mode knowledge base (3000+ Denote notes) by meaning. Use for finding notes, concepts, references, meta-knowledge. Supports Korean and English queries. Korean morphological analysis (Kiwi) enriches BM25 indexing.",
    promptSnippet:
      "Search org-mode knowledge base semantically — notes, concepts, references in Korean and English. Kiwi stems enrich BM25.",
    promptGuidelines: [
      "Use knowledge_search when the user asks about their notes, concepts, or knowledge base.",
      "Use knowledge_search for cross-lingual queries — Korean '보편' finds English-tagged 'universalism' notes.",
      "Prefer knowledge_search over denotecli for semantic/conceptual search. Use denotecli for exact title/tag matching.",
      "If results are sparse, extract keywords from top results and re-search with more specific terms. Try dictcli expand for Korean→English term expansion.",
      "Korean verb stems are auto-indexed via dictcli stem (Kiwi). Searching '설계' matches notes containing '설계했다', '설계하는' etc. Compound nouns like '검색증강생성' are decomposed into '검색'+'증강'+'생성'.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Natural language search query (e.g., '보편 학문', 'knowledge graph ontology', '바흐 체화인지')",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results (default 10)",
          default: 10,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      // PR-D: knowledge_search uses the ORG provider exclusively. Even if
      // sessionsProvider/sessionsStore are entirely broken, knowledge_search
      // must still work — that is the independent-init invariant.
      const orgP = ensureOrgProvider();

      // Lazy init — org DB may exist but session_start lost the race with env-loader
      if (!orgReady) {
        if (!fs.existsSync(orgDbPath)) {
          throw new Error("Org knowledge base not indexed. Run: ./run.sh index:org");
        }
        try {
          await getOrgStore().init();
          orgReady = true;
        } catch (err) {
          throw new Error(`Org memory init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Dim safety: an embedding-provider misconfiguration should produce a
      // clear error rather than silently fall back to FTS-only via the
      // VectorStore's existing dim-mismatch warning. checkCompatibleDim
      // returns ok for empty tables (fresh DB), so this guard does not block
      // first-run scenarios.
      const dimCheck = await getOrgStore().checkCompatibleDim();
      if (!dimCheck.ok) {
        throw new Error(
          `knowledge_search refused: ${dimCheck.reason ?? "org dim incompatible"}. ` +
          `Configured ${dimCheck.configured}d, stored ${dimCheck.actual}d. ` +
          `Run rebuild or fix ANDENKEN_ORG_*.`,
        );
      }

      const limit = params.limit ?? 10;

      // 3층 dictcli expand — 한글 쿼리 확장
      const expanded = dictcliExpand(params.query);
      const enrichedQuery = expanded.length > 0
        ? `${params.query} ${expanded.join(" ")}`
        : params.query;

      const candidates = Math.min(limit * 4, 200); // openclaw candidateMultiplier
      const queryVector = await orgP.embedQuery(enrichedQuery);
      const vectorResults = await getOrgStore().search(queryVector, candidates, 0.05);
      const bm25Query = expandQueryForBM25(enrichedQuery); // include dictcli expand terms in FTS
      const ftsResults = await getOrgStore().fullTextSearch(bm25Query, candidates);

      const results = await retrieve(params.query, vectorResults, ftsResults, {
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        recencyHalfLifeDays: 90,
        minScore: 0.05,
        mmr: { enabled: true, lambda: 0.7 },
        mergeStrategy: "weighted" as const,
      });

      const finalResults = results.slice(0, limit);
      recordRecall(params.query, "knowledge_search", finalResults);
      return formatResults(
        expanded.length > 0 ? `${params.query} (+expand: ${expanded.join(", ")})` : params.query,
        finalResults,
      );
    },
  });

  // --- /memory command ---
  pi.registerCommand("memory", {
    description: "Semantic memory — status, search <query>, reindex",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "status";

      if (sub === "status") {
        const sCount = sessionReady ? await getSessionStore().getCount() : 0;
        const oCount = orgReady ? await getOrgStore().getCount() : 0;
        const sFiles = findSessionFiles();
        const sIndexed = sessionReady ? await getSessionStore().getIndexedFiles() : new Set();
        ctx.ui.notify(
          `🧠 Sessions: ${sCount} chunks (${sIndexed.size}/${sFiles.length} files)\n` +
            `📚 Org: ${oCount} chunks${orgReady ? "" : " (not indexed)"}`,
          "info",
        );
      } else if (sub === "search") {
        const query = parts.slice(1).join(" ");
        if (!query) {
          ctx.ui.notify("Usage: /memory search <query>", "warning");
          return;
        }
        pi.sendUserMessage(
          `Use session_search to find: "${query}"`,
          { deliverAs: "followUp" },
        );
      } else if (sub === "reindex") {
        const target = parts[1] || "sessions";
        const force = parts.includes("--force");
        let p: EmbeddingProvider;
        try {
          p = ensureProvider();
        } catch {
          ctx.ui.notify("No embedding provider available", "error");
          return;
        }

        if (target === "sessions" || target === "all") {
          if (!sessionReady) {
            ctx.ui.notify("Session memory not initialized.", "warning");
            return;
          }
          p.resetStats();
          ctx.ui.notify(`🧠 Starting session index (${p.name})...`, "info");
          try {
            await indexSessions(getSessionStore(), p, ctx, force);
            const count = await getSessionStore().getCount();
            const stats = p.getStats();
            ctx.ui.setStatus("semantic-memory", `🧠 ${count} chunks indexed`);
            ctx.ui.notify(
              `✅ Sessions done. ${count} chunks. 💰 ${stats.calls} calls, ~$${stats.estimatedCostUSD.toFixed(3)}`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(
              `❌ Failed: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        }

        if (target === "org" || target === "all") {
          ctx.ui.notify("📚 Org 인덱싱은 CLI로 실행하세요: cd ~/repos/gh/andenken && npx tsx indexer.ts org", "info");
          ctx.ui.notify("📚 Kiwi stem 에리치먼트 때문에 pi 내부에서 실행 불가 (JVM 필요)", "info");
        }

        if (target !== "sessions" && target !== "org" && target !== "all") {
          ctx.ui.notify(
            "Usage: /memory reindex [sessions|org|all] [--force]",
            "warning",
          );
        }
      } else {
        ctx.ui.notify(
          "Usage: /memory [status | search <query> | reindex [sessions|org|all] [--force]]",
          "warning",
        );
      }
    },
  });

  // --- /new 시 자동 인덱싱 비활성화 ---
  // 비용 투명성을 위해 명시적 /memory reindex만 사용.
  // 이전: session_before_switch에서 최대 20세션 자동 임베딩 (숨은 API 콜)
  // 변경: /new 시 미인덱싱 세션 수만 알려주고, 인덱싱은 사용자 명시 실행
  pi.on("session_before_switch", async (event, ctx) => {
    if (event.reason !== "new") return;
    if (!sessionReady) return;

    try {
      const files = findSessionFiles();
      const indexed = await getSessionStore().getIndexedFiles();
      const newCount = files.filter((f) => !indexed.has(f)).length;
      if (newCount > 0) {
        ctx.ui.notify(
          `🧠 ${newCount}개 미인덱싱 세션. /memory reindex 로 인덱싱하세요.`,
          "info",
        );
      }
    } catch {
      // silent
    }
  });

  pi.on("session_shutdown", async () => {
    if (sessionStore) await sessionStore.close();
    if (orgStore) await orgStore.close();
  });
}

// --- Helpers ---

/**
 * Read excerpts for the top-N hits. Returns a Map keyed by `sessionFile:line`
 * (matching `SearchResult.id` shape from session-indexer.ts) → SessionExcerpt.
 * Errors per file are swallowed so a single missing JSONL never breaks the
 * whole search.
 */
async function fetchExcerptsForResults(
  results: SearchResult[],
): Promise<Map<string, SessionExcerpt>> {
  const out = new Map<string, SessionExcerpt>();
  for (const r of results) {
    if ((r.source !== "pi" && r.source !== "claude") || !r.sessionFile.endsWith(".jsonl")) continue;
    try {
      const ex = await readSessionExcerpt(r.sessionFile, r.lineNumber);
      out.set(r.id, ex);
    } catch {
      // file may have been deleted/rotated since indexing — skip silently
    }
  }
  return out;
}

function formatResults(
  query: string,
  results: SearchResult[],
  excerpts?: Map<string, SessionExcerpt>,
) {
  if (results.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No results for: "${query}"` }],
      details: {
        query,
        resultCount: 0,
        results: [] as Array<Record<string, unknown>>,
      },
    };
  }

  const formatted = results
    .map((r, i) => {
      const srcTag = r.source ? ` [${r.source}]` : "";
      const lines = [
        `## ${i + 1}. [${r.project}]${srcTag} ${r.role} (score: ${r.score.toFixed(3)})`,
        `- File: ${r.sessionFile}:L${r.lineNumber}`,
        `- Time: ${r.timestamp}`,
        `- Text:\n${r.text.slice(0, 500)}${r.text.length > 500 ? "..." : ""}`,
      ];
      const ex = excerpts?.get(r.id);
      if (ex) {
        const truncTag = ex.truncated ? " (truncated)" : "";
        lines.push(
          `- Excerpt L${ex.startLine}-L${ex.endLine}${truncTag}:`,
          ex.text,
        );
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");

  return {
    content: [
      {
        type: "text" as const,
        text: `Found ${results.length} results for: "${query}"\n\n${formatted}`,
      },
    ],
    details: {
      query,
      resultCount: results.length,
      results: results.map((r) => {
        const ex = excerpts?.get(r.id);
        const base: Record<string, unknown> = {
          id: r.id,
          project: r.project,
          role: r.role,
          source: r.source,
          score: r.score,
          sessionFile: r.sessionFile,
          lineNumber: r.lineNumber,
        };
        if (ex) {
          base.excerpt = {
            startLine: ex.startLine,
            endLine: ex.endLine,
            truncated: ex.truncated,
            text: ex.text,
          };
        }
        return base;
      }) as Array<Record<string, unknown>>,
    },
  };
}

async function indexSessions(
  store: VectorStore,
  provider: EmbeddingProvider,
  ctx: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } },
  force: boolean = false,
): Promise<void> {
  const files = findSessionFiles();
  if (force) await store.reset();
  await store.ensureTable();

  // PR-D safety: refuse to write to a store whose actual dim doesn't match
  // the configured provider dim. Mirrors indexer.ts (CLI write path).
  await store.assertCompatibleDim();

  const indexed = force ? new Set<string>() : await store.getIndexedFiles();
  const toIndex = files.filter((f) => !indexed.has(f));

  if (toIndex.length === 0) {
    ctx.ui.notify("All sessions already indexed.", "info");
    return;
  }

  ctx.ui.notify(`Indexing ${toIndex.length} sessions (${provider.name})...`, "info");
  let totalChunks = 0;

  for (let i = 0; i < toIndex.length; i++) {
    const chunks = await extractSessionChunks(toIndex[i]);
    if (chunks.length === 0) continue;

    const vectors = await provider.embedDocumentBatch(chunks.map((c) => c.text));
    await store.addChunks(chunks.map((c, j) => ({ ...c, vector: vectors[j] })));
    totalChunks += chunks.length;

    if ((i + 1) % 10 === 0) {
      ctx.ui.notify(`${i + 1}/${toIndex.length} sessions, ${totalChunks} chunks...`, "info");
    }
  }

  await store.createFtsIndex();
  ctx.ui.notify(`Indexed ${toIndex.length} sessions → ${totalChunks} chunks`, "info");
}
