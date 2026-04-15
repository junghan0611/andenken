#!/usr/bin/env npx tsx
/**
 * Embedding Provider Test Suite
 *
 * Usage:
 *   source ~/.env.local
 *   npx tsx test-provider.ts                    # all tests
 *   npx tsx test-provider.ts unit               # unit only (no API)
 *   npx tsx test-provider.ts gemini             # Gemini provider integration
 *   npx tsx test-provider.ts vllm               # vLLM provider integration
 *   npx tsx test-provider.ts vllm http://gpu2i:8000 model-name  # custom endpoint
 *
 * Environment:
 *   GEMINI_API_KEY — for Gemini tests
 *   ANDENKEN_PROVIDER=vllm — for vLLM tests
 *   ANDENKEN_VLLM_ENDPOINT=http://gpu2i:8000
 *   ANDENKEN_VLLM_MODEL=Qwen/Qwen3-Embedding-8B
 */

import {
  GeminiProvider,
  VLLMProvider,
  createProvider,
  createProviderFromEnv,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { getModelPreset, listPresets } from "./model-presets.js";

// --- Test Framework ---

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

function skip(msg: string) {
  skipped++;
  console.log(`  ⏭  ${msg}`);
}

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// --- Unit Tests ---

async function testFactory() {
  section("Provider Factory (unit)");

  // Gemini creation
  try {
    const g = createProvider({ type: "gemini", apiKey: "test-key" });
    assert(g.name === "gemini", `Gemini provider name: ${g.name}`);
    assert(g.dimensions === 768, `Gemini dimensions: ${g.dimensions}`);
  } catch (err) {
    assert(false, `Gemini creation failed: ${err}`);
  }

  // Gemini without key
  try {
    createProvider({ type: "gemini" });
    assert(false, "Should throw without apiKey");
  } catch {
    assert(true, "Throws without apiKey");
  }

  // vLLM creation
  try {
    const v = createProvider({
      type: "vllm",
      vllmEndpoint: "http://localhost:8000",
      vllmModel: "test-model",
      vllmDimensions: 1024,
    });
    assert(v.name === "vllm", `vLLM provider name: ${v.name}`);
    assert(v.dimensions === 1024, `vLLM dimensions: ${v.dimensions}`);
  } catch (err) {
    assert(false, `vLLM creation failed: ${err}`);
  }

  // vLLM without endpoint
  try {
    createProvider({ type: "vllm", vllmModel: "test" });
    assert(false, "Should throw without endpoint");
  } catch {
    assert(true, "Throws without vllmEndpoint");
  }

  // vLLM without model
  try {
    createProvider({ type: "vllm", vllmEndpoint: "http://localhost:8000" });
    assert(false, "Should throw without model");
  } catch {
    assert(true, "Throws without vllmModel");
  }

  // vLLM auto-detect dimensions (0 initially)
  const v0 = createProvider({
    type: "vllm",
    vllmEndpoint: "http://localhost:8000",
    vllmModel: "test-model",
  });
  assert(v0.dimensions === 0, `vLLM no-dim: dimensions=${v0.dimensions} (auto-detect pending)`);

  // createProviderFromEnv with no env
  // Note: loadGeminiKey() also reads ~/.env.local as fallback,
  // so if that file exists, it won't return null.
  // We test the env-only path by temporarily setting HOME to a non-existent dir.
  const keysToSave = ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANDENKEN_PROVIDER", "HOME"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keysToSave) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.HOME = "/nonexistent-home-for-test";
  const nullProvider = createProviderFromEnv();
  assert(nullProvider === null, "No env + no ~/.env.local → null provider");
  for (const k of keysToSave) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
}

async function testProviderInterface() {
  section("Provider Interface (unit)");

  // Stats tracking
  const v = createProvider({
    type: "vllm",
    vllmEndpoint: "http://localhost:9999", // won't connect, just testing interface
    vllmModel: "test",
    vllmDimensions: 512,
  });

  const stats = v.getStats();
  assert(stats.calls === 0, `Initial calls: ${stats.calls}`);
  assert(stats.estimatedTokens === 0, `Initial tokens: ${stats.estimatedTokens}`);
  assert(stats.estimatedCostUSD === 0, `vLLM cost: $${stats.estimatedCostUSD}`);

  v.resetStats();
  assert(v.getStats().calls === 0, "Stats reset works");

  // Instruction prefix
  const vi = createProvider({
    type: "vllm",
    vllmEndpoint: "http://localhost:9999",
    vllmModel: "test",
    vllmDimensions: 512,
    vllmQueryInstruction: "Instruct: Retrieve\nQuery: ",
    vllmDocumentInstruction: "",
  }) as VLLMProvider;
  assert(vi.name === "vllm", "Instruction provider created");
}

async function testVLLMErrorHandling() {
  section("vLLM Error Handling (unit)");

  // Connection refused
  const refused = new VLLMProvider({
    endpoint: "http://localhost:1",
    model: "test",
    dimensions: 512,
  });
  try {
    await refused.embedQuery("test");
    assert(false, "Should throw on connection refused");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes("unreachable") || msg.includes("ECONNREFUSED"), `Connection refused error: ${msg.slice(0, 80)}`);
  }

  // Host not found
  const notfound = new VLLMProvider({
    endpoint: "http://nonexistent-host-12345.local:8000",
    model: "test",
    dimensions: 512,
  });
  try {
    await notfound.embedQuery("test");
    assert(false, "Should throw on host not found");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      msg.includes("not found") || msg.includes("ENOTFOUND") || msg.includes("unreachable"),
      `Host not found error: ${msg.slice(0, 80)}`,
    );
  }

  // Health check on dead endpoint
  const health = await refused.healthCheck();
  assert(!health.ok, `Health check dead endpoint: ok=${health.ok}`);
  assert(typeof health.error === "string", `Health check error: ${health.error}`);

  // 4xx should NOT retry (verify by timing — 3 retries would take 6s+)
  const start = Date.now();
  const badModel = new VLLMProvider({
    endpoint: "http://localhost:18000", // real endpoint but wrong model name
    model: "nonexistent-model-xyz",
    dimensions: 512,
  });
  try {
    await badModel.embedQuery("test");
    // If endpoint is not running, skip this test gracefully
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.includes("does not exist")) {
      assert(elapsed < 3000, `4xx non-retryable: ${elapsed}ms (should be < 3s, no retries)`);
    }
    // Connection refused = endpoint not running, that's ok for this test
  }
}

