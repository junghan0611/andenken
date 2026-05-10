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
  estimatedCostUSD: number; // 0 for local providers; computed from tokens × price for paid
  /** PR-B: true when the provider talks to a paid remote endpoint. */
  paidRemote?: boolean;
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
  endpoint: string;    // e.g. "http://localhost:18000" (gpu1i tunnel). Comma-separated multi-endpoint round-robin is still supported but currently single-host (gpu2i moved to VOS 2026-04-30).
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
  /**
   * Per-request embed timeout in milliseconds. Takes precedence over the
   * legacy ANDENKEN_VLLM_TIMEOUT_MS env so namespaced configs (sessions/org)
   * can carry their own value without depending on global env.
   * Default 30000.
   */
  timeoutMs?: number;
  /**
   * Cosmetic provider-name suffix for stats/logs (e.g. "openrouter" alias).
   * Does not change behavior. Useful when paid remote endpoints reuse the
   * VLLMProvider class.
   */
  nameTag?: string;
  /**
   * PR-B: Paid-remote endpoint flag.
   *
   * When true, the provider:
   *   - emits a one-time stderr warning on construction (operator visibility)
   *   - reports `paidRemote: true` in getStats() return value
   *   - computes `estimatedCostUSD = tokens × pricePerMillionInputTokens / 1e6`
   *
   * Default false (local/free endpoints). Local gpu1i / ollama remain
   * paidRemote: false. OpenRouter / paid OpenAI-compatible endpoints set
   * this to true via `ANDENKEN_*_PAID_REMOTE=1`.
   */
  paidRemote?: boolean;
  /**
   * PR-B: Price per million input tokens (USD). Only consulted when
   * `paidRemote` is true. Default 0 (so unconfigured paid endpoints surface
   * the gap visibly: "paidRemote: true, cost: $0.000" makes the missing
   * price obvious in stats).
   */
  pricePerMillionInputTokens?: number;
}

// Retry for local — simpler, shorter delays (GPU restart, etc.)
const VLLM_RETRY_ATTEMPTS = 3;
const VLLM_RETRY_DELAY_MS = 1000;

export class VLLMProvider implements EmbeddingProvider {
  readonly name: string;
  private _dimensions: number;
  private _requestDimensions: boolean; // only send dimensions param if explicitly configured
  private config: VLLMProviderConfig;
  private _calls = 0;
  private _tokenEstimate = 0;
  private _healthy: boolean | null = null; // null = unknown
  private _paidRemote: boolean;
  private _pricePerM: number;

  private _endpoints: string[];
  private _endpointIdx = 0;

  constructor(config: VLLMProviderConfig) {
    this.config = config;
    this.name = config.nameTag ? `vllm (${config.nameTag})` : "vllm";
    this._dimensions = config.dimensions ?? 0;
    this._requestDimensions = config.truncateDimensions === true && (config.dimensions ?? 0) > 0;
    this._paidRemote = config.paidRemote === true;
    this._pricePerM = config.pricePerMillionInputTokens ?? 0;
    // Multi-GPU: comma-separated endpoints → round-robin
    this._endpoints = config.endpoint.split(",").map((e) => e.trim()).filter(Boolean);
    if (this._endpoints.length > 1) {
      process.stderr.write(`🔀 Multi-GPU: ${this._endpoints.length} endpoints\n`);
    }
    // PR-B: paidRemote operator visibility — emit a one-time warning on
    // construction. This is the only place "OpenRouter is paid" surfaces in
    // long-running processes (pi extension); CLI invocations also see it.
    if (this._paidRemote) {
      process.stderr.write(
        `🟡 ${this.name}: paid remote endpoint (${this._endpoints[0]}). ` +
        `Stats track tokens; cost = tokens × $${this._pricePerM}/M tokens.\n`,
      );
    }
  }

