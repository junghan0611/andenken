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
  createSessionProviderFromEnv,
  createOrgProviderFromEnv,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getSessionsDbPath, getOrgDbPath } from "./store.js";
import {
  retrieve,
  expandQueryForBM25,
  isScaffoldChunk,
  type MergeStrategy,
} from "./retriever.js";

// --- Golden Query Fixtures ---
// 힣의 언어장에서 뽑은 쿼리. 각 쿼리에 기대하는 최소 조건을 명시.
//
// Categories (retrieval quality dimensions):
//   sanity              — baseline "can we find anything"
//   intent-definition   — 누구/뭐였지/시작점 — 설명 chunk가 top-1이어야 함
//   operational-recovery — 최근 운영 결정 복원 — session 우선
//   abstract-context    — 메타 질의 → 2단계 검색 hint가 top-3에 나와야
//   local-magnet        — 힣 가든 고유 자석 (국제/어쏠로지 등) 유지
//   hard-negative       — 특정 chunk 종류가 top-K에 나오면 안 됨
//
// Intent is used by rankers (R2) to route query-type-sensitive scoring.

type QueryCategory =
  | "sanity"
  | "intent-definition"
  | "operational-recovery"
  | "abstract-context"
  | "local-magnet"
  | "hard-negative";

type QueryIntent = "definition" | "recovery" | "concept" | "magnet" | "abstract";

// Scaffold detection is shared with retriever.ts so the eval measures the
// same chunks the ranker damps.

interface GoldenQuery {
  query: string;
  description: string;          // 왜 이 쿼리가 중요한지
  category: QueryCategory;
  intent?: QueryIntent;
  expectMinResults: number;     // 최소 N개 결과가 나와야
  expectKeywords?: string[];    // 결과 텍스트에 이 중 하나는 포함되어야 (top-K 합산)
  top1MustContain?: string[];   // top-1 텍스트에 이 중 하나는 포함되어야 (엄격)
  top1MustNotContain?: string[]; // top-1 텍스트에 이 중 어떤 것도 포함되면 안 됨 (hard negative)
  topKMustNotContain?: string[]; // top-K 어디에도 포함되면 안 됨 (:ARCHIVE:/:LLMLOG: 류)
  top1NoScaffold?: boolean;     // top-1이 SCAFFOLD_MARKERS 중 하나를 포함하면 fail (R1 guard)
  topKScaffoldMax?: number;     // top-K 내 scaffold chunk가 이 값 이하여야 함 (R1 density)
  db: "session" | "org" | "both"; // 어느 DB에서 테스트할지
  topK?: number;                // 기본 5
}