async function testModelPresets() {
  section("Model Presets (unit)");

  // Exact match
  const q4 = getModelPreset("Qwen/Qwen3-Embedding-4B");
  assert(q4 !== null, "Exact match: Qwen3-Embedding-4B");
  assert(q4!.dimensions === 2560, `4B dimensions: ${q4!.dimensions}`);
  assert(q4!.queryInstruction.includes("Instruct:"), "4B has query instruction");
  assert(q4!.documentInstruction === "", "4B document instruction is empty");

  // bge-m3
  const bge = getModelPreset("BAAI/bge-m3");
  assert(bge !== null, "Exact match: bge-m3");
  assert(bge!.dimensions === 1024, `bge-m3 dimensions: ${bge!.dimensions}`);
  assert(bge!.queryInstruction === "", "bge-m3 has no query instruction");

  // Path match: /storage/models/vllm/Qwen3-Embedding-4B → Qwen/Qwen3-Embedding-4B
  const pathMatch = getModelPreset("/storage/models/vllm/Qwen3-Embedding-4B");
  assert(pathMatch !== null, "Path match: Qwen3-Embedding-4B from path");
  assert(pathMatch!.dimensions === 2560, `Path match dimensions: ${pathMatch!.dimensions}`);

  // Variant match
  const memory = getModelPreset("Qwen/Qwen3-Embedding-4B:memory");
  assert(memory !== null, "Variant match: 4B:memory");
  assert(memory!.queryInstruction.includes("memory retrieval"), "Memory instruction");

  // Unknown model
  const unknown = getModelPreset("some/unknown-model");
  assert(unknown === null, "Unknown model returns null");

  // List presets
  const presets = listPresets();
  assert(presets.length >= 5, `Listed ${presets.length} presets`);
}

