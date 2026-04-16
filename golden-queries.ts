#!/usr/bin/env npx tsx
/**
 * andenken golden-queries — 힣의 언어장으로 검색 품질 판단
 *
 * Usage:
 *   source ~/.env.local
 *   npx tsx golden-queries.ts              # 전체 실행
 *   npx tsx golden-queries.ts --no-expand  # dictcli expand 없이
 *   npx tsx golden-queries.ts --json       # JSON 출력
 *   npx tsx golden-queries.ts --compare    # expand 전/후 비교
 *   npx tsx golden-queries.ts --db session # session DB만 (기본: both)
 *   npx tsx golden-queries.ts --db org     # org DB만
 *
 * Golden queries = 힣의 실제 표현. 범용 벤치마크가 아니라 "내 언어"가 잘 회수되는지 확인.
 * 결과가 어제보다 나빠졌는지 바로 판단 가능해야 한다.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  createProviderFromEnv,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getSessionsDbPath, getOrgDbPath } from "./store.js";
import { retrieve, expandQueryForBM25, type MergeStrategy } from "./retriever.js";

// --- Golden Query Fixtures ---
// 힣의 언어장에서 뽑은 쿼리. 각 쿼리에 기대하는 최소 조건을 명시.

interface GoldenQuery {
  query: string;
  description: string;          // 왜 이 쿼리가 중요한지
  expectMinResults: number;     // 최소 N개 결과가 나와야
  expectKeywords?: string[];    // 결과 텍스트에 이 중 하나는 포함되어야
  db: "session" | "org" | "both"; // 어느 DB에서 테스트할지
}

const GOLDEN_QUERIES: GoldenQuery[] = [
  {
    query: "보편 학문",
    description: "paideia/universalism — dictcli expand가 영어 태그로 확장해야",
    expectMinResults: 1,
    expectKeywords: ["보편", "paideia", "universalism", "학문"],
    db: "org",
  },
  {
    query: "설계했다",
    description: "한국어 어간 '설계' — Kiwi stem이 동작해야",
    expectMinResults: 1,
    expectKeywords: ["설계"],
    db: "org",
  },
  {
    query: "존재사건",
    description: "힣 고유 워딩 — Ereignis/존재론",
    expectMinResults: 1,
    expectKeywords: ["존재", "사건", "Ereignis"],
    db: "org",
  },
  {
    query: "피투성",
    description: "하이데거 Geworfenheit — 힣의 핵심 개념",
    expectMinResults: 1,
    expectKeywords: ["피투", "Geworfenheit", "던져진"],
    db: "org",
  },
  {
    query: "뜻새김",
    description: "힣 고유 개념 — semantic/meaning-making",
    expectMinResults: 1,
    db: "org",
  },
  {
    query: "봇멘트 remark42",
    description: "최근 인프라 작업 — 세션에서 잘 찾아야",
    expectMinResults: 1,
    expectKeywords: ["봇멘트", "remark42", "botment"],
    db: "session",
  },
  {
    query: "andenken 임베딩 비용",
    description: "비용 폭탄 사건 — 세션/지식 양쪽에서",
    expectMinResults: 1,
    expectKeywords: ["임베딩", "비용", "embedding", "cost"],
    db: "both",
  },
  {
    query: "1KB 프로파일 존재",
    description: "힣의 핵심 비전 — 1KB로 존재를 전달",
    expectMinResults: 1,
    expectKeywords: ["1KB", "프로파일", "존재"],
    db: "both",
  },
  {
    query: "delegate session directory",
    description: "영어 기술 쿼리 — delegate 세션 관리",
    expectMinResults: 1,
    expectKeywords: ["delegate", "session"],
    db: "session",
  },
  {
    query: "디지털 가든 공진화",
    description: "힣의 방향성 — AI와 인간의 공진화",
    expectMinResults: 1,
    expectKeywords: ["가든", "공진화", "digital", "garden"],
    db: "org",
  },
];

// --- Config ---

function dictcliExpand(query: string): string[] {
  const koreanWords = query.match(/[\uAC00-\uD7AF]+/g) ?? [];
  if (koreanWords.length === 0) return [];

  const dictcliDir = path.join(process.env.HOME ?? "", ".pi", "agent", "skills", "pi-skills", "dictcli");
  const dictcliBin = path.join(dictcliDir, "dictcli");
  if (!fs.existsSync(dictcliBin)) return [];

  const expanded: string[] = [];
  for (const word of koreanWords) {
    try {
      const out = execSync(`./dictcli expand "${word}" --json`, {
        timeout: 1000, encoding: "utf-8", cwd: dictcliDir,
      }).trim();
      if (out.startsWith("[")) expanded.push(...(JSON.parse(out) as string[]));
    } catch { /* silent */ }
  }
  return [...new Set(expanded)];
}

// --- Search ---

interface QueryResult {
  query: string;
  description: string;
  db: string;
  expanded: string[];
  resultCount: number;
  topScore: number;
  keywordHit: boolean;
  pass: boolean;
  topResults: { score: number; text: string; project?: string }[];
}

