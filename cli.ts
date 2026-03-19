#!/usr/bin/env npx tsx
/**
 * Semantic Memory CLI
 *
 * Thin CLI wrapper over the existing semantic-memory modules.
 * Designed for Claude Code skill invocation.
 *
 * Usage:
 *   cli.ts search-sessions <query> [--limit N]
 *   cli.ts search-knowledge <query> [--limit N]
 *   cli.ts status
 *   cli.ts reindex [--force]
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import {
  embedQuery,
  embedDocumentBatch,
  type GeminiEmbeddingConfig,
} from "./gemini-embeddings.ts";
import { VectorStore, getSessionsDbPath, getOrgDbPath, type SearchResult } from "./store.ts";
import { findSessionFiles, extractSessionChunks } from "./session-indexer.ts";
import { retrieve, type MergeStrategy } from "./retriever.ts";

// --- Config ---

function getGeminiConfig(
  dimensions?: 768 | 3072,
): GeminiEmbeddingConfig | null {
  const apiKey =
    process.env.GOOGLE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return null;
  return {
    apiKey,
    model: "gemini-embedding-2-preview",
    ...(dimensions ? { dimensions } : {}),
  };
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

// --- Commands ---

async function searchSessions(query: string, limit: number): Promise<void> {
  const gemini = getGeminiConfig();
  if (!gemini) {
    console.error(JSON.stringify({ error: "GOOGLE_AI_API_KEY not set" }));
    process.exit(1);
  }

  const store = new VectorStore(sessionDbPath, 3072);
  await store.init();

  const expanded = dictcliExpand(query);
  const enrichedQuery =
    expanded.length > 0 ? `${query} ${expanded.join(" ")}` : query;

  const queryVector = await embedQuery(enrichedQuery, gemini);
  const vectorResults = await store.search(queryVector, limit * 2);
  const ftsResults = await store.fullTextSearch(query, limit * 2);

  let results = await retrieve(query, vectorResults, ftsResults, {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    recencyHalfLifeDays: 14,
    minScore: 0.001,
    mergeStrategy: "rrf" as MergeStrategy,
    mmr: { enabled: false, lambda: 0.7 },
  });

  // Auto-fallback to knowledge if session results are thin
  let fallback = false;
  const topScore = results[0]?.score ?? 0;
  if (fs.existsSync(orgDbPath) && (results.length < 3 || topScore < 0.005)) {
    const orgGemini = getGeminiConfig(768);
    if (orgGemini) {
      const orgStore = new VectorStore(orgDbPath, 768);
      await orgStore.init();
      const orgQueryVector = await embedQuery(enrichedQuery, orgGemini);
      const orgVec = await orgStore.search(orgQueryVector, limit, 0.05);
      const orgFts = await orgStore.fullTextSearch(query, limit);
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

  const finalResults = results.slice(0, limit);
  console.log(
    JSON.stringify({
      query,
      expanded: expanded.length > 0 ? expanded : undefined,
      fallback,
      count: finalResults.length,
      results: finalResults.map(formatResult),
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

  const gemini = getGeminiConfig(768);
  if (!gemini) {
    console.error(JSON.stringify({ error: "GOOGLE_AI_API_KEY not set" }));
    process.exit(1);
  }

  const store = new VectorStore(orgDbPath, 768);
  await store.init();

  const expanded = dictcliExpand(query);
  const enrichedQuery =
    expanded.length > 0 ? `${query} ${expanded.join(" ")}` : query;

  const queryVector = await embedQuery(enrichedQuery, gemini);
  const vectorResults = await store.search(queryVector, limit * 2, 0.05);
  const ftsResults = await store.fullTextSearch(query, limit * 2);

  const results = await retrieve(query, vectorResults, ftsResults, {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    recencyHalfLifeDays: 90,
    minScore: 0.05,
    mmr: { enabled: true, lambda: 0.7 },
    mergeStrategy: "weighted" as MergeStrategy,
  });

  const finalResults = results.slice(0, limit);
  console.log(
    JSON.stringify({
      query,
      expanded: expanded.length > 0 ? expanded : undefined,
      count: finalResults.length,
      results: finalResults.map(formatResult),
    }),
  );

  await store.close();
}

async function status(): Promise<void> {
  const sessionStore = new VectorStore(sessionDbPath, 3072);
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

  let orgCount = 0;
  const orgExists = fs.existsSync(orgDbPath);
  if (orgExists) {
    const orgStore = new VectorStore(orgDbPath, 768);
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
      knowledge: {
        chunks: orgCount,
        indexed: orgExists,
      },
    }),
  );
}

async function reindex(force: boolean): Promise<void> {
  const gemini = getGeminiConfig();
  if (!gemini) {
    console.error(JSON.stringify({ error: "GOOGLE_AI_API_KEY not set" }));
    process.exit(1);
  }

  const store = new VectorStore(sessionDbPath, 3072);
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

    const vectors = await embedDocumentBatch(
      chunks.map((c) => c.text),
      gemini,
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

function formatResult(r: SearchResult) {
  return {
    project: r.project,
    role: r.role,
    score: Number(r.score.toFixed(4)),
    file: r.sessionFile,
    line: r.lineNumber,
    timestamp: r.timestamp,
    text: r.text.slice(0, 800) + (r.text.length > 800 ? "..." : ""),
  };
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
        console.error(JSON.stringify({ error: "Usage: search-sessions <query> [--limit N]" }));
        process.exit(1);
      }
      await searchSessions(query, limit);
      break;
    }
    case "search-knowledge":
    case "knowledge": {
      const query = positional.join(" ");
      if (!query) {
        console.error(JSON.stringify({ error: "Usage: search-knowledge <query> [--limit N]" }));
        process.exit(1);
      }
      await searchKnowledge(query, limit);
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
          usage: "cli.ts <search-sessions|search-knowledge|status|reindex> [args]",
        }),
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