// --- Integration Tests ---

async function testGeminiIntegration() {
  section("Gemini Provider (integration)");

  const apiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    skip("GEMINI_API_KEY not set");
    return;
  }

  const provider = new GeminiProvider({
    apiKey,
    model: "gemini-embedding-2-preview",
    dimensions: 768,
  });

  try {
    // Query embedding
    const qVec = await provider.embedQuery("보편 학문");
    assert(qVec.length === 768, `Query embedding: ${qVec.length}d`);
    assert(typeof qVec[0] === "number", "Values are numbers");

    // Document embedding
    const dVec = await provider.embedDocument("andenken 로컬 임베딩 전환 전략");
    assert(dVec.length === 768, `Document embedding: ${dVec.length}d`);

    // Batch embedding
    const batch = await provider.embedDocumentBatch(["첫 번째", "두 번째", "세 번째"]);
    assert(batch.length === 3, `Batch: ${batch.length} vectors`);
    assert(batch[0].length === 768, `Batch[0]: ${batch[0].length}d`);

    // Empty batch
    const empty = await provider.embedDocumentBatch([]);
    assert(empty.length === 0, "Empty batch: 0 vectors");

    // Stats
    const stats = provider.getStats();
    assert(stats.calls > 0, `API calls: ${stats.calls}`);
    assert(stats.estimatedTokens > 0, `Estimated tokens: ${stats.estimatedTokens}`);

    // Cosine similarity sanity check
    const sim = cosineSimilarity(qVec, dVec);
    assert(sim > 0 && sim <= 1, `Cosine similarity: ${sim.toFixed(4)} (should be > 0)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429") || msg.includes("spending")) {
      skip(`Rate limited: ${msg.slice(0, 80)}`);
    } else {
      assert(false, `Gemini error: ${msg.slice(0, 120)}`);
    }
  }
}

async function testVLLMIntegration(endpoint?: string, model?: string) {
  section("vLLM Provider (integration)");

  const ep = endpoint ?? process.env.ANDENKEN_VLLM_ENDPOINT;
  const md = model ?? process.env.ANDENKEN_VLLM_MODEL;

  if (!ep || !md) {
    skip("ANDENKEN_VLLM_ENDPOINT / ANDENKEN_VLLM_MODEL not set");
    skip("Usage: npx tsx test-provider.ts vllm http://gpu2i:8000 model-name");
    return;
  }

  const dims = process.env.ANDENKEN_VLLM_DIMENSIONS
    ? parseInt(process.env.ANDENKEN_VLLM_DIMENSIONS, 10)
    : undefined;

  const provider = new VLLMProvider({
    endpoint: ep,
    model: md,
    dimensions: dims,
    queryInstruction: process.env.ANDENKEN_VLLM_QUERY_INSTRUCTION,
    documentInstruction: process.env.ANDENKEN_VLLM_DOCUMENT_INSTRUCTION,
  });

  // Health check
  console.log(`  📡 Endpoint: ${ep}`);
  console.log(`  📦 Model: ${md}`);
  const health = await provider.healthCheck();
  assert(health.ok, `Health check: ${health.ok ? "OK" : health.error}`);
  if (health.model) console.log(`  ✓ Serving: ${health.model}`);
  if (!health.ok) {
    console.log("  ⚠ Skipping remaining vLLM tests — endpoint not healthy");
    return;
  }

  try {
    // Query embedding
    const qVec = await provider.embedQuery("보편 학문 테스트");
    assert(qVec.length > 0, `Query embedding: ${qVec.length}d`);
    assert(typeof qVec[0] === "number", "Values are numbers");
    console.log(`  📐 Detected dimensions: ${provider.dimensions}d`);

    // Document embedding
    const dVec = await provider.embedDocument("andenken 로컬 임베딩 전환 전략 문서");
    assert(dVec.length === qVec.length, `Document embedding: ${dVec.length}d (same as query)`);

    // Batch embedding
    const batch = await provider.embedDocumentBatch([
      "첫 번째 문장: NixOS 설정",
      "두 번째 문장: Emacs org-mode",
      "세 번째 문장: 하이데거 존재론",
    ]);
    assert(batch.length === 3, `Batch: ${batch.length} vectors`);
    assert(batch[0].length === qVec.length, `Batch[0]: ${batch[0].length}d`);

    // Empty batch
    const empty = await provider.embedDocumentBatch([]);
    assert(empty.length === 0, "Empty batch: 0 vectors");

    // Stats
    const stats = provider.getStats();
    assert(stats.calls > 0, `API calls: ${stats.calls}`);
    assert(stats.estimatedCostUSD === 0, `Cost: $${stats.estimatedCostUSD} (local = free)`);

    // Cosine similarity sanity
    const sim = cosineSimilarity(qVec, dVec);
    assert(sim > 0 && sim <= 1, `Cosine similarity: ${sim.toFixed(4)}`);

    // Cross-lingual: Korean query vs English doc
    const koVec = await provider.embedQuery("임베딩 모델 품질");
    const enVec = await provider.embedDocument("embedding model quality comparison");
    const crossSim = cosineSimilarity(koVec, enVec);
    console.log(`  🌐 Cross-lingual sim (ko↔en): ${crossSim.toFixed(4)}`);
    assert(crossSim > 0.1, `Cross-lingual: ${crossSim.toFixed(4)} > 0.1 (basic sanity)`);

    console.log(`\n  ✅ vLLM provider fully operational at ${ep}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(false, `vLLM error: ${msg.slice(0, 200)}`);
  }
}

