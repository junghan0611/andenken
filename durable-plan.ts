/**
 * API-0 embedding PLAN for one closed pi-durable snapshot (issue #15, purpose 1).
 *
 * This is not an indexer. It writes nothing, embeds nothing and touches no
 * store or manifest. It reads a closed snapshot through durable-reader.ts
 * (same refusals) and says, for every stored entry, what two candidate
 * admission policies would do with it and why:
 *
 *   B  human-run text: GLG turns, compaction/handoff, and assistant text inside
 *      a human input's run bounded by EXPLICIT endpoints (the input entry and
 *      its done `answer`). Version B.1 (2026-10-15): another human input steered
 *      into the run is not a mix — both are GLG's. B.1 is the initial
 *      production policy (`DURABLE_POLICY`).
 *   C  root/fork assistant text: every normal assistant text outside task-owned
 *      child conversations, whoever started the run. Plan comparison only.
 *
 * Decisions are include / hold / ambiguous / exclude, each with a basis:
 *   hold       the run is still open in this snapshot (input placed, no answer);
 *              a later snapshot settles it. `watermark.safeProcessedId` is the
 *              highest entry id an incremental indexer could mark processed
 *              without skipping held entries.
 *   ambiguous  the run's range also holds a non-human input (a doorbell, a host
 *              input kind, an unsubmitted continuation, …), or the explicit
 *              answer serves a non-human input too. Same conversation plus an
 *              entry range is not proof of whom the text answers.
 *
 * GLG turns carry no length floor (only empty text is excluded) and an
 * `unknown` origin is never treated as human. The plan carries no entry text;
 * `durable:read <file> --around <entryId>` reads any candidate.
 *
 * SDK facts relied on (pi-durable 1.2.0): a run's answer entry and its inputs'
 * done+answer settlement are one commit (harness/generation.js answer(),
 * harness/live.js endRun), so a snapshot that shows an answer entry also shows
 * the settlement; endRun settles every input of the run with the same answer.
 */

import {
  censusDurable,
  openDurableSnapshot,
  readDurableRange,
  type DurableEntryView,
  type DurableSnapshotInfo,
  type OpenOptions,
} from "./durable-reader.js";

export type PlanDecision = "include" | "hold" | "ambiguous" | "exclude";

export interface PlanVerdict {
  decision: PlanDecision;
  basis: string;
}

export interface PlanCandidate {
  entryId: number;
  conversationId: number;
  scope: string;
  kind: string;
  origin: string;
  /** Embedding role the row would take if included. */
  role: "user" | "assistant" | "compaction" | null;
  chars: number;
  B: PlanVerdict;
  C: PlanVerdict;
}

export interface PlanTotals {
  entries: number;
  chars: number;
  estTokens: number;
}

export interface DurablePlan {
  snapshot: DurableSnapshotInfo & { lineage: string | null; lineageBasis: string };
  assumptions: string[];
  watermark: { maxEntryId: number; safeProcessedId: number; heldBy: number | null };
  totals: { B: Record<PlanDecision, PlanTotals>; C: Record<PlanDecision, PlanTotals> };
  candidates: PlanCandidate[];
}

/** Admission policy version the indexer records per file; a different version is refused, never mixed. */
export const DURABLE_POLICY = "B.1";
/** The sessions estimate heuristic (indexer.ts estimate: chars / 2.5, as VLLMProvider estimates tokens). */
export const CHARS_PER_TOKEN = 2.5;
const NORMAL_STOPS = new Set(["stop", "length", "toolUse"]);
/** User-role entries that open or interrupt a run. */
const OPENER_ORIGINS = new Set([
  "human", "entwurf-brief", "entwurf-doorbell", "subagent-brief", "background-report", "input-entry", "unsubmitted", "unknown",
]);

export function rootLineage(file: string, options: OpenOptions = {}): { lineage: string | null; basis: string } {
  const { db } = openDurableSnapshot(file, options);
  try {
    const row = db
      .prepare(
        `SELECT r.content AS content FROM documents d JOIN document_revisions r ON r.document_id = d.id
         WHERE d.kind = '"pi.provider"' AND d.scope_kind = 'conversation' AND d.owner_id = 1 AND d.retired_at IS NULL
         ORDER BY r.seq DESC LIMIT 1`,
      )
      .get();
    if (!row) return { lineage: null, basis: "root conversation has no pi.provider document (legacy, before its first generation)" };
    try {
      const v = JSON.parse(String(row.content)) as { sessionId?: unknown };
      if (typeof v.sessionId === "string") {
        return { lineage: v.sessionId, basis: "root pi.provider sessionId (created once with the conversation; harness/provider.js)" };
      }
    } catch {
      /* fall through */
    }
    return { lineage: null, basis: "root pi.provider document has no sessionId" };
  } finally {
    db.close();
  }
}

