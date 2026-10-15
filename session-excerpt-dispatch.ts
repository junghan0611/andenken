/**
 * One excerpt door for a session search hit, shared by the CLI
 * (`search --with-excerpt`) and the pi tool (`session_search withExcerpt`).
 *
 * The unit is explicit: a JSONL hit's window is in file lines, a pi-durable
 * hit's window is in ENTRY ids of the hit's conversation (lineNumber stores
 * the entry id; a split part returns to its whole entry). A durable read that
 * the reader refuses comes back as a named `unsupported` with the command that
 * reads it, never as an empty excerpt.
 *
 * API 0. DB writes 0.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readDurableAround, readDurableRange, DurableReadRefused, type DurableOrigin } from "./durable-reader.js";
import { rootLineage } from "./durable-plan.js";
import { readSessionExcerpt } from "./session-excerpt.js";

/** Absolute run.sh of this checkout (this module may run from dist/), so a printed command works from any cwd. */
function runSh(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(path.basename(here) === "dist" ? path.dirname(here) : here, "run.sh");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function durableReadCommand(file: string, entryId: number): string {
  return `${runSh()} durable:read ${shellQuote(file)} --around ${entryId}`;
}

export interface HitExcerpt {
  unit: "jsonl-line" | "durable-entry";
  startLine: number;
  endLine: number;
  truncated: boolean;
  text: string;
  /** pi-durable only: provenance of the window. */
  session?: string | null;
  lineage?: string | null;
  entry?: number;
  /** pi-durable only: inputs answered inside the window whose own entry lies outside it, with one line of each. */
  answeredInputs?: Array<{ answerEntryId: number; submissionId: number; entryId: number | null; origin: DurableOrigin; line: string | null }>;
  /** pi-durable only: the command that reads a wider window. */
  read?: string;
}

export interface HitUnsupported {
  unsupported: string;
  read?: string;
}

export interface ExcerptHit {
  source?: string;
  sessionFile: string;
  lineNumber: number;
}

/** Entries before/after the hit; at least 1 so a turn's prompt or answer is never cut off. */
export const DURABLE_EXCERPT_WINDOW = { before: 3, after: 3, maxChars: 800 };

export async function readHitExcerpt(hit: ExcerptHit): Promise<HitExcerpt | HitUnsupported | null> {
  if (hit.source === "pi-durable") {
    const { before, after, maxChars } = DURABLE_EXCERPT_WINDOW;
    try {
      const r = await readDurableAround(hit.sessionFile, hit.lineNumber, before, after, { maxChars });
      const label = (o: DurableOrigin) => (o === "human" ? "GLG" : o);
      const text = r.entries
        .filter((e) => e.kind !== "pi.system")
        .map((e) => {
          const mark = e.entryId === hit.lineNumber ? ">>" : "  ";
          const calls = e.toolCalls.map((c) => `[tool: ${c.name}]`).join(" ");
          const body = [e.text, calls].filter(Boolean).join(" ");
          return `${mark} e${e.entryId} ${label(e.origin)}${e.truncated ? ` (cut ${e.text.length}/${e.chars})` : ""}: ${body}`;
        })
        .join("\n");
      const ids = r.entries.map((e) => e.entryId);
      // Answers in the window whose prompt sits outside it: name the prompt and give
      // one line of it, read entry by entry (no wider window).
      const pointers: NonNullable<HitExcerpt["answeredInputs"]> = [];
      for (const e of r.entries) {
        for (const a of e.answeredInputs) {
          if (a.entryId !== null && ids.includes(a.entryId)) continue;
          let line: string | null = null;
          if (a.entryId !== null) {
            const one = await readDurableRange(hit.sessionFile, { conversationId: e.conversationId, from: a.entryId, to: a.entryId, limit: 1 }, { maxChars: 400 });
            line = one.entries[0]?.text.split("\n").find((l) => l.trim())?.slice(0, 160) ?? null;
          }
          pointers.push({ answerEntryId: e.entryId, submissionId: a.submissionId, entryId: a.entryId, origin: a.origin, line });
        }
      }
      const pointerText = pointers
        .map((p) => `   ↳ e${p.answerEntryId} answers ${p.entryId !== null ? `e${p.entryId}` : `submission ${p.submissionId}`} (${label(p.origin)}): ${p.line ?? "(no placed entry)"}`)
        .join("\n");
      return {
        unit: "durable-entry",
        startLine: Math.min(...ids),
        endLine: Math.max(...ids),
        truncated: r.truncatedEntries > 0,
        text: pointerText ? `${text}\n${pointerText}` : text,
        session: r.snapshot.sessionId,
        lineage: rootLineage(hit.sessionFile).lineage,
        entry: hit.lineNumber,
        ...(pointers.length > 0 ? { answeredInputs: pointers } : {}),
        read: durableReadCommand(hit.sessionFile, hit.lineNumber),
      };
    } catch (err) {
      const reason = err instanceof DurableReadRefused ? err.reason : "read-failed";
      return { unsupported: `pi-durable:${reason}`, read: durableReadCommand(hit.sessionFile, hit.lineNumber) };
    }
  }
  if ((hit.source === "pi" || hit.source === "claude") && hit.sessionFile.endsWith(".jsonl")) {
    try {
      const ex = await readSessionExcerpt(hit.sessionFile, hit.lineNumber);
      return { unit: "jsonl-line", startLine: ex.startLine, endLine: ex.endLine, truncated: ex.truncated, text: ex.text };
    } catch {
      return null; // the JSONL may have rotated since indexing — same silence as before
    }
  }
  return null;
}

export function isHitExcerpt(x: HitExcerpt | HitUnsupported | null | undefined): x is HitExcerpt {
  return !!x && "unit" in x;
}
