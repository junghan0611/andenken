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
  /**
   * Provider calls: one per request this provider was asked to make, a
   * caller's resubmission included. Not a count of unique requests.
   */
  calls: number;
  /** Submitted-input estimate (chars / 2.5) over those calls. Not provider usage, not a bill. */
  estimatedTokens: number;
  estimatedCostUSD: number; // 0 for local providers; computed from tokens × price for paid
  /** PR-B: true when the provider talks to a paid remote endpoint. */
  paidRemote?: boolean;
  /**
   * Transport counters (VLLMProvider; absent elsewhere). `httpAttempts` counts
   * every fetch started, the provider's own transport retries included;
   * `httpOk` returned vectors, `httpFailed` did not.
   */
  httpAttempts?: number;
  httpOk?: number;
  httpFailed?: number;
  /**
   * Provider-reported `usage.prompt_tokens`, summed over the ok attempts that
   * carried it (`okWithUsage`). `okWithoutUsage` ok attempts reported none:
   * their tokens are unknown, not zero.
   */
  reportedPromptTokens?: number;
  okWithUsage?: number;
  okWithoutUsage?: number;
}

export interface EmbeddingProvider {
  /** Provider identifier */
  readonly name: string;

  /** Vector dimensions this provider produces */
  readonly dimensions: number;

  /** The embedding generation this provider speaks for (embedding-profile.ts). */
  readonly profile?: EmbeddingProfile;

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
  // Identity and cost facts of the wrapped provider. Callers read these by
  // duck type (profileOfProvider, paid gates, the store generation check); a
  // wrapper that hid them would make a profiled provider look unprofiled — a
  // stamped store would refuse it and the profiled split would be skipped —
  // and would make a paid endpoint look free to the /memory --force gate.
  get profile(): EmbeddingProfile | undefined {
    return (this.inner as { profile?: EmbeddingProfile }).profile;
  }
  get model(): string | undefined {
    return (this.inner as { model?: string }).model;
  }
  get isPaidRemote(): boolean {
    return (this.inner as { isPaidRemote?: boolean }).isPaidRemote === true;
  }

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


// --- vLLM Provider ---

/**
 * Loopback / OpenAI-compatible embedding provider.
 *
 * Calls `/v1/embeddings`, or — for a profile whose transport is
 * `ollama-native` — Ollama's `/api/embed` with `truncate: false`.
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
  /**
   * Embedding generation identity. When set, the provider enforces it:
   * fixed model/dimension, input-length bound (fail-closed against silent
   * runtime truncation), and — for loopback profiles — the response `model`.
   */
  profile?: EmbeddingProfile;
}

// Retry for local — simpler, shorter delays (GPU restart, etc.)
const VLLM_RETRY_ATTEMPTS = 3;
const VLLM_RETRY_DELAY_MS = 1000;

/** `Retry-After` as delay-seconds or an HTTP date → milliseconds (bounded to 1h); otherwise undefined. */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (!Number.isFinite(at)) return undefined;
    ms = at - nowMs;
  }
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, 3_600_000);
}

// --- Provider error diagnostics (bounded, allowlisted) ---
//
// At most PROVIDER_ERROR_BODY_LIMIT bytes of a non-2xx body are kept for
// parsing; the stream is then cancelled (never drained). Only allowlisted fields are
// kept: error.code / error.type / error.metadata.provider_name and, for an
// upstream error wrapped as "HTTP NNN: {json}", its status, code and type.
// Free-form text (messages, raw upstream bodies, URLs) is never kept or logged.
// Each kept value must pass `diagnosticToken` — a shape rule plus a configured-key
// overlap check. That lowers, but does not prove away, the chance of a secret
// surviving; it is why only these few fields are read at all.

export const PROVIDER_ERROR_BODY_LIMIT = 4096;

export interface ProviderErrorMeta {
  status: number;
  retryAfterMs?: number;
  /** What became of the body. Never the body itself. */
  body: "empty" | "parsed" | "unparsed" | "truncated" | "read-error";
  code?: string;
  type?: string;
  providerName?: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  upstreamType?: string;
  /** Allowlisted fields present but refused by the value rule. */
  dropped?: number;
}

export type BoundedBody = { text: string; state: "empty" | "complete" | "truncated" | "read-error" };

