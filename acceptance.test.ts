#!/usr/bin/env npx tsx
/**
 * Fixture tests for acceptance.ts + recall-log.ts. API 0, no LanceDB, no network.
 *
 * These cover the judgments the acceptance report makes on the steward's behalf
 * — the ones that would quietly mislead if they were wrong:
 *
 *   - a stale index must never be reported as a ranking defect
 *   - a live append must never be reported as a stale index
 *   - zero rows on a time probe must never be a PASS
 *   - numeric diversity must never reach PASS on its own
 *   - two runs that measured different things must never produce a direction
 *   - acceptance probes must never append to the recall log
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  canonicalDocId,
  diversityOf,
  classifyFreshness,
  isLiveAppend,
  expandHome,
  oneLineExcerpt,
  groupByTrack,
  evaluateProbe,
  buildProbeArgs,
  probeApiCost,
  assessProductionContract,
  mergeCasePacks,
  isBindingExpired,
  isUnbound,
  compareRuns,
  buildWindowControlProbe,
  interpretWindowControl,
  loadL3Evidence,
  NO_DIRECTION_VERDICTS,
  resultDigestOf,
  tallyDiagnostics,
  auditRecallLog,
  SCORE_SEMANTICS,
  LIVE_APPEND_WINDOW_MS,
  type AnchorHealth,
  type CliResultRow,
  type Probe,
  type CaseOutcome,
  type AcceptanceReport,
  type ProbeOutcome,
} from "./acceptance.js";
import { isRecallTrackingDisabled, recordRecall, RECALL_TRACKING_ENV } from "./recall-log.js";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

function section(name: string) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
}

// --- helpers ---------------------------------------------------------------

const SESSION_FILE = "/home/x/.claude/projects/-home-x-repos-gh-demo/abc-123.jsonl";
const MD_FILE = "/home/x/repos/gh/notes/content/notes/20250214T145957.md";
const MD_FILE_2 = "/home/x/repos/gh/notes/content/notes/20250727T094722.md";

function row(file: string, score: number, text = "body"): CliResultRow {
  return { file, score, text };
}

function anchor(over: Partial<AnchorHealth>): AnchorHealth {
  return {
    anchor: "~/x",
    resolved: MD_FILE,
    track: "md",
    docId: "md:20250214T145957",
    status: "fresh",
    liveAppend: false,
    observedAt: new Date().toISOString(),
    policy: "payload-hash",
    ...over,
  };
}

function probe(over: Partial<Probe> = {}): Probe {
  return {
    id: "p",
    surface: "search-md",
    query: "q",
    limit: 5,
    rankThreshold: 3,
    evidence: { canonical: ["20250214T145957"] },
    ...over,
  };
}

// --- canonical identity ----------------------------------------------------

section("canonical document identity");
{
  const s = canonicalDocId(SESSION_FILE);
  assert(s.track === "sessions" && s.docId === "session:abc-123", "session file → session docId");
  assert(s.visibility === "private-session", "session rows are labeled private");

  const m = canonicalDocId(MD_FILE);
  assert(m.track === "md" && m.docId === "md:20250214T145957", "md file → Denote-ID docId");
  assert(m.visibility === "public-garden", "garden rows are labeled public");

  const titled = canonicalDocId("/g/notes/20250214T145957--some-title__tag.md");
  assert(titled.docId === "md:20250214T145957", "Denote ID survives a title/tag suffix rename");

  const plain = canonicalDocId("/g/notes/handwritten.md");
  assert(plain.docId === "md:handwritten", "non-Denote md falls back to its stem");
  assert(canonicalDocId("").docId === "other:", "empty path does not throw");
}

section("document-level diversity");
{
  const d = diversityOf([MD_FILE, MD_FILE, MD_FILE_2]);
  assert(d.uniqueDocs === 2, "adjacent chunks of one note count as ONE document");
  assert(d.maxChunksPerDoc === 2, "per-document share is counted on documents, not chunks");
  assert(Math.abs(d.monopolyRatio - 2 / 3) < 1e-9, "monopoly ratio is share of the screen");
  assert(diversityOf([]).uniqueDocs === 0, "empty result set does not throw");
}

section("track grouping");
{
  const g = groupByTrack([{ file: SESSION_FILE }, { file: MD_FILE }, { file: MD_FILE_2 }]);
  assert(g.length === 2, "sessions and md become two groups, never one ranking");
  const md = g.find((x) => x.track === "md")!;
  assert(md.rows === 2 && md.uniqueDocs === 2, "group counts rows and documents separately");
}

// --- freshness -------------------------------------------------------------

section("freshness classification");
{
  const stat = { size: 100, mtimeMs: 1000 };
  assert(classifyFreshness({ size: 100, mtimeMs: 1000 }, stat, true) === "fresh", "exact match → fresh");
  assert(classifyFreshness({ size: 90, mtimeMs: 1000 }, stat, true) === "stale", "size drift → stale");
  assert(
    classifyFreshness({ size: 100, mtimeMs: 900 }, stat, true) === "fresh",
    "sessions use size growth: an append-only transcript at the same size is unchanged",
  );

  // md follows the indexer's payload-hash policy, not a size guess.
  const md = (entry: Parameters<typeof classifyFreshness>[0], hash: string | null) =>
    classifyFreshness(entry, stat, true, { payloadHash: hash });
  assert(
    md({ size: 100, mtimeMs: 900, payloadHash: "H" }, "H") === "fresh",
    "md same size + matching payload hash → fresh",
  );
  assert(
    md({ size: 100, mtimeMs: 900, payloadHash: "H" }, "OTHER") === "stale",
    "md same size + MISMATCHED payload hash → stale (equal bytes never proved equal payload)",
  );
  assert(
    md({ size: 100, mtimeMs: 900 }, "H") === "unknown",
    "md legacy entry with no stored hash → unknown; the indexer would re-embed it, so we must not call it healthy",
  );
  assert(
    md({ size: 100, mtimeMs: 900, payloadHash: "H" }, null) === "unknown",
    "md hash uncomputable → unknown, decided by nobody",
  );
  assert(
    md({ size: 90, mtimeMs: 1000, payloadHash: "H" }, "H") === "stale",
    "a size change is stale regardless of hash",
  );
  assert(
    classifyFreshness({ size: 100, mtimeMs: 1000.4 }, stat, true) === "fresh",
    "sub-millisecond mtime jitter is not staleness (JSON round-trip tolerance)",
  );
  assert(classifyFreshness(undefined, stat, true) === "unindexed", "no entry → unindexed");
  assert(classifyFreshness(undefined, undefined, true) === "source-missing", "no file → source-missing");
  assert(
    classifyFreshness(undefined, stat, false) === "no-manifest",
    "no manifest → cannot judge, reported as such",
  );

  const now = 10_000_000;
  assert(isLiveAppend({ size: 1, mtimeMs: now - 60_000 }, now), "a 1-minute-old write is a live append");
  assert(
    !isLiveAppend({ size: 1, mtimeMs: now - LIVE_APPEND_WINDOW_MS - 1 }, now),
    "past the window it is no longer a live append",
  );
}

section("path expansion");
{
  assert(expandHome("~/a/b") === path.join(os.homedir(), "a/b"), "~/ expands to home");
  assert(expandHome("/abs") === "/abs", "absolute path is untouched");
  assert(expandHome("~notuser/x") === "~notuser/x", "~user form is not mangled");
}

// --- grading ---------------------------------------------------------------

section("lookup grading");
{
  const found = evaluateProbe("c", probe(), [row(MD_FILE, 1.0), row(MD_FILE_2, 0.9)], {
    caseType: "lookup",
    anchors: [anchor({})],
  });
  assert(found.verdict === "pass" && found.expectedRank === 1, "canonical at rank 1 → pass");
  assert(found.evidence![0].label === "canonical", "canonical row is labeled in the evidence table");

  const pushed = evaluateProbe(
    "c",
    probe({ rankThreshold: 1 }),
    [row(MD_FILE_2, 1), row(MD_FILE, 0.9)],
    { caseType: "lookup", anchors: [anchor({})] },
  );
  assert(
    pushed.verdict === "weak-pass" && pushed.expectedRank === 2,
    "found but past the threshold → weak-pass, not fail (progress stays visible)",
  );

  const narrow = evaluateProbe(
    "c",
    probe({ guardrails: { maxChunksPerDoc: 1 } }),
    [row(MD_FILE, 1), row(MD_FILE, 0.9)],
    { caseType: "lookup", anchors: [anchor({})] },
  );
  assert(
    narrow.verdict === "pass" && narrow.warnings.length > 0,
    "for a narrow lookup, one document dominating is a WARNING, not a failure",
  );

  // Monopoly is worth saying even when no guardrail was declared: four of five
  // rows from one session is a smaller screen than the row count suggests.
  const undeclared = evaluateProbe(
    "c",
    probe(),
    [row(MD_FILE, 1), row(MD_FILE, 0.9), row(MD_FILE, 0.8), row(MD_FILE_2, 0.7)],
    { caseType: "lookup", anchors: [anchor({})] },
  );
  assert(
    undeclared.verdict === "pass" && undeclared.warnings.some((w) => w.includes("3/4")),
    "a lookup with no declared guardrail still warns past half the screen",
  );
  const balanced = evaluateProbe("c", probe(), [row(MD_FILE, 1), row(MD_FILE_2, 0.9)], {
    caseType: "lookup",
    anchors: [anchor({})],
  });
  assert(balanced.warnings.length === 0, "a balanced lookup screen raises no monopoly warning");
}

section("miss classification — the whole point");
{
  const stale = evaluateProbe("c", probe(), [row(MD_FILE_2, 1)], {
    caseType: "lookup",
    anchors: [anchor({ status: "stale", lagBytes: 4000 })],
  });
  assert(
    stale.verdict === "fail" && stale.missReason === "stale-index",
    "index behind the source is classified stale-index, never ranking-miss",
  );
  assert(stale.warnings.length > 0, "the freshness warning is emitted before any ranking reading");

  const live = evaluateProbe("c", probe(), [row(MD_FILE_2, 1)], {
    caseType: "lookup",
    anchors: [anchor({ status: "stale", liveAppend: true })],
  });
  assert(
    live.verdict === "abstain",
    "a source being appended to right now is not evaluable — never a simplistic FAIL",
  );

  const undecided = evaluateProbe("c", probe(), [row(MD_FILE_2, 1)], {
    caseType: "lookup",
    anchors: [anchor({ status: "unknown" })],
  });
  assert(
    undecided.verdict === "abstain" && undecided.missReason !== "ranking-miss",
    "an undecided index state can NEVER be reported as a ranking miss — that would be false certainty",
  );

  const gone = evaluateProbe("c", probe(), [row(MD_FILE_2, 1)], {
    caseType: "lookup",
    anchors: [anchor({ status: "source-missing" })],
  });
  assert(
    gone.verdict === "honest-miss" && gone.missReason === "corpus-miss",
    "a source that does not exist is an honest corpus miss, not a defect",
  );

  const ranking = evaluateProbe("c", probe(), [row(MD_FILE_2, 1)], {
    caseType: "lookup",
    anchors: [anchor({ status: "fresh" })],
  });
  assert(
    ranking.verdict === "fail" && ranking.missReason === "ranking-miss",
    "indexed + fresh + absent is the only case retrieval owns",
  );

  const unlabeled = evaluateProbe("c", probe({ evidence: { canonical: [] } }), [row(MD_FILE, 1)], {
    caseType: "lookup",
    anchors: [],
  });
  assert(
    unlabeled.verdict === "abstain",
    "with no canonical label there is nothing to grade — abstain rather than invent a pass",
  );
}

section("explore grading — numbers are necessary, not sufficient");
{
  const rows = [row(MD_FILE, 1), row(MD_FILE_2, 0.9), row("/g/notes/20240101T000000.md", 0.8)];
  const p = probe({ guardrails: { minUniqueDocs: 3, maxChunksPerDoc: 2 } });

  const unlabeled = evaluateProbe("c", p, rows, { caseType: "explore", anchors: [anchor({})] });
  assert(
    unlabeled.verdict === "weak-pass",
    "guardrails met but neighbors unlabeled → capped below pass; the steward judges usefulness",
  );

  const labeled = evaluateProbe(
    "c",
    probe({
      guardrails: { minUniqueDocs: 3, maxChunksPerDoc: 2 },
      evidence: { canonical: ["20250214T145957"], helpfulNeighbors: ["20250727T094722"] },
    }),
    rows,
    { caseType: "explore", anchors: [anchor({})] },
  );
  assert(labeled.verdict === "pass", "canonical + a labeled helpful neighbor on the screen → pass");

  const thin = evaluateProbe(
    "c",
    probe({
      guardrails: { minUniqueDocs: 3 },
      evidence: { canonical: ["20250214T145957"], helpfulNeighbors: ["20250727T094722"] },
    }),
    [row(MD_FILE, 1), row(MD_FILE_2, 0.9)],
    { caseType: "explore", anchors: [anchor({})] },
  );
  assert(thin.verdict === "weak-pass", "too few distinct documents → capped below pass");

  const distracted = evaluateProbe(
    "c",
    probe({
      evidence: {
        canonical: ["20250214T145957"],
        helpfulNeighbors: ["20250727T094722"],
        knownDistractors: ["20240101T000000"],
      },
    }),
    [row("/g/notes/20240101T000000.md", 1), row(MD_FILE, 0.9), row(MD_FILE_2, 0.8)],
    { caseType: "explore", anchors: [anchor({})] },
  );
  assert(
    distracted.verdict === "weak-pass",
    "a known distractor ahead of canonical is at most partial, whatever the rank",
  );
}

section("time-probe grading — an honest miss is not a pass and not a failure");
{
  const empty = evaluateProbe("c", probe({ surface: "search-sessions", mode: "recent", evidence: {} }), [], {
    caseType: "time-probe",
    anchors: [],
  });
  assert(empty.verdict === "honest-miss", "zero rows in a window → honest-miss");
  assert(
    empty.verdict !== "pass" && empty.verdict !== "fail",
    "zero rows is neither a retrieval PASS nor a defect",
  );
  assert(
    empty.notes.some((n) => n.includes("NOT an empty day")),
    "the report refuses to turn a retrieval gap into an empty day",
  );
  assert(!empty.countsTowardUsable, "a time-probe never counts toward user acceptance");

  const some = evaluateProbe(
    "c",
    probe({ surface: "search-sessions", mode: "recent", evidence: {} }),
    [row(SESSION_FILE, 0)],
    { caseType: "time-probe", anchors: [] },
  );
  assert(!some.countsTowardUsable, "even a productive window scan stays diagnostic-only");
}

section("cross-track grading — labeled, never merged");
{
  const both = evaluateProbe(
    "c",
    probe({ surface: "search-sessions", grader: "labeled-groups", evidence: {} }),
    [row(SESSION_FILE, 0.03), row(MD_FILE, 1.05)],
    { caseType: "explore", anchors: [], fallback: true },
  );
  assert(both.verdict === "pass" && both.groups!.length === 2, "both tracks present and labeled → pass");
  assert(!both.countsTowardUsable, "a structural check cannot mean 'usable' on its own");
  assert(
    both.evidence!.some((e) => e.visibility === "private-session") &&
      both.evidence!.some((e) => e.visibility === "public-garden"),
    "private session rows and public garden rows stay distinguishable",
  );

  const one = evaluateProbe(
    "c",
    probe({ surface: "search-sessions", grader: "labeled-groups", evidence: {} }),
    [row(SESSION_FILE, 0.03)],
    { caseType: "explore", anchors: [] },
  );
  assert(one.verdict === "weak-pass", "only one track answering is not a silent pass");
}

section("observed score range is per-run, never a hard-coded band");
{
  const o = evaluateProbe("c", probe(), [row(MD_FILE, 1.1), row(MD_FILE_2, 0.66)], {
    caseType: "lookup",
    anchors: [anchor({})],
  });
  assert(
    o.observedScoreRange!.min === 0.66 && o.observedScoreRange!.max === 1.1,
    "the range is computed from this run's rows",
  );
  // The published semantics must carry formula and strategy, never a range.
  // (Checking raw source text would only catch the comment that explains why
  // the old band was removed — the contract lives in the exported object.)
  const semantics = JSON.stringify(SCORE_SEMANTICS);
  assert(!semantics.includes("observedScoreBand"), "no observed band is published as a semantic");
  assert(
    !/\d\.\d+\s*[–-]\s*\d\.\d+/.test(semantics),
    "no score range literal survives in the published score semantics",
  );
  assert(
    SCORE_SEMANTICS.strategies.md.formula.length > 0 &&
      SCORE_SEMANTICS.strategies.sessions.mergeStrategy === "rrf",
    "formula and strategy — the stable facts — are published instead",
  );
  assert(
    SCORE_SEMANTICS.sentinels.mdVectorOnlyTop.scope.includes("version-specific"),
    "the 0.70 sentinel is marked implementation/version-specific, not a universal confidence",
  );
}

// --- excerpt / args / contract --------------------------------------------

section("excerpt, probe args, api cost");
{
  assert(
    oneLineExcerpt("Title: 일일일생\nTags: a b\nbody") === "일일일생",
    "a Title: preamble becomes the one-line label",
  );
  assert(oneLineExcerpt("a\nb\nc") === "a b c", "multiline text collapses to one line");
  assert(oneLineExcerpt("x".repeat(50), 10).endsWith("…"), "long lines are truncated, never dumped");
  assert(oneLineExcerpt(undefined) === "", "missing text does not throw");

  const args = buildProbeArgs(
    probe({ surface: "search-sessions", query: "", mode: "recent", dateFrom: "A", dateTo: "B" }),
  );
  assert(args.includes("--mode") && args.includes("recent"), "recent mode is passed through");
  assert(args[2] === "*", "an empty window query still satisfies the CLI positional");
  assert(args.includes("--date-from") && args.includes("A"), "ISO window is passed, never parsed here");

  assert(probeApiCost(probe({ mode: "recent" })) === "none", "a stored-signal scan costs no API call");
  assert(
    probeApiCost(probe({ mode: "hybrid" })) === "paid-query-embedding",
    "a hybrid probe is correctly declared paid",
  );
}

section("production contract is measured from the response, not from our prose");
{
  const pc = assessProductionContract("cli", {
    query: "q",
    count: 1,
    results: [{ file: MD_FILE, score: 1, source: "md", text: "body" }],
  });
  assert(pc.exposes.openableSourcePath === "exposed", "an absolute path is an openable source");
  assert(pc.exposes.rankOrder === "implicit", "rank is only implicit in array order");
  assert(pc.exposes.freshnessWarning === "absent", "the production response carries no freshness warning");
  assert(pc.exposes.scoreSemantics === "absent", "the production response does not explain its score");
  assert(pc.productionPathParity === "unproven", "CLI results never claim pi-extension parity");
  const empty = assessProductionContract("cli", null);
  assert(empty.exposes.excerpt === "absent", "no rows → nothing claimed as exposed");
}

// --- case packs ------------------------------------------------------------

section("case pack merge — local overlay carries volatile bindings");
{
  const merged = mergeCasePacks([
    {
      schemaVersion: 2,
      cases: [
        {
          id: "a",
          type: "lookup",
          title: "t",
          userQuestion: "u",
          requiresLocalBinding: true,
          probes: [probe({ id: "p1", evidence: { canonical: [] } })],
        },
      ],
    },
    {
      schemaVersion: 2,
      cases: [
        {
          id: "a",
          type: "lookup",
          title: "t",
          userQuestion: "u",
          freshnessAnchors: ["~/s.jsonl"],
          probes: [{ id: "p1", surface: "search-md", query: "q", evidence: { canonical: ["uuid"] } }],
        },
      ],
    },
  ]);
  assert(merged.length === 1, "same id merges instead of duplicating the case");
  assert(merged[0].probes![0].evidence!.canonical![0] === "uuid", "local overlay binds the anchor");
  assert(merged[0].probes![0].rankThreshold === 3, "committed probe fields survive the overlay");

  assert(
    isUnbound({ id: "a", type: "lookup", title: "t", userQuestion: "u", requiresLocalBinding: true }),
    "a case needing a local binding with none present is unbound",
  );
  assert(!isUnbound(merged[0]), "once bound it is no longer unbound");

  const old = {
    id: "a",
    type: "lookup" as const,
    title: "t",
    userQuestion: "u",
    boundAt: "2026-01-01T00:00:00Z",
    expiresAfterDays: 7,
  };
  assert(isBindingExpired(old, Date.parse("2026-02-01T00:00:00Z")), "an aged binding expires");
  assert(!isBindingExpired(old, Date.parse("2026-01-03T00:00:00Z")), "a fresh binding does not");
  assert(
    !isBindingExpired({ id: "a", type: "lookup", title: "t", userQuestion: "u" }),
    "a case with no binding never expires",
  );
}

// --- comparison ------------------------------------------------------------

section("comparison contract — confounding is shown, never inferred away");
{
  const outcome = (verdict: ProbeOutcome["verdict"], rank: number | null): ProbeOutcome => ({
    caseId: "c",
    caseType: "lookup",
    probeId: "p",
    surface: "search-md",
    measuredSurface: "cli:search-md",
    query: "q",
    apiCost: "paid-query-embedding",
    verdict,
    missReason: "none",
    countsTowardUsable: true,
    warnings: [],
    notes: [],
    rows: 1,
    expectedRank: rank,
    rankThreshold: 3,
    evidence: [{ rank: 1, track: "md", visibility: "public-garden", docId: "md:1", score: 1, excerpt: "" }],
  });
  const mkCase = (o: ProbeOutcome): CaseOutcome => ({
    id: "c",
    type: "lookup",
    title: "t",
    userQuestion: "u",
    anchors: [],
    probes: [o],
  });
  const mk = (o: ProbeOutcome, over: Partial<AcceptanceReport["runIdentity"]> = {}): AcceptanceReport => {
    const cases = [mkCase(o)];
    return {
      generatedAt: "now",
      host: "h",
      scope: { retrievalEnabled: true, casePacks: [] },
      runIdentity: {
        schemaVersion: 2,
        pipelineContractVersion: "v",
        pipelineDigest: "PIPE",
        casePackDigest: "PACK",
        measuredSurface: "cli",
        config: { mdModel: "m" },
        corpusSnapshot: { mdManifest: "C1" },
        resultDigest: resultDigestOf(cases),
        ...over,
      },
      scoreSemantics: {} as AcceptanceReport["scoreSemantics"],
      productionContract: {} as AcceptanceReport["productionContract"],
      recallSuppression: {} as AcceptanceReport["recallSuppression"],
      indexHealth: { tracks: [], anchors: [] },
      recallLog: {} as AcceptanceReport["recallLog"],
      cases,
      diagnostics: tallyDiagnostics(cases),
      humanAcceptance: {
        verdict: "usable",
        workflowChange: "",
        scenarios: [],
        contract: "",
      },
    };
  };

  const before = mk(outcome("weak-pass", 5));
  const after = mk(outcome("pass", 1), { pipelineDigest: "PIPE2" });
  const improved = compareRuns(before, after);
  assert(improved.comparable, "same pack/config/surface stays comparable across a reindex");
  assert(improved.deltas[0].direction === "improved", "rank 5 → 1 with a better verdict is improved");
  assert(improved.pipelineChanged, "a retrieval source change is detected automatically");
  assert(
    improved.verdictReset,
    "a changed result digest resets a previously recorded human verdict to unset",
  );

  const packChanged = compareRuns(before, mk(outcome("pass", 1), { casePackDigest: "PACK2" }));
  assert(!packChanged.comparable, "a changed case pack blocks comparison");
  assert(
    packChanged.deltas[0].direction === "not-comparable",
    "an incomparable pair reports no direction at all — never 'improved'",
  );

  const configChanged = compareRuns(before, mk(outcome("pass", 1), { config: { mdModel: "other" } }));
  assert(!configChanged.comparable, "a changed embedding model blocks comparison");

  const corpusMoved = compareRuns(
    before,
    mk(outcome("pass", 1), { pipelineDigest: "PIPE2", corpusSnapshot: { mdManifest: "C2" } }),
  );
  assert(
    !corpusMoved.comparable && corpusMoved.deltas[0].direction === "not-comparable",
    "a moved corpus/index generation BLOCKS a direction — an unattributable delta is not an improvement",
  );

  const vanished = compareRuns(before, mk(outcome("honest-miss", null), { pipelineDigest: "PIPE2" }));
  assert(
    vanished.deltas[0].direction === "not-comparable",
    "fail → honest-miss is NOT an improvement — a source disappearing is not retrieval getting better",
  );
  assert(
    NO_DIRECTION_VERDICTS.includes("honest-miss"),
    "honest-miss carries no usefulness signal, so it can never produce a direction",
  );

  const notMeasured = compareRuns(mk(outcome("skipped", null)), mk(outcome("pass", 1)));
  assert(
    notMeasured.deltas[0].direction === "not-comparable",
    "a probe that was skipped on one side is not measured — never 'improved' or 'regressed'",
  );
  const wentUnmeasured = compareRuns(before, mk(outcome("abstain", null)));
  assert(
    wentUnmeasured.deltas[0].direction === "not-comparable",
    "an abstain on either side is not a regression",
  );

  const samePipeline = compareRuns(before, mk(outcome("pass", 1)));
  assert(
    samePipeline.confounders.some((c) => c.includes("IDENTICAL")),
    "an unchanged retrieval source warns that a delta is drift or noise, not the change working",
  );
  assert(
    samePipeline.comparable,
    "an unchanged pipeline is a run-level caution, not a comparability blocker",
  );
}

section("diagnostics tally keeps non-green states distinct");
{
  const mk = (v: ProbeOutcome["verdict"]): ProbeOutcome =>
    ({ verdict: v, probeId: v, caseId: "c" }) as ProbeOutcome;
  const t = tallyDiagnostics([
    {
      id: "c",
      type: "lookup",
      title: "t",
      userQuestion: "u",
      anchors: [],
      probes: [mk("pass"), mk("honest-miss"), mk("abstain"), mk("expired"), mk("fail")],
    },
  ]);
  assert(t.pass === 1 && t.fail === 1, "pass and fail stay separate");
  assert(
    t.honestMiss === 1 && t.abstain === 1 && t.expired === 1,
    "honest-miss / abstain / expired are counted on their own, folded into neither",
  );
}

// --- recall log ------------------------------------------------------------

section("recall log — readiness audit and the suppression guard");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-accept-"));
  const logFile = path.join(dir, "recalls.jsonl");
  fs.writeFileSync(
    logFile,
    [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", query: "a", tool: "search-md", resultIds: ["f#1"], topScore: 1 }),
      JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", query: "b", tool: "search-knowledge", resultIds: ["g#1"], topScore: 1 }),
    ].join("\n") + "\n",
  );
  const audit = auditRecallLog(logFile);
  assert(audit.entries === 2, "entries are counted");
  assert(audit.promotionGateReady === false, "the log is never declared promotion-ready");
  assert(audit.fields.canonicalDocId === "derivable", "doc id is derivable from resultIds, not stored");
  assert(audit.fields.track === "inferable-ambiguous", "track is only ambiguously inferable from tool");
  assert(audit.fields.pipelineVersion === "absent", "pipeline version is absent");
  assert(
    audit.reasons.some((r) => r.includes("promotion-quality gate")),
    "the audit says outright not to use existing entries as a gate",
  );
  assert(auditRecallLog(path.join(dir, "nope.jsonl")).present === false, "a missing log is reported, not thrown");

  // The guard itself.
  assert(isRecallTrackingDisabled({ [RECALL_TRACKING_ENV]: "1" }), '"1" disables tracking');
  assert(isRecallTrackingDisabled({ [RECALL_TRACKING_ENV]: "true" }), '"true" disables tracking');
  assert(!isRecallTrackingDisabled({}), "unset env keeps production logging on");
  assert(!isRecallTrackingDisabled({ [RECALL_TRACKING_ENV]: "0" }), '"0" must NOT disable tracking');

  const prevData = process.env.ANDENKEN_DATA;
  process.env.ANDENKEN_DATA = dir;
  const target = path.join(dir, "recalls.jsonl");
  const before = fs.readFileSync(target, "utf-8").length;
  recordRecall("q", "acceptance-probe", [], { [RECALL_TRACKING_ENV]: "1" });
  assert(
    fs.readFileSync(target, "utf-8").length === before,
    "with the guard set, a search appends nothing — acceptance traffic cannot enter promotion evidence",
  );
  recordRecall("q", "production", [], {});
  assert(
    fs.readFileSync(target, "utf-8").length > before,
    "without the guard, normal production calls keep logging exactly as before",
  );
  if (prevData === undefined) delete process.env.ANDENKEN_DATA;
  else process.env.ANDENKEN_DATA = prevData;
  fs.rmSync(dir, { recursive: true, force: true });
}

section("window path control — a zero must be earned before it means anything");
{
  const ctrl = buildWindowControlProbe(Date.parse("2026-08-10T00:00:00Z"), 48);
  assert(ctrl.mode === "recent", "the control runs the same stored-signal path, at API 0");
  assert(
    ctrl.dateFrom === "2026-08-08T00:00:00.000Z" && ctrl.dateTo === "2026-08-10T00:00:00.000Z",
    "the control window is the recent range the index is expected to cover",
  );
  assert(probeApiCost(ctrl) === "none", "the control costs nothing");

  const proven = interpretWindowControl(ctrl, 3);
  assert(proven.proven, "rows on the control range prove the window path works");
  const unproven = interpretWindowControl(ctrl, 0);
  assert(!unproven.proven, "zero on the control range leaves the path unproven");
  assert(!interpretWindowControl(ctrl, 5, "boom").proven, "an errored control never counts as proof");

  const zeroProven = evaluateProbe("c", probe({ evidence: {} }), [], {
    caseType: "time-probe",
    anchors: [],
    windowPathProven: true,
  });
  assert(
    zeroProven.verdict === "honest-miss" && zeroProven.missReason === "corpus-miss",
    "with the path proven, an empty window is a genuine corpus gap",
  );
  const zeroUnproven = evaluateProbe("c", probe({ evidence: {} }), [], {
    caseType: "time-probe",
    anchors: [],
    windowPathProven: false,
  });
  assert(
    zeroUnproven.missReason === "corpus-miss-candidate",
    "without the control, an empty window is only a CANDIDATE — the runner must not assert a corpus gap it did not establish",
  );
}

section("layer-3 evidence stays on its own surface");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-l3-"));
  const f = path.join(dir, "l3.json");
  fs.writeFileSync(
    f,
    JSON.stringify({
      measuredSurface: "pi-tools",
      recordedAt: "2026-08-10T04:00:00Z",
      overall: "CONDITIONAL",
      scenarios: [{ caseId: "garden-lookup-canonical", verdict: "usable", oneLessStep: "exact-title-search" }],
    }),
  );
  const ev = loadL3Evidence(f)!;
  assert(ev.measuredSurface === "pi-tools", "L3 evidence names the surface it was earned on");
  assert(
    ev.measuredSurface !== "cli",
    "a verdict earned on pi tools is not a verdict about the CLI surface",
  );
  assert(loadL3Evidence(path.join(dir, "nope.json")) === undefined, "absent evidence is not an error");
  fs.writeFileSync(f, JSON.stringify({ recordedAt: "x" }));
  assert(loadL3Evidence(f) === undefined, "evidence with no surface is refused, not half-trusted");
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- committed case pack sanity -------------------------------------------

section("committed case pack stays public-safe");
{
  const raw = fs.readFileSync(path.join(import.meta.dirname, "acceptance-cases.json"), "utf-8");
  assert(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(raw),
    "no session UUID is committed — volatile bindings belong in the gitignored local pack",
  );
  assert(!raw.includes("/home/"), "no absolute machine path is committed");
  const pack = JSON.parse(raw) as {
    cases: Array<{
      id: string;
      type: string;
      probes?: Array<{ query: string; forbiddenQueryTokens?: string[] }>;
    }>;
  };
  assert(
    pack.cases.every((c) => ["lookup", "explore", "time-probe"].includes(c.type)),
    "every committed case declares a known case type",
  );

  // A query that repeats the canonical title measures string overlap, not
  // retrieval — a rank-1 hit under those conditions proves nothing.
  let checked = 0;
  const leaks: string[] = [];
  for (const c of pack.cases) {
    for (const p of c.probes ?? []) {
      for (const tok of p.forbiddenQueryTokens ?? []) {
        checked++;
        if (p.query.includes(tok)) leaks.push(`${c.id}: "${tok}"`);
      }
    }
  }
  assert(checked > 0, "at least one probe declares the title wording its query must avoid");
  assert(
    leaks.length === 0,
    `no probe query repeats canonical title/subtitle wording${leaks.length ? ` (leaked: ${leaks.join(", ")})` : ""}`,
  );
}

console.log(`\n${"─".repeat(64)}`);
console.log(`✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
