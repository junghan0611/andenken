#!/usr/bin/env npx tsx
/**
 * andenken golden-queries — 힣의 언어장으로 검색 품질 판단
 *
 * Usage:
 *   source ~/.env.local
 *   npx tsx golden-queries.ts               # 전체 (sessions + md)
 *   npx tsx golden-queries.ts --db md       # md (public garden) DB만
 *   npx tsx golden-queries.ts --db session  # session DB만
 *   npx tsx golden-queries.ts --no-expand   # dictcli expand 없이
 *   npx tsx golden-queries.ts --json        # JSON 출력
 *   npx tsx golden-queries.ts --compare     # expand 전/후 비교
 *
 * Golden queries = 힣의 실제 표현. 범용 벤치마크가 아니라 "내 언어"가 잘 회수되는지 확인.
 * 결과가 어제보다 나빠졌는지 바로 판단 가능해야 한다.
 *
 * TRACKS (2026-07-27) — sessions + md. The org track is RETIRED here: org.lance
 * was last indexed 2026-05-07, `ANDENKEN_ORG_*` is commented out in .env.local,
 * and `createOrgProviderFromEnv()` then falls through to a legacy 768d Gemini
 * provider that dim-mismatches the 2560d org index. That made the DEFAULT run
 * (`./run.sh golden`) abort before executing a single query — the regression
 * gate was dead while still being cited as one. md is the production knowledge
 * axis (`search-md` / `knowledge`), so the garden queries live on md now.
 *
 * The md track calls `searchMdCore()` — the same function `cli.ts search-md`
 * runs. Do not re-implement the pipeline here; that drift is exactly what let
 * the org branch measure parameters (`recencyHalfLifeDays: 90`) no caller used.
 */

