#!/usr/bin/env tsx
/**
 * Fixture tests for the OpenClaw freshness board and reconcile dry-run
 * (tier 4, stages A + B — 2026-09-29).
 *
 * API 0. DB 0. ssh 0. Pure checks on openclaw-reconcile.ts plus one static check
 * on export-openclaw.sh.
 *
 * The case list is the one sol's review asked for (REVIEW-sol.md, "구현 범위"
 * 2), restricted to what stages A and B can get wrong: a read failure on 1 of 7
 * agents, a zero-row database, a paused identity, the wrong host, a 38%-sized
 * decrease, a reused staging directory, and a same-id row with a new stamp. The
 * reason each is a fixture and not a live run: on the day this landed the live
 * data had none of the failures — every agent read, status answered — so a guard
 * that silently stopped working would have printed the same healthy table.
 *
 * Run it: `./run.sh test:openclaw` (runs the import tests first).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import {
	checkBinding,
	classifyGone,
	digestIds,
	digestRows,
	generationUnbound,
	freshnessRows,
	holdKind,
	parseManifestLines,
	parseStatus,
	reconcile,
	renderFreshness,
	renderReconcile,
	type HeldRow,
	type Manifest,
	type StatusParse,
} from "./openclaw-reconcile.ts";
import { partitionByChange, type PreparedChunk } from "./openclaw-importer.ts";
import type { StagedRun } from "./openclaw-importer.ts";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const RUN = "20260929T000000Z-1-abcdef";
const run: StagedRun = {
	runId: RUN, host: "oracle", mode: "delta", exportedAt: 0,
	rows: 0, agentsOk: 7, agentsSkipped: [], statusRc: "0",
};

type Chunk = { id: string; source: string; path: string; updated_at?: number };

/** Build manifest lines the way the remote python prints them, digest included. */
function manifestLines(
	agents: Record<string, { state?: string; chunks?: Chunk[]; chunkingVersion?: number; runId?: string; digest?: string }>,
): string[] {
	const out: string[] = [];
	for (const [agent, a] of Object.entries(agents)) {
		const state = a.state ?? "ok";
		const chunks = a.chunks ?? [];
		if (state !== "ok" && state !== "delta-failed") {
			out.push(JSON.stringify({ kind: "agent", agent, state, run_id: a.runId ?? RUN }));
			continue;
		}
		out.push(JSON.stringify({
			kind: "agent", agent, state, run_id: a.runId ?? RUN, rows: chunks.length,
			max_updated_at: chunks.length ? Math.max(...chunks.map((c) => c.updated_at ?? 1)) : null,
			revision: 7, meta: { memory_index_meta_v1: { chunkingVersion: a.chunkingVersion ?? 5 } },
			digest: a.digest ?? digestIds(chunks.map((c) => c.id)),
			row_digest: digestRows(chunks.map((c) => ({ agent, updated_at: 1, ...c }))),
		}));
		for (const c of chunks) out.push(JSON.stringify({ kind: "chunk", agent, updated_at: 1, ...c }));
	}
	return out;
}

/**
 * A status answer. `chunks` defaults to the agent's row count in `m` when a
 * manifest is given — a status that agrees with its snapshot — and is omitted
 * (null, which now holds) when neither is given.
 */
function status(
	agents: Record<string, { identity?: string; code?: string; dirty?: boolean; chunks?: number }>,
	m?: Manifest,
): StatusParse {
	return parseStatus(JSON.stringify(Object.entries(agents).map(([agentId, s]) => ({
		agentId,
		status: {
			dirty: s.dirty ?? false,
			files: 1,
			chunks: s.chunks ?? m?.agents.get(agentId)?.rows,
			sourceCounts: [{ source: "memory", files: 1, eligible: 1 }],
			custom: { indexIdentity: { status: s.identity ?? "valid", code: s.code } },
		},
		scan: { totalFiles: 1 },
	}))));
}

