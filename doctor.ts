#!/usr/bin/env npx tsx
/**
 * andenken doctor — 운영 상태 한 화면 진단
 *
 * Usage:
 *   npx tsx doctor.ts
 *   npx tsx doctor.ts --json
 *
 * Checks:
 *   1. API health (vLLM embedding endpoint; Gemini fallback if configured)
 *   2. Local session/org DB status (+ dim parity vs provider)
 *   3. Oracle session/org DB status (SSH)
 *   4. Stale files (unindexed)
 *   5. Cost pre-flight (org incremental estimate)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { VectorStore, getSessionsDbPath, getOrgDbPath } from "./store.js";
import { findSessionFiles } from "./session-indexer.js";
import { findOrgFiles, shouldIndexOrgFile } from "./org-chunker.js";
import { createProviderFromEnv } from "./embedding-provider.js";

// --- Types ---

type Status = "OK" | "WARN" | "FAIL" | "SKIP";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  value?: string | number;
}

// --- Config ---

const ORACLE_HOST = "oracle";
const ANDENKEN_DIR = path.join(process.env.HOME ?? "", "repos", "gh", "andenken");
// --- Helpers ---

function runSSH(cmd: string, timeout = 10000): string | null {
  try {
    return execSync(`ssh ${ORACLE_HOST} "${cmd}"`, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function getDevice(): string {
  try {
    return fs.readFileSync(path.join(process.env.HOME ?? "", ".current-device"), "utf-8").trim();
  } catch {
    return "unknown";
  }
}

function getKST(): string {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

// --- Checks ---

async function checkAPI(): Promise<CheckResult> {
  // Use createProviderFromEnv() so auth (including ~/.env.local $VAR expansion) is handled identically to production.
  const provider = createProviderFromEnv();
  if (!provider) {
    return { name: "API", status: "WARN", detail: "no provider configured (set ANDENKEN_PROVIDER=vllm + env vars)" };
  }
  try {
    const [vec] = await provider.embedBatch(["ping"]);
    const dim = vec?.length ?? 0;
    const label = provider.constructor.name.replace("Provider", "");
    return { name: label, status: "OK", detail: `responding, dim=${dim}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const label = provider.constructor.name.replace("Provider", "");
    return { name: label, status: "FAIL", detail: msg.slice(0, 120) };
  }
}

async function checkLocalDB(label: string, dbPath: string, providerDim?: number): Promise<CheckResult> {
  if (!fs.existsSync(dbPath)) {
    return { name: `Local ${label}`, status: "WARN", detail: "DB not found", value: 0 };
  }

  try {
    const store = new VectorStore(dbPath);
    await store.init();
    const count = await store.getCount();
    const files = await store.getIndexedFiles();
    const actualDim = await store.getActualVectorDim();
    await store.close();
    const dimStr = actualDim ? `${actualDim}d` : "empty";
    const mismatch = actualDim && providerDim && actualDim !== providerDim;
    const base = `${count.toLocaleString()} chunks, ${files.size} files, ${dimStr}`;
    return {
      name: `Local ${label}`,
      status: mismatch ? "WARN" : count > 0 ? "OK" : "WARN",
      detail: mismatch
        ? `${base}  ⚠ provider=${providerDim}d (FTS-only fallback)`
        : base,
      value: count,
    };
  } catch (e) {
    return { name: `Local ${label}`, status: "FAIL", detail: String(e).slice(0, 100) };
  }
}

function checkOracleDB(label: string): CheckResult {
  // Oracle uses same andenken path structure
  const cmd = label === "Sessions"
    ? `cd ~/repos/gh/andenken && source ~/.env.local && npx tsx cli.ts status 2>/dev/null`
    : `ls -la ~/repos/gh/andenken/data/org-lancedb/ 2>/dev/null | head -3`;

  const result = runSSH(cmd);
  if (result === null) {
    return { name: `Oracle ${label}`, status: "FAIL", detail: "SSH connection failed" };
  }

  try {
    if (label === "Sessions") {
      const data = JSON.parse(result);
      const sc = data.sessions?.chunks ?? 0;
      const sf = data.sessions?.indexed_files ?? 0;
      const oc = data.knowledge?.chunks ?? 0;
      return {
        name: "Oracle",
        status: sc > 0 ? "OK" : "WARN",
        detail: `sessions: ${sc} chunks/${sf} files, knowledge: ${oc} chunks`,
        value: sc,
      };
    }
  } catch {
    // non-JSON output
  }

  return {
    name: `Oracle ${label}`,
    status: result.length > 0 ? "OK" : "WARN",
    detail: result.slice(0, 120),
  };
}

async function checkStaleFiles(): Promise<CheckResult> {
  // Sessions
  const sessionDbPath = getSessionsDbPath();
  const allSessions = findSessionFiles().length;
  let indexedSessions = 0;

  if (fs.existsSync(sessionDbPath)) {
    try {
      const store = new VectorStore(sessionDbPath);
      await store.init();
      indexedSessions = (await store.getIndexedFiles()).size;
      await store.close();
    } catch { /* */ }
  }

  const staleSessions = allSessions - indexedSessions;

  // Org
  const orgDbPath = getOrgDbPath();
  const allOrg = findOrgFiles().filter((f) => shouldIndexOrgFile(f));
  let indexedOrg = 0;

  if (fs.existsSync(orgDbPath)) {
    try {
      const store = new VectorStore(orgDbPath);
      await store.init();
      indexedOrg = (await store.getIndexedFiles()).size;
      await store.close();
    } catch { /* */ }
  }

  const staleOrg = allOrg.length - indexedOrg;
  const totalStale = staleSessions + staleOrg;

  const status: Status = totalStale > 100 ? "WARN" : totalStale > 0 ? "OK" : "OK";
  return {
    name: "Stale files",
    status,
    detail: `sessions: ${staleSessions} unindexed/${allSessions} total, org: ${staleOrg} unindexed/${allOrg.length} total`,
    value: totalStale,
  };
}

