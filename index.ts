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
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getOrgDbPath } from "./store.js";
import {
  findSessionFiles,
  extractSessionChunks,
} from "./session-indexer.js";
import { retrieve, expandQueryForBM25 } from "./retriever.js";

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

// --- dictcli expand (3층) ---

function dictcliExpand(query: string): string[] {
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

function getProvider(): EmbeddingProvider | null {
  loadEnvLocal();
  return createProviderFromEnv();
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Provider initialized lazily — dimensions determine store compat
  let provider: EmbeddingProvider | null = null;
  function ensureProvider(): EmbeddingProvider {
    if (!provider) {
      provider = getProvider();
      if (!provider) throw new Error("No embedding provider available (set GEMINI_API_KEY or ANDENKEN_PROVIDER=vllm)");
    }
    return provider;
  }

  const sessionStore = new VectorStore(undefined, 768);
  const orgDbPath = getOrgDbPath();
  const orgStore = new VectorStore(orgDbPath, 768);

  let sessionReady = false;
  let orgReady = false;
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
  pi.on("session_start", async (_event, ctx) => {
    provider = getProvider();
    if (!provider) {
      ctx.ui.setStatus(
        "semantic-memory",
        "⚠ No embedding provider — semantic memory disabled",
      );
      return;
    }
    ctx.ui.setStatus("semantic-memory", `📡 ${provider.name} (${provider.dimensions}d) loading...`);

    try {
      await sessionStore.init();
      sessionReady = true;
      const sCount = await sessionStore.getCount();

      // Org store (if indexed)
      if (fs.existsSync(orgDbPath)) {
        await orgStore.init();
        orgReady = true;
        const oCount = await orgStore.getCount();
        ctx.ui.setStatus(
          "semantic-memory",
          `🧠 ${sCount} sessions + 📚 ${oCount} org chunks`,
        );
      } else {
        ctx.ui.setStatus("semantic-memory", `🧠 ${sCount} session chunks`);
      }
    } catch (err) {
      ctx.ui.setStatus(
        "semantic-memory",
        `⚠ Memory init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        Type.String({
          description: "Filter by source: 'pi' or 'claude' (default: all)",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const p = ensureProvider();

      // Lazy init
      if (!sessionReady) {
        try {
          await sessionStore.init();
          sessionReady = true;
        } catch (err) {
          throw new Error(`Session memory init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const limit = params.limit ?? 10;

      // 3층 dictcli expand — 한글 쿼리 확장
      const expanded = dictcliExpand(params.query);
      const enrichedQuery = expanded.length > 0
        ? `${params.query} ${expanded.join(" ")}`
        : params.query;

      const candidates = Math.min(limit * 4, 200); // openclaw candidateMultiplier
      const queryVector = await p.embedQuery(enrichedQuery);
      const vectorResults = await sessionStore.search(queryVector, candidates);
      const bm25Query = expandQueryForBM25(params.query);
      const ftsResults = await sessionStore.fullTextSearch(bm25Query, candidates);

      let results = await retrieve(params.query, vectorResults, ftsResults, {
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        recencyHalfLifeDays: 14,
        minScore: 0.001,
        mergeStrategy: "rrf" as const,
        mmr: { enabled: false, lambda: 0.7 },
      });

      // Source filter (pi | claude)
      const sourceFilter = params.source;
      if (sourceFilter) {
        results = results.filter((r) => r.source === sourceFilter);
      }

      // 자동 폴백: session 결과가 빈약하면 knowledge_search도 실행
      const topScore = results[0]?.score ?? 0;
      let fallbackUsed = false;
      if (orgReady && (results.length < 3 || topScore < 0.005)) {
        const orgCandidates = Math.min(limit * 4, 200);
        const orgQueryVector = await p.embedQuery(enrichedQuery);
        const orgVec = await orgStore.search(orgQueryVector, orgCandidates, 0.05);
        const orgFts = await orgStore.fullTextSearch(expandQueryForBM25(params.query), orgCandidates);
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

      const output = formatResults(
        expanded.length > 0 ? `${params.query} (+expand: ${expanded.join(", ")})` : params.query,
        results.slice(0, limit),
      );
      if (fallbackUsed) {
        output.content[0].text += "\n\n(⚡ session 결과 부족 → knowledge_search 폴백 포함)";
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
      const p = ensureProvider();

      // Lazy init — org DB may exist but session_start lost the race with env-loader
      if (!orgReady) {
        if (!fs.existsSync(orgDbPath)) {
          throw new Error("Org knowledge base not indexed. Run: ./run.sh index:org");
        }
        try {
          await orgStore.init();
          orgReady = true;
        } catch (err) {
          throw new Error(`Org memory init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const limit = params.limit ?? 10;

      // 3층 dictcli expand — 한글 쿼리 확장
      const expanded = dictcliExpand(params.query);
      const enrichedQuery = expanded.length > 0
        ? `${params.query} ${expanded.join(" ")}`
        : params.query;

      const candidates = Math.min(limit * 4, 200); // openclaw candidateMultiplier
      const queryVector = await p.embedQuery(enrichedQuery);
      const vectorResults = await orgStore.search(queryVector, candidates, 0.05);
      const bm25Query = expandQueryForBM25(params.query);
      const ftsResults = await orgStore.fullTextSearch(bm25Query, candidates);

      const results = await retrieve(params.query, vectorResults, ftsResults, {
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        recencyHalfLifeDays: 90,
        minScore: 0.05,
        mmr: { enabled: true, lambda: 0.7 },
        mergeStrategy: "weighted" as const,
      });

      return formatResults(
        expanded.length > 0 ? `${params.query} (+expand: ${expanded.join(", ")})` : params.query,
        results.slice(0, limit),
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
        const sCount = sessionReady ? await sessionStore.getCount() : 0;
        const oCount = orgReady ? await orgStore.getCount() : 0;
        const sFiles = findSessionFiles();
        const sIndexed = sessionReady ? await sessionStore.getIndexedFiles() : new Set();
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
            await indexSessions(sessionStore, p, ctx, force);
            const count = await sessionStore.getCount();
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
      const indexed = await sessionStore.getIndexedFiles();
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
    await sessionStore.close();
    await orgStore.close();
  });
}

// --- Helpers ---

function formatResults(query: string, results: SearchResult[]) {
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
      results: results.map((r) => ({
        id: r.id,
        project: r.project,
        role: r.role,
        source: r.source,
        score: r.score,
        sessionFile: r.sessionFile,
        lineNumber: r.lineNumber,
      })) as Array<Record<string, unknown>>,
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
