/**
 * Gemini Embedding 2 — Native API client
 *
 * Ported from OpenClaw embeddings-gemini.ts pattern.
 * Uses native Google AI API (not openai-compatible) for:
 * - taskType: RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT
 * - outputDimensionality: fixed 768d (cost control)
 * - batchEmbedContents: native batch API
 *
 * Concurrency & retry patterns from OpenClaw manager-embedding-ops.ts:
 * - Parallel file processing (concurrency limit)
 * - Exponential backoff on 429/5xx
 * - Retryable error detection
 */

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-embedding-2-preview";
const VALID_DIMENSIONS = [768] as const;
const MAX_BATCH_SIZE = 100; // Gemini batch limit

// Retry config (OpenClaw pattern, tuned for Tier 1 RPM limits)
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 30000;

// Concurrency config — Tier 1 safe
export const DEFAULT_CONCURRENCY = 2;

// Rate limiting — respect Gemini API RPM limits
// Free tier: 1,500 RPM. Paid tier: 3,000 RPM.
// With batch size 100, each batch = 1 request.
// MIN_REQUEST_INTERVAL_MS ensures we never exceed RPM.
const MIN_REQUEST_INTERVAL_MS = 3000; // 20 RPM max — safe for Free tier TPM limits
let _lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  _lastRequestTime = Date.now();
}

// --- API call tracking (cost transparency) ---
let _apiCallCount = 0;
let _apiTokenEstimate = 0;
const CHARS_PER_TOKEN_ESTIMATE = 2.5; // conservative for Korean-heavy content

export function getApiStats() {
  return {
    calls: _apiCallCount,
    estimatedTokens: _apiTokenEstimate,
    estimatedCostUSD: (_apiTokenEstimate / 1_000_000) * 0.20,
  };
}

export function resetApiStats() {
  _apiCallCount = 0;
  _apiTokenEstimate = 0;
}

function trackApiCall(texts: string[]) {
  _apiCallCount++;
  const chars = texts.reduce((sum, t) => sum + t.length, 0);
  _apiTokenEstimate += Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

export type TaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

export interface GeminiEmbeddingConfig {
  apiKey: string;
  model?: string;
  dimensions?: (typeof VALID_DIMENSIONS)[number];
}

export interface EmbeddingResult {
  values: number[];
}

// --- Retry logic (OpenClaw pattern) ---

function isRetryableError(message: string): boolean {
  return /(rate[_ ]limit|too many requests|429|resource has been exhausted|spending cap|5\d\d|cloudflare)/i.test(
    message,
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  label: string,
): Promise<Response> {
  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;

  while (true) {
    const res = await fetch(url, options);

    if (res.ok) return res;

    const err = await res.text();
    const message = `${label} (${res.status}): ${err.slice(0, 120)}`;

    if (!isRetryableError(message) || attempt >= RETRY_MAX_ATTEMPTS) {
      throw new Error(message);
    }

    const waitMs = Math.min(
      RETRY_MAX_DELAY_MS,
      Math.round(delayMs * (1 + Math.random() * 0.2)),
    );
    // Minimal log for retries
    process.stderr.write(`⟳ ${res.status} retry ${attempt + 1}/${RETRY_MAX_ATTEMPTS} in ${waitMs}ms\n`);
    await sleep(waitMs);
    delayMs *= 2;
    attempt++;
  }
}

// --- Concurrency utility (OpenClaw runTasksWithConcurrency pattern) ---

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<{ results: T[]; errors: number }> {
  if (tasks.length === 0) return { results: [], errors: 0 };

  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length }) as T[];
  let next = 0;
  let errors = 0;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      const index = next;
      next++;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch {
        errors++;
      }
    }
  });

  await Promise.allSettled(workers);
  return { results, errors };
}

// --- Public API ---

/**
 * Embed a single text for query (search time)
 */
export async function embedQuery(
  text: string,
  config: GeminiEmbeddingConfig,
): Promise<number[]> {
  return embedSingle(text, "RETRIEVAL_QUERY", config);
}

/**
 * Embed a single text for document (index time)
 */
export async function embedDocument(
  text: string,
  config: GeminiEmbeddingConfig,
): Promise<number[]> {
  return embedSingle(text, "RETRIEVAL_DOCUMENT", config);
}

/**
 * Embed multiple texts for documents (index time, batch)
 * Uses batchEmbedContents API (up to 100 per request)
 * Includes retry with exponential backoff on 429/5xx
 */
export async function embedDocumentBatch(
  texts: string[],
  config: GeminiEmbeddingConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embedDocument(texts[0], config)];

  const model = config.model ?? DEFAULT_MODEL;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const url = `${GEMINI_BASE_URL}/models/${model}:batchEmbedContents`;

    const body: Record<string, unknown> = {
      requests: batch.map((text) => {
        const req: Record<string, unknown> = {
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
        };
        if (config.dimensions) {
          req.outputDimensionality = config.dimensions;
        }
        return req;
      }),
    };

    await rateLimit();
    trackApiCall(batch);
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
      `Gemini batch embed`,
    );

    const data = (await res.json()) as { embeddings: EmbeddingResult[] };
    results.push(...data.embeddings.map((e) => e.values));
  }

  return results;
}

// --- Internal ---

async function embedSingle(
  text: string,
  taskType: TaskType,
  config: GeminiEmbeddingConfig,
): Promise<number[]> {
  await rateLimit();
  trackApiCall([text]);
  const model = config.model ?? DEFAULT_MODEL;
  const url = `${GEMINI_BASE_URL}/models/${model}:embedContent`;

  const body: Record<string, unknown> = {
    content: { parts: [{ text }] },
    taskType,
  };
  if (config.dimensions) {
    body.outputDimensionality = config.dimensions;
  }

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
      },
      body: JSON.stringify(body),
    },
    `Gemini embed`,
  );

  const data = (await res.json()) as { embedding: EmbeddingResult };
  return data.embedding.values;
}
