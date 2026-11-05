/**
 * index-finalize.ts — the end of a document indexing run, one seam for the
 * sessions and md indexers. Order is the checkpoint contract:
 *
 *   run → flush → persist → (success only) onSuccess → summary → close → rethrow
 *
 * - Rows are flushed before the manifest is persisted. A flush failure skips
 *   persist, so the manifest does not advance past rows that never landed.
 * - Files that completed are persisted even when others failed — partial
 *   success is kept — and the run still fails with `IndexRunFailed`, so the
 *   process exits non-zero and sync-sessions.sh does not publish.
 * - The summary is printed on every outcome, and printing it is part of the
 *   contract: when the run itself succeeded, a summary or log failure is the
 *   run's error (close still runs, then it is thrown — non-zero). When the run
 *   already failed, that error is kept; a summary, log or close failure never
 *   replaces it. If the summary fails, one fallback warning is attempted; its
 *   own failure does not replace the summary error.
 */

import { formatProviderErrorMeta, type EmbeddingStats } from "./embedding-provider.js";
import type { RateLimitTelemetry } from "./embed-retry.js";

export class IndexRunFailed extends Error {
  constructor(
    readonly label: string,
    readonly failedFiles: number,
  ) {
    super(`${label} indexing failed for ${failedFiles} files`);
    this.name = "IndexRunFailed";
  }
}

export interface FinalizeOutcome {
  ok: boolean;
  failedFiles: number;
  persisted: boolean;
}

export interface FinalizeDeps {
  label: string;
  run(): Promise<{ errors: number }>;
  flush(): Promise<void>;
  persist(): void;
  onSuccess?(): Promise<void>;
  summary(outcome: FinalizeOutcome): string[];
  log(line: string): void;
  close(): Promise<void>;
}

export async function finalizeIndexRun(d: FinalizeDeps): Promise<void> {
  let failedFiles = 0;
  let persisted = false;
  let failed = false;
  let primary: unknown;
  try {
    failedFiles = (await d.run()).errors;
    await d.flush();
    d.persist();
    persisted = true;
    if (failedFiles > 0) throw new IndexRunFailed(d.label, failedFiles);
    await d.onSuccess?.();
  } catch (e) {
    failed = true;
    primary = e;
  }
  try {
    for (const line of d.summary({ ok: !failed, failedFiles, persisted })) d.log(line);
  } catch (e) {
    if (!failed) {
      failed = true;
      primary = e;
    }
    try {
      d.log("⚠ run summary unavailable");
    } catch { /* the error recorded above stands */ }
  }
  try {
    await d.close();
  } catch (e) {
    if (!failed) {
      failed = true;
      primary = e;
    }
  }
  if (failed) throw primary;
}

export type RetryReport =
  | { kind: "on"; telemetry: RateLimitTelemetry }
  | { kind: "off"; why: string };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * API lines for the run summary. Counters keep their own names: provider
 * calls (resubmissions included), HTTP attempts, provider-reported usage,
 * and — when the rescheduler ran — slices and inner calls. None of them is a
 * unique-request count, and the bill is not known here.
 */
export function formatApiSummary(stats: EmbeddingStats, retry: RetryReport): string[] {
  const lines = [
    `💰 API: ${stats.calls} provider calls (resubmissions included), ` +
      `~${(stats.estimatedTokens / 1000).toFixed(0)}K submitted-input tokens (estimate), ` +
      `~$${stats.estimatedCostUSD.toFixed(3)} (estimate); actual bill unknown; ` +
      `this process only — the shell's preflight probe is not counted`,
  ];
  if (stats.httpAttempts !== undefined) {
    const ok = stats.httpOk ?? 0;
    const withUsage = stats.okWithUsage ?? 0;
    const tokens = stats.reportedPromptTokens ?? 0;
    const usage =
      ok === 0
        ? "n/a (no ok response)"
        : withUsage === 0
          ? `unknown (0/${ok} ok responses reported usage)`
          : withUsage < ok
            ? `≥${tokens} (partial: ${withUsage}/${ok} ok responses reported usage)`
            : `${tokens} (${withUsage}/${ok} ok responses reported usage)`;
    lines.push(
      `🌐 HTTP: ${stats.httpAttempts} attempts (ok ${ok}, failed ${stats.httpFailed ?? 0}); ` +
        `provider-reported prompt tokens: ${usage}`,
    );
  }
  if (retry.kind === "off") {
    lines.push(`⟳ 429 retry: off — ${retry.why}`);
    return lines;
  }
  const t = retry.telemetry;
  lines.push(
    `⟳ 429 retry: slices ${t.slices} | inner calls ${t.innerCalls} ` +
      `(resubmissions ${t.resubmissions}, ${t.resubmittedTexts} texts) | ` +
      `429 seen ${t.rateLimited}, recovered ${t.recovered} | ` +
      `scheduled shared pause ${secs(t.sharedPauseMs)}, scheduled worker wait ${secs(t.workerWaitMs)} | ` +
      `stopped: ${t.stopped ?? "no"} | refused before a provider call: ${t.refusedSlices} | ` +
      `discarded embedded texts: ${t.discardedTexts}`,
  );
  if (t.lastRateLimit) lines.push(`   last 429: status=${t.lastRateLimit.status} ${formatProviderErrorMeta(t.lastRateLimit)}`);
  return lines;
}
