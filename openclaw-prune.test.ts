#!/usr/bin/env tsx
/**
 * Fixture tests for the OpenClaw prune (tier 4, stage C — 2026-09-29).
 *
 * API 0. ssh 0. A throwaway LanceDB under the OS temp dir for the apply /
 * backup / restore round trip; everything else is pure.
 *
 * The prune is the only code in this repo that removes a harvested row, so the
 * tests are written from the side of "what must never be deleted": session
 * archives, rows of an agent that did not clear every hold, a mass decrease
 * nobody allowed, rows of an agent whose upstream moved since the run, a
 * dreaming file that is still on disk, and anything whose backup did not read
 * back.
 *
 * Run it: `./run.sh test:openclaw` (after the import and reconcile tests).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { spawnSync } from "child_process";
import { VectorStore } from "./store.ts";
import {
	applyRecheck,
	executePrune,
	localRecheck,
	planIds,
	planPrune,
	recheckRequest,
	renderPlan,
	restorePrune,
	type PrunePlan,
	type RecheckAgent,
} from "./openclaw-prune.ts";
import {
	digestIds,
	digestRows,
	parseManifestLines,
	parseStatus,
	reconcile,
	type HeldRow,
	type Manifest,
	type StatusParse,
} from "./openclaw-reconcile.ts";
import type { StagedRun } from "./openclaw-importer.ts";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const RUN = "20260929T000000Z-1-abcdef";
const run: StagedRun = { runId: RUN, host: "oracle", mode: "delta", exportedAt: 0, rows: 0, agentsOk: 1, agentsSkipped: [], statusRc: "0", statusPostRc: "0" };
const STAMP1 = new Date(1).toISOString();

type Chunk = { id: string; source: string; path: string };
function manifest(agents: Record<string, { chunks: Chunk[]; revision?: number | null }>): Manifest {
	const lines: string[] = [];
	for (const [agent, a] of Object.entries(agents)) {
		lines.push(JSON.stringify({
			kind: "agent", agent, state: "ok", run_id: RUN, rows: a.chunks.length, max_updated_at: 1,
			revision: a.revision === undefined ? 7 : a.revision, meta: {},
			digest: digestIds(a.chunks.map((c) => c.id)),
			row_digest: digestRows(a.chunks.map((c) => ({ agent, updated_at: 1, ...c }))),
		}));
		for (const c of a.chunks) lines.push(JSON.stringify({ kind: "chunk", agent, updated_at: 1, ...c }));
	}
	return parseManifestLines(lines);
}
function status(m: Manifest, over: Record<string, { identity?: string; dirty?: boolean }> = {}): StatusParse {
	return parseStatus(JSON.stringify([...m.agents.keys()].map((agentId) => ({
		agentId,
		status: {
			dirty: over[agentId]?.dirty ?? false, files: 1, chunks: m.agents.get(agentId)!.rows,
			workspaceDir: `/home/node/.openclaw/workspace-${agentId}`,
			custom: { indexIdentity: { status: over[agentId]?.identity ?? "valid" } },
		},
	}))));
}
const held = (agent: string, rows: Array<[string, string, string]>): HeldRow[] =>
	rows.map(([id, source, p]) => ({ id: `${agent}:${id}`, source, sessionFile: p, timestamp: STAMP1 }));

/**
 * Agent `a`: 10 upstream rows (MEMORY.md), held = those 10 + 1 old MEMORY.md
 * chunk (sup✓) + 1 dreaming + 1 reset archive + 1 deleted archive. 4/14 = 29%
 * gone, so `maxRatio` decides whether it is a mass decrease.
 */
function world(over: { identity?: string; dirty?: boolean; revision?: number | null } = {}) {
	const up = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, source: "memory", path: "MEMORY.md" }));
	const m = manifest({ a: { chunks: up, revision: over.revision } });
	const st = status(m, { a: { identity: over.identity, dirty: over.dirty } });
	const hs = [
		...held("a", up.map((c) => [c.id, c.source, c.path] as [string, string, string])),
		...held("a", [
			["old", "memory", "MEMORY.md"],
			["dr", "memory", "memory/dreaming/light/2026-04-21.md"],
			["rs", "sessions", "sessions/a/s.jsonl.reset.2026-08-01T00-00-00.000Z"],
			["dl", "sessions", "sessions/a/t.jsonl.deleted.2026-08-01T00-00-00.000Z"],
		]),
	];
	return { m, st, hs };
}
const report = (w: ReturnType<typeof world>, maxRatio = 0.5) =>
	reconcile({ held: w.hs, manifest: w.m, status: w.st, statusPost: w.st, binding: { ok: true }, run, maxRatio });