interface HumanRun {
  input: DurableEntryView;
  /** Explicit answer entry id, when the input is done. */
  end: number | null;
  open: boolean;
}

function decideAssistant(
  e: DurableEntryView,
  runs: HumanRun[],
  openers: DurableEntryView[],
): PlanVerdict {
  // An exclusion names the entry's confirmed answer link when it has one; a run
  // position alone is reported as such, never promoted to an attribution.
  const linked = e.answeredInputs.find((a) => a.origin !== "human");
  const exclude = (position: string): PlanVerdict => ({
    decision: "exclude",
    basis: linked
      ? `explicit answer of ${linked.entryId !== null ? `e${linked.entryId}` : `submission ${linked.submissionId}`} (${linked.origin})`
      : `${position}; no explicit answer link (run attribution not inferred)`,
  });

  // The latest human input before this entry in the same conversation.
  const run = [...runs].reverse().find((r) => r.input.entryId < e.entryId);
  if (!run) return exclude("no human input precedes it in this conversation");
  const h = run.input.entryId;

  if (run.end !== null && e.answers.includes(run.input.submission!.id)) {
    if (linked) {
      return { decision: "ambiguous", basis: `explicit answer of human e${h} and also of e${linked.entryId ?? "?"} (${linked.origin})` };
    }
    return { decision: "include", basis: `explicit answer of human input e${h}` };
  }

  if (run.end !== null) {
    if (e.entryId > run.end) return exclude(`after the run of human e${h} ended at e${run.end}`);
    // B.1: a human input steered into the run is GLG's too, not a mix.
    const intruder = openers.find((o) => o.entryId > h && o.entryId <= run.end! && o.origin !== "human");
    if (intruder) {
      return { decision: "ambiguous", basis: `run e${h}..e${run.end} also holds e${intruder.entryId} (${intruder.origin})` };
    }
    return { decision: "include", basis: `inside human run e${h}..e${run.end} (explicit endpoints, no other input in range)` };
  }

  const next = openers.find((o) => o.entryId > h);
  if (next && next.entryId < e.entryId) return exclude(`after e${next.entryId} (${next.origin}); human e${h} has no explicit answer`);
  if (run.open) return { decision: "hold", basis: `human input e${h} is not answered yet in this snapshot` };
  return exclude(`human input e${h} ended without an answer (${run.input.submission?.status ?? "?"})`);
}

