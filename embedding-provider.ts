/**
 * Embedding Provider — Abstract interface + factory
 *
 * Decouples andenken search/indexing from any specific embedding API.
 * Providers: Gemini (existing), vLLM (local GPU), future others.
 *
 * Design:
 * - Config injected at creation, not per-call
 * - Stats tracking built into interface (cost or throughput)
 * - Factory auto-selects based on env vars
 * - Gemini fallback when ANDENKEN_PROVIDER not set
 */

// --- Interface ---

export interface EmbeddingStats {
  calls: number;
  estimatedTokens: number;
  estimatedCostUSD: number; // 0 for local providers
}

export interface EmbeddingProvider {
  /** Provider identifier */
  readonly name: string;

  /** Vector dimensions this provider produces */
  readonly dimensions: number;

  /** Embed a single text for search (query time) */
  embedQuery(text: string): Promise<number[]>;

  /** Embed a single text for indexing (document time) */
  embedDocument(text: string): Promise<number[]>;

  /** Embed multiple texts for indexing (batch) */
  embedDocumentBatch(texts: string[]): Promise<number[][]>;

  /** Get cumulative API call stats */
  getStats(): EmbeddingStats;

  /** Reset stats counters */
  resetStats(): void;
}

// --- Caching Provider (query-time only, for long-lived processes like pi extension) ---

export class CachingProvider implements EmbeddingProvider {
  private inner: EmbeddingProvider;
  private queryCache = new Map<string, { vector: number[]; expires: number }>();
  private ttlMs: number;
  private _hits = 0;

  constructor(inner: EmbeddingProvider, ttlMs: number = 5 * 60 * 1000) {
    this.inner = inner;
    this.ttlMs = ttlMs;
  }

  get name() { return this.inner.name; }
  get dimensions() { return this.inner.dimensions; }

  async embedQuery(text: string): Promise<number[]> {
    const cached = this.queryCache.get(text);
    if (cached && cached.expires > Date.now()) {
      this._hits++;
      return cached.vector;
    }
    const vector = await this.inner.embedQuery(text);
    this.queryCache.set(text, { vector, expires: Date.now() + this.ttlMs });
    return vector;
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.inner.embedDocument(text);
  }

  async embedDocumentBatch(texts: string[]): Promise<number[][]> {
    return this.inner.embedDocumentBatch(texts);
  }

  getStats(): EmbeddingStats {
    const inner = this.inner.getStats();
    return { ...inner, cacheHits: this._hits } as EmbeddingStats & { cacheHits: number };
  }

  resetStats(): void {
    this.inner.resetStats();
    this._hits = 0;
    this.queryCache.clear();
  }
}

// --- Gemini Provider ---

import {
  embedQuery as geminiEmbedQuery,
  embedDocument as geminiEmbedDocument,
  embedDocumentBatch as geminiEmbedDocumentBatch,
  getApiStats as geminiGetApiStats,
  resetApiStats as geminiResetApiStats,
  type GeminiEmbeddingConfig,
} from "./gemini-embeddings.js";

export class GeminiProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimensions: number;
  private config: GeminiEmbeddingConfig;

  constructor(config: GeminiEmbeddingConfig) {
    this.config = config;
    this.dimensions = config.dimensions ?? 768;
  }

  async embedQuery(text: string): Promise<number[]> {
    return geminiEmbedQuery(text, this.config);
  }

  async embedDocument(text: string): Promise<number[]> {
    return geminiEmbedDocument(text, this.config);
  }

  async embedDocumentBatch(texts: string[]): Promise<number[][]> {
    return geminiEmbedDocumentBatch(texts, this.config);
  }

  getStats(): EmbeddingStats {
    return geminiGetApiStats();
  }

  resetStats(): void {
    geminiResetApiStats();
  }
}

// --- vLLM Provider ---

/**
 * vLLM OpenAI-compatible embedding provider.
 *
 * Calls /v1/embeddings endpoint served by vLLM.
 * Supports instruction-aware models (Qwen3-Embedding, etc.)
 * via query/document instruction prefixes.
 *
 * No rate limiting needed — local GPU, no cost.
 */