/**
 * Keep at most `limit` bytes of a response body for parsing, then cancel the
 * stream. Reaching the limit ends the read at once — no further read() is
 * awaited, so a body that stops sending without closing cannot hold it — and
 * is reported as "truncated" even when the body was exactly `limit` bytes.
 * The limit bounds what is kept and parsed; it is not a strict cap on what the
 * transport may already have received (a fetch chunk can be larger).
 */
export async function readBoundedBody(res: Response, limit: number = PROVIDER_ERROR_BODY_LIMIT): Promise<BoundedBody> {
  const stream = res.body;
  if (!stream) return { text: "", state: "empty" };
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let state: BoundedBody["state"] = "complete";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - size;
      if (value.byteLength >= room) {
        parts.push(value.subarray(0, room));
        size = limit;
        state = "truncated";
        break;
      }
      parts.push(value);
      size += value.byteLength;
    }
  } catch {
    state = "read-error";
  } finally {
    // Release the connection without reading the rest.
    void reader.cancel().catch(() => {});
  }
  if (state === "read-error") return { text: "", state };
  if (size === 0 && state === "complete") return { text: "", state: "empty" };
  const buf = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.byteLength;
  }
  return { text: new TextDecoder().decode(buf), state };
}

const DIAGNOSTIC_TOKEN = /^[A-Za-z0-9._:/ -]{1,64}$/;

/**
 * A value fit for an allowlisted diagnostic field, `undefined` when absent, or
 * `null` when refused: not a short plain token, URL- or credential-shaped,
 * containing the whole configured key (any length), or sharing any
 * 8-character run with it.
 */
export function diagnosticToken(v: unknown, secret?: string): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) return null;
  const s = String(v);
  if (!DIAGNOSTIC_TOKEN.test(s)) return null;
  if (s.includes("://")) return null;
  if (/bearer|^sk[-_]|api[-_]?key|secret|password/i.test(s)) return null;
  if (/[A-Za-z0-9]{24,}/.test(s)) return null;
  if (secret && s.includes(secret)) return null;
  if (secret && secret.length >= 8) {
    for (let i = 0; i + 8 <= s.length; i++) {
      if (secret.includes(s.slice(i, i + 8))) return null;
    }
  }
  return s;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Reduce a bounded body to allowlisted fields. Parse failure or truncation keeps the state only. */
export function extractProviderErrorMeta(
  status: number,
  retryAfterMs: number | undefined,
  read: BoundedBody,
  secret?: string,
): ProviderErrorMeta {
  const meta: ProviderErrorMeta = { status, body: read.state === "complete" ? "unparsed" : read.state };
  if (retryAfterMs !== undefined) meta.retryAfterMs = retryAfterMs;
  if (read.state !== "complete") return meta;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return meta;
  }
  const err = asRecord(asRecord(parsed)?.error);
  meta.body = "parsed";
  if (!err) return meta;
  let dropped = 0;
  const keep = (field: "code" | "type" | "providerName" | "upstreamCode" | "upstreamType", v: unknown) => {
    const t = diagnosticToken(v, secret);
    if (t === null) dropped++;
    else if (t !== undefined) meta[field] = t;
  };
  keep("code", err.code);
  keep("type", err.type);
  keep("providerName", asRecord(err.metadata)?.provider_name);
  if (typeof err.message === "string") {
    const wrapped = /^HTTP (\d{3}): (\{[\s\S]*\})$/.exec(err.message);
    if (wrapped) {
      meta.upstreamStatus = Number(wrapped[1]);
      try {
        const inner = asRecord(asRecord(JSON.parse(wrapped[2]))?.error);
        if (inner) {
          keep("upstreamCode", inner.code);
          keep("upstreamType", inner.type);
        }
      } catch { /* upstream JSON unparsable: status only */ }
    }
  }
  if (dropped > 0) meta.dropped = dropped;
  return meta;
}

/** `key=value` rendering of the allowlisted fields (status is in the message prefix). */
export function formatProviderErrorMeta(m: ProviderErrorMeta): string {
  const q = (s: string) => (s.includes(" ") ? JSON.stringify(s) : s);
  const parts = [`body=${m.body}`];
  if (m.type !== undefined) parts.push(`type=${q(m.type)}`);
  if (m.code !== undefined) parts.push(`code=${q(m.code)}`);
  if (m.providerName !== undefined) parts.push(`provider=${q(m.providerName)}`);
  if (m.upstreamStatus !== undefined) {
    const up = [String(m.upstreamStatus), m.upstreamType, m.upstreamCode].filter((x): x is string => x !== undefined);
    parts.push(`upstream=${up.map(q).join("/")}`);
  }
  if (m.retryAfterMs !== undefined) parts.push(`retry-after=${m.retryAfterMs}ms`);
  if (m.dropped !== undefined) parts.push(`dropped=${m.dropped}`);
  return parts.join(" ");
}