import * as fs from "node:fs";
import {
  createSessionProviderFromEnv,
  createMdProviderFromEnv,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { VectorStore, getSessionsDbPath, getMdDbPath } from "./store.js";
import {
  retrieve,
  expandQueryForBM25,
  isScaffoldChunk,
  mdScaffoldRatio,
  type MergeStrategy,
} from "./retriever.js";
import { searchMdCore, dictcliExpand } from "./md-search.js";

// --- Golden Query Fixtures ---
// 힣의 언어장에서 뽑은 쿼리. 각 쿼리에 기대하는 최소 조건을 명시.
//
// Categories (retrieval quality dimensions):
//   sanity              — baseline "can we find anything"
//   intent-definition   — 누구/뭐였지/시작점 — 설명 chunk가 top-1이어야 함
//   operational-recovery — 최근 운영 결정 복원 — session 우선
//   abstract-context    — 메타 질의 → 2단계 검색 hint가 top-3에 나와야
//   local-magnet        — 힣 가든 고유 자석 (국제/어쏠로지 등) 유지
//   sparse-term         — 코퍼스에 몇 건뿐인 고유어 — BM25 신호가 살아남아야
//   diversity           — 한 파일/한 섹션이 top-K를 독점하면 안 됨
//   hard-negative       — 특정 chunk 종류가 top-K에 나오면 안 됨
//
// Intent is used by rankers (R2) to route query-type-sensitive scoring.

type QueryCategory =
  | "sanity"
  | "intent-definition"
  | "operational-recovery"
  | "abstract-context"
  | "local-magnet"
  | "sparse-term"
  | "diversity"
  | "hard-negative";

type QueryIntent = "definition" | "recovery" | "concept" | "magnet" | "abstract";

type TrackId = "session" | "md";
type DbScope = TrackId | "both";

// Scaffold detection is shared with retriever.ts so the eval measures the
// same chunks the ranker damps (org markers), plus md-specific markers that
// the ranker does NOT yet damp (observation-only — see MD_SCAFFOLD_MARKERS).

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
  expectFiles?: string[];       // top-K 파일 경로에 이 중 하나는 있어야 (희소 고유어 정답 고정)
  topKMaxPerFile?: number;      // 같은 파일이 top-K에 이 개수를 넘게 나오면 fail
  top1NoScaffold?: boolean;     // top-1이 SCAFFOLD_MARKERS 중 하나를 포함하면 fail (R1 guard)
  topKScaffoldMax?: number;     // top-K 내 scaffold chunk가 이 값 이하여야 함 (R1 density)
  top1MdScaffoldMax?: number;   // top-1의 md scaffold 비율 상한 (0~1)
  db: DbScope;                  // 어느 DB에서 테스트할지
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
    db: "md",
  },
  {
    query: "설계했다",
    description: "한국어 어간 '설계' — Kiwi stem이 동작해야",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["설계"],
    db: "md",
  },
  {
    query: "존재사건",
    description: "힣 고유 워딩 — Ereignis/존재론",
    category: "sanity",
    expectMinResults: 1,
    expectKeywords: ["존재", "사건", "Ereignis"],
    db: "md",
  },
  {
    query: "뜻새김",
    description: "힣 고유 개념 — semantic/meaning-making",
    category: "sanity",
    expectMinResults: 1,
    db: "md",
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
    db: "md",
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
    db: "md",
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
    db: "md",
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
    db: "md",
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
    db: "md",
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
    db: "md",
  },

  // ─── sparse-term: 코퍼스에 몇 건뿐인 고유어 ────────────────
  // 2026-07-27 실측: "피투성"은 가든 2파일(botlog/20260310T140114,
  // journal/20260323T000000)에만 있고 둘 다 인덱싱되어 있다. FTS는 8건을
  // 정확히 회수하는데 최종 결과에는 한 건도 남지 않았다 — weightedMerge가
  // max 기준 상대 정규화라, 무관한 벡터 결과(코사인 0.69 밴드)가 vecNorm≈1.0
  // 만점을 받아 BM25-only 정답(0.3×0.78≈0.235)을 밀어낸다.
  // 즉 "희소 고유어는 회수 불가"가 md 축의 실제 결함. 여기에 못으로 박는다.
  {
    query: "피투성",
    description: "하이데거 Geworfenheit — 가든 2파일뿐. FTS는 찾는데 merge에서 죽는지 감시",
    category: "sparse-term",
    intent: "concept",
    expectMinResults: 1,
    expectKeywords: ["피투", "Geworfenheit", "던져진"],
    expectFiles: ["20260310T140114", "20260323T000000"],
    db: "md",
  },
  {
    query: "Geworfenheit",
    description: "동일 개념의 원어 표기 — 가든 4파일. 라틴 문자라 FTS 토큰화는 확실",
    category: "sparse-term",
    intent: "concept",
    expectMinResults: 1,
    expectKeywords: ["Geworfenheit", "피투", "하이데거", "Heidegger"],
    expectFiles: [
      "20260310T140114",
      "20260302T191200",
      "20241214T122458",
      "20250413T184954",
    ],
    db: "md",
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
    db: "md",
  },
  {
    query: "어쏠로지",
    description: "힣 고유 조어 — 어쏠로지/어쏠로그/어쏠로지스트 계열 생존",
    category: "local-magnet",
    intent: "magnet",
    expectMinResults: 2,
    expectKeywords: ["어쏠로지", "authology", "어쏠로그", "어쏠로지스트"],
    db: "md",
  },

  // ─── diversity: 한 파일이 top-K를 독점하면 안 됨 ───────────
  // 2026-07-27 실측: "일일일생" top-1/top-2가 같은 파일(notes/20250727T094722)의
  // 인접 chunk였다(1.0863 / 1.0843). MMR이 켜져 있는데도 통과 — 파일 단위가
  // 아니라 chunk 단위 다양성만 보기 때문. 사용자가 보는 화면에서는 같은 노트가
  // 두 줄 차지하는 손실이라 계약으로 박는다.
  {
    query: "일일일생",
    description: "다양성 — 같은 노트가 top-5를 2건 넘게 먹으면 fail",
    category: "diversity",
    intent: "concept",
    expectMinResults: 2,
    topKMaxPerFile: 2,
    db: "md",
  },
  {
    query: "어쏠로지스트 뉴스레터",
    description: "다양성 — 자석 질의에서 한 노트 독점 감시",
    category: "diversity",
    intent: "magnet",
    expectMinResults: 2,
    topKMaxPerFile: 2,
    db: "md",
  },

  // ─── hard-negative: 나오면 안 되는 것 ─────────────────────
  {
    query: "존재사건",
    description: "hard-neg — ARCHIVE/scaffold-only chunk는 top-10에 없어야",
    category: "hard-negative",
    intent: "concept",
    expectMinResults: 1,
    topKMustNotContain: ["## ARCHIVE", ":ARCHIVE:", ":LLMLOG:", ":noembed:"],
    db: "md",
    topK: 10,
  },
  {
    query: "하이데거 존재론",
    description: "hard-neg — top-1이 히스토리/관련메타 덩어리면 fail (md scaffold 비율)",
    category: "hard-negative",
    intent: "concept",
    expectMinResults: 1,
    top1MdScaffoldMax: 0.5,
    db: "md",
    topK: 10,
  },
];

// --- Search ---