async function runQuery(
  gq: GoldenQuery,
  provider: EmbeddingProvider,
  useExpand: boolean,
  dbFilter?: "session" | "org",
): Promise<QueryResult> {
  const targetDb = dbFilter ?? gq.db;
  const expanded = useExpand ? dictcliExpand(gq.query) : [];
  const enrichedQuery = expanded.length > 0 ? `${gq.query} ${expanded.join(" ")}` : gq.query;
  const bm25Query = expandQueryForBM25(enrichedQuery);

  const allResults: { score: number; text: string; project: string }[] = [];

  const dim = provider.dimensions || 2560;

  // Session DB
  if (targetDb === "session" || targetDb === "both") {
    const dbPath = getSessionsDbPath();
    if (fs.existsSync(dbPath)) {
      const store = new VectorStore(dbPath, dim);
      await store.init();
      const qv = await provider.embedQuery(enrichedQuery);
      const vec = await store.search(qv, 20);
      const fts = await store.fullTextSearch(bm25Query, 20);
      const results = await retrieve(gq.query, vec, fts, {
        vectorWeight: 0.7, bm25Weight: 0.3,
        recencyHalfLifeDays: 14, minScore: 0.001,
        mergeStrategy: "rrf" as MergeStrategy,
        mmr: { enabled: false, lambda: 0.7 },
      });
      allResults.push(...results.slice(0, 5).map((r) => ({
        score: r.score, text: r.text.slice(0, 500), project: r.project,
      })));
      await store.close();
    }
  }

  // Org DB
  if (targetDb === "org" || targetDb === "both") {
    const dbPath = getOrgDbPath();
    if (fs.existsSync(dbPath)) {
      const store = new VectorStore(dbPath, dim);
      await store.init();
      const qv = await provider.embedQuery(enrichedQuery);
      const vec = await store.search(qv, 20, 0.05);
      const fts = await store.fullTextSearch(bm25Query, 20);
      const results = await retrieve(gq.query, vec, fts, {
        vectorWeight: 0.7, bm25Weight: 0.3,
        recencyHalfLifeDays: 90, minScore: 0.05,
        mergeStrategy: "weighted" as MergeStrategy,
        mmr: { enabled: true, lambda: 0.7 },
      });
      allResults.push(...results.slice(0, 5).map((r) => ({
        score: r.score, text: r.text.slice(0, 500), project: r.project,
      })));
      await store.close();
    }
  }

  // Sort by score
  allResults.sort((a, b) => b.score - a.score);
  const top = allResults.slice(0, 5);

  // Check keyword hit
  let keywordHit = true;
  if (gq.expectKeywords && gq.expectKeywords.length > 0) {
    const allText = top.map((r) => r.text.toLowerCase()).join(" ");
    keywordHit = gq.expectKeywords.some((kw) => allText.includes(kw.toLowerCase()));
  }

  const pass = top.length >= gq.expectMinResults && keywordHit;

  return {
    query: gq.query,
    description: gq.description,
    db: targetDb,
    expanded,
    resultCount: top.length,
    topScore: top[0]?.score ?? 0,
    keywordHit,
    pass,
    topResults: top,
  };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const compareMode = args.includes("--compare");
  const noExpand = args.includes("--no-expand");
  const dbIdx = args.indexOf("--db");
  const dbFilter = dbIdx >= 0 ? (args[dbIdx + 1] as "session" | "org") : undefined;

  const provider = createProviderFromEnv();
  if (!provider) {
    console.error("❌ No embedding provider available (set GEMINI_API_KEY or ANDENKEN_PROVIDER=vllm)");
    process.exit(1);
  }
  console.log(`📡 Provider: ${provider.name} (${provider.dimensions}d)\n`);

  if (compareMode) {
    // Run each query twice: with/without expand
    console.log("🔍 golden-queries — dictcli expand 비교\n");
    console.log("─".repeat(80));

    let improved = 0;
    let degraded = 0;
    let same = 0;

    for (const gq of GOLDEN_QUERIES) {
      if (dbFilter && gq.db !== dbFilter && gq.db !== "both") continue;

      const without = await runQuery(gq, provider, false, dbFilter);
      const withExp = await runQuery(gq, provider, true, dbFilter);

      const scoreDiff = withExp.topScore - without.topScore;
      const icon = scoreDiff > 0.01 ? "📈" : scoreDiff < -0.01 ? "📉" : "➡️";
      if (scoreDiff > 0.01) improved++;
      else if (scoreDiff < -0.01) degraded++;
      else same++;

      console.log(`  ${icon} "${gq.query}"`);
      console.log(`     without: score=${without.topScore.toFixed(4)} results=${without.resultCount}`);
      console.log(`     with:    score=${withExp.topScore.toFixed(4)} results=${withExp.resultCount} expanded=[${withExp.expanded.join(",")}]`);
    }

    console.log("─".repeat(80));
    console.log(`  📈 improved: ${improved}  ➡️ same: ${same}  📉 degraded: ${degraded}\n`);
    return;
  }

  // Normal mode
  const results: QueryResult[] = [];

  for (const gq of GOLDEN_QUERIES) {
    if (dbFilter && gq.db !== dbFilter && gq.db !== "both") continue;
    results.push(await runQuery(gq, provider, !noExpand, dbFilter));
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Pretty output
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  console.log(`\n🔍 golden-queries — ${passed}/${total} passed\n`);
  console.log("─".repeat(80));

  for (const r of results) {
    const icon = r.pass ? "✅" : "❌";
    const expandInfo = r.expanded.length > 0 ? ` +[${r.expanded.join(",")}]` : "";
    console.log(`  ${icon} "${r.query}" (${r.db})${expandInfo}`);
    console.log(`     ${r.description}`);
    console.log(`     results=${r.resultCount} topScore=${r.topScore.toFixed(4)} keywordHit=${r.keywordHit}`);

    if (!r.pass && r.topResults.length > 0) {
      console.log(`     top: "${r.topResults[0].text.slice(0, 80)}..."`);
    }
  }

  console.log("─".repeat(80));

  if (passed === total) {
    console.log(`  ✅ ALL PASSED — 검색 품질 정상\n`);
  } else {
    console.log(`  ⚠️  ${total - passed}개 실패 — 검색 품질 점검 필요\n`);
  }
}

main().catch((err) => {
  console.error(`❌ golden-queries failed: ${err}`);
  process.exit(1);
});