function checkCostPreflight(): CheckResult {
  // Quick org estimate without full chunk computation
  const allOrg = findOrgFiles().filter((f) => shouldIndexOrgFile(f));

  // Rough estimate: avg 3 chunks/file, 800 chars/chunk, 4 chars/token, $0.20/1M tokens
  const estChunks = allOrg.length * 3;
  const estTokens = (estChunks * 800) / 4;
  const estUSD = (estTokens / 1_000_000) * 0.20;
  const estKRW = Math.round(estUSD * 1450);

  const status: Status = estKRW > 50000 ? "WARN" : "OK";
  return {
    name: "Cost (full reindex)",
    status,
    detail: `~${estChunks.toLocaleString()} chunks, ~$${estUSD.toFixed(2)} (₩${estKRW.toLocaleString()})`,
    value: estKRW,
  };
}

// --- Main ---

async function main() {
  const jsonMode = process.argv.includes("--json");
  const device = getDevice();
  const time = getKST();

  const checks: CheckResult[] = [];

  // 1. API
  checks.push(await checkAPI());

  // 2. Local DBs — pass active provider dim for parity check
  const provider = createProviderFromEnv();
  const providerDim = provider?.dimensions;
  checks.push(await checkLocalDB("Sessions", getSessionsDbPath(), providerDim));
  checks.push(await checkLocalDB("Knowledge", getOrgDbPath(), providerDim));

  // 3. Oracle (single SSH call)
  checks.push(checkOracleDB("Sessions"));

  // 4. Stale files
  checks.push(await checkStaleFiles());

  // 5. Cost pre-flight
  checks.push(checkCostPreflight());

  if (jsonMode) {
    console.log(JSON.stringify({ device, time, checks }, null, 2));
    return;
  }

  // Pretty output
  const statusIcon = { OK: "✅", WARN: "⚠️", FAIL: "❌", SKIP: "⏭️" };

  console.log(`\n🩺 andenken doctor`);
  console.log(`   device: ${device}  |  ${time}`);
  console.log("─".repeat(60));

  let hasWarn = false;
  let hasFail = false;

  for (const c of checks) {
    const icon = statusIcon[c.status];
    console.log(`  ${icon} ${c.name.padEnd(20)} ${c.detail}`);
    if (c.status === "WARN") hasWarn = true;
    if (c.status === "FAIL") hasFail = true;
  }

  console.log("─".repeat(60));

  if (hasFail) {
    console.log("  ❌ FAIL — 수정 필요");
  } else if (hasWarn) {
    console.log("  ⚠️  WARN — 확인 필요");
  } else {
    console.log("  ✅ ALL OK — sync 가능");
  }

  console.log();
}

main().catch((err) => {
  console.error(`❌ doctor failed: ${err}`);
  process.exit(1);
});