interface TopResult {
  score: number;
  text: string;
  file: string;
  project?: string;
  scaffold?: boolean;
  mdScaffold?: number;
}

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
  expectFilesHit: boolean;
  perFileOk: boolean;
  maxPerFile: number;       // largest single-file share of top-K (diagnostic)
  top1NoScaffoldOk: boolean;
  topKScaffoldOk: boolean;
  top1MdScaffoldOk: boolean;
  scaffoldCount: number;    // # org-marker scaffold chunks in top-K (diagnostic)
  mdScaffoldCount: number;  // # md chunks that are >50% scaffold (diagnostic)
  failReasons: string[];
  pass: boolean;
  topResults: TopResult[];
}

/**
 * One opened track. Stores are opened ONCE for the whole run — the previous
 * implementation opened and closed a VectorStore per query, which dominated
 * wall time on the 573MB md index.
 */
interface Track {
  id: TrackId;
  provider: EmbeddingProvider;
  store: VectorStore;
}

type TrackMap = Partial<Record<TrackId, Track>>;

/**
 * Run ONE query against ONE track.
 *
 * A `db: "both"` query is evaluated once per track and reported as two rows,
 * rather than merging both result lists into a single ranking. The tracks emit
 * incomparable scores — sessions run RRF (observed 0.008–0.053) while md runs a
 * weighted merge normalized toward 1.0 (observed 0.94–1.10). Sorting them
 * together let md win every position, so the five "both" queries were silently
 * grading md twice and sessions never. Per-track rows also name which axis
 * regressed instead of hiding it behind one verdict.
 */
async function runQuery(
  gq: GoldenQuery,
  track: Track,
  useExpand: boolean,
): Promise<QueryResult> {
  const topK = gq.topK ?? 5;

  const allResults: TopResult[] = [];
  let expanded: string[] = [];

  if (track.id === "session") {
    // Sessions — RRF + recency decay. Kept inline (not shared with cli.ts)
    // because searchSessions carries stored-signal filters and excerpt logic
    // the eval does not exercise; see NEXT.md for the pending extraction.
    const { provider, store } = track;
    expanded = useExpand ? dictcliExpand(gq.query) : [];
    const enrichedQuery =
      expanded.length > 0 ? `${gq.query} ${expanded.join(" ")}` : gq.query;

    const qv = await provider.embedQuery(enrichedQuery);
    const vec = await store.search(qv, 20);
    const fts = await store.fullTextSearch(expandQueryForBM25(enrichedQuery), 20);
    const results = await retrieve(gq.query, vec, fts, {
      vectorWeight: 0.7, bm25Weight: 0.3,
      // Must track production (cli.ts:255, index.ts:571), which is 0. A 14-day
      // half-life multiplies score by exp(-ln2*age/14): a 5-month-old hit lands
      // at ~2^-10 and falls under minScore, so the gate DELETED old sessions and
      // then failed queries for "returning nothing". The decay was removed from
      // production on 2026-09-02; this inline copy kept it, which is exactly the
      // divergence the header comment at :27 warns about and the md branch below
      // avoids by calling searchMdCore. Extract this branch and the copy dies.
      recencyHalfLifeDays: 0, minScore: 0.001,
      mergeStrategy: "rrf" as MergeStrategy,
      mmr: { enabled: false, lambda: 0.7 },
    });
    allResults.push(...results.slice(0, topK).map((r) => ({
      score: r.score, text: r.text.slice(0, 500),
      file: r.sessionFile, project: r.project,
    })));
  } else {
    // md — production knowledge axis. Runs the SAME core as `cli.ts search-md`
    // so a tuning change there cannot silently pass this gate.
    const { provider, store } = track;
    const outcome = await searchMdCore(store, provider, gq.query, topK, {
      expand: useExpand,
    });
    expanded = outcome.expanded;
    allResults.push(...outcome.results.map((r) => ({
      score: r.score, text: r.text.slice(0, 500),
      file: r.sessionFile, project: r.project,
    })));
  }

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

  // expectFiles: the known-correct note must survive ranking. Matched on path
  // substring so a Denote ID alone is enough to pin the answer.
  let expectFilesHit = true;
  if (gq.expectFiles && gq.expectFiles.length > 0) {
    expectFilesHit = gq.expectFiles.some((f) =>
      top.some((r) => r.file.includes(f)),
    );
    if (!expectFilesHit) {
      failReasons.push(`no expected file in top-${topK} (want one of ${gq.expectFiles.join(", ")})`);
    }
  }

  // topKMaxPerFile: file-level diversity. MMR dedups chunks, not notes.
  const perFile = new Map<string, number>();
  for (const r of top) perFile.set(r.file, (perFile.get(r.file) ?? 0) + 1);
  const maxPerFile = perFile.size > 0 ? Math.max(...perFile.values()) : 0;
  let perFileOk = true;
  if (typeof gq.topKMaxPerFile === "number" && maxPerFile > gq.topKMaxPerFile) {
    perFileOk = false;
    const worst = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0];
    failReasons.push(
      `one file takes ${maxPerFile}/${top.length} of top-K (max ${gq.topKMaxPerFile}): ${worst[0].split("/").pop()}`,
    );
  }

  // Scaffold checks (R1) — org markers, the ones the ranker actually damps.
  const scaffoldFlags = top.map((r) => isScaffoldChunk(r.text));
  const scaffoldCount = scaffoldFlags.filter(Boolean).length;

  // md scaffold ratios — observation-only today (ranker does not damp these).
  const mdRatios = top.map((r) => mdScaffoldRatio(r.text));
  const mdScaffoldCount = mdRatios.filter((x) => x > 0.5).length;

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

  let top1MdScaffoldOk = true;
  if (typeof gq.top1MdScaffoldMax === "number") {
    const r1 = mdRatios[0] ?? 0;
    if (r1 > gq.top1MdScaffoldMax) {
      top1MdScaffoldOk = false;
      failReasons.push(
        `top-1 is ${(r1 * 100).toFixed(0)}% md scaffold (히스토리/관련메타), max ${(gq.top1MdScaffoldMax * 100).toFixed(0)}%`,
      );
    }
  }

  const pass =
    top.length >= gq.expectMinResults &&
    keywordHit &&
    top1Hit &&
    top1NegClean &&
    topKNegClean &&
    expectFilesHit &&
    perFileOk &&
    top1NoScaffoldOk &&
    topKScaffoldOk &&
    top1MdScaffoldOk;

  return {
    query: gq.query,
    description: gq.description,
    category: gq.category,
    intent: gq.intent,
    db: track.id,
    expanded,
    resultCount: top.length,
    topScore: top[0]?.score ?? 0,
    keywordHit,
    top1Hit,
    top1NegClean,
    topKNegClean,
    expectFilesHit,
    perFileOk,
    maxPerFile,
    top1NoScaffoldOk,
    topKScaffoldOk,
    top1MdScaffoldOk,
    scaffoldCount,
    mdScaffoldCount,
    failReasons,
    pass,
    topResults: top.map((r, i) => ({
      ...r,
      scaffold: scaffoldFlags[i],
      mdScaffold: Number(mdRatios[i].toFixed(2)),
    })),
  };
}