const liveOk = (over: Partial<RecheckAgent> = {}) =>
	new Map<string, RecheckAgent>([["a", { agent: "a", ok: true, revision: 7, rows: 10, digest: digestIds(Array.from({ length: 10 }, (_, i) => `n${i}`)), existingDreamPaths: [], ...over }]]);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== plan — what may be deleted at all ===");
{
	const w = world();
	const plan = planPrune(report(w), w.m, w.st, { allowMassDecrease: false });
	const ids = planIds(plan).sort();
	ok("only dream + sup✓ are planned", ids.join(",") === "a:dr,a:old");
	ok("session archives (reset, deleted) are never planned", !ids.includes("a:rs") && !ids.includes("a:dl"));
	ok("the plan carries the snapshot's revision / rows / digest for the live re-check",
		plan.agents[0].expected.revision === 7 && plan.agents[0].expected.rows === 10 && plan.agents[0].expected.digest !== null);
	ok("…and the workspace dir the status reported", plan.agents[0].workspaceDir === "/home/node/.openclaw/workspace-a");
	ok("the dry-run text says it deletes nothing", /DRY RUN \(nothing deleted/.test(renderPlan(plan, [], false)));

	const refused = { ...report(w), binding: { ok: false as const, reason: "stale" } };
	let threw = false;
	try { planPrune(refused, w.m, w.st, { allowMassDecrease: true }); } catch { threw = true; }
	ok("a refused binding refuses the plan", threw);
}

console.log("\n=== plan — every hold is a hold ===");
{
	const hold = (w: ReturnType<typeof world>, maxRatio = 0.5, allow = true) =>
		planPrune(report(w, maxRatio), w.m, w.st, { allowMassDecrease: allow }).agents[0];
	ok("identity mismatched → hold", hold(world({ identity: "mismatched" })).decision === "hold");
	ok("dirty → hold", hold(world({ dirty: true })).decision === "hold");
	ok("…even with --allow-mass-decrease (it only passes the size guard)",
		hold(world({ dirty: true }), 0.1, true).decision === "hold");
	ok("no revision in the snapshot → hold (nothing to re-check against)", hold(world({ revision: null })).decision === "hold");

	const massNo = hold(world(), 0.2, false);
	ok("29% > 20% without the flag → hold, and the reason names the flag", massNo.decision === "hold" && /--allow-mass-decrease/.test(massNo.reason));
	const massYes = hold(world(), 0.2, true);
	ok("…with --allow-mass-decrease → prune", massYes.decision === "prune" && /allowed for this invocation/.test(massYes.reason));

	const w = world();
	const noStatus = planPrune(
		reconcile({ held: w.hs, manifest: w.m, status: parseStatus(JSON.stringify([])), statusPost: parseStatus(JSON.stringify([])), binding: { ok: true }, run, maxRatio: 0.5 }),
		w.m, parseStatus(JSON.stringify([])), { allowMassDecrease: true },
	);
	ok("status that does not list the agent → hold", noStatus.agents[0].decision === "hold");
}

console.log("\n=== live re-check — the last look before deleting ===");
{
	const fresh = () => { const w = world(); return planPrune(report(w), w.m, w.st, { allowMassDecrease: false }); };
	ok("revision, rows and digest unchanged → still prune", applyRecheck(fresh(), liveOk()).plan.agents[0].decision === "prune");

	const moved = applyRecheck(fresh(), liveOk({ revision: 8 }));
	ok("SAME COUNT, NEW GENERATION: revision moved → hold", moved.plan.agents[0].decision === "hold" && /revision 7 → 8/.test(moved.heldBack[0]));
	ok("rows moved → hold", applyRecheck(fresh(), liveOk({ rows: 11 })).plan.agents[0].decision === "hold");
	ok("id digest moved → hold", applyRecheck(fresh(), liveOk({ digest: "x" })).plan.agents[0].decision === "hold");
	ok("re-check failed (ssh / sqlite) → hold", applyRecheck(fresh(), liveOk({ ok: false, error: "boom" })).plan.agents[0].decision === "hold");
	ok("no answer for the agent → hold", applyRecheck(fresh(), new Map()).plan.agents[0].decision === "hold");

	const still = applyRecheck(fresh(), liveOk({ existingDreamPaths: ["memory/dreaming/light/2026-04-21.md"] }));
	ok("a dreaming file still in the workspace keeps its rows", !planIds(still.plan).includes("a:dr") && planIds(still.plan).includes("a:old"));
	const unknown = applyRecheck(fresh(), liveOk({ workspaceUnknown: true, existingDreamPaths: undefined }));
	ok("unknown workspace → dreaming held, sup✓ still goes", planIds(unknown.plan).join(",") === "a:old");

	const w2 = world();
	const onlyDream = planPrune(report(w2), w2.m, w2.st, { allowMassDecrease: false });
	onlyDream.agents[0].byClass.delete("superseded-confirmed");
	const empty = applyRecheck(onlyDream, liveOk({ existingDreamPaths: ["memory/dreaming/light/2026-04-21.md"] }));
	ok("nothing left after the re-check → the agent becomes a hold", empty.plan.agents[0].decision === "hold" && planIds(empty.plan).length === 0);

	const req = recheckRequest(fresh());
	ok("the re-check request asks only about agents that would be pruned, dream paths deduped",
		req.agents.length === 1 && req.agents[0].dreamPaths.length === 1);
}


// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== the re-check script itself, run locally against a fake host ===");
{
	// The same RECHECK_PY that ssh ships, pointed at a temp "host": an agents dir
	// with a real sqlite db, and a workspace beside it the way the gateway mounts it.
	const host = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-recheck-"));
	try {
		const agentsDir = path.join(host, "agents");
		const db = path.join(agentsDir, "a", "agent", "openclaw-agent.sqlite");
		fs.mkdirSync(path.dirname(db), { recursive: true });
		const mk = spawnSync("python3", ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("create table memory_index_chunks (id text primary key)")
c.execute("create table memory_index_state (id integer primary key, revision integer)")
c.executemany("insert into memory_index_chunks values (?)", [("n%d" % i,) for i in range(10)])
c.execute("insert into memory_index_state values (1, 7)")
c.commit()`, db]);
		ok("fixture db created", mk.status === 0);
		const ws = path.join(host, "workspace-a");
		fs.mkdirSync(path.join(ws, "memory", "dreaming", "light"), { recursive: true });
		const DREAM = "memory/dreaming/light/2026-04-21.md";
		const req = (workspaceDir: string | null) => ({ agents: [{ agent: "a", workspaceDir, dreamPaths: [DREAM] }] });
		const run1 = (workspaceDir: string | null, home = "/home/node/.openclaw") => localRecheck(agentsDir, home)(req(workspaceDir)).get("a")!;

		const moved = run1("/home/node/.openclaw/workspace-a");
		ok("live db read: revision, rows and the same digest the manifest uses",
			moved.ok && moved.revision === 7 && moved.rows === 10 && moved.digest === digestIds(Array.from({ length: 10 }, (_, i) => `n${i}`)));
		ok("mapped workspace present, file absent → provably moved", moved.workspaceUnknown !== true && moved.existingDreamPaths?.length === 0);

		fs.writeFileSync(path.join(ws, DREAM), "still here");
		ok("file present → reported as still there", run1("/home/node/.openclaw/workspace-a").existingDreamPaths?.[0] === DREAM);
		fs.rmSync(path.join(ws, DREAM));

		// A broken symlink at the path is still something standing there.
		fs.symlinkSync(path.join(ws, "nowhere.md"), path.join(ws, DREAM));
		ok("broken symlink at the path → still there (lstat, not stat)", run1("/home/node/.openclaw/workspace-a").existingDreamPaths?.[0] === DREAM);
		fs.rmSync(path.join(ws, DREAM));

		// A path component that is a FILE gives ENOTDIR, not ENOENT: unknown.
		fs.rmSync(path.join(ws, "memory", "dreaming"), { recursive: true });
		fs.writeFileSync(path.join(ws, "memory", "dreaming"), "a file where a dir should be");
		const notDir = run1("/home/node/.openclaw/workspace-a");
		ok("ENOTDIR (not ENOENT) → the agent's dreaming is unknown", notDir.workspaceUnknown === true && /NotADirectoryError/.test(notDir.workspaceWhy ?? ""));
		fs.rmSync(path.join(ws, "memory", "dreaming"));

		// Unreadable directory: EACCES on lstat of an entry below it. Skipped when
		// running as root, where permission bits do not bind.
		if (process.getuid && process.getuid() !== 0) {
			fs.mkdirSync(path.join(ws, "memory", "dreaming", "light"), { recursive: true });
			fs.chmodSync(path.join(ws, "memory", "dreaming"), 0o000);
			const denied = run1("/home/node/.openclaw/workspace-a");
			fs.chmodSync(path.join(ws, "memory", "dreaming"), 0o755);
			ok("EACCES → the agent's dreaming is unknown, not 'moved'", denied.workspaceUnknown === true && /PermissionError/.test(denied.workspaceWhy ?? ""));
		}

		const wrongMap = run1("/home/node/.openclaw/workspace-a", "/wrong/home");
		ok("WRONG MAPPING (prefix mismatch) → unknown, not 'moved'", wrongMap.workspaceUnknown === true && wrongMap.existingDreamPaths === undefined);
		const noDir = run1("/home/node/.openclaw/workspace-missing");
		ok("MAPPED DIR MISSING → unknown, not 'moved'", noDir.workspaceUnknown === true && /not a directory/.test(noDir.workspaceWhy ?? ""));
		fs.mkdirSync(path.join(host, "workspace-bare"));
		const noMem = run1("/home/node/.openclaw/workspace-bare");
		ok("workspace without memory/ → unknown", noMem.workspaceUnknown === true && /no memory\//.test(noMem.workspaceWhy ?? ""));
		ok("prefix look-alike (/home/node/.openclawX/…) → unknown", run1("/home/node/.openclawX/workspace-a").workspaceUnknown === true);

		// End to end through applyRecheck: the 861-row failure sol described.
		const w = world();
		const plan = planPrune(report(w), w.m, w.st, { allowMassDecrease: false });
		const live = localRecheck(agentsDir, "/home/node/.openclaw")({ agents: [{ agent: "a", workspaceDir: "/home/node/.openclaw/workspace-missing", dreamPaths: [DREAM] }] });
		const folded = applyRecheck(plan, live);
		ok("…and a missing workspace keeps every dreaming row out of the plan", !planIds(folded.plan).includes("a:dr") && planIds(folded.plan).includes("a:old"));
		ok("an answer with no dream list at all is treated as unknown",
			!planIds(applyRecheck(planPrune(report(w), w.m, w.st, { allowMassDecrease: false }), liveOk({ existingDreamPaths: undefined })).plan).includes("a:dr"));
	} finally {
		fs.rmSync(host, { recursive: true, force: true });
	}
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== apply / backup / restore on a throwaway store ===");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-prune-"));
try {
	const store = new VectorStore(path.join(tmp, "openclaw.lance"), 4096);
	await store.init();
	const vec = (seed: number) => Array.from({ length: 4096 }, (_, i) => Math.fround(Math.sin(seed * 1000 + i)));
	await store.addChunksRaw(["a:n0", "a:old", "a:dr", "a:rs"].map((id, k) => ({
		id, text: `t-${id}`, vector: vec(k), sessionFile: `p-${id}`, project: "a", lineNumber: 0,
		timestamp: STAMP1, role: "", source: "memory", metadata: { agent: "a" },
	})));
	const before = await store.getCount();

	const plan: PrunePlan = {
		runId: RUN, host: "oracle", allowMassDecrease: false,
		agents: [{
			agent: "a", decision: "prune", reason: "t", workspaceDir: null,
			expected: { revision: 7, rows: 1, digest: "d" },
			byClass: new Map([
				["superseded-confirmed", [{ id: "a:old", source: "memory", sessionFile: "p-a:old", timestamp: STAMP1 }]],
				["dreaming", [{ id: "a:dr", source: "memory", sessionFile: "p-a:dr", timestamp: STAMP1 }]],
			]),
		}],
	};
	const dir = path.join(tmp, "prune-1");
	const r = await executePrune(plan, store, dir, ["note"]);
	ok("apply: receipt says applied", r.status === "applied");
	ok("apply: exactly the planned rows left", r.deleted === 2 && r.countAfter === before - 2 && r.stillPresent === 0);
	ok("apply: the rows outside the plan (incl. a reset archive) are untouched",
		(await store.getStoredStamps(["a:n0", "a:rs"])).size === 2);
	ok("apply: backup, plan and receipt are on disk",
		["rows.jsonl.gz", "plan.json", "receipt.json"].every((f) => fs.existsSync(path.join(dir, f))));
	const backup = zlib.gunzipSync(fs.readFileSync(path.join(dir, "rows.jsonl.gz"))).toString().trim().split("\n").map((l) => JSON.parse(l));
	ok("backup holds the whole row: text and a 4096d float32 vector",
		backup.length === 2 && backup.every((b) => b.text.startsWith("t-") && Buffer.from(b.vector_f32_b64, "base64").byteLength === 4096 * 4));

	const res = await restorePrune(dir, store);
	ok("restore re-adds what was deleted", res.restored === 2 && (await store.getCount()) === before);
	const back = await store.getRowsByIds(["a:old"]);
	const v = Array.from((back[0].vector as { toArray(): Float32Array }).toArray());
	ok("restore is bit-exact on the vector", v.length === 4096 && v.every((x, i) => x === Math.fround(Math.sin(1 * 1000 + i))));
	const again = await restorePrune(dir, store);
	ok("restore is idempotent", again.restored === 0 && again.alreadyPresent === 2 && (await store.getCount()) === before);

	// A plan naming a row the store does not hold: the backup cannot be complete,
	// so nothing may be deleted.
	const bad: PrunePlan = { ...plan, agents: [{ ...plan.agents[0], byClass: new Map([["dreaming", [
		{ id: "a:dr", source: "memory", sessionFile: "x", timestamp: STAMP1 },
		{ id: "a:ghost", source: "memory", sessionFile: "x", timestamp: STAMP1 },
	]]]) }] };
	let threw = false;
	try { await executePrune(bad, store, path.join(tmp, "prune-2")); } catch { threw = true; }
	const badReceipt = JSON.parse(fs.readFileSync(path.join(tmp, "prune-2", "receipt.json"), "utf-8"));
	ok("incomplete backup → refused before the first delete", threw && badReceipt.status === "aborted-before-delete" && badReceipt.deleted === 0);
	ok("…and the store is unchanged", (await store.getCount()) === before && (await store.getStoredStamps(["a:dr"])).size === 1);
	await store.close();
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== CLI / run.sh — static guards ===");
{
	const src = fs.readFileSync(new URL("./openclaw-prune.ts", import.meta.url), "utf-8");
	const mainSrc = src.slice(src.indexOf("async function main"));
	ok("delete happens only after `if (!apply) return`", mainSrc.indexOf("if (!apply) return") >= 0 && mainSrc.indexOf("if (!apply) return") < mainSrc.indexOf("executePrune("));
	ok("--offline cannot be combined with --apply", /apply && offline/.test(mainSrc));
	ok("the mass-decrease threshold is fixed, not read from the env", /loadStagedReport\(DEFAULT_MAX_RATIO\)/.test(mainSrc) && !/RECONCILE_MAX_RATIO/.test(src));
	ok("the live re-check opens the upstream db mode=ro", /mode=ro/.test(src) && !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+|vacuum|replace\s+into)\b/i.test(src.slice(src.indexOf("RECHECK_PY"), src.indexOf("`;", src.indexOf("RECHECK_PY")))));
	const runsh = fs.readFileSync(new URL("./run.sh", import.meta.url), "utf-8");
	const pr = runsh.slice(runsh.indexOf("  prune:openclaw)"), runsh.indexOf("  report:openclaw)"));
	ok("run.sh prune:openclaw takes the harvest lock before anything else", pr.indexOf("flock -n 8") >= 0 && pr.indexOf("flock -n 8") < pr.indexOf("openclaw-prune.ts"));
	ok("--publish only after --apply, and verify before the push", /\*" --apply "\*\) \.\/run\.sh verify openclaw && bash scripts\/sync-openclaw-to-oracle\.sh/.test(pr));
	const pub = fs.readFileSync(new URL("./scripts/sync-openclaw-to-oracle.sh", import.meta.url), "utf-8");
	ok("a standalone publish takes the same lock", /flock -n 8/.test(pub) && /ANDENKEN_OPENCLAW_LOCK_HELD/.test(pub));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