export class VLLMProvider implements EmbeddingProvider {
  readonly name: string;
  private _dimensions: number;
  private _requestDimensions: boolean; // only send dimensions param if explicitly configured
  private config: VLLMProviderConfig;
  private _calls = 0;
  private _tokenEstimate = 0;
  private _httpAttempts = 0;
  private _httpOk = 0;
  private _httpFailed = 0;
  private _reportedPromptTokens = 0;
  private _okWithUsage = 0;
  private _okWithoutUsage = 0;
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

  /**
   * The batch size this provider was configured with (preset or
   * `*_MAX_BATCH_SIZE`), when it is a positive integer. embedDocumentBatch()
   * sends at most this many inputs per embed() call, so a caller handing it
   * slices of this size makes one embed() call per slice (one call may still
   * make several HTTP attempts on 5xx/network). Undefined when not configured —
   * callers must not guess a size.
   */
  get configuredMaxBatchSize(): number | undefined {
    const v = this.config.maxBatchSize;
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
  }

  private nextEndpoint(): string {
    const ep = this._endpoints[this._endpointIdx % this._endpoints.length];
    this._endpointIdx++;
    return ep;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  /** The configured endpoint base (first one when several are given). */
  get endpoint(): string {
    return this._endpoints[0] ?? this.config.endpoint;
  }

  /** The exact model string sent to the endpoint. */
  get model(): string {
    return this.config.model;
  }

  /** The enforced embedding profile, when this provider was built from one. */
  get profile(): EmbeddingProfile | undefined {
    return this.config.profile;
  }

  async embedQuery(text: string): Promise<number[]> {
    if (this.config.profile) assertInputsFit(this.config.profile, "query", [text]);
    const input = this.config.queryInstruction
      ? `${this.config.queryInstruction}${text}`
      : text;
    const result = await this.embed([input]);
    return result[0];
  }

  async embedDocument(text: string): Promise<number[]> {
    if (this.config.profile) assertInputsFit(this.config.profile, "document", [text]);
    const input = this.config.documentInstruction
      ? `${this.config.documentInstruction}${text}`
      : text;
    const result = await this.embed([input]);
    return result[0];
  }

  async embedDocumentBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.config.profile) assertInputsFit(this.config.profile, "document", texts);

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
      httpAttempts: this._httpAttempts,
      httpOk: this._httpOk,
      httpFailed: this._httpFailed,
      reportedPromptTokens: this._reportedPromptTokens,
      okWithUsage: this._okWithUsage,
      okWithoutUsage: this._okWithoutUsage,
    } as EmbeddingStats & { paidRemote: boolean };
  }

  resetStats(): void {
    this._calls = 0;
    this._tokenEstimate = 0;
    this._httpAttempts = 0;
    this._httpOk = 0;
    this._httpFailed = 0;
    this._reportedPromptTokens = 0;
    this._okWithUsage = 0;
    this._okWithoutUsage = 0;
  }

  // --- Internal ---

  /** Runtime identity proven for this process (digest profiles only). */
  private _identity: Promise<void> | null = null;

  /**
   * A digest-pinned profile proves WHICH weights answer before the first
   * embedding request of this process (Ollama `/api/tags`), not only in a
   * separate preflight. Any failure is permanent for the process and no
   * embedding request is made. Profiles without a digest skip this.
   */
  private ensureRuntimeIdentity(): Promise<void> {
    const p = this.config.profile;
    if (!p || p.digest === null) return Promise.resolve();
    if (!this._identity) {
      this._identity = verifyRuntimeIdentity(p, this._endpoints[0]).then((r) => {
        if (!r.ok) {
          throw Object.assign(new Error(`runtime-identity-${r.code}: ${p.model} at ${this._endpoints[0]}`), {
            nonRetryable: true,
            code: `runtime-identity-${r.code}`,
          });
        }
      });
    }
    return this._identity;
  }

  private async embed(inputs: string[]): Promise<number[][]> {
    await this.ensureRuntimeIdentity();
    this._calls++;
    const chars = inputs.reduce((sum, t) => sum + t.length, 0);
    this._tokenEstimate += Math.ceil(chars / 2.5);

    const ep = this.nextEndpoint();
    // Native Ollama transport (profile.transport): /api/embed with
    // truncate:false, so the runtime refuses an oversize input instead of
    // embedding a truncated one. Loopback only — re-checked here, not trusted
    // from the factory.
    const profile = this.config.profile;
    const native = profile?.transport === "ollama-native";
    if (native && !isLoopbackEndpoint(ep)) {
      throw Object.assign(new Error(`native-transport-not-loopback: ${ep}`), { nonRetryable: true, code: "native-transport-not-loopback" });
    }
    const url = native ? `${ep}/api/embed` : `${ep}/v1/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey && !native) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    let body: Record<string, unknown>;
    if (native) {
      body = nativeEmbedBody(profile!, inputs);
    } else {
      body = {
        model: this.config.model,
        input: inputs,
      };
      // Only send dimensions if explicitly configured (not auto-detected)
      // Some models (e.g., Qwen3-Embedding-0.6B) reject dimensions param
      if (this._requestDimensions && this._dimensions > 0) {
        body.dimensions = this._dimensions;
      }
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
        this._httpAttempts++;
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
          const bounded = await readBoundedBody(res);
          // The runtime's own "input longer than the context" refusal, at ANY
          // status: permanent for this request, never retried here or by a
          // caller. Only the status travels; the body text does not.
          if (native && isContextLengthRefusal(bounded.text)) {
            throw new EmbeddingRuntimeRefusedLength(res.status);
          }
          const providerMeta = extractProviderErrorMeta(
            res.status,
            retryAfterMs,
            bounded,
            this.config.apiKey,
          );
          // The message carries allowlisted fields only — never body text.
          // The "vLLM embed (NNN):" prefix is a contract (candidate-build's
          // providerErrorCode reads the status from it).
          const errMsg = `vLLM embed (${res.status}): ${formatProviderErrorMeta(providerMeta)}`;
          // Structured hints for callers that schedule their own retries (the
          // candidate builder, embed-retry.ts); this provider's own retry
          // behaviour is unchanged.
          const hints = { status: res.status, retryAfterMs, providerMeta };
          // 4xx: `nonRetryable` makes THIS provider's transport retry loop below
          // let the error through at once. It is not a verdict that the failure
          // is permanent — a 429 leaves here immediately, and whether to
          // resubmit is the caller's decision, made on `status`.
          if (res.status >= 400 && res.status < 500) {
            throw Object.assign(new Error(errMsg), { nonRetryable: true }, hints);
          }
          // 5xx = server error, retried by the loop below
          throw Object.assign(new Error(errMsg), hints);
        }

        const raw = (await res.json()) as unknown;
        const data = (native ? nativeToValidatable(raw) : raw) as {
          data?: unknown;
          model?: unknown;
          usage?: { prompt_tokens?: unknown };
        };

        // Legacy auto-detect (dimensions unset, org/legacy env only): learn the
        // dim from the first vector, then validate the whole reply against it.
        // Profile- and namespaced-env providers always carry a fixed dim.
        let expectedDim = this._dimensions;
        if (expectedDim === 0) {
          const first = Array.isArray(data?.data) ? (data.data[0] as { embedding?: unknown } | undefined) : undefined;
          expectedDim = Array.isArray(first?.embedding) ? first.embedding.length : 0;
        }
        // One vector per input, in input order, finite, non-zero, expected
        // dim — else EmbeddingResponseInvalid (nonRetryable: a wrong-shaped
        // answer is not transient).
        const expectedModel =
          this.config.profile?.endpointClass === "loopback" ? this.config.profile.model : undefined;
        const vectors = validateEmbeddingResponse(data, inputs.length, expectedDim, expectedModel);
        if (this._dimensions === 0) {
          this._dimensions = expectedDim;
          process.stderr.write(`📡 vLLM auto-detected ${this._dimensions}d\n`);
        }

        this._httpOk++;
        const reported = data.usage?.prompt_tokens;
        if (typeof reported === "number" && Number.isInteger(reported) && reported >= 0) {
          this._reportedPromptTokens += reported;
          this._okWithUsage++;
        } else {
          this._okWithoutUsage++;
        }
        return vectors;
      } catch (err) {
        this._httpFailed++;
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

import {
  assertInputsFit,
  EmbeddingRuntimeRefusedLength,
  getProfile,
  isContextLengthRefusal,
  isLoopbackEndpoint,
  nativeEmbedBody,
  nativeToValidatable,
  validateEmbeddingResponse,
  verifyRuntimeIdentity,
  type EmbeddingProfile,
} from "./embedding-profile.js";

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
  providerType: "vllm" | "openrouter",
): VLLMProvider | null {
  // A provider comes ONLY from a known generation profile. There is no
  // model-string path, no preset and no dimension default (2026-11-25): an
  // env without ANDENKEN_<NS>_PROFILE builds nothing.
  const profileId = read("PROFILE");
  if (profileId === undefined) {
    process.stderr.write(`⚠ ${nameTag} provider: ${"PROFILE"} not set — refused (no fallback)\n`);
    return null;
  }
  return buildVllmFromProfile(read, nameTag, profileId, providerType);
}

function parsePositiveInt(v: string): number | null {
  return /^[1-9][0-9]*$/.test(v.trim()) ? parseInt(v.trim(), 10) : null;
}

/**
 * `ANDENKEN_<NS>_PROFILE=<id>`: the provider is fully defined by a known
 * embedding profile. Every geometry-deciding env key that is also set must
 * AGREE with the profile — a conflicting MODEL or DIMENSIONS is a refusal, not
 * an override, so one stale line in ~/.env.local cannot mix generations.
 * Loopback profiles take their fixed endpoint and refuse any other host.
 */
function buildVllmFromProfile(
  read: (suffix: string) => string | undefined,
  nameTag: string,
  profileId: string,
  providerType: "vllm" | "openrouter",
): VLLMProvider | null {
  const profile = getProfile(profileId);
  const refuse = (why: string) => {
    process.stderr.write(`⚠ ${nameTag} provider: profile ${profileId} — ${why} — refused\n`);
    return null;
  };
  if (!profile) return refuse("unknown profile");
  // OpenRouter generation belongs to the Oracle producer only: a hosted profile
  // is a STORE identity here (what the harvest's vectors are), never something
  // andenken embeds with — so no paid query path exists to fall back to.
  if (profile.endpointClass !== "loopback") return refuse("hosted generation is a store identity only; andenken embeds only with a loopback profile");
  if (profile.endpointClass === "loopback" && providerType !== "vllm") return refuse(`PROVIDER=${providerType} contradicts a loopback profile (use vllm)`);
  const model = read("MODEL");
  if (model !== undefined && model !== profile.model) return refuse(`MODEL ${model} ≠ ${profile.model}`);
  const dimStr = read("DIMENSIONS");
  if (dimStr !== undefined && parsePositiveInt(dimStr) !== profile.dimensions) {
    return refuse(`DIMENSIONS ${dimStr} ≠ ${profile.dimensions}`);
  }
  for (const k of ["QUERY_INSTRUCTION", "DOCUMENT_INSTRUCTION"] as const) {
    const v = read(k);
    const want = k === "QUERY_INSTRUCTION" ? profile.queryInstruction : profile.documentInstruction;
    if (v !== undefined && v !== want) return refuse(`${k} differs from the profile`);
  }
  if (read("TRUNCATE_DIMENSIONS") !== undefined) return refuse("TRUNCATE_DIMENSIONS is not allowed with a profile");
  const endpoint = read("ENDPOINT") ?? profile.endpoint;
  if (!endpoint) return refuse("ENDPOINT not set");
  // Loopback profiles: any loopback host:port. WHICH weights answer is proven
  // by the runtime digest before the first request (ensureRuntimeIdentity),
  // so the port is a placement fact, not an identity claim.
  if (profile.endpointClass === "loopback" && !isLoopbackEndpoint(endpoint)) return refuse("endpoint is not loopback");
  const paid = read("PAID_REMOTE");
  if (paid !== undefined && (paid === "1") !== profile.paidRemote) return refuse("PAID_REMOTE disagrees with the profile");
  const batchStr = read("MAX_BATCH_SIZE");
  let maxBatchSize = profile.maxBatchSize;
  if (batchStr !== undefined) {
    const b = parsePositiveInt(batchStr);
    if (b === null || b > profile.maxBatchSize) return refuse(`MAX_BATCH_SIZE must be 1..${profile.maxBatchSize}`);
    maxBatchSize = b;
  }
  const timeoutStr = read("TIMEOUT_MS");
  let timeoutMs = profile.timeoutMs;
  if (timeoutStr !== undefined) {
    const t = parsePositiveInt(timeoutStr);
    if (t === null || t > profile.timeoutMs) return refuse(`TIMEOUT_MS must be 1..${profile.timeoutMs}`);
    timeoutMs = t;
  }
  const priceStr = read("PRICE_PER_M_TOKENS");
  const parsedPrice = priceStr !== undefined ? parseFloat(priceStr) : NaN;
  return new VLLMProvider({
    endpoint,
    model: profile.model,
    dimensions: profile.dimensions,
    queryInstruction: profile.queryInstruction,
    documentInstruction: profile.documentInstruction,
    maxBatchSize,
    apiKey: profile.endpointClass === "loopback" ? undefined : read("API_KEY"),
    timeoutMs,
    nameTag: `${nameTag}:${profile.id}`,
    paidRemote: profile.paidRemote,
    pricePerMillionInputTokens: Number.isFinite(parsedPrice) ? parsedPrice : undefined,
    profile,
  });
}

// --- Namespaced provider factories ---
//
// Each track reads its own env namespace (ANDENKEN_SESSION_*, ANDENKEN_MD_*,
// ANDENKEN_OPENCLAW_QUERY_*) so a misconfiguration on one cannot bleed into
// another. No namespace falls back to a legacy or shared one.

/**
 * The SESSIONS provider from `ANDENKEN_SESSION_*`. Built ONLY from a known generation
 * profile (`ANDENKEN_SESSION_PROFILE`, e.g. `ollama-bge-m3-1024`); `ANDENKEN_SESSION_PROVIDER` may be
 * unset or `vllm`. No model-string path, no preset, no Gemini, no fallback:
 * an absent namespace builds nothing (null).
 */
export function createSessionProviderFromEnv(): EmbeddingProvider | null {
  return buildFromNamespace((suffix: string) => readEnvWithFileFallback("ANDENKEN_SESSION_" + suffix), "sessions");
}

/**
 * The MD provider from `ANDENKEN_MD_*`. Built ONLY from a known generation
 * profile (`ANDENKEN_MD_PROFILE`, e.g. `ollama-bge-m3-1024`); `ANDENKEN_MD_PROVIDER` may be
 * unset or `vllm`. No model-string path, no preset, no Gemini, no fallback:
 * an absent namespace builds nothing (null).
 */
export function createMdProviderFromEnv(): EmbeddingProvider | null {
  return buildFromNamespace((suffix: string) => readEnvWithFileFallback("ANDENKEN_MD_" + suffix), "md");
}

/**
 * OpenClaw QUERY provider from `ANDENKEN_OPENCLAW_QUERY_*` (same profile-only
 * rules). Null when the namespace is absent; the caller then uses the sessions
 * provider, and the store's generation stamp (or an explicit query
 * attestation) decides whether that provider may query the harvest at all.
 */
export function createOpenclawQueryProviderFromEnv(): EmbeddingProvider | null {
  const read = (suffix: string) => readEnvWithFileFallback("ANDENKEN_OPENCLAW_QUERY_" + suffix);
  if (read("PROFILE") === undefined && read("PROVIDER") === undefined) return null;
  const p = buildFromNamespace(read, "openclaw-query");
  if (!p) throw new Error("ANDENKEN_OPENCLAW_QUERY_* is set but does not build a provider — refused");
  return p;
}

/** Shared namespaced builder: profile only; PROVIDER, when given, must be vllm. */
function buildFromNamespace(read: (suffix: string) => string | undefined, tag: string): VLLMProvider | null {
  const rawType = read("PROVIDER");
  if (read("PROFILE") === undefined && rawType === undefined) return null;
  if (rawType !== undefined && rawType !== "vllm") {
    process.stderr.write(`⚠ ${tag} provider: PROVIDER=${rawType} refused (profile generations are served by a loopback vllm/OpenAI-compatible runtime)\n`);
    return null;
  }
  return buildVllmFromNamespacedEnv(read, `${tag}:vllm`, "vllm");
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



// --- Re-exports for backward compatibility ---
// Consumers that still import from gemini-embeddings.ts continue to work.
// New code should use EmbeddingProvider interface.

export { runWithConcurrency, DEFAULT_CONCURRENCY } from "./gemini-embeddings.js";