export interface VLLMProviderConfig {
  endpoint: string;    // e.g. "http://gpu2i:8000" — comma-separated for multi-GPU: "http://gpu1:8000,http://gpu2:8000"
  model: string;       // e.g. "Qwen/Qwen3-Embedding-8B"
  dimensions?: number; // expected native dimensions (for VectorStore init). NOT sent to API unless truncateDimensions is true.
  /** If true, send dimensions param to API (for MRL/Matryoshka truncation). Default: false. */
  truncateDimensions?: boolean;
  /** Instruction prefix for query embeddings (model-dependent) */
  queryInstruction?: string;
  /** Instruction prefix for document embeddings (model-dependent) */
  documentInstruction?: string;
  /** Max texts per batch request */
  maxBatchSize?: number;
  /** Bearer token for authenticated OpenAI-compatible endpoints (e.g. OpenRouter). Optional. */
  apiKey?: string;
}

// Retry for local — simpler, shorter delays (GPU restart, etc.)
const VLLM_RETRY_ATTEMPTS = 3;
const VLLM_RETRY_DELAY_MS = 1000;

export class VLLMProvider implements EmbeddingProvider {
  readonly name = "vllm";
  private _dimensions: number;
  private _requestDimensions: boolean; // only send dimensions param if explicitly configured
  private config: VLLMProviderConfig;
  private _calls = 0;
  private _tokenEstimate = 0;
  private _healthy: boolean | null = null; // null = unknown

  private _endpoints: string[];
  private _endpointIdx = 0;

  constructor(config: VLLMProviderConfig) {
    this.config = config;
    this._dimensions = config.dimensions ?? 0;
    this._requestDimensions = config.truncateDimensions === true && (config.dimensions ?? 0) > 0;
    // Multi-GPU: comma-separated endpoints → round-robin
    this._endpoints = config.endpoint.split(",").map((e) => e.trim()).filter(Boolean);
    if (this._endpoints.length > 1) {
      process.stderr.write(`🔀 Multi-GPU: ${this._endpoints.length} endpoints\n`);
    }
  }

  private nextEndpoint(): string {
    const ep = this._endpoints[this._endpointIdx % this._endpoints.length];
    this._endpointIdx++;
    return ep;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async embedQuery(text: string): Promise<number[]> {
    const input = this.config.queryInstruction
      ? `${this.config.queryInstruction}${text}`
      : text;
    const result = await this.embed([input]);
    return result[0];
  }

  async embedDocument(text: string): Promise<number[]> {
    const input = this.config.documentInstruction
      ? `${this.config.documentInstruction}${text}`
      : text;
    const result = await this.embed([input]);
    return result[0];
  }

  async embedDocumentBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const prefix = this.config.documentInstruction ?? "";
    const inputs = prefix ? texts.map((t) => `${prefix}${t}`) : texts;
    const maxBatch = this.config.maxBatchSize ?? 64;
    const allResults: number[][] = [];

    for (let i = 0; i < inputs.length; i += maxBatch) {
      const batch = inputs.slice(i, i + maxBatch);
      const results = await this.embed(batch);
      allResults.push(...results);
    }

    return allResults;
  }