// --- Track setup ---

/**
 * Open only the tracks the requested scope needs.
 *
 * Eager creation was a real trap: the previous version built BOTH providers
 * unconditionally and printed whatever it got, so `--db session` announced a
 * "📡 Org provider: gemini (768d)" that no query ever used, and the default
 * scope died on a dim mismatch against a retired index before running.
 */
async function openTrack(id: TrackId): Promise<Track> {
  const provider =
    id === "session" ? createSessionProviderFromEnv() : createMdProviderFromEnv();
  if (!provider) {
    const ns = id === "session" ? "ANDENKEN_SESSION_*" : "ANDENKEN_MD_*";
    const other = id === "session" ? "md" : "session";
    throw new Error(
      `${id} provider unavailable — set ${ns} (PROVIDER + ENDPOINT/MODEL/API_KEY). Use --db ${other} to skip.`,
    );
  }

  const dbPath = id === "session" ? getSessionsDbPath() : getMdDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `${id} index missing at ${dbPath}. Run ./run.sh index:${id === "session" ? "sessions" : "md"}.`,
    );
  }

  const store = new VectorStore(dbPath, provider.dimensions || 4096);
  await store.init();

  // Dim guard mirrors cli.ts: fail loud on provider/DB mismatch so paid embed
  // calls are never issued against a stale index.
  const dimCheck = await store.checkCompatibleDim();
  if (!dimCheck.ok) {
    await store.close();
    throw new Error(
      `golden ${id} dim mismatch: ${dimCheck.reason ?? "incompatible"} (configured=${dimCheck.configured}, actual=${dimCheck.actual}).`,
    );
  }

  return { id, provider, store };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const compareMode = args.includes("--compare");
  const noExpand = args.includes("--no-expand");
  const dbIdx = args.indexOf("--db");
  const dbRaw = dbIdx >= 0 ? args[dbIdx + 1] : undefined;

  if (dbRaw !== undefined && dbRaw !== "session" && dbRaw !== "md") {
    console.error(
      `❌ --db must be "session" or "md" (got "${dbRaw}"). The org track is retired — see the header comment.`,
    );
    process.exit(1);
  }
  const dbFilter = dbRaw as TrackId | undefined;

  const needed: TrackId[] =
    dbFilter !== undefined ? [dbFilter] : ["session", "md"];

  const tracks: TrackMap = {};
  try {
    for (const id of needed) {
      tracks[id] = await openTrack(id);
      const t = tracks[id]!;
      const label = id === "session" ? "Sessions" : "md (garden)";
      console.log(`📡 ${label.padEnd(12)} ${t.provider.name} (${t.provider.dimensions}d)`);
    }
    console.log("");

    await runAll(tracks, { jsonMode, compareMode, noExpand, dbFilter });
  } finally {
    for (const t of Object.values(tracks)) {
      if (t) await t.store.close();
    }
  }
}

