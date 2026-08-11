/**
 * andenken recall log — the append-only trace of what retrieval actually returned.
 *
 * WHY THIS MODULE EXISTS
 *
 * Two identical copies of `recordRecall` lived in `cli.ts` and `index.ts`. That
 * was tolerable while the only requirement was "append best-effort". It stopped
 * being tolerable once the acceptance runner started driving the real search
 * surfaces: every acceptance probe is a genuine query, so it lands in this log
 * and pollutes exactly the statistic the log exists to support.
 *
 * OpenClaw's dreaming promotes memory on *recall statistics* — recall count and
 * unique-query count — which is the evidence-gated design worth copying (see
 * COMPARISON.md §14.4). A promotion gate fed by its own test harness is not
 * evidence-gated; it is a mirror. Hence the guard below.
 *
 * `ANDENKEN_DISABLE_RECALL_TRACKING=1` suppresses the append and nothing else.
 * Retrieval behaviour, ranking, and output are untouched. Normal production
 * calls (agents, the emacs wrapper, a human running `./run.sh search`) do not
 * set it and keep logging exactly as before.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir, type SearchResult } from "./store.js";

export const RECALL_TRACKING_ENV = "ANDENKEN_DISABLE_RECALL_TRACKING";

/** Truthy values are deliberately narrow — a stray "0" must not disable logging. */
export function isRecallTrackingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[RECALL_TRACKING_ENV];
  return v === "1" || v === "true";
}

export function getRecallLogPath(): string {
  return path.join(getDataDir(), "recalls.jsonl");
}

export interface RecallContext {
  /** Rows the caller ASKED for. Absent when the surface did not pass one. */
  limit?: number;
}

/**
 * Append one recall record. Best-effort: search must never fail because the
 * trace could not be written.
 *
 * `limit` / `returned` are additive keys (2026-08-11). Without them the log
 * cannot answer "what limit do callers actually use", so every default-limit
 * argument rested on a single observed task. Readers must treat both as
 * optional: rows written before this change carry neither. Note that
 * `resultIds` stays capped at 5 — it is a first-screen trace, not a full
 * result dump — so `returned` is the only witness of how many rows a caller
 * actually received.
 */
export function recordRecall(
  query: string,
  tool: string,
  results: SearchResult[],
  context: RecallContext = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isRecallTrackingDisabled(env)) return;
  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      query,
      tool,
      ...(context.limit !== undefined ? { limit: context.limit } : {}),
      returned: results.length,
      resultIds: results.slice(0, 5).map((r) => r.id),
      topScore: results[0]?.score ?? 0,
    });
    fs.appendFileSync(getRecallLogPath(), entry + "\n");
  } catch {
    // best-effort — never block search
  }
}
