/**
 * Semantic Memory — pi extension
 *
 * Tools:
 * - session_search: search past pi sessions by meaning
 * - knowledge_search: search public garden Markdown knowledge base by meaning
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
  createMdProviderFromEnv,
  CachingProvider,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getMdDbPath, getDataDir, type SearchFilters } from "./store.js";
import {
  findSessionFiles,
  extractSessionChunks,
  normalizeSourceFilter,
} from "./session-indexer.js";
import { retrieve, expandQueryForBM25, getShortCJKTokens, sortByTimestampDesc } from "./retriever.js";
import {
  searchMdCore,
  formatMdScreen,
  mdResultToJson,
  MD_DEFAULT_LIMIT,
} from "./md-search.js";
import { readSessionExcerpt, type SessionExcerpt } from "./session-excerpt.js";
import { recordRecall } from "./recall-log.js";

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
// Implementation lives in recall-log.ts, shared with cli.ts, so the
// `ANDENKEN_DISABLE_RECALL_TRACKING` guard applies identically on both search
// entry points. Production callers never set it and keep logging as before.

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
 * Build the MD-track provider for the extension.
 * Reads ANDENKEN_MD_* only. Independent from sessions — failure on one track
 * must not cascade to the other.
 */
function getMdProviderForExtension(): EmbeddingProvider | null {
  loadEnvLocal();
  return wrapForExtension(createMdProviderFromEnv());
}

/**
 * Legacy single-provider entry kept as a back-compat alias so any old call
 * site (and the /memory reindex sessions path below) doesn't break in this
 * PR. New code should pick sessions vs md explicitly.
 */