  /**
   * Health check: verify vLLM endpoint is reachable and model is loaded.
   * Returns { ok, model, error }.
   */
  async healthCheck(): Promise<{ ok: boolean; model?: string; error?: string }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.config.endpoint}/v1/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this._healthy = false;
        return { ok: false, error: `HTTP ${res.status}` };
      }

      const data = (await res.json()) as { data: Array<{ id: string }> };
      const models = data.data?.map((m) => m.id) ?? [];
      this._healthy = models.length > 0;
      return {
        ok: this._healthy,
        model: models[0],
        error: models.length === 0 ? "No models loaded" : undefined,
      };
    } catch (err) {
      this._healthy = false;
      const msg = err instanceof Error ? err.message : String(err);
      const causeMsg = (err as { cause?: { message?: string } })?.cause?.message ?? "";
      const fullMsg = `${msg} ${causeMsg}`;
      if (fullMsg.includes("abort") || fullMsg.includes("AbortError")) return { ok: false, error: `Timeout connecting to ${this.config.endpoint}` };
      if (fullMsg.includes("ECONNREFUSED")) return { ok: false, error: `Connection refused: ${this.config.endpoint}` };
      if (fullMsg.includes("ENOTFOUND")) return { ok: false, error: `Host not found: ${this.config.endpoint}` };
      if (msg === "fetch failed") return { ok: false, error: `Cannot reach ${this.config.endpoint}: ${causeMsg || 'network error'}` };
      return { ok: false, error: msg.slice(0, 200) };
    }
  }

  getStats(): EmbeddingStats {
    return {
      calls: this._calls,
      estimatedTokens: this._tokenEstimate,
      estimatedCostUSD: 0, // local = free
    };
  }

  resetStats(): void {
    this._calls = 0;
    this._tokenEstimate = 0;
  }

  // --- Internal ---

  private async embed(inputs: string[]): Promise<number[][]> {
    this._calls++;
    const chars = inputs.reduce((sum, t) => sum + t.length, 0);
    this._tokenEstimate += Math.ceil(chars / 2.5);

    const ep = this.nextEndpoint();
    const url = `${ep}/v1/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: inputs,
    };
    // Only send dimensions if explicitly configured (not auto-detected)
    // Some models (e.g., Qwen3-Embedding-0.6B) reject dimensions param
    if (this._requestDimensions && this._dimensions > 0) {
      body.dimensions = this._dimensions;
    }

    let attempt = 0;
    while (true) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const errBody = await res.text();
          const errMsg = `vLLM embed (${res.status}): ${errBody.slice(0, 200)}`;
          // 4xx = client error, non-retryable (bad request, model not found, etc.)
          if (res.status >= 400 && res.status < 500) {
            throw Object.assign(new Error(errMsg), { nonRetryable: true });
          }
          // 5xx = server error, retryable
          throw new Error(errMsg);
        }

        const data = (await res.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        if (!data.data || data.data.length === 0) {
          throw new Error("vLLM returned empty embedding data");
        }

        // Sort by index (API may return unordered)
        const sorted = data.data.sort((a, b) => a.index - b.index);

        // Auto-detect dimensions from first response
        if (this._dimensions === 0 && sorted[0].embedding.length > 0) {
          this._dimensions = sorted[0].embedding.length;
          process.stderr.write(`📡 vLLM auto-detected ${this._dimensions}d\n`);
        }

        return sorted.map((d) => d.embedding);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Node.js fetch wraps network errors as TypeError with cause
        const causeMsg = (err as { cause?: { message?: string } })?.cause?.message ?? "";
        const fullMsg = `${msg} ${causeMsg}`;

        // Non-retryable errors
        if (fullMsg.includes("ECONNREFUSED") || (msg === "fetch failed" && causeMsg.includes("ECONNREFUSED"))) {
          throw new Error(`vLLM endpoint unreachable: ${ep} — is the service running?`);
        }
        if (fullMsg.includes("ENOTFOUND") || (msg === "fetch failed" && causeMsg.includes("ENOTFOUND"))) {
          throw new Error(`vLLM host not found: ${ep}`);
        }
        if (fullMsg.includes("abort") || fullMsg.includes("AbortError")) {
          throw new Error(`vLLM request timeout (30s): ${ep}`);
        }
        // Non-retryable marked errors (4xx)
        if ((err as { nonRetryable?: boolean })?.nonRetryable) {
          throw err;
        }

        // Generic fetch failure (e.g., connection reset, DNS timeout)
        if (msg === "fetch failed" && attempt >= VLLM_RETRY_ATTEMPTS) {
          throw new Error(`vLLM endpoint unreachable: ${ep} — ${causeMsg || 'network error'}`);
        }

        if (attempt >= VLLM_RETRY_ATTEMPTS) throw err;
        attempt++;
        process.stderr.write(
          `⟳ vLLM retry ${attempt}/${VLLM_RETRY_ATTEMPTS}: ${msg.slice(0, 80)}\n`,
        );
        await new Promise((r) => setTimeout(r, VLLM_RETRY_DELAY_MS * attempt));
      }
    }
  }
}

// --- Model Presets ---

import { getModelPreset } from "./model-presets.js";

// --- Factory ---

export interface ProviderConfig {
  type?: "gemini" | "vllm";
  // Gemini
  apiKey?: string;
  geminiModel?: string;
  geminiDimensions?: number;
  // vLLM
  vllmEndpoint?: string;
  vllmModel?: string;
  vllmDimensions?: number;
  vllmQueryInstruction?: string;
  vllmDocumentInstruction?: string;
  vllmMaxBatchSize?: number;
}

/**
 * Create embedding provider from explicit config.
 */
export function createProvider(config: ProviderConfig): EmbeddingProvider {
  if (config.type === "vllm") {
    if (!config.vllmEndpoint) throw new Error("ANDENKEN_VLLM_ENDPOINT required for vllm provider");
    if (!config.vllmModel) throw new Error("ANDENKEN_VLLM_MODEL required for vllm provider");
    return new VLLMProvider({
      endpoint: config.vllmEndpoint,
      model: config.vllmModel,
      dimensions: config.vllmDimensions,
      queryInstruction: config.vllmQueryInstruction,
      documentInstruction: config.vllmDocumentInstruction,
      maxBatchSize: config.vllmMaxBatchSize,
    });
  }

  // Default: Gemini
  if (!config.apiKey) throw new Error("GEMINI_API_KEY required for gemini provider");
  return new GeminiProvider({
    apiKey: config.apiKey,
    model: config.geminiModel ?? "gemini-embedding-2-preview",
    dimensions: (config.geminiDimensions ?? 768) as 768,
  });
}

/**
 * Create provider from environment variables.
 *
 * vLLM env vars:
 *   ANDENKEN_PROVIDER=vllm
 *   ANDENKEN_VLLM_ENDPOINT=http://gpu2i:8000
 *   ANDENKEN_VLLM_MODEL=Qwen/Qwen3-Embedding-8B
 *   ANDENKEN_VLLM_DIMENSIONS=4096  (optional)
 *   ANDENKEN_VLLM_QUERY_INSTRUCTION="Instruct: ...\nQuery: "  (optional)
 *   ANDENKEN_VLLM_DOCUMENT_INSTRUCTION="..."  (optional)
 *   ANDENKEN_VLLM_MAX_BATCH_SIZE=64  (optional)
 *
 * Gemini env vars (existing):
 *   GOOGLE_AI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY
 *
 * Falls back to Gemini if ANDENKEN_PROVIDER not set.
 */
export function createProviderFromEnv(): EmbeddingProvider | null {
  const providerType = process.env.ANDENKEN_PROVIDER as "gemini" | "vllm" | undefined;

  if (providerType === "vllm") {
    const endpoint = process.env.ANDENKEN_VLLM_ENDPOINT;
    const model = process.env.ANDENKEN_VLLM_MODEL;
    if (!endpoint || !model) {
      process.stderr.write("⚠ ANDENKEN_PROVIDER=vllm but ANDENKEN_VLLM_ENDPOINT or ANDENKEN_VLLM_MODEL not set\n");
      return null;
    }

    // Auto-apply model preset if available
    // ANDENKEN_VLLM_PRESET overrides model name for preset lookup
    // (useful when model path differs from HF name, e.g., /storage/models/vllm/default)
    const presetName = process.env.ANDENKEN_VLLM_PRESET ?? model;
    const preset = getModelPreset(presetName);
    if (preset && process.env.ANDENKEN_LOG_PRESET === "1") {
      process.stderr.write(`📋 Preset: ${presetName} (${preset.dimensions}d, batch=${preset.maxBatchSize})\n`);
    }

    return new VLLMProvider({
      endpoint,
      model,
      dimensions: process.env.ANDENKEN_VLLM_DIMENSIONS
        ? parseInt(process.env.ANDENKEN_VLLM_DIMENSIONS, 10)
        : preset?.dimensions,
      queryInstruction: process.env.ANDENKEN_VLLM_QUERY_INSTRUCTION ?? preset?.queryInstruction,
      documentInstruction: process.env.ANDENKEN_VLLM_DOCUMENT_INSTRUCTION ?? preset?.documentInstruction,
      maxBatchSize: process.env.ANDENKEN_VLLM_MAX_BATCH_SIZE
        ? parseInt(process.env.ANDENKEN_VLLM_MAX_BATCH_SIZE, 10)
        : preset?.maxBatchSize,
      apiKey: process.env.ANDENKEN_VLLM_API_KEY,
    });
  }

  // Default: Gemini
  const apiKey = loadGeminiKey();
  if (!apiKey) return null;
  return new GeminiProvider({
    apiKey,
    model: "gemini-embedding-2-preview",
    dimensions: 768,
  });
}

// --- Gemini key loader (consolidated from 4 duplicate getGeminiConfig functions) ---

import * as fs from "node:fs";
import * as nodePath from "node:path";

function loadGeminiKey(): string {
  // Check process.env first
  const fromEnv =
    process.env.GOOGLE_AI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY;
  if (fromEnv) return fromEnv;

  // Read ~/.env.local as fallback
  try {
    const envPath = nodePath.join(process.env.HOME ?? "", ".env.local");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const stripped = line.trim().replace(/^export\s+/, "");
      const match = stripped.match(
        /^(GOOGLE_AI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)=["']?([^"'\s]+)["']?/,
      );
      if (match) return match[2];
    }
  } catch {
    // file not found
  }
  return "";
}

// --- Re-exports for backward compatibility ---
// Consumers that still import from gemini-embeddings.ts continue to work.
// New code should use EmbeddingProvider interface.

export { runWithConcurrency, DEFAULT_CONCURRENCY } from "./gemini-embeddings.js";