const GOLDEN_QUERIES: GoldenQuery[] = [
  // ─── sanity (기존 baseline) ────────────────────────────────
  {
    query: "보편 학문",
    description: "paideia/universalism — dictcli expand가 영어 태그로 확장해야",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["보편", "paideia", "universalism", "학문"],
    db: "org",
  },
  {
    query: "설계했다",
    description: "한국어 어간 '설계' — Kiwi stem이 동작해야",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["설계"],
    db: "org",
  },
  {
    query: "존재사건",
    description: "힣 고유 워딩 — Ereignis/존재론",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["존재", "사건", "Ereignis"],
    db: "org",
  },
  {
    query: "피투성",
    description: "하이데거 Geworfenheit — 힣의 핵심 개념",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["피투", "Geworfenheit", "던져진"],
    db: "org",
  },
  {
    query: "뜻새김",
    description: "힣 고유 개념 — semantic/meaning-making",
    category: "sanity",
    expectMinResults: 1,
    db: "org",
  },
  {
    query: "봇멘트 remark42",
    description: "최근 인프라 작업 — 세션에서 잘 찾아야",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["봇멘트", "remark42", "botment"],
    db: "session",
  },
  {
    query: "andenken 임베딩 비용",
    description: "비용 폭탄 사건 — 세션/지식 양쪽에서",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["임베딩", "비용", "embedding", "cost"],
    db: "both",
  },
  {
    query: "1KB 프로파일 존재",
    description: "힣의 핵심 비전 — 1KB로 존재를 전달",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["1KB", "프로파일", "존재"],
    db: "both",
  },
  {
    query: "디지털 가든 공진화",
    description: "힣의 방향성 — AI와 인간의 공진화",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["가든", "공진화", "digital", "garden"],
    db: "org",
  },

  // ─── intent-definition: top-1이 설명 chunk여야, scaffold 밀도 제한 ────
  {
    query: "바네바 부시 누구였지",
    description: "정의 질의 — bib/설명 chunk가 top-1이어야. scaffold heading이면 fail",
    category: "intent-definition",
    intent: "definition",
    expectMinResults: 1,
    expectKeywords: ["바네바", "부시", "Vannevar", "Bush", "As We May Think", "Memex"],
    top1NoScaffold: true,
    topKScaffoldMax: 1,
    db: "org",
  },
  {
    query: "메멕스 시작점",
    description: "정의 질의 — As We May Think 설명이 top-1이어야",
    category: "intent-definition",
    intent: "definition",
    expectMinResults: 1,
    expectKeywords: ["Memex", "메멕스", "As We May Think", "1945"],
    top1NoScaffold: true,
    topKScaffoldMax: 1,
    db: "org",
  },
  {
    query: "어쏠로지 뭐였지",
    description: "힣 고유어 정의 질의 — canonical 설명이 top-1이어야",
    category: "intent-definition",
    intent: "definition",
    expectMinResults: 1,
    expectKeywords: ["어쏠로지", "authology"],
    top1NoScaffold: true,
    topKScaffoldMax: 1,
    db: "org",
  },
  {
    query: "Andenken 뜻",
    description: "프로젝트 네이밍 정의 질의 — Heidegger 설명이 top-1",
    category: "intent-definition",
    intent: "definition",
    expectMinResults: 1,
    expectKeywords: ["Andenken", "뜻새김", "Heidegger", "recollective", "이기상"],
    top1NoScaffold: true,
    topKScaffoldMax: 1,
    db: "both",
  },
  {
    query: "일일일생 왜 중요",
    description: "힣 고유 개념 정의 질의 — 본문 설명이 top-1이어야",
    category: "intent-definition",
    intent: "definition",
    expectMinResults: 1,
    top1NoScaffold: true,
    topKScaffoldMax: 1,
    db: "org",
  },
  {
    query: "보편학 파이데이아",
    description: "개념명 질의 (explicit intent 없음) — top-1/2은 content여야, scaffold는 뒤로",
    category: "intent-definition",
    intent: "concept",
    expectMinResults: 1,
    expectKeywords: ["파이데이아", "paideia", "universalism", "모티머", "애들러"],
    top1NoScaffold: true,
    topKScaffoldMax: 2,
    db: "org",
  },

  // ─── operational-recovery: session 우선 ────────────────────
  {
    query: "최근 org 임베딩 폭파 이유",
    description: "운영 복원 — 최근+프로젝트 일치 세션이 top-3 내. 딴 리포 세션이 top-1이면 fail",
    category: "operational-recovery",
    intent: "recovery",
    expectMinResults: 1,
    expectKeywords: ["andenken", "org", "임베딩", "embedding", "폭파", "duplicate"],
    top1MustNotContain: ["hej-nixos-cluster", "nixos-config commit"],
    db: "session",
    topK: 3,
  },
  {
    query: "오늘 조테로 어떻게 하기로 했지",
    description: "최근 운영 결정 복원 — zotero save/sync 워크플로우 세션 (dictcli 음차 매핑 의존)",
    category: "operational-recovery",
    intent: "recovery",
    expectMinResults: 1,
    expectKeywords: ["zotero", "bibcli", "sync", "citation", "bib"],
    db: "session",
  },
  {
    query: "dual GPU 인덱싱 튜닝",
    description: "최근 인프라 결정 — max-num-batched-tokens / round-robin 세션",
    category: "operational-recovery",
    intent: "recovery",
    expectMinResults: 1,
    expectKeywords: ["vllm", "GPU", "batched", "round-robin", "8192", "16384"],
    db: "session",
  },
  {
    query: "duplicate rows 재인덱싱 결정",
    description: "WriteBuffer 동시성 버그 관련 운영 결정",
    category: "operational-recovery",
    intent: "recovery",
    expectMinResults: 1,
    expectKeywords: ["duplicate", "write-buffer", "rebuild", "재인덱싱"],
    db: "both",
  },

  // ─── abstract-context: 메타 질의 → concrete term top-3 ─────
  {
    query: "요즘 뭐하고 있지",
    description: "추상 질의 — top-3에 프로젝트명/파일명 같은 concrete term이 나와야 다음 쿼리 가능",
    category: "abstract-context",
    intent: "abstract",
    expectMinResults: 3,
    db: "session",
    topK: 3,
  },
  {
    query: "남은 작업 뭐지",
    description: "메타 질의 — next/todo/pending 언급된 세션 상위",
    category: "abstract-context",
    intent: "abstract",
    expectMinResults: 1,
    expectKeywords: ["TODO", "NEXT", "pending", "다음"],
    db: "both",
  },

  // ─── local-magnet: 힣 가든 고유 자석 ───────────────────────
  {
    query: "국제",
    description: "로컬 자석 — 비영리/IB/AIONS 계열이 top-5 내",
    category: "local-magnet",
    intent: "magnet",
    expectMinResults: 3,
    expectKeywords: ["비영리", "IB", "AIONS", "인터내셔널", "바칼로레아"],
    db: "org",
  },
  {
    query: "어쏠로지",
    description: "힣 고유 조어 — 어쏠로지/어쏠로그/어쏠로지스트 계열 생존",
    category: "local-magnet",
    intent: "magnet",
    expectMinResults: 2,
    expectKeywords: ["어쏠로지", "authology", "어쏠로그", "어쏠로지스트"],
    db: "org",
  },

  // ─── hard-negative: 나오면 안 되는 것 ─────────────────────
  {
    query: "존재사건",
    description: "hard-neg — :ARCHIVE:/:LLMLOG:/noembed chunk는 top-10에 없어야",
    category: "hard-negative",
    intent: "concept",
    expectMinResults: 1,
    topKMustNotContain: [":ARCHIVE:", ":LLMLOG:", ":noembed:", "#+filetags:   :llmlog:"],
    db: "org",
    topK: 10,
  },
  {
    query: "피투성",
    description: "hard-neg — archive/llmlog tagged chunks는 나오면 안 됨",
    category: "hard-negative",
    intent: "concept",
    expectMinResults: 1,
    topKMustNotContain: [":ARCHIVE:", ":LLMLOG:"],
    db: "org",
    topK: 10,
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
  category: QueryCategory;
  intent?: QueryIntent;
  db: string;
  expanded: string[];
  resultCount: number;
  topScore: number;
  keywordHit: boolean;
  top1Hit: boolean;
  top1NegClean: boolean;
  topKNegClean: boolean;
  top1NoScaffoldOk: boolean;
  topKScaffoldOk: boolean;
  scaffoldCount: number;    // # scaffold chunks in top-K (diagnostic)
  failReasons: string[];
  pass: boolean;
  topResults: { score: number; text: string; project?: string; scaffold?: boolean }[];
}

interface ProviderPair {
  sessions: EmbeddingProvider | null;
  org: EmbeddingProvider | null;
}

async function runQuery(
  gq: GoldenQuery,
  providers: ProviderPair,
  useExpand: boolean,
  dbFilter?: "session" | "org",
): Promise<QueryResult> {
  const targetDb = dbFilter ?? gq.db;
  const expanded = useExpand ? dictcliExpand(gq.query) : [];
  const enrichedQuery = expanded.length > 0 ? `${gq.query} ${expanded.join(" ")}` : gq.query;
  const bm25Query = expandQueryForBM25(enrichedQuery);

  const allResults: { score: number; text: string; project: string }[] = [];

  // Session DB — sessions provider (e.g. OpenRouter 8B / 4096d)
  if (targetDb === "session" || targetDb === "both") {
    const dbPath = getSessionsDbPath();
    if (fs.existsSync(dbPath) && providers.sessions) {
      const sessP = providers.sessions;
      const sessDim = sessP.dimensions || 2560;
      const store = new VectorStore(dbPath, sessDim);
      await store.init();
      // Dim guard mirrors cli.ts searchSessions: fail-loud on provider/DB
      // mismatch so paid embed calls are never issued against a stale index.
      const dimCheck = await store.checkCompatibleDim();
      if (!dimCheck.ok) {
        await store.close();
        throw new Error(
          `golden sessions dim mismatch: ${dimCheck.reason ?? "incompatible"} (configured=${dimCheck.configured}, actual=${dimCheck.actual}). Run scripts/rebuild-sessions-full.sh or fix ANDENKEN_SESSION_*.`,
        );
      }
      const qv = await sessP.embedQuery(enrichedQuery);
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

  // Org DB — org provider (e.g. vLLM 4B / 2560d)
  if (targetDb === "org" || targetDb === "both") {
    const dbPath = getOrgDbPath();
    if (fs.existsSync(dbPath) && providers.org) {
      const orgP = providers.org;
      const orgDim = orgP.dimensions || 2560;
      const store = new VectorStore(dbPath, orgDim);
      await store.init();
      const dimCheck = await store.checkCompatibleDim();
      if (!dimCheck.ok) {
        await store.close();
        throw new Error(
          `golden org dim mismatch: ${dimCheck.reason ?? "incompatible"} (configured=${dimCheck.configured}, actual=${dimCheck.actual}). Fix ANDENKEN_ORG_* or rebuild org index.`,
        );
      }
      const qv = await orgP.embedQuery(enrichedQuery);
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
  const topK = gq.topK ?? 5;
  const top = allResults.slice(0, topK);

  const failReasons: string[] = [];

  // expectMinResults
  if (top.length < gq.expectMinResults) {
    failReasons.push(`resultCount=${top.length} < expectMin=${gq.expectMinResults}`);
  }

  // expectKeywords: any keyword in top-K joined text (loose)
  let keywordHit = true;
  if (gq.expectKeywords && gq.expectKeywords.length > 0) {
    const allText = top.map((r) => r.text.toLowerCase()).join(" ");
    keywordHit = gq.expectKeywords.some((kw) => allText.includes(kw.toLowerCase()));
    if (!keywordHit) failReasons.push(`no expectKeyword in top-${topK}`);
  }

  // top1MustContain: strict — top-1 must contain one of these
  let top1Hit = true;
  if (gq.top1MustContain && gq.top1MustContain.length > 0) {
    const t1 = (top[0]?.text ?? "").toLowerCase();
    top1Hit = gq.top1MustContain.some((kw) => t1.includes(kw.toLowerCase()));
    if (!top1Hit) failReasons.push(`top1 missing required keyword`);
  }

  // top1MustNotContain: hard negative on top-1 (scaffold heading detection)
  let top1NegClean = true;
  if (gq.top1MustNotContain && gq.top1MustNotContain.length > 0) {
    const t1 = top[0]?.text ?? "";
    const hit = gq.top1MustNotContain.find((kw) => t1.includes(kw));
    if (hit !== undefined) {
      top1NegClean = false;
      failReasons.push(`top1 contains forbidden: "${hit}"`);
    }
  }

  // topKMustNotContain: hard negative anywhere in top-K
  let topKNegClean = true;
  if (gq.topKMustNotContain && gq.topKMustNotContain.length > 0) {
    for (let i = 0; i < top.length; i++) {
      const hit = gq.topKMustNotContain.find((kw) => top[i].text.includes(kw));
      if (hit !== undefined) {
        topKNegClean = false;
        failReasons.push(`top${i + 1} contains forbidden: "${hit}"`);
        break;
      }
    }
  }

  // Scaffold checks (R1)
  const scaffoldFlags = top.map((r) => isScaffoldChunk(r.text));
  const scaffoldCount = scaffoldFlags.filter(Boolean).length;

  let top1NoScaffoldOk = true;
  if (gq.top1NoScaffold) {
    if (scaffoldFlags[0]) {
      top1NoScaffoldOk = false;
      failReasons.push(`top-1 is a scaffold chunk (History/KEYWORDS/Related-Notes)`);
    }
  }

  let topKScaffoldOk = true;
  if (typeof gq.topKScaffoldMax === "number") {
    if (scaffoldCount > gq.topKScaffoldMax) {
      topKScaffoldOk = false;
      failReasons.push(`scaffold density ${scaffoldCount} > max ${gq.topKScaffoldMax} in top-${top.length}`);
    }
  }

  const pass =
    top.length >= gq.expectMinResults &&
    keywordHit &&
    top1Hit &&
    top1NegClean &&
    topKNegClean &&
    top1NoScaffoldOk &&
    topKScaffoldOk;

  return {
    query: gq.query,
    description: gq.description,
    category: gq.category,
    intent: gq.intent,
    db: targetDb,
    expanded,
    resultCount: top.length,
    topScore: top[0]?.score ?? 0,
    keywordHit,
    top1Hit,
    top1NegClean,
    topKNegClean,
    top1NoScaffoldOk,
    topKScaffoldOk,
    scaffoldCount,
    failReasons,
    pass,
    topResults: top.map((r, i) => ({ ...r, scaffold: scaffoldFlags[i] })),
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

  // Sessions and org are dimension-separated tracks. Loading both providers
  // independently is required so each DB is queried with the matching dim.
  // Prior implementation used a single createProviderFromEnv() (legacy 2560d
  // unified slot) which silently dim-mismatched the 4096d sessions index and
  // produced empty results.
  const sessionsProvider = createSessionProviderFromEnv();
  const orgProvider = createOrgProviderFromEnv();

  // Decide which providers are required for the requested scope.
  const wantsSessions = dbFilter === "session" || dbFilter === undefined;
  const wantsOrg = dbFilter === "org" || dbFilter === undefined;
  if (wantsSessions && !sessionsProvider) {
    console.error("❌ Sessions provider unavailable (set ANDENKEN_SESSION_PROVIDER + endpoint/model). Use --db org to skip.");
    process.exit(1);
  }
  if (wantsOrg && !orgProvider) {
    console.error("❌ Org provider unavailable (set ANDENKEN_ORG_* or legacy ANDENKEN_VLLM_*). Use --db session to skip.");
    process.exit(1);
  }

  const providers: ProviderPair = { sessions: sessionsProvider, org: orgProvider };

  if (sessionsProvider) {
    console.log(`📡 Sessions provider: ${sessionsProvider.name} (${sessionsProvider.dimensions}d)`);
  }
  if (orgProvider) {
    console.log(`📡 Org provider:      ${orgProvider.name} (${orgProvider.dimensions}d)`);
  }
  console.log("");

  if (compareMode) {
    // Run each query twice: with/without expand
    console.log("🔍 golden-queries — dictcli expand 비교\n");
    console.log("─".repeat(80));

    let improved = 0;
    let degraded = 0;
    let same = 0;

    for (const gq of GOLDEN_QUERIES) {
      if (dbFilter && gq.db !== dbFilter && gq.db !== "both") continue;

      const without = await runQuery(gq, providers, false, dbFilter);
      const withExp = await runQuery(gq, providers, true, dbFilter);

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
    results.push(await runQuery(gq, providers, !noExpand, dbFilter));
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

  // Group by category
  const byCategory = new Map<QueryCategory, QueryResult[]>();
  for (const r of results) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  for (const [cat, list] of byCategory) {
    const catPass = list.filter((r) => r.pass).length;
    console.log(`\n📂 ${cat} — ${catPass}/${list.length}`);
    for (const r of list) {
      const icon = r.pass ? "✅" : "❌";
      const expandInfo = r.expanded.length > 0 ? ` +[${r.expanded.join(",")}]` : "";
      console.log(`  ${icon} "${r.query}" (${r.db})${expandInfo}`);
      console.log(`     ${r.description}`);
      console.log(`     results=${r.resultCount} topScore=${r.topScore.toFixed(4)}`);
      if (!r.pass) {
        console.log(`     fail: ${r.failReasons.join(" | ")}`);
        if (r.topResults.length > 0) {
          console.log(`     top-1: "${r.topResults[0].text.slice(0, 100).replace(/\n/g, " ")}..."`);
        }
      }
    }
  }

  console.log("\n" + "─".repeat(80));

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
