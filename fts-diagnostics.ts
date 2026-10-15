/**
 * Request-local diagnostics for the full-text (BM25) leg (issue #16).
 *
 * `VectorStore.fullTextSearch()` keeps returning rows only. An optional
 * observer receives exactly one `FtsDiagnostic` per call. The codes are a fixed,
 * safe vocabulary: a native error message, the query, a row or a path never
 * travels with them.
 *
 * A consumer that serves one request collects its calls in a
 * `FtsDiagnosticsCollector`. The worst outcome wins, so a later `ok` never hides
 * an earlier failure, and a request whose FTS never ran (mode=recent) reports
 * `not-run` instead of passing for healthy. A collector belongs to one request;
 * nothing here is global.
 */

export type FtsDiagnostic =
  | { status: "ok" }
  | { status: "unavailable"; code: "no-table" | "no-fts-index" }
  | { status: "error"; code: "query-failed" | "row-decode-failed" };

export type FtsRequestDiagnostic = FtsDiagnostic | { status: "not-run" };

const SEVERITY: Record<FtsDiagnostic["status"], number> = { ok: 0, unavailable: 1, error: 2 };

export class FtsDiagnosticsCollector {
  private worst: FtsDiagnostic | null = null;

  /** The observer to hand to `fullTextSearch`; bound, so it can be passed as is. */
  readonly observe = (d: FtsDiagnostic): void => {
    if (this.worst === null || SEVERITY[d.status] > SEVERITY[this.worst.status]) this.worst = d;
  };

  result(): FtsRequestDiagnostic {
    return this.worst ?? { status: "not-run" };
  }

  /** True only when FTS ran and did not succeed. `not-run` is not degraded. */
  get degraded(): boolean {
    return this.worst !== null && this.worst.status !== "ok";
  }
}

/** A one-line note for a model or a terminal, or null when there is nothing to say. */
export function ftsNote(d: FtsRequestDiagnostic, axis: string): string | null {
  if (d.status === "ok" || d.status === "not-run") return null;
  return `${axis} full-text (BM25) leg ${d.status}: ${d.code}; results come from the other legs only`;
}

function isDegraded(d: FtsRequestDiagnostic | undefined): boolean {
  return d !== undefined && (d.status === "unavailable" || d.status === "error");
}

/** The additive fields a request reports: CLI JSON top level, pi `details`. */
export interface FtsRequestReport {
  degraded: boolean;
  diagnostics: { fts: FtsRequestDiagnostic; fallbackFts?: FtsRequestDiagnostic };
}

/**
 * Summarize one request. `fallbackFts` is the md fallback's own FTS outcome,
 * given only when that search ran; it is omitted otherwise. `degraded` is true
 * when ANY leg that ran was degraded. Whether fallback rows were merged stays
 * the caller's separate `fallback` flag; this summary never redefines it.
 */
export function ftsRequestReport(fts: FtsRequestDiagnostic, fallbackFts?: FtsRequestDiagnostic): FtsRequestReport {
  return {
    degraded: isDegraded(fts) || isDegraded(fallbackFts),
    diagnostics: fallbackFts ? { fts, fallbackFts } : { fts },
  };
}

/**
 * Put a report on a pi tool result: one note line on the model-visible text
 * when a leg was degraded, and the report itself in `details`.
 */
export function attachFtsReport(
  output: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> },
  report: FtsRequestReport,
  labels: { fts: string; fallbackFts?: string },
): void {
  const { fts, fallbackFts } = report.diagnostics;
  const notes = [
    ftsNote(fts, labels.fts),
    fallbackFts ? ftsNote(fallbackFts, labels.fallbackFts ?? "fallback") : null,
  ].filter((n): n is string => n !== null);
  if (notes.length > 0) output.content[0].text += `\n\n(⚠ ${notes.join("; ")})`;
  Object.assign(output.details, report);
}