/** Build the plan. Reads the snapshot; writes and embeds nothing. */
export async function planDurable(file: string, options: OpenOptions = {}): Promise<DurablePlan> {
  const census = await censusDurable(file, options);
  const lineage = rootLineage(file, options);
  const candidates: PlanCandidate[] = [];
  let heldBy: number | null = null;

  for (const conv of census.conversations) {
    const entries = (await readDurableRange(file, { conversationId: conv.id, limit: Number.MAX_SAFE_INTEGER - 1 }, options)).entries;
    const openers = entries.filter((e) => OPENER_ORIGINS.has(e.origin) && e.kind !== "pi.assistant");
    const runs: HumanRun[] = entries
      .filter((e) => e.origin === "human" && e.submission)
      .map((e) => ({
        input: e,
        end: e.submission!.answer,
        open: e.submission!.status === "placed" || e.submission!.status === "queued",
      }));
    for (const r of runs) if (r.open && (heldBy === null || r.input.entryId < heldBy)) heldBy = r.input.entryId;

    for (const e of entries) {
      const text = e.text.trim();
      let role: PlanCandidate["role"] = null;
      let B: PlanVerdict;
      let C: PlanVerdict;
      if (e.origin === "human") {
        role = "user";
        B = text ? { decision: "include", basis: "human turn (no length floor; empty excluded)" } : { decision: "exclude", basis: "empty human input" };
        C = B;
      } else if (e.origin === "compaction-summary" || e.origin === "handoff") {
        role = "compaction";
        const what = e.origin === "handoff" ? "handoff text (reset/tool control, not a GLG turn)" : "compaction summary (model-written)";
        B = text ? { decision: "include", basis: `${what}, role compaction` } : { decision: "exclude", basis: `empty ${e.origin}` };
        C = B;
      } else if (e.origin === "assistant") {
        role = "assistant";
        if (!text) {
          B = C = { decision: "exclude", basis: "assistant entry without text" };
        } else if (!NORMAL_STOPS.has(e.stopReason ?? "")) {
          B = C = { decision: "exclude", basis: `assistant stop=${e.stopReason ?? "?"}` };
        } else {
          C = e.scope === "task-owned"
            ? { decision: "exclude", basis: "task-owned child conversation (subagent)" }
            : { decision: "include", basis: `${e.scope} assistant text, stop=${e.stopReason}` };
          B = decideAssistant(e, runs, openers);
        }
      } else {
        B = C = { decision: "exclude", basis: `origin ${e.origin} is readable-only` };
      }
      candidates.push({
        entryId: e.entryId,
        conversationId: e.conversationId,
        scope: e.scope,
        kind: e.kind,
        origin: e.origin,
        role,
        chars: e.chars,
        B,
        C,
      });
    }
  }
  candidates.sort((a, b) => a.entryId - b.entryId);

  const empty = (): Record<PlanDecision, PlanTotals> => ({
    include: { entries: 0, chars: 0, estTokens: 0 },
    hold: { entries: 0, chars: 0, estTokens: 0 },
    ambiguous: { entries: 0, chars: 0, estTokens: 0 },
    exclude: { entries: 0, chars: 0, estTokens: 0 },
  });
  const totals = { B: empty(), C: empty() };
  for (const c of candidates) {
    for (const p of ["B", "C"] as const) {
      const t = totals[p][c[p].decision];
      t.entries++;
      t.chars += c.chars;
    }
  }
  for (const p of ["B", "C"] as const) for (const t of Object.values(totals[p])) t.estTokens = Math.ceil(t.chars / CHARS_PER_TOKEN);

  const maxEntryId = census.snapshot.maxEntryId;
  return {
    snapshot: { ...census.snapshot, lineage: lineage.lineage, lineageBasis: lineage.basis },
    assumptions: [
      `estTokens = chars / ${CHARS_PER_TOKEN} (the sessions estimate heuristic); chars are stored text before sanitize and splitting`,
      "compaction/handoff chars include the SDK's summary wrapper",
      `B is ${DURABLE_POLICY}, the initial production admission policy; C is for comparison only`,
      "the watermark applies to B; C depends on no answer and needs no hold",
    ],
    watermark: { maxEntryId, safeProcessedId: heldBy !== null ? heldBy - 1 : maxEntryId, heldBy },
    totals,
    candidates,
  };
}

/** Text form: provenance, assumptions, totals and every non-excluded candidate. No entry text. */
export function renderDurablePlan(plan: DurablePlan): string {
  const s = plan.snapshot;
  const lines: string[] = [];
  lines.push(`# durable plan (API 0 — nothing is written or embedded): ${s.file}`);
  lines.push(`# session=${s.sessionId ?? "-"} device=${s.device ?? "-"} lineage=${s.lineage ?? "-"} project=${s.project ?? "unknown"} schema=${s.schema}`);
  lines.push(`# cwd: ${s.cwdBasis}`);
  for (const a of plan.assumptions) lines.push(`# assume: ${a}`);
  const w = plan.watermark;
  lines.push(`# watermark: maxEntryId=${w.maxEntryId} safeProcessedId=${w.safeProcessedId}${w.heldBy !== null ? ` (held by open human e${w.heldBy})` : ""}`);
  lines.push("");
  lines.push("policy  decision    entries     chars  estTokens");
  for (const p of ["B", "C"] as const) {
    for (const d of ["include", "hold", "ambiguous", "exclude"] as const) {
      const t = plan.totals[p][d];
      lines.push(`${p.padEnd(7)} ${d.padEnd(10)} ${String(t.entries).padStart(8)} ${String(t.chars).padStart(9)} ${String(t.estTokens).padStart(10)}`);
    }
  }
  lines.push("");
  for (const c of plan.candidates) {
    if (c.B.decision === "exclude" && c.C.decision === "exclude") continue;
    lines.push(`e${c.entryId} conv=${c.conversationId} ${c.origin} role=${c.role ?? "-"} chars=${c.chars}`);
    lines.push(`   B ${c.B.decision}: ${c.B.basis}`);
    if (c.C.decision !== c.B.decision || c.C.basis !== c.B.basis) lines.push(`   C ${c.C.decision}: ${c.C.basis}`);
  }
  const excluded: Record<string, number> = {};
  for (const c of plan.candidates) if (c.B.decision === "exclude" && c.C.decision === "exclude") excluded[c.origin] = (excluded[c.origin] ?? 0) + 1;
  lines.push("");
  lines.push(`# excluded by both, by origin: ${Object.entries(excluded).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`);
  return lines.join("\n");
}