function getProvider(): EmbeddingProvider | null {
  return getSessionsProviderForExtension();
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Provider/store split into two independent live tracks. Failure on one
  // track must not cascade to the other. Sessions and md both use OpenRouter
  // Qwen3-Embedding-8B / 4096d today, but they still have separate stores and
  // providers so their lifecycle/cost boundaries stay isolated.
  //
  // Cross-track query in session_search → knowledge_search re-embeds through
  // the MD provider; sessions vectors are NEVER passed into the md store.

  let sessionsProvider: EmbeddingProvider | null = null;
  let mdProvider: EmbeddingProvider | null = null;

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

  /** MD-track provider getter — lazy, throws if not available. */
  function ensureMdProvider(): EmbeddingProvider {
    if (!mdProvider) {
      mdProvider = getMdProviderForExtension();
      if (!mdProvider) {
        throw new Error(
          "No md embedding provider available (set ANDENKEN_MD_PROVIDER and ANDENKEN_MD_*)",
        );
      }
    }
    return mdProvider;
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
  let mdStore: VectorStore | null = null;
  const mdDbPath = getMdDbPath();

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
  function getMdStore(): VectorStore {
    if (!mdStore) {
      const dim = mdProvider?.dimensions ?? 4096;
      mdStore = new VectorStore(mdDbPath, dim);
    }
    return mdStore;
  }

  // Each track has its own ready flag. session init failure must not block
  // md knowledge operations (knowledge_search) and vice versa.
  let sessionReady = false;
  let mdReady = false;
  let sessionsInitErr: string | null = null;
  let mdInitErr: string | null = null;
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
  // Sessions and md init are independent. A failure on one track surfaces in
  // status but does not disable the other. The two tools (session_search,
  // knowledge_search) report their own per-track readiness.
  pi.on("session_start", async (_event, ctx) => {
    let sCount: number | null = null;
    let mCount: number | null = null;

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

    // ---- MD track (independent) ----
    try {
      if (fs.existsSync(mdDbPath)) {
        mdProvider = getMdProviderForExtension();
        if (mdProvider) {
          await getMdStore().init();
          mdReady = true;
          mCount = await getMdStore().getCount();
        } else {
          mdInitErr = "no md provider configured";
        }
      }
      // MD DB absent → not an error; knowledge_search will report when called.
    } catch (err) {
      mdInitErr = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }

    // ---- Status line summarizes whatever subset came up ----
    const parts: string[] = [];
    if (sessionReady && sCount !== null) parts.push(`🧠 ${sCount} sessions`);
    else if (sessionsInitErr) parts.push(`⚠ sessions: ${sessionsInitErr}`);
    if (mdReady && mCount !== null) parts.push(`📝 ${mCount} md chunks`);
    else if (mdInitErr) parts.push(`⚠ md: ${mdInitErr}`);
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
          {
            description:
              "Filter by session source. Default 'all' = pi + claude, with md knowledge cross-track fallback when sessions results are thin. Explicit 'pi' or 'claude' restricts the candidate pool to that source AND disables the knowledge fallback (sessions-only intent).",
          },
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
      // --- Phase 1 — stored-signal filters (already-indexed columns) ---
      // Per NEXT.md (commit fe5ebf2): andenken does NOT parse natural-language
      // time. The caller (recall orchestrator / day-query) converts
      // "어제/지난주" to ISO ranges and passes dateFrom/dateTo explicitly.
      dateFrom: Type.Optional(
        Type.String({
          description:
            "Inclusive lower bound on chunk timestamp (ISO 8601). Caller is responsible for converting natural-language time expressions to ISO; andenken never parses 'yesterday'/'어제' etc.",
        }),
      ),
      dateTo: Type.Optional(
        Type.String({
          description:
            "Exclusive upper bound on chunk timestamp (ISO 8601). Pair with dateFrom for a half-open range [dateFrom, dateTo).",
        }),
      ),
      project: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "Project basename filter (single string for equality or array for IN). Matches the basename `extractProjectName` stored at index time — no cwd normalization in Phase 1.",
        }),
      ),
      role: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("user"),
            Type.Literal("assistant"),
            Type.Literal("compaction"),
          ]),
          {
            description:
              "Role filter — any of user|assistant|compaction. Use ['compaction'] to surface session-summary chunks; combine with withExcerpt to read the surrounding turn flow.",
          },
        ),
      ),
      sessionFile: Type.Optional(
        Type.String({
          description:
            "Exact sessionFile path to restrict the search to a single JSONL.",
        }),
      ),
      sessionFileContains: Type.Optional(
        Type.String({
          description:
            "Substring filter on sessionFile path. Generic path filter — narrow to a directory or filename fragment when project/time is not enough.",
        }),
      ),
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("semantic"),
            Type.Literal("hybrid"),
            Type.Literal("recent"),
          ],
          {
            description:
              "Retrieval mode. semantic|hybrid (default): vector+BM25 hybrid with 14d temporal decay. recent: stored-signal scan + timestamp-DESC sort (no embedding/BM25/dictcli; caller should pass filters). Cross-track md fallback is suppressed whenever any filter is set or mode='recent'.",
          },
        ),
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

      // Phase 1 — assemble stored-signal filters from optional params.
      // When every Phase-1 field is absent and mode is undefined, behavior
      // is identical to the pre-Phase-1 path (source filter still works).
      const sourceFilter = normalizeSourceFilter(params.source);
      const mode: "semantic" | "hybrid" | "recent" = params.mode ?? "hybrid";
      const filters: SearchFilters = {};
      if (sourceFilter) filters.source = sourceFilter;
      if (params.dateFrom) filters.dateFrom = params.dateFrom;
      if (params.dateTo) filters.dateTo = params.dateTo;
      if (params.project !== undefined) filters.project = params.project;
      if (params.role && params.role.length > 0) filters.role = params.role;
      if (params.sessionFile) filters.sessionFile = params.sessionFile;
      if (params.sessionFileContains) filters.sessionFileContains = params.sessionFileContains;
      const hasUserFilters = !!(
        params.dateFrom ||
        params.dateTo ||
        params.project ||
        (params.role && params.role.length > 0) ||
        params.sessionFile ||
        params.sessionFileContains
      );

      let expanded: string[] = [];
      let enrichedQuery = params.query;
      let results: SearchResult[];

      if (mode === "recent") {
        // Stored-signal mode: no embedding call, no BM25, no dictcli expansion.
        // The caller has already supplied ISO/project/role/sessionFile filters;
        // timestamp DESC is the primary retrieval axis.
        results = sortByTimestampDesc(await getSessionStore().filterSearch(filters));
      } else {
        // 3층 dictcli expand — 한글 쿼리 확장
        expanded = dictcliExpand(params.query);
        enrichedQuery = expanded.length > 0
          ? `${params.query} ${expanded.join(" ")}`
          : params.query;

        const candidates = Math.min(limit * 4, 200); // openclaw candidateMultiplier
        const queryVector = await sessP.embedQuery(enrichedQuery);
        const vectorResults = await getSessionStore().search(queryVector, candidates, 0.1, filters);
        const bm25Query = expandQueryForBM25(enrichedQuery); // include dictcli expand terms in FTS
        const ftsResults = await getSessionStore().fullTextSearch(bm25Query, candidates, filters);

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
            shortTokens.map((t) => getSessionStore().substringSearch(t, candidates, filters)),
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

        results = await retrieve(params.query, vectorResults, ftsResults, {
          vectorWeight: 0.7,
          bm25Weight: 0.3,
          recencyHalfLifeDays: 14,
          minScore: 0.001,
          mergeStrategy: "rrf" as const,
          mmr: { enabled: false, lambda: 0.7 },
        });
      }

      // Source filter is pushed down to LanceDB before retrieval so the candidate
      // pool is source-specific. Keep this defensive filter for older DB rows.
      if (sourceFilter) {
        results = results.filter((r) => r.source === sourceFilter);
      }

      // mode=recent: filterSearch already returned stored-signal rows;
      // keep timestamp DESC as the primary order. Scores are usually 0 in
      // this mode because no embedding/BM25 call is made.
      if (mode === "recent") {
        results = sortByTimestampDesc(results);
      }

      // Cross-track fallback (knowledge_search graceful degrade).
      //
      // When sessions results are thin, supplement with hits from the md
      // public garden corpus. Two safety boundaries:
      //
      //   1. Re-embed the query through mdProvider, NOT through sessP.
      //      Passing a sessions vector into mdStore.search would couple tracks.
      //
      //   2. Confirm dim compatibility between mdStore (DB truth) and
      //      mdProvider (configured dim). If mismatched, skip the fallback
      //      and surface a diagnostic — sessions results still return.
      //
      // session_search itself NEVER fails because of md-side issues.
      // Phase 1: disable cross-track fallback whenever the caller passed any
      // stored-signal filter or chose mode=recent. Falling back to md/org
      // under those modes would silently break sessions-only intent.
      const topScore = results[0]?.score ?? 0;
      let fallbackUsed = false;
      let fallbackDiagnostic: string | null = null;
      const wantsFallback =
        !sourceFilter &&
        !hasUserFilters &&
        mode !== "recent" &&
        (results.length < 3 || topScore < 0.005);
      if (wantsFallback) {
        if (!mdReady) {
          fallbackDiagnostic = "knowledge fallback skipped: md store not ready";
        } else {
          let mdP: EmbeddingProvider | null = null;
          try {
            mdP = ensureMdProvider();
          } catch (err) {
            fallbackDiagnostic = `knowledge fallback skipped: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
          }
          if (mdP) {
            const dimCheck = await getMdStore().checkCompatibleDim();
            if (!dimCheck.ok) {
              fallbackDiagnostic = `knowledge fallback skipped: ${dimCheck.reason ?? "md dim incompatible"}`;
            } else {
              // The fallback answers from the md track, so it runs the md core
              // rather than a third copy of that pipeline. Session ordering,
              // the 3-row budget, and the output shape are unchanged; what the
              // core adds is the stable candidate floor and the lossless
              // per-document cap.
              const { results: mdResults } = await searchMdCore(
                getMdStore(),
                mdP,
                params.query,
                3,
                { expandFn: dictcliExpand },
              );
              if (mdResults.length > 0) {
                results = [...results.slice(0, limit - 3), ...mdResults.slice(0, 3)];
                fallbackUsed = true;
              }
            }
          }
        }
      }

      const finalResults = results.slice(0, limit);
      recordRecall(params.query, "session_search", finalResults, { limit });

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

  // --- knowledge_search tool (public garden md production axis) ---
  pi.registerTool({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Search the public digital garden Markdown knowledge base by meaning. Use for finding notes, concepts, references, and meta-knowledge. This is the production knowledge axis; org semantic search is disabled/upstream R&D.",
    promptSnippet:
      "Search public garden Markdown semantically — notes, concepts, references in Korean and English.",
    promptGuidelines: [
      "Use knowledge_search when the user asks about their notes, concepts, or knowledge base.",
      "Use knowledge_search for cross-lingual queries — Korean '보편' finds English-tagged 'universalism' notes. Expansion only fires when the query itself contains Hangul.",
      "Judge from the top 3-5 documents. The first screen groups chunks by document and shows each note's own description; widen the limit only when that screen is genuinely sparse, not by habit.",
      "Choose a document, then open its file path to read it. Do not re-query for text you can read directly.",
      "The score is a per-query normalized rank, not a confidence. The top md hit sits near 1.0 whatever the match quality, and md scores are NOT comparable with session_search scores.",
      "For a person or any existence question ('is there a note about X?'), knowledge_search returns CANDIDATES only. Confirm with denotecli exact title/tag search before asserting that a note exists or writing a link to it.",
      "If results are sparse, extract keywords from top results and re-search with more specific terms. Try dictcli expand for Korean→English term expansion.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Natural language search query (e.g., '보편 학문', 'knowledge graph ontology', '바흐 체화인지')",
      }),
      limit: Type.Optional(
        Type.Number({
          description:
            `Max chunks to display (default ${MD_DEFAULT_LIMIT}). The candidate pool has a floor of 40, so for any limit up to 10 this changes how much you read, not what can be found. Above 10 the pool grows with the limit and the ranking itself can shift.`,
          default: MD_DEFAULT_LIMIT,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      // knowledge_search uses the MD provider exclusively. Even if
      // sessionsProvider/sessionsStore are entirely broken, knowledge_search
      // must still work — that is the independent-init invariant.
      const mdP = ensureMdProvider();

      // Lazy init — md DB may exist but session_start lost the race with env-loader
      if (!mdReady) {
        if (!fs.existsSync(mdDbPath)) {
          throw new Error("MD knowledge base not indexed. Run: ./run.sh index:md");
        }
        try {
          await getMdStore().init();
          mdReady = true;
        } catch (err) {
          throw new Error(`MD memory init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Dim safety: an embedding-provider misconfiguration should produce a
      // clear error rather than silently fall back to FTS-only via the
      // VectorStore's existing dim-mismatch warning. checkCompatibleDim
      // returns ok for empty tables (fresh DB), so this guard does not block
      // first-run scenarios.
      const dimCheck = await getMdStore().checkCompatibleDim();
      if (!dimCheck.ok) {
        throw new Error(
          `knowledge_search refused: ${dimCheck.reason ?? "md dim incompatible"}. ` +
          `Configured ${dimCheck.configured}d, stored ${dimCheck.actual}d. ` +
          `Run ./run.sh index:md or fix ANDENKEN_MD_*.`,
        );
      }

      const limit = params.limit ?? MD_DEFAULT_LIMIT;

      // Production path parity: this tool runs the SAME function as
      // `cli.ts search-md` and `golden-queries.ts`. It used to carry a
      // line-by-line copy of that pipeline, which meant the golden gate and
      // `./run.sh accept` measured a function no agent ever called.
      // `expandFn` keeps this surface's 30-minute expansion cache.
      const { results: finalResults, expanded } = await searchMdCore(
        getMdStore(),
        mdP,
        params.query,
        limit,
        { expandFn: dictcliExpand },
      );

      recordRecall(params.query, "knowledge_search", finalResults, { limit });

      // The model-visible screen echoes the caller's own query and nothing
      // else. Expansion terms are unbounded (one per matched Korean word, from
      // dictcli) and carry no decision value on the first screen, so they live
      // in `details`, which pi never sends to the model.
      return {
        content: [
          { type: "text" as const, text: formatMdScreen(params.query, finalResults) },
        ],
        details: {
          query: params.query,
          expanded,
          limit,
          resultCount: finalResults.length,
          results: finalResults.map((r) => ({
            id: r.id,
            ...mdResultToJson(r),
          })),
        },
      };
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
        const mCount = mdReady ? await getMdStore().getCount() : 0;
        const sFiles = findSessionFiles();
        const sIndexed = sessionReady ? await getSessionStore().getIndexedFiles() : new Set();
        ctx.ui.notify(
          `🧠 Sessions: ${sCount} chunks (${sIndexed.size}/${sFiles.length} files)\n` +
            `📝 MD: ${mCount} chunks${mdReady ? "" : " (not indexed)"}`,
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

        if (target === "md" || target === "all") {
          ctx.ui.notify("📝 MD 인덱싱은 CLI로 실행하세요: cd ~/repos/gh/andenken && ./run.sh sync:md", "info");
        }

        if (target === "org") {
          ctx.ui.notify("📚 Org semantic track is disabled in production; use md (`./run.sh sync:md`) for agent-facing knowledge.", "warning");
        }

        if (target !== "sessions" && target !== "md" && target !== "org" && target !== "all") {
          ctx.ui.notify(
            "Usage: /memory reindex [sessions|md|all] [--force]",
            "warning",
          );
        }
      } else {
        ctx.ui.notify(
          "Usage: /memory [status | search <query> | reindex [sessions|md|all] [--force]]",
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
    if (mdStore) await mdStore.close();
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

// `augmentShortCjkFts` lived here as a second copy of the short-CJK substring
// fallback in `md-search.ts`. Both md callers on this surface (knowledge_search
// and the session cross-track fallback) now run `searchMdCore`, which owns that
// step, so the copy was removed rather than left to drift.

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