/** Held rows carry the stamp the importer would have written for updated_at=1 unless told otherwise. */
const STAMP1 = new Date(1).toISOString();
const held = (agent: string, rows: Array<[string, string, string] | [string, string, string, string]>): HeldRow[] =>
	rows.map(([id, source, p, ts]) => ({ id: `${agent}:${id}`, source, sessionFile: p, timestamp: ts ?? STAMP1 }));

const ok7 = { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} } as Record<string, object>;

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== digest — the same function on both sides ===");
{
	ok("empty id set digests to sha256('') — what the live `claude` agent carries",
		digestIds([]) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	ok("digest sorts before hashing (order of arrival cannot change it)",
		digestIds(["b", "a"]) === crypto.createHash("sha256").update("a\nb").digest("hex"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== classification — each class, and the order between them ===");
{
	const up: Parameters<typeof classifyGone>[2] = [
		{ agent: "x", id: "new1", source: "memory", path: "MEMORY.md", updated_at: 2 },
		{ agent: "x", id: "new2", source: "memory", path: "memory/2026-09-01.md", updated_at: 2 },
		{ agent: "x", id: "dnew", source: "memory", path: "memory/dreaming/light/2026-09-01.md", updated_at: 2 },
		{ agent: "x", id: "arch", source: "sessions", path: "sessions/x/s3.jsonl.reset.2026-09-01T00-00-00.000Z", updated_at: 2 },
	];
	const gone = held("x", [
		["old1", "memory", "MEMORY.md"],                                        // path still up, new1 held → confirmed
		["old2", "memory", "memory/2026-09-01.md"],                             // path still up, new2 NOT held → unconfirmed
		["dold", "memory", "memory/dreaming/light/2026-09-01.md"],              // dreaming prefix but path still up → superseded wins
		["dgone", "memory", "memory/dreaming/deep/2026-04-21.md"],              // dreaming
		["r", "sessions", "sessions/x/s1.jsonl.reset.2026-08-01T00-00-00.000Z"],
		["d", "sessions", "sessions/x/s2.jsonl.deleted.2026-08-01T00-00-00.000Z"],
		["mv", "sessions", "sessions/x/s3.jsonl"],                              // archived under a new name upstream
		["gs", "sessions", "sessions/x/s4.jsonl"],
		["gm", "memory", "memory/2026-01-01.md"],
	]);
	const heldStamps = new Map([["x:new1", new Date(2).toISOString()], ["x:dnew", new Date(2).toISOString()], ...gone.map((g) => [g.id, g.timestamp] as [string, string])]);
	const c = classifyGone("x", gone, up, heldStamps);
	const ids = (k: string) => (c.get(k as never) ?? []).map((r) => r.id.slice(2)).sort().join(",");
	ok("same path + every replacement held → superseded-confirmed", ids("superseded-confirmed") === "dold,old1");
	ok("same path + replacement not arrived → superseded-unconfirmed", ids("superseded-unconfirmed") === "old2");
	ok("a dreaming path still indexed upstream is re-chunking, not dreaming", !ids("dreaming").includes("dold"));
	ok("dreaming prefix gone upstream → dreaming", ids("dreaming") === "dgone");
	ok(".jsonl.reset. → session-reset", ids("session-reset") === "r");
	ok(".jsonl.deleted. → session-deleted", ids("session-deleted") === "d");
	ok("live path gone, archive of it upstream → session-renamed", ids("session-renamed") === "mv");
	ok("sessions path gone without trace → path-gone-sessions", ids("path-gone-sessions") === "gs");
	ok("memory path gone (not dreaming) → path-gone-memory, never widened into dreaming", ids("path-gone-memory") === "gm");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== binding — one run or nothing ===");
{
	const m = parseManifestLines(manifestLines({ a: {} }));
	const base = { run, manifest: m, receipt: null, chunksStaged: false, watermarkHost: "oracle" };
	ok("run.json + manifest of the same run, nothing staged → bound", checkBinding(base).ok);
	ok("no run.json → refused", !checkBinding({ ...base, run: null }).ok);
	ok("no manifest → refused", !checkBinding({ ...base, manifest: null }).ok);

	const stale = parseManifestLines(manifestLines({ a: { runId: "20260928T000000Z-9-000000" } }));
	const r1 = checkBinding({ ...base, manifest: stale });
	ok("STAGING REUSE: a manifest line from another run is refused",
		!r1.ok && /belongs to run/.test((r1 as { reason: string }).reason));

	const r2 = checkBinding({ ...base, watermarkHost: "elsewhere" });
	ok("WRONG HOST: export host ≠ watermark host is refused",
		!r2.ok && /watermark belongs/.test((r2 as { reason: string }).reason));

	const receipt = { at: "", stagingMtimeMs: 0, seen: run.rows, imported: 0, unchanged: 0, host: "oracle" };
	ok("chunks staged, no receipt → refused (replacements not landed)",
		!checkBinding({ ...base, chunksStaged: true }).ok);
	ok("chunks staged, receipt of an EARLIER run → refused",
		!checkBinding({ ...base, chunksStaged: true, receipt: { ...receipt, runId: "older" } }).ok);
	ok("chunks staged, receipt of this run → bound",
		checkBinding({ ...base, chunksStaged: true, receipt: { ...receipt, runId: RUN } }).ok);
	ok("receipt of this run but a different row count → refused",
		!checkBinding({ ...base, chunksStaged: true, receipt: { ...receipt, runId: RUN, seen: run.rows + 5 } }).ok);
	ok("receipt of this run but another host → refused",
		!checkBinding({ ...base, chunksStaged: true, receipt: { ...receipt, runId: RUN, host: "elsewhere" } }).ok);
	const staleSource = parseManifestLines([
		...manifestLines({ a: {} }),
		JSON.stringify({ kind: "source", agent: "a", run_id: "older", source: "memory", files: 1, newest_mtime: 1, newest_path: "MEMORY.md" }),
	]);
	ok("a source line from another run is refused like an agent line", !checkBinding({ ...base, manifest: staleSource }).ok);

	const report = reconcile({
		held: held("a", [["1", "memory", "MEMORY.md"]]), manifest: stale, status: status({ a: {} }),
		statusPost: status({ a: {} }), binding: r1, run,
	});
	ok("a refused binding classifies nothing", report.agents.length === 0);
	ok("…and says so in the rendered report", /❌ refused/.test(renderReconcile(report)));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== read failure on 1 of 7 agents ===");
{
	const lines = manifestLines({
		...Object.fromEntries(Object.keys(ok7).map((k) => [k, { chunks: [{ id: "u", source: "memory", path: "MEMORY.md" }] }])),
		c: { state: "vacuum-failed" },
	});
	const m = parseManifestLines(lines);
	const hs = Object.keys(ok7).flatMap((a) => held(a, [["u", "memory", "MEMORY.md"], ["gone", "memory", "memory/dreaming/x.md"]]));
	const st = status(Object.fromEntries(Object.keys(ok7).map((k) => [k, {}])), m);
	const rep = reconcile({ held: hs, manifest: m, status: st, statusPost: st, binding: { ok: true }, run, maxRatio: 0.9 });
	const c = rep.agents.find((a) => a.agent === "c")!;
	ok("the failed agent is not classified", c.guard === "not-classified:vacuum-failed" && c.gone.size === 0);
	ok("the six readable agents are", rep.agents.filter((a) => a.guard === "ok").length === 6);
	const fr = freshnessRows(m, st);
	ok("the board names it read-failed, not fresh", fr.find((r) => r.agent === "c")!.verdict === "read-failed");
	ok("…and lists it as not fresh-checked", /not fresh-checked: c/.test(renderFreshness(fr, run, st)));

	const dm = parseManifestLines(manifestLines({ a: { chunks: [{ id: "u", source: "memory", path: "M" }], digest: "0".repeat(64) } }));
	const dr = reconcile({ held: held("a", [["z", "memory", "M"]]), manifest: dm, status: st, statusPost: st, binding: { ok: true }, run });
	ok("a manifest whose digest does not verify is not classified", dr.agents[0].guard === "not-classified:digest-mismatch");

	const df = parseManifestLines(manifestLines({ a: { state: "delta-failed", chunks: [{ id: "u", source: "memory", path: "M" }] } }));
	const dfr = reconcile({ held: held("a", [["z", "memory", "M"]]), manifest: df, status: st, statusPost: st, binding: { ok: true }, run });
	ok("delta-failed (manifest fine, import missed its delta) is not classified", dfr.agents[0].guard === "not-classified:delta-failed");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== zero rows, no index, agents that vanish ===");
{
	const m = parseManifestLines(manifestLines({ a: {}, b: { state: "no-index" } }));
	const hs = [...held("a", [["1", "memory", "MEMORY.md"], ["2", "memory", "MEMORY.md"]]), ...held("b", [["1", "memory", "M"]]), ...held("z", [["1", "memory", "M"]])];
	const rep = reconcile({ held: hs, manifest: m, status: status({ a: {}, b: {} }, m), statusPost: status({ a: {}, b: {} }, m), binding: { ok: true }, run });
	const a = rep.agents.find((x) => x.agent === "a")!;
	ok("a 0-row upstream with held rows is flagged upstream-empty", a.flags.some((f) => f.startsWith("upstream-empty")));
	ok("…which holds it as an upstream hold, not a prune", holdKind(a) === "upstream");
	ok("no-index is a different claim than zero rows: not classified", rep.agents.find((x) => x.agent === "b")!.guard === "not-classified:no-index");
	const z = rep.agents.find((x) => x.agent === "z")!;
	ok("an agent absent from this host's discovery list is never classified", z.guard === "absent-upstream" && z.gone.size === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== paused identity and a failed status call ===");
{
	const m = parseManifestLines(manifestLines({
		p: { chunks: [{ id: "n", source: "memory", path: "MEMORY.md" }], chunkingVersion: 3 },
		d: { chunks: [{ id: "n", source: "memory", path: "MEMORY.md" }] },
		f: { chunks: [{ id: "n", source: "memory", path: "MEMORY.md" }] },
	}));
	const st = status({ p: { identity: "mismatched", code: "chunking_version", dirty: true }, d: { dirty: true }, f: {} }, m);
	const fr = freshnessRows(m, st);
	const p = fr.find((r) => r.agent === "p")!;
	ok("mismatched identity → paid-rebuild, even though it is also dirty", p.verdict === "paid-rebuild");
	ok("…and the prescription says a plain index call FULLY rebuilds", /FULLY rebuild/.test(p.prescription) && /GLG gate/.test(p.prescription));
	ok("…and the command it prints never carries --force", !/`[^`]*--force[^`]*`/.test(p.prescription));
	ok("valid + dirty → incremental", fr.find((r) => r.agent === "d")!.verdict === "incremental");
	ok("valid + clean → fresh", fr.find((r) => r.agent === "f")!.verdict === "fresh");

	const rep = reconcile({
		held: held("p", [["n", "memory", "MEMORY.md"], ["o", "memory", "MEMORY.md"]]),
		manifest: m, status: st, statusPost: st, binding: { ok: true }, run, maxRatio: 0.9,
	});
	const pr = rep.agents.find((a) => a.agent === "p")!;
	ok("reconcile still classifies a paused agent (the numbers are useful)…", pr.gone.get("superseded-confirmed")?.length === 1);
	ok("…but holds it: the upstream is mid-change", holdKind(pr) === "upstream");

	const down = parseStatus("Error: gateway not running", "docker: container not found");
	ok("non-JSON status parses as a failure with the stderr hint", !down.ok && /container not found/.test((down as { reason: string }).reason));
	const fd = freshnessRows(m, down);
	ok("a failed status call leaves NO agent reported fresh", fd.every((r) => r.verdict === "status-unknown"));
	const rd = reconcile({ held: held("f", [["n", "memory", "MEMORY.md"], ["o", "memory", "MEMORY.md"]]), manifest: m, status: down, statusPost: down, binding: { ok: true }, run, maxRatio: 0.9 });
	ok("…and reconcile holds every agent while identity is unknown", holdKind(rd.agents.find((a) => a.agent === "f")!) === "upstream");

	const nc = freshnessRows(parseManifestLines(manifestLines({ claude: {}, ghost: { chunks: [{ id: "1", source: "memory", path: "M" }] } })), status({}));
	ok("an unconfigured agent with 0 rows is inactive (the live `claude` case)", nc.find((r) => r.agent === "claude")!.verdict === "inactive");
	ok("an unconfigured agent that holds rows is surfaced, not ignored", nc.find((r) => r.agent === "ghost")!.verdict === "not-configured");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== the 38% decrease ===");
{
	// 100 held, 62 still upstream → 38% gone, the size of the first live reconcile.
	const upChunks = Array.from({ length: 62 }, (_, i) => ({ id: `k${i}`, source: "memory", path: "MEMORY.md" }));
	const m = parseManifestLines(manifestLines({ a: { chunks: upChunks } }));
	const hs = held("a", Array.from({ length: 100 }, (_, i) => [`k${i}`, "memory", i < 62 ? "MEMORY.md" : "memory/dreaming/x.md"] as [string, string, string]));
	const rep = reconcile({ held: hs, manifest: m, status: status({ a: {} }, m), statusPost: status({ a: {} }, m), binding: { ok: true }, run });
	const a = rep.agents[0];
	ok("38% gone trips the default 20% threshold", a.flags.some((f) => f.startsWith("mass-decrease 38%")));
	ok("…as a mass-decrease hold, distinct from an upstream hold", holdKind(a) === "mass-decrease");
	ok("…and the summary counts it apart", /behind mass-decrease only 38/.test(renderReconcile(rep, 0)));
	const loose = reconcile({ held: hs, manifest: m, status: status({ a: {} }, m), statusPost: status({ a: {} }, m), binding: { ok: true }, run, maxRatio: 0.5 });
	ok("under the threshold the same rows are clear of every guard", holdKind(loose.agents[0]) === "none" && /clear of every guard 38/.test(renderReconcile(loose, 0)));
	ok("retry: the dry-run is pure — same input, same report",
		renderReconcile(reconcile({ held: hs, manifest: m, status: status({ a: {} }, m), statusPost: status({ a: {} }, m), binding: { ok: true }, run }), 3) === renderReconcile(rep, 3));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== mass-decrease measures the prune step, not the archive stock ===");
{
	// One agent shaped like a live board: `live` rows held ∩ upstream, `sup` old
	// MEMORY.md chunks whose replacements arrived (sup✓), `dream` moved dreaming
	// rows, `archives` session reset archives kept forever.
	const shaped = (live: number, sup: number, dream: number, archives: number) => {
		const up = Array.from({ length: live }, (_, i) => ({ id: `k${i}`, source: "memory", path: "MEMORY.md" }));
		const m = parseManifestLines(manifestLines({ a: { chunks: up } }));
		const hs = held("a", [
			...up.map((c) => [c.id, c.source, c.path] as [string, string, string]),
			...Array.from({ length: sup }, (_, i) => [`s${i}`, "memory", "MEMORY.md"] as [string, string, string]),
			...Array.from({ length: dream }, (_, i) => [`d${i}`, "memory", `memory/dreaming/light/${i}.md`] as [string, string, string]),
			...Array.from({ length: archives }, (_, i) => [`r${i}`, "sessions", `sessions/a/${i}.jsonl.reset.2026-08-01T00-00-00.000Z`] as [string, string, string]),
		]);
		return reconcile({ held: hs, manifest: m, status: status({ a: {} }, m), statusPost: status({ a: {} }, m), binding: { ok: true }, run }).agents[0];
	};

	// main on 2026-10-02, after both prunes: 348 live, 98 reset + 9 renamed, 0 to prune.
	// The old ratio (all gone / held) read 24% and held an agent with nothing to delete.
	const main = shaped(348, 0, 0, 107);
	ok("archives alone are not a decrease: nothing to prune → no mass-decrease", holdKind(main) === "none");

	// gpt on 2026-10-02: 656 live, 37 sup✓, 186 archives. Old ratio 223/879 = 25%.
	const gpt = shaped(656, 37, 0, 186);
	ok("a routine sup✓ step on an archive-heavy agent clears (37 of 693 live = 5%)", holdKind(gpt) === "none");

	// Archives must not dilute the step either: if they sat in the denominator,
	// every reset archive kept forever would raise the bar a little more.
	const diluted = shaped(100, 30, 0, 400);
	ok("archives do not dilute the step: 30 of 130 live rows is 23% even with 400 archives held",
		holdKind(diluted) === "mass-decrease" && diluted.flags.some((f) => f.startsWith("mass-decrease 23% > 20%")));

	// mini on 2026-09-29, the smallest per-agent step of the post-rebuild prune
	// (plan.json of data/openclaw-prune/2026-09-29T04-28-03-312Z-…): 210 upstream,
	// 61 dreaming + 17 sup✓ pruned → 78 / 288 = 27%.
	const rebuild = shaped(210, 17, 61, 55);
	ok("the 2026-09-29 post-rebuild step (mini, 27%) still trips 20%",
		holdKind(rebuild) === "mass-decrease" && rebuild.flags.some((f) => f.startsWith("mass-decrease 27% > 20%")));
	ok("…and the flag names what it counted", rebuild.flags.some((f) => /78 of 288 live rows/.test(f)));

	// sup? is kept (a replacement has not arrived with this snapshot's stamp), so
	// it is not part of the step.
	const up = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, source: "memory", path: "MEMORY.md" }));
	const m = parseManifestLines(manifestLines({ a: { chunks: up } }));
	const stale = new Date(2).toISOString();
	const hs = held("a", [
		...up.map((c) => [c.id, c.source, c.path, stale] as [string, string, string, string]),
		...Array.from({ length: 10 }, (_, i) => [`o${i}`, "memory", "MEMORY.md"] as [string, string, string]),
	]);
	const sq = reconcile({ held: hs, manifest: m, status: status({ a: {} }, m), statusPost: status({ a: {} }, m), binding: { ok: true }, run }).agents[0];
	ok("sup? rows are kept, so they are not a decrease (10 sup?, 0 to prune)",
		sq.gone.get("superseded-unconfirmed")?.length === 10 && holdKind(sq) === "none");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== same id, new updated_at ===");
{
	// Upstream re-embedded a row in place: same id, newer stamp. It is present
	// upstream, so it is NOT a reconcile candidate — and the importer still
	// rewrites it, because the stamp moved.
	const m = parseManifestLines(manifestLines({ a: { chunks: [{ id: "same", source: "memory", path: "M", updated_at: 99 }] } }));
	const rep = reconcile({ held: held("a", [["same", "memory", "M"]]), manifest: m, status: status({ a: {} }, m), statusPost: status({ a: {} }, m), binding: { ok: true }, run });
	ok("a same-id row with a new stamp is held ∩ upstream, not gone", rep.agents[0].both === 1 && rep.agents[0].gone.size === 0);
	const chunk = { id: "a:same", timestamp: new Date(99).toISOString() } as PreparedChunk;
	ok("…and the unchanged-skip does not skip it", partitionByChange([chunk], new Map([["a:same", new Date(1).toISOString()]])).write.length === 1);
}


// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== re-review holes (sol 2026-09-29) ===");
{
	const up = [{ id: "n", source: "memory", path: "MEMORY.md" }];
	const m = parseManifestLines(manifestLines({ a: { chunks: up }, b: { chunks: up } }));
	const hs = [...held("a", [["n", "memory", "MEMORY.md"], ["o", "memory", "MEMORY.md"]]), ...held("b", [["n", "memory", "MEMORY.md"], ["o", "memory", "MEMORY.md"]])];
	const clear = (st: StatusParse, post: StatusParse = st) =>
		reconcile({ held: hs, manifest: m, status: st, statusPost: post, binding: { ok: true }, run, maxRatio: 0.9 });

	// 1. status answered, but not for this agent
	const r1 = clear(status({ b: {} }, m));
	const a1 = r1.agents.find((x) => x.agent === "a")!;
	ok("status parsed but the agent is missing → status-missing hold", a1.flags.includes("status-missing: hold") && holdKind(a1) === "upstream");
	ok("…so its sup✓ is NOT counted clear of every guard", /clear of every guard 1,/.test(renderReconcile(r1, 0)));
	ok("the agent that status did answer for stays clear", holdKind(r1.agents.find((x) => x.agent === "b")!) === "none");

	// 1b. dirty is a hold, not a flag
	const a2 = clear(status({ a: { dirty: true }, b: {} }, m)).agents.find((x) => x.agent === "a")!;
	ok("valid + dirty → hold (upstream catch-up pending)", holdKind(a2) === "upstream" && a2.flags.some((f) => f.startsWith("dirty")));

	// 3. generation bracket
	const r3 = clear(status({ a: {}, b: {} }, m), status({ a: { identity: "mismatched", code: "chunking_version" }, b: {} }, m));
	ok("identity moved between the two status calls → generation-unbound hold",
		r3.agents.find((x) => x.agent === "a")!.flags.some((f) => f.startsWith("generation-unbound (identity moved")));
	const r4 = clear(status({ a: { chunks: 1 }, b: { chunks: 1 } }), status({ a: { chunks: 9 }, b: { chunks: 1 } }));
	ok("chunk count moved between the calls → hold", holdKind(r4.agents.find((x) => x.agent === "a")!) === "upstream");
	ok("…while the agent that held still is bound", holdKind(r4.agents.find((x) => x.agent === "b")!) === "none");
	const r5 = clear(status({ a: { chunks: 7 }, b: { chunks: 1 } }));
	ok("snapshot rows ≠ status chunks (both calls agree) → hold",
		r5.agents.find((x) => x.agent === "a")!.flags.some((f) => /snapshot rows 1 ≠ status chunks 7/.test(f)));
	ok("status without a chunk count binds nothing (sol third check)",
		generationUnbound("a", m.agents.get("a"), status({ a: {} }), status({ a: {} })) === "status chunk count missing");
	ok("generationUnbound: post failed → status-unknown",
		generationUnbound("a", m.agents.get("a"), status({ a: {} }, m), parseStatus(null)) === "status-unknown");
	ok("board: an unbound agent is not reported fresh",
		freshnessRows(m, status({ a: {}, b: {} }, m), status({ a: { dirty: true }, b: {} }, m)).find((r) => r.agent === "a")!.verdict === "unbound");

	// status structure
	ok("a status entry without agentId fails the whole parse", !parseStatus(JSON.stringify([{ status: {} }])).ok);
	ok("the same agentId twice fails the whole parse", !parseStatus(JSON.stringify([{ agentId: "a" }, { agentId: "a" }])).ok);

	// row digest covers source/path/stamp
	const garbled = manifestLines({ a: { chunks: up } }).map((l) => l.replace('"path": "MEMORY.md"', '"path": "OTHER.md"').replace('"path":"MEMORY.md"', '"path":"OTHER.md"'));
	const rg = reconcile({ held: held("a", [["n", "memory", "MEMORY.md"]]), manifest: parseManifestLines(garbled), status: status({ a: {} }), statusPost: status({ a: {} }), binding: { ok: true }, run });
	ok("a garbled path with the id set intact fails the row digest", rg.agents[0].guard === "not-classified:digest-mismatch");

	// superseded needs the same source AND this generation's stamp
	const upc = [{ agent: "x", id: "new", source: "memory", path: "P.md", updated_at: 5 }];
	const other = classifyGone("x", held("x", [["old", "sessions", "P.md"]]), upc, new Map([["x:new", new Date(5).toISOString()]]));
	ok("same path under another source is not re-chunking", !other.has("superseded-confirmed") && !other.has("superseded-unconfirmed"));
	const stale = classifyGone("x", held("x", [["old", "memory", "P.md"]]), upc, new Map([["x:new", new Date(4).toISOString()]]));
	ok("replacement held with an OLDER stamp → unconfirmed", stale.get("superseded-unconfirmed")?.length === 1);
	const fresh = classifyGone("x", held("x", [["old", "memory", "P.md"]]), upc, new Map([["x:new", new Date(5).toISOString()]]));
	ok("replacement held with this snapshot's stamp → confirmed", fresh.get("superseded-confirmed")?.length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== source vs index (memory) ===");
{
	const H = 3_600_000;
	const lines = manifestLines({ a: {}, b: {}, c: {} }).map((l) => {
		const r = JSON.parse(l);
		if (r.kind === "agent") r.indexed_mtime = { memory: 100 * H };
		return JSON.stringify(r);
	});
	const src = (agent: string, t: number | null) =>
		JSON.stringify({ kind: "source", agent, run_id: RUN, source: "memory", files: 3, newest_mtime: t, newest_path: "memory/new.md" });
	const m = parseManifestLines([...lines, src("a", 150 * H), src("b", 100 * H + 60_000), src("c", null)]);
	const fr = freshnessRows(m, status({ a: {}, b: {}, c: {} }, m));
	const a = fr.find((r) => r.agent === "a")!;
	ok("clean by status but a memory file 50h newer than the index → source-ahead", a.verdict === "source-ahead" && /2d newer/.test(a.prescription));
	ok("within the 1h tolerance → fresh", fr.find((r) => r.agent === "b")!.verdict === "fresh");
	ok("unknown source side → no lag claimed", fr.find((r) => r.agent === "c")!.memoryLagMs === null);
	const pr = freshnessRows(m, status({ a: { identity: "mismatched", code: "chunking_version" }, b: {}, c: {} }, m)).find((r) => r.agent === "a")!;
	ok("a paid-rebuild agent keeps its verdict and carries the lag as a note", pr.verdict === "paid-rebuild" && /memory source ahead of index by 2d/.test(pr.prescription));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== export-openclaw.sh — static guards ===");
{
	const src = fs.readFileSync(new URL("./scripts/export-openclaw.sh", import.meta.url), "utf-8");
	const code = src.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
	ok("no fixed remote artifact path (concurrent runs cannot collide)", !code.includes("/tmp/openclaw-chunks.jsonl.gz"));
	ok("the remote work dir is named by the run id", /run_dir="\/tmp\/andenken-openclaw\.\$RUN_ID"/.test(code));
	ok("the host is only read: no `memory index`, --index, --deep, --force or reset in executed lines",
		!/memory index|--index|--deep|--force|memory reset/.test(code));
	ok("every sqlite3 CLI open is -readonly", (code.match(/\bsqlite3 +(?!-readonly)["'$-]/g) ?? []).length === 0
		&& (code.match(/\bsqlite3 -readonly/g) ?? []).length >= 2);
	ok("the manifest's python open is mode=ro", /mode=ro/.test(code));
	ok("each agent's delta lands in its own file and joins the artifact only on success",
		/> "\$delta"; then\n\s+cat "\$delta" >> "\$out"/.test(code) && !/>> "\$out"; then/.test(code));
	ok("status is taken before the loop AND after it",
		code.indexOf('run_status status)') < code.indexOf('for dir in') && code.indexOf('run_status status-post)') > code.indexOf("MANIFEST\n  rm -f"));
	ok("the manifest carries a row digest over id/source/path/updated_at", /row_digest=hashlib/.test(code));
	ok("staging from the previous run is cleared before the new one starts", /rm -f "\$STAGE\/openclaw-chunks\.jsonl\.gz" "\$STAGE\/host" "\$STAGE\/run\.json"/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