  /**
   * PR-B accessor: lets indexer.ts gate `--force` rebuilds against paid
   * remote endpoints behind ANDENKEN_ALLOW_PAID_FULL_REBUILD=1.
   */
  get isPaidRemote(): boolean {
    return this._paidRemote;
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
      // Authenticated endpoints (OpenRouter, paid OpenAI-compatible) reject
      // /v1/models without a bearer token. Pass apiKey when configured so
      // healthCheck doesn't return false-negative for valid paid endpoints.
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      const res = await fetch(`${this.config.endpoint}/v1/models`, {
        signal: controller.signal,
        headers,
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
    // PR-B: cost is non-zero only for paid remote endpoints. Local endpoints
    // (gpu1i, ollama) remain paidRemote: false → cost: $0.
    const cost = this._paidRemote
      ? (this._tokenEstimate / 1_000_000) * this._pricePerM
      : 0;
    return {
      calls: this._calls,
      estimatedTokens: this._tokenEstimate,
      estimatedCostUSD: cost,
      paidRemote: this._paidRemote,
    } as EmbeddingStats & { paidRemote: boolean };
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
        // Precedence: explicit config.timeoutMs > legacy global env > 30s default.
        // Namespaced providers (sessions/org) carry their own timeoutMs so they
        // do not depend on a shared env slot. Legacy ANDENKEN_VLLM_TIMEOUT_MS
        // remains a fallback for backward-compat.
        const envTimeout = parseInt(process.env.ANDENKEN_VLLM_TIMEOUT_MS ?? "", 10);
        const timeoutMs =
          this.config.timeoutMs ??
          (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30000);
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
          // Match the precedence used at request time (config > env > default).
          const _envT = parseInt(process.env.ANDENKEN_VLLM_TIMEOUT_MS ?? "", 10);
          const _t =
            this.config.timeoutMs ??
            (Number.isFinite(_envT) && _envT > 0 ? _envT : 30000);
          throw new Error(`vLLM request timeout (${Math.round(_t / 1000)}s): ${ep}`);
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
      // PR-A: explicit createProvider(config) had been silently dropping apiKey
      // for the vllm branch. ProviderConfig.apiKey is shared across provider
      // types; for vllm/OpenAI-compatible endpoints it is the bearer token.
      apiKey: config.apiKey,
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

// --- Env reading: shared $VAR-aware getter ---
//
// Resolution order for a key:
//   1. process.env[key] holds a regular value         → return as-is
//                       (a literal "$" inside a value, e.g. an API token,
//                        is preserved — only an EXACT placeholder triggers
//                        expansion; see PLACEHOLDER_RE below)
//   2. process.env[key] is exactly "$NAME"/"${NAME}"  → resolve `NAME` from
//                                                       envfile, then from
//                                                       process.env (refusing
//                                                       to recurse into another
//                                                       placeholder); if it
//                                                       resolves, return that
//   3. otherwise (key missing, or placeholder that didn't resolve)
//                                                     → envfile[key]
//                                                       (loadEnvFile already
//                                                        does declaration-order
//                                                        $VAR expansion within
//                                                        the file)
//
// This lets shell scripts export `ANDENKEN_*=$OTHER` and have it actually
// resolve to OTHER's value, not just fall through to envfile[key].
//
// Note: `_cachedEnvFileShared` is module-level. Once loaded, runtime changes
// to ~/.env.local within the same process are NOT picked up. CLI invocations
// (one-shot) re-load on every run. Long-lived processes (pi extension) load
// once at startup. If a test or operator needs a fresh load, restart the
// process — there is intentionally no public reset.

const PLACEHOLDER_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

let _cachedEnvFileShared: Record<string, string> | undefined;
function getEnvFile(): Record<string, string> {
  return (_cachedEnvFileShared ??= loadEnvFile());
}

/** Resolve a placeholder NAME — used when process.env[key] is literally "$NAME". */
function resolvePlaceholderName(name: string): string | undefined {
  // envfile is consulted first because loadEnvFile() already performs
  // declaration-order expansion within the file (so envfile[NAME] is the
  // already-resolved string). Falling through to process.env[NAME] handles
  // the case where NAME was exported by the shell but never written to file.
  const fromFile = getEnvFile()[name];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  const fromEnv = process.env[name];
  if (fromEnv === undefined || fromEnv === "") return undefined;
  // Refuse to recurse into another placeholder — pathological config; caller
  // gets undefined here and we'll fall through to envfile[key] of the original
  // outer key.
  if (PLACEHOLDER_RE.test(fromEnv)) return undefined;
  return fromEnv;
}

function readEnvWithFileFallback(key: string): string | undefined {
  const raw = process.env[key];
  if (raw !== undefined) {
    const m = raw.match(PLACEHOLDER_RE);
    if (!m) return raw;                        // (1) regular value, even if it contains '$' inside
    const resolved = resolvePlaceholderName(m[1]);
    if (resolved !== undefined) return resolved; // (2) placeholder resolved
    // (3) placeholder didn't resolve → fall through to envfile[key]
  }
  return getEnvFile()[key];
}

/**
 * Map provider type strings to the concrete class.
 *
 * - "vllm"        → VLLMProvider (local /v1/embeddings)
 * - "openrouter"  → VLLMProvider with paid-remote default (OpenAI-compatible)
 * - "gemini"      → GeminiProvider
 *
 * The "openrouter" alias is purely cosmetic at this layer (it still
 * constructs VLLMProvider). The classification matters for downstream
 * paid-remote signalling, which lands in PR-B.
 */
export type ResolvedProviderType = "vllm" | "openrouter" | "gemini";
export function resolveProviderType(raw: string | undefined): ResolvedProviderType | null {
  if (!raw) return null;
  if (raw === "vllm" || raw === "gemini" || raw === "openrouter") return raw;
  process.stderr.write(`⚠ unknown provider type: ${raw} (allowed: vllm | openrouter | gemini)\n`);
  return null;
}

/**
 * Build a VLLMProvider from a namespaced env reader. Used by both
 * createSessionProviderFromEnv (ANDENKEN_SESSION_*) and
 * createOrgProviderFromEnv (ANDENKEN_ORG_*) so prefix changes never
 * cross-contaminate.
 *
 * `nameTag` is woven into the provider's `name` for stats/logs (e.g.
 * "vllm (sessions:openrouter)") so operators can tell which track a stats
 * line came from. Behavior is unchanged.
 */
function buildVllmFromNamespacedEnv(
  read: (suffix: string) => string | undefined,
  nameTag: string,
): VLLMProvider | null {
  const endpoint = read("ENDPOINT");
  const model = read("MODEL");
  if (!endpoint || !model) {
    process.stderr.write(
      `⚠ ${nameTag} provider: ENDPOINT or MODEL not set\n`,
    );
    return null;
  }
  const presetName = read("PRESET") ?? model;
  const preset = getModelPreset(presetName);
  if (preset && read("LOG_PRESET") === "1") {
    process.stderr.write(
      `📋 ${nameTag} preset: ${presetName} (${preset.dimensions}d, batch=${preset.maxBatchSize})\n`,
    );
  }
  const dimStr = read("DIMENSIONS");
  const batchStr = read("MAX_BATCH_SIZE");
  const timeoutStr = read("TIMEOUT_MS");
  const priceStr = read("PRICE_PER_M_TOKENS");
  const parsedPrice = priceStr !== undefined ? parseFloat(priceStr) : NaN;
  return new VLLMProvider({
    endpoint,
    model,
    dimensions: dimStr ? parseInt(dimStr, 10) : preset?.dimensions,
    queryInstruction: read("QUERY_INSTRUCTION") ?? preset?.queryInstruction,
    documentInstruction: read("DOCUMENT_INSTRUCTION") ?? preset?.documentInstruction,
    maxBatchSize: batchStr ? parseInt(batchStr, 10) : preset?.maxBatchSize,
    apiKey: read("API_KEY"),
    timeoutMs: timeoutStr ? parseInt(timeoutStr, 10) : undefined,
    nameTag,
    // PR-B: paid-remote signalling. Both env vars are namespaced
    // (ANDENKEN_SESSION_PAID_REMOTE, ANDENKEN_SESSION_PRICE_PER_M_TOKENS, etc.)
    // so sessions/org tracks each carry their own pricing without affecting
    // the other.
    paidRemote: read("PAID_REMOTE") === "1",
    pricePerMillionInputTokens: Number.isFinite(parsedPrice) ? parsedPrice : undefined,
  });
}

/**
 * Create provider from environment variables (LEGACY surface).
 *
 * vLLM env vars:
 *   ANDENKEN_PROVIDER=vllm
 *   ANDENKEN_VLLM_ENDPOINT=http://localhost:18000   # gpu1i tunnel (gpu2i is VOS, do not embed against it)
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
 *
 * NOTE: as of PR-A, this function is preserved for backward-compat. New code
 * should prefer createSessionProviderFromEnv() / createOrgProviderFromEnv()
 * which read from ANDENKEN_SESSION_* / ANDENKEN_ORG_* respectively.
 */
export function createProviderFromEnv(): EmbeddingProvider | null {
  const getEnv = readEnvWithFileFallback;

  const rawType = getEnv("ANDENKEN_PROVIDER");
  const providerType = resolveProviderType(rawType);

  // Legacy global slot must not select paid-remote providers. The "openrouter"
  // alias is only valid in the namespaced surfaces (ANDENKEN_SESSION_PROVIDER /
  // ANDENKEN_ORG_PROVIDER) so a single global misconfiguration cannot push
  // BOTH tracks onto a paid endpoint at once.
  if (providerType === "openrouter") {
    process.stderr.write(
      "⚠ ANDENKEN_PROVIDER=openrouter rejected on the legacy global slot. " +
      "Use ANDENKEN_SESSION_PROVIDER (or ANDENKEN_ORG_PROVIDER) to opt one " +
      "track into OpenRouter without affecting the other. Returning null.\n",
    );
    return null;
  }

  if (providerType === "vllm") {
    const endpoint = getEnv("ANDENKEN_VLLM_ENDPOINT");
    const model = getEnv("ANDENKEN_VLLM_MODEL");
    if (!endpoint || !model) {
      process.stderr.write("⚠ ANDENKEN_PROVIDER=vllm but ANDENKEN_VLLM_ENDPOINT or ANDENKEN_VLLM_MODEL not set\n");
      return null;
    }

    // Auto-apply model preset if available
    // ANDENKEN_VLLM_PRESET overrides model name for preset lookup
    // (useful when model path differs from HF name, e.g., /storage/models/vllm/default)
    const presetName = getEnv("ANDENKEN_VLLM_PRESET") ?? model;
    const preset = getModelPreset(presetName);
    if (preset && getEnv("ANDENKEN_LOG_PRESET") === "1") {
      process.stderr.write(`📋 Preset: ${presetName} (${preset.dimensions}d, batch=${preset.maxBatchSize})\n`);
    }

    const dimStr = getEnv("ANDENKEN_VLLM_DIMENSIONS");
    const batchStr = getEnv("ANDENKEN_VLLM_MAX_BATCH_SIZE");
    const timeoutStr = getEnv("ANDENKEN_VLLM_TIMEOUT_MS");
    return new VLLMProvider({
      endpoint,
      model,
      dimensions: dimStr ? parseInt(dimStr, 10) : preset?.dimensions,
      queryInstruction: getEnv("ANDENKEN_VLLM_QUERY_INSTRUCTION") ?? preset?.queryInstruction,
      documentInstruction: getEnv("ANDENKEN_VLLM_DOCUMENT_INSTRUCTION") ?? preset?.documentInstruction,
      maxBatchSize: batchStr ? parseInt(batchStr, 10) : preset?.maxBatchSize,
      apiKey: getEnv("ANDENKEN_VLLM_API_KEY"),
      // Preserves prior behavior: legacy env path keeps reading the global
      // ANDENKEN_VLLM_TIMEOUT_MS at request time. Setting timeoutMs here is
      // belt-and-suspenders so explicit config wins over env if both exist.
      timeoutMs: timeoutStr ? parseInt(timeoutStr, 10) : undefined,
      // Legacy slot intentionally has no nameTag — it can only select "vllm"
      // (openrouter alias is rejected above), so the default "vllm" name is
      // correct for stats/logs.
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

// --- Namespaced provider factories ---
//
// SESSIONS and ORG run on independent env namespaces so a misconfiguration
// on one track cannot silently bleed into the other.
//
// Namespace contract (PR-B):
//   ANDENKEN_SESSION_*  — sessions track only. NEVER falls back to legacy.
//   ANDENKEN_ORG_*      — org track only. Falls back to legacy ANDENKEN_VLLM_*.
//
// PR-A had a transitional `allowLegacyFallback` option for sessions so
// existing operators with only ANDENKEN_VLLM_* didn't break immediately.
// PR-B removes it: sessions providers now require explicit ANDENKEN_SESSION_*.
// Operators must migrate or sessions search/index returns null/throws.

/**
 * Create the SESSIONS-track embedding provider from `ANDENKEN_SESSION_*`.
 *
 * Returns null when the namespace is empty. Never reads `ANDENKEN_VLLM_*`
 * directly — sessions must opt out of the global env slot to stay isolated
 * from org indexing. PR-B removed the transitional legacy fallback.
 */
export function createSessionProviderFromEnv(): EmbeddingProvider | null {
  const read = (suffix: string) =>
    readEnvWithFileFallback("ANDENKEN_SESSION_" + suffix);
  const rawType = read("PROVIDER");
  const providerType = resolveProviderType(rawType);

  // Fail-fast on EXPLICIT-but-INVALID config. If the operator typed a
  // namespace value (e.g. ANDENKEN_SESSION_PROVIDER=anthropic), that is a
  // misconfiguration we must surface — silently returning null instead of
  // applying some default would mask the typo. resolveProviderType already
  // wrote the warning.
  if (rawType && !providerType) return null;

  if (providerType === "vllm" || providerType === "openrouter") {
    return buildVllmFromNamespacedEnv(
      read,
      providerType === "openrouter" ? "sessions:openrouter" : "sessions:vllm",
    );
  }
  if (providerType === "gemini") {
    // Permitted but unusual. Sessions on Gemini is a corner case.
    const apiKey = loadGeminiKey();
    if (!apiKey) return null;
    return new GeminiProvider({
      apiKey,
      model: read("GEMINI_MODEL") ?? "gemini-embedding-2-preview",
      dimensions: 768,
    });
  }

  // SESSIONS namespace ABSENT → null. No legacy fallback in PR-B.
  return null;
}

/**
 * Create the ORG-track embedding provider from `ANDENKEN_ORG_*`.
 *
 * Falls back to the legacy `ANDENKEN_VLLM_*` reader when the ORG namespace
 * is empty. Org keeps backward-compat indefinitely because existing
 * operators run their full rebuild against gpu1i with the legacy env.
 */
export function createOrgProviderFromEnv(): EmbeddingProvider | null {
  const read = (suffix: string) =>
    readEnvWithFileFallback("ANDENKEN_ORG_" + suffix);
  const rawType = read("PROVIDER");
  const providerType = resolveProviderType(rawType);

  // Fail-fast on EXPLICIT-but-INVALID config (mirrors sessions). If the
  // operator typed a namespace value (e.g. ANDENKEN_ORG_PROVIDER=anthropic),
  // do NOT silently fall through to the legacy slot — that would mask a typo
  // and could push org onto a wrong dim/track. resolveProviderType already
  // wrote the warning.
  if (rawType && !providerType) return null;

  if (providerType === "vllm" || providerType === "openrouter") {
    return buildVllmFromNamespacedEnv(
      read,
      providerType === "openrouter" ? "org:openrouter" : "org:vllm",
    );
  }
  if (providerType === "gemini") {
    const apiKey = loadGeminiKey();
    if (!apiKey) return null;
    return new GeminiProvider({
      apiKey,
      model: read("GEMINI_MODEL") ?? "gemini-embedding-2-preview",
      dimensions: 768,
    });
  }

  // ORG namespace ABSENT (no rawType) → legacy fallback (no warning; this is
  // the supported backward-compat path for org indexing until that track also
  // migrates). Explicit-but-invalid values were rejected by the fail-fast
  // guard above.
  return createProviderFromEnv();
}

// --- Env file loader with variable expansion ---

import * as fs from "node:fs";
import * as nodePath from "node:path";

// Parses ~/.env.local into a Record, resolving $VAR references in declaration order.
// Handles: export KEY=value, KEY="value", KEY='value', KEY=$OTHER_KEY
function loadEnvFile(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const envPath = nodePath.join(process.env.HOME ?? "", ".env.local");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const stripped = line.trim().replace(/^export\s+/, "");
      if (!stripped || stripped.startsWith("#")) continue;
      const eqIdx = stripped.indexOf("=");
      if (eqIdx < 0) continue;
      const key = stripped.slice(0, eqIdx).trim();
      if (!key) continue;
      const raw = stripped.slice(eqIdx + 1).trim();

      let value: string;
      if (raw.startsWith("'") && raw.endsWith("'")) {
        value = raw.slice(1, -1); // single-quoted: no expansion
      } else {
        const inner = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
        // Expand $VAR and ${VAR} using already-parsed values then process.env
        value = inner.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, v) =>
          result[v] ?? process.env[v] ?? "",
        );
      }
      result[key] = value;
    }
  } catch {
    // file not found or unreadable
  }
  return result;
}

function loadGeminiKey(): string {
  const fromEnv =
    process.env.GOOGLE_AI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY;
  if (fromEnv) return fromEnv;

  const envFile = loadEnvFile();
  return (
    envFile["GOOGLE_AI_API_KEY"] ??
    envFile["GEMINI_API_KEY"] ??
    envFile["GOOGLE_API_KEY"] ??
    ""
  );
}

// --- Re-exports for backward compatibility ---
// Consumers that still import from gemini-embeddings.ts continue to work.
// New code should use EmbeddingProvider interface.

export { runWithConcurrency, DEFAULT_CONCURRENCY } from "./gemini-embeddings.js";
