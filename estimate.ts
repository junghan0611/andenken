#!/usr/bin/env npx tsx
/**
 * Cost Estimator — dry-run that counts chunks and estimates Gemini API cost
 *
 * Usage:
 *   npx tsx estimate.ts org
 *   npx tsx estimate.ts sessions
 *   npx tsx estimate.ts all
 *
 * Shows: files, chunks, chars, tokens, estimated cost
 * No API calls — pure local computation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findOrgFiles, chunkOrgFile, shouldIndexOrgFile } from "./org-chunker.js";
import { findSessionFiles, extractSessionChunks } from "./session-indexer.js";

// --- Gemini Embedding Pricing (2026-03 확인) ---
// Source: https://tokencost.app/blog/gemini-embedding-2-pricing
// Model: gemini-embedding-2-preview
// Text: $0.20 per 1M input tokens (Paid tier)
// Free tier: 1,500 RPM / 500 RPD — $0 (속도 제한만)
// 차원(768/3072): 비용 동일 (입력 토큰만 과금)

const PRICE_PER_1M_TOKENS = 0.20; // USD — gemini-embedding-2-preview (Paid tier)
const USD_TO_KRW = 1450;
const CHARS_PER_TOKEN = 4; // Korean ≈ 2-3, English ≈ 4, 혼합 ≈ 4 (보수적)

interface EstimateResult {
  label: string;
  files: number;
  chunks: number;
  totalChars: number;
  avgChars: number;
  minChars: number;
  maxChars: number;
  estimatedTokens: number;
  costUSD: number;
  costKRW: number;
  apiCalls: number; // batch API calls (100 per call)
}

function estimateOrg(): EstimateResult {
  const allOrg = findOrgFiles();
  const orgFiles = allOrg.filter((f) => shouldIndexOrgFile(f));

  let chunks = 0;
  let totalChars = 0;
  let maxChars = 0;
  let minChars = Infinity;

  for (const f of orgFiles) {
    const content = fs.readFileSync(f, "utf-8");
    const fileChunks = chunkOrgFile(content, f);
    for (const c of fileChunks) {
      chunks++;
      const len = c.text.length;
      totalChars += len;
      if (len > maxChars) maxChars = len;
      if (len < minChars) minChars = len;
    }
  }

  const estimatedTokens = Math.round(totalChars / CHARS_PER_TOKEN);
  const costUSD = (estimatedTokens / 1_000_000) * PRICE_PER_1M_TOKENS;
  const apiCalls = Math.ceil(chunks / 100); // batchEmbedContents: 100 per request

  return {
    label: "Org",
    files: orgFiles.length,
    chunks,
    totalChars,
    avgChars: chunks > 0 ? Math.round(totalChars / chunks) : 0,
    minChars: chunks > 0 ? minChars : 0,
    maxChars,
    estimatedTokens,
    costUSD,
    costKRW: Math.round(costUSD * USD_TO_KRW),
    apiCalls,
  };
}

async function estimateSessions(): Promise<EstimateResult> {
  const sessFiles = findSessionFiles();

  let chunks = 0;
  let totalChars = 0;
  let maxChars = 0;
  let minChars = Infinity;

  for (const f of sessFiles) {
    const fileChunks = await extractSessionChunks(f);
    for (const c of fileChunks) {
      chunks++;
      const len = c.text.length;
      totalChars += len;
      if (len > maxChars) maxChars = len;
      if (len < minChars) minChars = len;
    }
  }

  const estimatedTokens = Math.round(totalChars / CHARS_PER_TOKEN);
  const costUSD = (estimatedTokens / 1_000_000) * PRICE_PER_1M_TOKENS;
  const apiCalls = Math.ceil(chunks / 100);

  return {
    label: "Sessions",
    files: sessFiles.length,
    chunks,
    totalChars,
    avgChars: chunks > 0 ? Math.round(totalChars / chunks) : 0,
    minChars: chunks > 0 ? minChars : 0,
    maxChars,
    estimatedTokens,
    costUSD,
    costKRW: Math.round(costUSD * USD_TO_KRW),
    apiCalls,
  };
}

function printEstimate(est: EstimateResult) {
  console.log(`\n📊 ${est.label} Estimate`);
  console.log("─".repeat(50));
  console.log(`  Files:          ${est.files.toLocaleString()}`);
  console.log(`  Chunks:         ${est.chunks.toLocaleString()}`);
  console.log(`  Total chars:    ${est.totalChars.toLocaleString()}`);
  console.log(`  Avg chars/chunk:${est.avgChars.toLocaleString()}`);
  console.log(`  Min/Max chars:  ${est.minChars.toLocaleString()} / ${est.maxChars.toLocaleString()}`);
  console.log(`  Est. tokens:    ${est.estimatedTokens.toLocaleString()}`);
  console.log(`  API calls:      ${est.apiCalls.toLocaleString()} (batch 100/call)`);
  console.log(`  ─── Cost (1회 --force, Paid tier) ───`);
  console.log(`  USD:            $${est.costUSD.toFixed(2)}`);
  console.log(`  KRW:            ₩${est.costKRW.toLocaleString()}`);
  console.log(`  ─── Free tier ───`);
  console.log(`  USD:            $0 (RPD 500 제한)`);
  console.log(`  소요 시간 추정:  ${Math.ceil(est.apiCalls / 500)}일 (500 RPD 기준)`);
}

function printFormula() {
  console.log(`\n📐 비용 공식 (gemini-embedding-2-preview)`);
  console.log("─".repeat(50));
  console.log(`  tokens = totalChars / ${CHARS_PER_TOKEN}`);
  console.log(`  cost   = tokens / 1,000,000 × $${PRICE_PER_1M_TOKENS}`);
  console.log(`  환율: $1 = ₩${USD_TO_KRW}`);
  console.log(`\n📋 과금 구조:`);
  console.log(`  차원(768/3072):  비용 동일 (입력 토큰만 과금)`);
  console.log(`  dictcli stem:    로컬 JVM — API 비용 0원`);
  console.log(`  enrichedText:    FTS에만 저장, 임베딩엔 원본 사용`);
  console.log(`  검색 쿼리 1회:   ~100 tokens = $0.00002 (₩0.03)`);
  console.log(`  하루 50회 검색:  $0.001 (₩1.5) — 무시할 수준`);
  console.log(`\n⚠️  실제 과금은 Google AI 콘솔에서 확인:`);
  console.log(`   https://aistudio.google.com/apikey (usage)`);
  console.log(`\n🔑 Free vs Paid tier:`);
  console.log(`   Free: $0 — RPD 500, RPM 1500 제한`);
  console.log(`   Paid: $0.20/1M tokens — 제한 완화, 전액 과금`);
  console.log(`   → API 키 생성 시 "Pay as you go" 선택하면 Paid!`);
  console.log(`   → Free tier만 쓰려면 billing 비활성화 확인!`);
  console.log(`\n💡 비용 절감 방안:`);
  console.log(`   1. Free tier 사용 (속도만 느림, 비용 $0)`);
  console.log(`   2. --force 대신 incremental (mtime manifest)`);
  console.log(`   3. 로컬에서 1회 빌드 → oracle에 rsync`);
  console.log(`   4. 대안: OpenAI text-embedding-3-small $0.02/1M (10배 저렴)`);
}

// --- Main ---

const target = process.argv[2] ?? "all";

if (target === "org" || target === "all") {
  const orgEst = estimateOrg();
  printEstimate(orgEst);
}

if (target === "sessions" || target === "all") {
  const sessEst = await estimateSessions();
  printEstimate(sessEst);
}

if (target === "all") {
  const orgEst = estimateOrg();
  const sessEst = await estimateSessions();
  const totalUSD = orgEst.costUSD + sessEst.costUSD;
  const totalKRW = Math.round(totalUSD * USD_TO_KRW);
  console.log(`\n💰 Total (1회 --force, Paid tier)`);
  console.log("─".repeat(50));
  console.log(`  USD: $${totalUSD.toFixed(2)}`);
  console.log(`  KRW: ₩${totalKRW.toLocaleString()}`);
  console.log(`  × 2회 (로컬+oracle) = ₩${(totalKRW * 2).toLocaleString()}`);
  console.log(`\n  ⚠️  Free tier면: $0 (${Math.ceil((orgEst.apiCalls + sessEst.apiCalls) / 500)}일 소요)`);
  console.log(`  💸 Paid tier면: 위 금액 전액 과금`);
}

printFormula();