interface RunOptions {
  jsonMode: boolean;
  compareMode: boolean;
  noExpand: boolean;
  dbFilter?: TrackId;
}

/**
 * Which tracks this query runs on, honouring `--db`.
 *
 * A `both` query yields one run per opened track; anything the scope excludes
 * is dropped so `--db md` never reports a session row it did not measure.
 */
function tracksFor(
  gq: GoldenQuery,
  tracks: TrackMap,
  dbFilter?: TrackId,
): Track[] {
  const want: TrackId[] = gq.db === "both" ? ["session", "md"] : [gq.db];
  return want
    .filter((id) => (dbFilter ? id === dbFilter : true))
    .map((id) => tracks[id])
    .filter((t): t is Track => t !== undefined);
}

async function runAll(tracks: TrackMap, opts: RunOptions) {
  const { jsonMode, compareMode, noExpand, dbFilter } = opts;
  const plan: { gq: GoldenQuery; track: Track }[] = [];
  for (const gq of GOLDEN_QUERIES) {
    for (const track of tracksFor(gq, tracks, dbFilter)) {
      plan.push({ gq, track });
    }
  }

  if (compareMode) {
    // Run each query twice: with/without expand
    console.log("🔍 golden-queries — dictcli expand 비교\n");
    console.log("─".repeat(80));

    let improved = 0;
    let degraded = 0;
    let same = 0;

    for (const { gq, track } of plan) {
      const without = await runQuery(gq, track, false);
      const withExp = await runQuery(gq, track, true);

      const scoreDiff = withExp.topScore - without.topScore;
      const icon = scoreDiff > 0.01 ? "📈" : scoreDiff < -0.01 ? "📉" : "➡️";
      if (scoreDiff > 0.01) improved++;
      else if (scoreDiff < -0.01) degraded++;
      else same++;

      console.log(`  ${icon} "${gq.query}" (${track.id})`);
      console.log(`     without: score=${without.topScore.toFixed(4)} results=${without.resultCount}`);
      console.log(`     with:    score=${withExp.topScore.toFixed(4)} results=${withExp.resultCount} expanded=[${withExp.expanded.join(",")}]`);
    }

    console.log("─".repeat(80));
    console.log(`  📈 improved: ${improved}  ➡️ same: ${same}  📉 degraded: ${degraded}\n`);
    return;
  }

  // Normal mode
  const results: QueryResult[] = [];
  for (const { gq, track } of plan) {
    results.push(await runQuery(gq, track, !noExpand));
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Pretty output
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  // Per-track tally: a single number hides which axis regressed, and the two
  // tracks fail for entirely different reasons (session corpus policy vs md
  // ranking). Rows are per (query, track), so these sum to the total.
  const perTrack = (["session", "md"] as TrackId[])
    .map((id) => {
      const rows = results.filter((r) => r.db === id);
      return rows.length > 0
        ? `${id} ${rows.filter((r) => r.pass).length}/${rows.length}`
        : null;
    })
    .filter((s): s is string => s !== null)
    .join("  ·  ");

  console.log(`\n🔍 golden-queries — ${passed}/${total} passed   (${perTrack})\n`);
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
      console.log(
        `     results=${r.resultCount} topScore=${r.topScore.toFixed(4)}` +
        ` maxPerFile=${r.maxPerFile} mdScaffold=${r.mdScaffoldCount}/${r.resultCount}`,
      );
      if (!r.pass) {
        console.log(`     fail: ${r.failReasons.join(" | ")}`);
        if (r.topResults.length > 0) {
          const t1 = r.topResults[0];
          console.log(`     top-1: [${t1.file.split("/").pop()}] "${t1.text.slice(0, 90).replace(/\n/g, " ")}..."`);
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