async function testProviderSwitch() {
  section("Provider Switch (Gemini → vLLM equivalence)");

  const geminiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  const vllmEndpoint = process.env.ANDENKEN_VLLM_ENDPOINT;
  const vllmModel = process.env.ANDENKEN_VLLM_MODEL;

  if (!geminiKey || !vllmEndpoint || !vllmModel) {
    skip("Need both GEMINI_API_KEY and ANDENKEN_VLLM_* for switch test");
    return;
  }

  const gemini = new GeminiProvider({
    apiKey: geminiKey,
    model: "gemini-embedding-2-preview",
    dimensions: 768,
  });

  const vllm = new VLLMProvider({
    endpoint: vllmEndpoint,
    model: vllmModel,
    queryInstruction: process.env.ANDENKEN_VLLM_QUERY_INSTRUCTION,
  });

  const testQuery = "andenken 임베딩 비용 분석";

  try {
    const gVec = await gemini.embedQuery(testQuery);
    const vVec = await vllm.embedQuery(testQuery);

    assert(gVec.length > 0, `Gemini: ${gVec.length}d`);
    assert(vVec.length > 0, `vLLM: ${vVec.length}d`);

    // They will have different dimensions — that's expected
    console.log(`  Gemini: ${gVec.length}d, vLLM: ${vVec.length}d`);
    if (gVec.length === vVec.length) {
      const sim = cosineSimilarity(gVec, vVec);
      console.log(`  Same-dim cosine similarity: ${sim.toFixed(4)}`);
    } else {
      console.log(`  ℹ Different dimensions — cannot compare directly (expected for different models)`);
    }

    assert(true, "Both providers produce valid embeddings for same query");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(false, `Provider switch test failed: ${msg.slice(0, 120)}`);
  }
}

// --- Helpers ---

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Main ---

const args = process.argv.slice(2);
const mode = args[0] ?? "all";

console.log("🧪 Embedding Provider Test Suite\n");

if (mode === "unit" || mode === "all") {
  await testFactory();
  await testProviderInterface();
  await testModelPresets();
  await testVLLMErrorHandling();
}

if (mode === "gemini" || mode === "all") {
  await testGeminiIntegration();
}

if (mode === "vllm" || mode === "all") {
  await testVLLMIntegration(args[1], args[2]);
}

if (mode === "switch" || mode === "all") {
  await testProviderSwitch();
}

console.log(`\n${"─".repeat(40)}`);
console.log(`✅ ${passed} passed  ❌ ${failed} failed  ⏭  ${skipped} skipped`);

if (failed > 0) process.exit(1);
