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
		}));
		for (const c of chunks) out.push(JSON.stringify({ kind: "chunk", agent, updated_at: 1, ...c }));
	}
	return out;
}

function status(agents: Record<string, { identity?: string; code?: string; dirty?: boolean }>): StatusParse {
	return parseStatus(JSON.stringify(Object.entries(agents).map(([agentId, s]) => ({
		agentId,
		status: {
			dirty: s.dirty ?? false,
			files: 1,
			sourceCounts: [{ source: "memory", files: 1, eligible: 1 }],
			custom: { indexIdentity: { status: s.identity ?? "valid", code: s.code } },
		},
		scan: { totalFiles: 1 },
	}))));
}

const held = (agent: string, rows: Array<[string, string, string]>): HeldRow[] =>
	rows.map(([id, source, p]) => ({ id: `${agent}:${id}`, source, sessionFile: p }));

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
	const heldIds = new Set(["x:new1", "x:dnew", ...gone.map((g) => g.id)]);
	const c = classifyGone("x", gone, up, heldIds);
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

	const receipt = { at: "", stagingMtimeMs: 0, seen: 1, imported: 0, unchanged: 1, host: "oracle" };
	ok("chunks staged, no receipt → refused (replacements not landed)",
		!checkBinding({ ...base, chunksStaged: true }).ok);
	ok("chunks staged, receipt of an EARLIER run → refused",
		!checkBinding({ ...base, chunksStaged: true, receipt: { ...receipt, runId: "older" } }).ok);
	ok("chunks staged, receipt of this run → bound",
		checkBinding({ ...base, chunksStaged: true, receipt: { ...receipt, runId: RUN } }).ok);

	const report = reconcile({
		held: held("a", [["1", "memory", "MEMORY.md"]]), manifest: stale, status: status({ a: {} }),
		binding: r1, run,
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
	const st = status(Object.fromEntries(Object.keys(ok7).map((k) => [k, {}])));
	const rep = reconcile({ held: hs, manifest: m, status: st, binding: { ok: true }, run, maxRatio: 0.9 });
	const c = rep.agents.find((a) => a.agent === "c")!;
	ok("the failed agent is not classified", c.guard === "not-classified:vacuum-failed" && c.gone.size === 0);
	ok("the six readable agents are", rep.agents.filter((a) => a.guard === "ok").length === 6);
	const fr = freshnessRows(m, st);
	ok("the board names it read-failed, not fresh", fr.find((r) => r.agent === "c")!.verdict === "read-failed");
	ok("…and lists it as not fresh-checked", /not fresh-checked: c/.test(renderFreshness(fr, run, st)));

	const dm = parseManifestLines(manifestLines({ a: { chunks: [{ id: "u", source: "memory", path: "M" }], digest: "0".repeat(64) } }));
	const dr = reconcile({ held: held("a", [["z", "memory", "M"]]), manifest: dm, status: st, binding: { ok: true }, run });
	ok("a manifest whose digest does not verify is not classified", dr.agents[0].guard === "not-classified:digest-mismatch");

	const df = parseManifestLines(manifestLines({ a: { state: "delta-failed", chunks: [{ id: "u", source: "memory", path: "M" }] } }));
	const dfr = reconcile({ held: held("a", [["z", "memory", "M"]]), manifest: df, status: st, binding: { ok: true }, run });
	ok("delta-failed (manifest fine, import missed its delta) is not classified", dfr.agents[0].guard === "not-classified:delta-failed");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== zero rows, no index, agents that vanish ===");
{
	const m = parseManifestLines(manifestLines({ a: {}, b: { state: "no-index" } }));
	const hs = [...held("a", [["1", "memory", "MEMORY.md"], ["2", "memory", "MEMORY.md"]]), ...held("b", [["1", "memory", "M"]]), ...held("z", [["1", "memory", "M"]])];
	const rep = reconcile({ held: hs, manifest: m, status: status({ a: {}, b: {} }), binding: { ok: true }, run });
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
	const st = status({ p: { identity: "mismatched", code: "chunking_version", dirty: true }, d: { dirty: true }, f: {} });
	const fr = freshnessRows(m, st);
	const p = fr.find((r) => r.agent === "p")!;
	ok("mismatched identity → paid-rebuild, even though it is also dirty", p.verdict === "paid-rebuild");
	ok("…and the prescription says a plain index call FULLY rebuilds", /FULLY rebuild/.test(p.prescription) && /GLG gate/.test(p.prescription));
	ok("…and the command it prints never carries --force", !/`[^`]*--force[^`]*`/.test(p.prescription));
	ok("valid + dirty → incremental", fr.find((r) => r.agent === "d")!.verdict === "incremental");
	ok("valid + clean → fresh", fr.find((r) => r.agent === "f")!.verdict === "fresh");

	const rep = reconcile({
		held: held("p", [["n", "memory", "MEMORY.md"], ["o", "memory", "MEMORY.md"]]),
		manifest: m, status: st, binding: { ok: true }, run, maxRatio: 0.9,
	});
	const pr = rep.agents.find((a) => a.agent === "p")!;
	ok("reconcile still classifies a paused agent (the numbers are useful)…", pr.gone.get("superseded-confirmed")?.length === 1);
	ok("…but holds it: the upstream is mid-change", holdKind(pr) === "upstream");

	const down = parseStatus("Error: gateway not running", "docker: container not found");
	ok("non-JSON status parses as a failure with the stderr hint", !down.ok && /container not found/.test((down as { reason: string }).reason));
	const fd = freshnessRows(m, down);
	ok("a failed status call leaves NO agent reported fresh", fd.every((r) => r.verdict === "status-unknown"));
	const rd = reconcile({ held: held("f", [["n", "memory", "MEMORY.md"], ["o", "memory", "MEMORY.md"]]), manifest: m, status: down, binding: { ok: true }, run, maxRatio: 0.9 });
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
	const rep = reconcile({ held: hs, manifest: m, status: status({ a: {} }), binding: { ok: true }, run });
	const a = rep.agents[0];
	ok("38% gone trips the default 20% threshold", a.flags.some((f) => f.startsWith("mass-decrease 38%")));
	ok("…as a mass-decrease hold, distinct from an upstream hold", holdKind(a) === "mass-decrease");
	ok("…and the summary counts it apart", /behind mass-decrease only 38/.test(renderReconcile(rep, 0)));
	const loose = reconcile({ held: hs, manifest: m, status: status({ a: {} }), binding: { ok: true }, run, maxRatio: 0.5 });
	ok("under the threshold the same rows are clear of every guard", holdKind(loose.agents[0]) === "none" && /clear of every guard 38/.test(renderReconcile(loose, 0)));
	ok("retry: the dry-run is pure — same input, same report",
		renderReconcile(reconcile({ held: hs, manifest: m, status: status({ a: {} }), binding: { ok: true }, run }), 3) === renderReconcile(rep, 3));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== same id, new updated_at ===");
{
	// Upstream re-embedded a row in place: same id, newer stamp. It is present
	// upstream, so it is NOT a reconcile candidate — and the importer still
	// rewrites it, because the stamp moved.
	const m = parseManifestLines(manifestLines({ a: { chunks: [{ id: "same", source: "memory", path: "M", updated_at: 99 }] } }));
	const rep = reconcile({ held: held("a", [["same", "memory", "M"]]), manifest: m, status: status({ a: {} }), binding: { ok: true }, run });
	ok("a same-id row with a new stamp is held ∩ upstream, not gone", rep.agents[0].both === 1 && rep.agents[0].gone.size === 0);
	const chunk = { id: "a:same", timestamp: new Date(99).toISOString() } as PreparedChunk;
	ok("…and the unchanged-skip does not skip it", partitionByChange([chunk], new Map([["a:same", new Date(1).toISOString()]])).write.length === 1);
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
	ok("staging from the previous run is cleared before the new one starts", /rm -f "\$STAGE\/openclaw-chunks\.jsonl\.gz" "\$STAGE\/host" "\$STAGE\/run\.json"/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
