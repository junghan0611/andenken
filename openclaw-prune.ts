/**
 * openclaw-prune.ts — stage C of the tier-4 repair: the ONE place that deletes
 * rows from openclaw.lance. Dry-run by default; `--apply` deletes.
 *
 * GLG ruling (2026-09-29, relayed by the agent-config coordinator): prune the
 * `dreaming` and `superseded-confirmed` classes only. Session archives —
 * reset / deleted / renamed / path-gone — stay: at least one of them
 * (gpt `841e5bbf…reset`) has no transcript left upstream, so our row may be the
 * only copy. INVARIANT §7.3 rule 1 still holds for every other path: the
 * importer never deletes; only this command does, only these two classes, only
 * after every check below.
 *
 * What has to be true before a row goes (sol reviews 1–3, 2026-09-29):
 *
 *   1. The staged run binds (run.json ↔ manifest ↔ host ↔ import receipt).
 *   2. The agent passes EVERY hold: classified (read ok, both digests verify),
 *      status answered before and after the snapshot, the two answers agree and
 *      carry a chunk count equal to the snapshot's rows, identity valid, not
 *      dirty, upstream not empty.
 *   3. A per-agent prune step above 20% — dream + sup✓ to delete, against the
 *      live rows held ∩ upstream plus that step; kept archives count on neither
 *      side — is held unless `--allow-mass-decrease` is given on THIS invocation.
 *      The threshold is not an env knob here: raising a number must not stand in
 *      for the approval.
 *   4. Immediately before deleting, the LIVE upstream database is re-read
 *      (read-only) and its revision, row count and id digest must equal the
 *      staged snapshot's. Anything that moved since the run → that agent is held.
 *      This is also what catches a same-count generation change: the revision
 *      moves even when the count does not.
 *   5. A dreaming row goes only if its file is actually gone from the workspace
 *      (it was moved out, not merely unindexed). Unknown workspace → held.
 *   6. Every row about to be deleted is backed up whole — text, metadata and the
 *      float32 vector — and the backup is read back and matched id-for-id before
 *      the first delete. A receipt records what happened, including a failure
 *      half-way, next to the backup; `--restore <dir>` re-adds it.
 *
 * The harvest lock (`data/.openclaw-harvest.lock`) is held by `run.sh` around
 * plan → apply → verify → publish.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { spawnSync } from "child_process";
import { VectorStore, getOpenclawDbPath, getDataDir } from "./store.js";
import {
	DEFAULT_MAX_RATIO,
	PRUNE_ELIGIBLE,
	RECONCILE_CLASSES,
	holdKind,
	loadStagedReport,
	type HeldRow,
	type Manifest,
	type ReconcileClass,
	type ReconcileReport,
	type StatusParse,
} from "./openclaw-reconcile.js";

const OPENCLAW_DIM = 4096;

// ── Plan ──────────────────────────────────────────────────────────────────────

export interface PlanAgent {
	agent: string;
	decision: "prune" | "hold";
	reason: string;
	byClass: Map<ReconcileClass, HeldRow[]>;
	/** Snapshot facts the live re-check must reproduce. */
	expected: { revision: number | null; rows: number; digest: string | null };
	workspaceDir: string | null;
}

export interface PrunePlan {
	runId: string;
	host: string;
	allowMassDecrease: boolean;
	agents: PlanAgent[];
}

export function planIds(plan: PrunePlan): string[] {
	return plan.agents
		.filter((a) => a.decision === "prune")
		.flatMap((a) => [...a.byClass.values()].flat().map((r) => r.id));
}

export function planPrune(
	report: ReconcileReport,
	manifest: Manifest,
	status: StatusParse,
	opts: { allowMassDecrease: boolean },
): PrunePlan {
	if (!report.binding.ok) throw new Error(`refused: ${report.binding.reason}`);
	const plan: PrunePlan = {
		runId: report.runId ?? "?",
		host: report.host ?? "?",
		allowMassDecrease: opts.allowMassDecrease,
		agents: [],
	};
	for (const a of report.agents) {
		const m = manifest.agents.get(a.agent);
		const byClass = new Map<ReconcileClass, HeldRow[]>();
		for (const [c, rows] of a.gone) if (PRUNE_ELIGIBLE.has(c) && rows.length > 0) byClass.set(c, rows);
		const pa: PlanAgent = {
			agent: a.agent,
			decision: "hold",
			reason: "",
			byClass,
			expected: { revision: m?.revision ?? null, rows: m?.rows ?? 0, digest: m?.digest ?? null },
			workspaceDir: status.ok ? (status.byAgent.get(a.agent)?.workspaceDir ?? null) : null,
		};
		plan.agents.push(pa);
		const kind = holdKind(a);
		if (a.guard !== "ok") pa.reason = a.guard;
		else if (kind === "upstream") pa.reason = a.flags.filter((f) => f.endsWith("hold")).join("; ");
		else if (kind === "mass-decrease" && !opts.allowMassDecrease) {
			pa.reason = `${a.flags.find((f) => f.startsWith("mass-decrease"))} — needs --allow-mass-decrease`;
		} else if (byClass.size === 0) pa.reason = "nothing in dream / sup✓";
		else if (m?.revision === null || m?.revision === undefined) pa.reason = "snapshot has no revision to re-check against";
		else {
			pa.decision = "prune";
			pa.reason = kind === "mass-decrease" ? "mass-decrease allowed for this invocation" : "all guards clear";
		}
	}
	return plan;
}

// ── Live re-check ─────────────────────────────────────────────────────────────

export interface RecheckAgent {
	agent: string;
	ok: boolean;
	error?: string;
	revision?: number | null;
	rows?: number;
	digest?: string;
	/** Dreaming paths from the plan that still exist in the workspace. */
	existingDreamPaths?: string[];
	/** True when the workspace could not be located, so no dreaming move is proven. */
	workspaceUnknown?: boolean;
	workspaceWhy?: string;
}

export interface RecheckRequest {
	agents: Array<{ agent: string; workspaceDir: string | null; dreamPaths: string[] }>;
}

export type Recheck = (req: RecheckRequest) => Map<string, RecheckAgent>;

/**
 * Fold the live re-check into the plan. Returns the plan with agents re-held
 * and dreaming rows removed where their file is still present, plus a list of
 * what was held back and why.
 */
export function applyRecheck(plan: PrunePlan, live: Map<string, RecheckAgent>): { plan: PrunePlan; heldBack: string[] } {
	const heldBack: string[] = [];
	for (const a of plan.agents) {
		if (a.decision !== "prune") continue;
		const r = live.get(a.agent);
		const hold = (why: string) => {
			a.decision = "hold";
			a.reason = why;
			heldBack.push(`${a.agent}: ${why}`);
		};
		if (!r || !r.ok) { hold(`live re-check failed (${r?.error ?? "no answer"})`); continue; }
		if (r.revision !== a.expected.revision) { hold(`upstream moved since the run: revision ${a.expected.revision} → ${r.revision}`); continue; }
		if (r.rows !== a.expected.rows) { hold(`upstream moved since the run: rows ${a.expected.rows} → ${r.rows}`); continue; }
		if (r.digest !== a.expected.digest) { hold("upstream moved since the run: id digest differs"); continue; }

		const dream = a.byClass.get("dreaming");
		if (dream) {
			// A malformed answer (no list at all) proves nothing either.
			if (r.workspaceUnknown || !Array.isArray(r.existingDreamPaths)) {
				a.byClass.delete("dreaming");
				heldBack.push(`${a.agent}: ${dream.length} dreaming rows held — workspace unknown (${r.workspaceWhy ?? "?"}), the move is not proven`);
			} else {
				const still = new Set(r.existingDreamPaths ?? []);
				const keep = dream.filter((row) => !still.has(row.sessionFile));
				if (keep.length !== dream.length) {
					heldBack.push(`${a.agent}: ${dream.length - keep.length} dreaming rows held — file still in the workspace`);
				}
				if (keep.length > 0) a.byClass.set("dreaming", keep);
				else a.byClass.delete("dreaming");
			}
		}
		if (a.byClass.size === 0) { a.decision = "hold"; a.reason = "nothing left after the live re-check"; }
	}
	return { plan, heldBack };
}

const RECHECK_PY = String.raw`
import base64, hashlib, json, os, sqlite3, sys
req = json.loads(base64.b64decode(sys.argv[1]))
agents_dir = os.path.expandvars(os.path.expanduser(req["agentsDir"])).rstrip("/")
host_root = os.path.dirname(agents_dir)
container_home = req["containerHome"].rstrip("/")
out = {}
for a in req["agents"]:
    name = a["agent"]
    r = {"agent": name}
    db = os.path.join(agents_dir, name, "agent", "openclaw-agent.sqlite")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con.execute("begin")
        row = con.execute("select revision from memory_index_state where id = 1").fetchone()
        ids = sorted(x[0] for x in con.execute("select id from memory_index_chunks"))
        con.rollback()
        con.close()
        r.update(ok=True, revision=row[0] if row else None, rows=len(ids),
                 digest=hashlib.sha256("\n".join(ids).encode()).hexdigest())
    except Exception as e:
        r.update(ok=False, error=str(e)[:200])
    # "The file is gone" is only a claim if we are provably looking at the
    # workspace: the mapped directory and its memory/ must exist and be listable.
    # A wrong mapping or a missing directory would otherwise make every dreaming
    # path look moved (sol P0, 2026-09-29) — so anything short of that is unknown.
    ws = a.get("workspaceDir") or ""
    why = None
    if not ws.startswith(container_home + "/"):
        why = "workspaceDir is not under the container home"
    else:
        host_ws = host_root + ws[len(container_home):]
        mem = os.path.join(host_ws, "memory")
        if not os.path.isdir(host_ws):
            why = "mapped workspace is not a directory: " + host_ws
        elif not os.path.isdir(mem):
            why = "mapped workspace has no memory/: " + host_ws
        else:
            try:
                os.listdir(host_ws)
                os.listdir(mem)
            except OSError as e:
                why = "mapped workspace is not readable: " + str(e)[:120]
    existing = []
    if not why:
        # Only ENOENT means "moved". lstat, not stat: a symlink — broken or not —
        # is something still standing at that path. Any other error (EACCES,
        # ENOTDIR, ELOOP, …) proves nothing, and holds the agent's dreaming rows.
        for p in a["dreamPaths"]:
            try:
                os.lstat(os.path.join(host_ws, p))
                existing.append(p)
            except FileNotFoundError:
                pass
            except OSError as e:
                why = "cannot tell whether %s is gone: %s" % (p, e.__class__.__name__)
                break
    if why:
        r["workspaceUnknown"] = True
        r["workspaceWhy"] = why
    else:
        r["existingDreamPaths"] = existing
    out[name] = r
print(json.dumps(out))
`;

function runRecheck(cmd: string, argv: string[], agentsDir: string, containerHome: string): Recheck {
	return (req) => {
		const arg = Buffer.from(JSON.stringify({ ...req, agentsDir, containerHome })).toString("base64");
		const res = spawnSync(cmd, [...argv, arg], { input: RECHECK_PY, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
		const out = new Map<string, RecheckAgent>();
		if (res.status !== 0) {
			for (const a of req.agents) {
				out.set(a.agent, { agent: a.agent, ok: false, error: `exit ${res.status}: ${(res.stderr ?? "").trim().split("\n").pop()}` });
			}
			return out;
		}
		const parsed = JSON.parse(res.stdout) as Record<string, RecheckAgent>;
		for (const [k, v] of Object.entries(parsed)) out.set(k, v);
		return out;
	};
}

/** The real re-check: one read-only ssh round trip, no write on the host. */
export function sshRecheck(host: string, agentsDir: string, containerHome: string): Recheck {
	// The remote shell joins these words into one command line; the last word
	// (the base64 request) is appended by runRecheck.
	return runRecheck("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "python3", "-"], agentsDir, containerHome);
}

/** The same script run locally — for fixtures, never for a real prune. */
export function localRecheck(agentsDir: string, containerHome: string): Recheck {
	return runRecheck("python3", ["-"], agentsDir, containerHome);
}

export function recheckRequest(plan: PrunePlan): RecheckRequest {
	return {
		agents: plan.agents
			.filter((a) => a.decision === "prune")
			.map((a) => ({
				agent: a.agent,
				workspaceDir: a.workspaceDir,
				dreamPaths: [...new Set((a.byClass.get("dreaming") ?? []).map((r) => r.sessionFile))],
			})),
	};
}

// ── Backup / apply / restore ──────────────────────────────────────────────────

/** One backed-up row: every column, the vector as base64 float32 so it round-trips bit-exact. */
interface BackupRow {
	id: string;
	text: string;
	vector_f32_b64: string;
	sessionFile: string;
	project: string;
	lineNumber: number;
	timestamp: string;
	role: string;
	source: string;
	metadata: string;
}

function toFloat32(v: unknown): Float32Array {
	if (v instanceof Float32Array) return v;
	const maybe = v as { toArray?: () => ArrayLike<number> };
	if (maybe && typeof maybe.toArray === "function") return Float32Array.from(maybe.toArray());
	return Float32Array.from(v as ArrayLike<number>);
}

function toBackupRow(r: Record<string, unknown>): BackupRow {
	const f = toFloat32(r.vector);
	return {
		id: r.id as string,
		text: (r.text as string) ?? "",
		vector_f32_b64: Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64"),
		sessionFile: (r.sessionFile as string) ?? "",
		project: (r.project as string) ?? "",
		lineNumber: Number(r.lineNumber ?? 0),
		timestamp: (r.timestamp as string) ?? "",
		role: (r.role as string) ?? "",
		source: (r.source as string) ?? "",
		metadata: typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata ?? {}),
	};
}

function fromBackupRow(b: BackupRow) {
	const buf = Buffer.from(b.vector_f32_b64, "base64");
	const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	return {
		id: b.id,
		text: b.text,
		vector: Array.from(f),
		sessionFile: b.sessionFile,
		project: b.project,
		lineNumber: b.lineNumber,
		timestamp: b.timestamp,
		role: b.role,
		source: b.source,
		metadata: JSON.parse(b.metadata || "{}") as Record<string, string>,
	};
}

export interface PruneReceipt {
	status: "applied" | "verify-failed" | "failed-midway" | "aborted-before-delete";
	runId: string;
	host: string;
	at: string;
	allowMassDecrease: boolean;
	backupPath: string;
	backupSha256: string | null;
	planned: number;
	deleted: number;
	countBefore: number;
	countAfter: number | null;
	stillPresent: number | null;
	byAgent: Record<string, Partial<Record<ReconcileClass, number>>>;
	heldBack: string[];
	error?: string;
}

export function getPruneRoot(): string {
	return path.join(getDataDir(), "openclaw-prune");
}

function readBackup(file: string): BackupRow[] {
	return zlib
		.gunzipSync(fs.readFileSync(file))
		.toString("utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as BackupRow);
}

/**
 * Delete the plan's rows from `store`, backup first. Never throws past the
 * receipt: whatever happened is written to `<dir>/receipt.json` before returning
 * or re-throwing.
 */
export async function executePrune(
	plan: PrunePlan,
	store: VectorStore,
	dir: string,
	heldBack: string[] = [],
): Promise<PruneReceipt> {
	fs.mkdirSync(dir, { recursive: true });
	const ids = planIds(plan);
	const backupPath = path.join(dir, "rows.jsonl.gz");
	const byAgent: PruneReceipt["byAgent"] = {};
	for (const a of plan.agents) {
		if (a.decision !== "prune") continue;
		byAgent[a.agent] = Object.fromEntries([...a.byClass].map(([c, rows]) => [c, rows.length]));
	}
	const receipt: PruneReceipt = {
		status: "aborted-before-delete",
		runId: plan.runId,
		host: plan.host,
		at: new Date().toISOString(),
		allowMassDecrease: plan.allowMassDecrease,
		backupPath,
		backupSha256: null,
		planned: ids.length,
		deleted: 0,
		countBefore: await store.getCount(),
		countAfter: null,
		stillPresent: null,
		byAgent,
		heldBack,
	};
	const writeReceipt = () => fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
	fs.writeFileSync(
		path.join(dir, "plan.json"),
		JSON.stringify(
			{ ...plan, agents: plan.agents.map((a) => ({ ...a, byClass: Object.fromEntries([...a.byClass].map(([c, r]) => [c, r.map((x) => x.id)])) })) },
			null,
			2,
		) + "\n",
	);

	try {
		// Backup, then prove the backup before the first delete.
		const rows = await store.getRowsByIds(ids);
		if (rows.length !== ids.length) {
			throw new Error(`backup read ${rows.length} of ${ids.length} planned rows — refusing to delete`);
		}
		fs.writeFileSync(backupPath, zlib.gzipSync(rows.map((r) => JSON.stringify(toBackupRow(r))).join("\n") + "\n"));
		receipt.backupSha256 = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");
		const back = readBackup(backupPath);
		const backIds = new Set(back.map((b) => b.id));
		if (back.length !== ids.length || ids.some((id) => !backIds.has(id))) {
			throw new Error("backup does not read back id-for-id — refusing to delete");
		}
		if (back.some((b) => Buffer.from(b.vector_f32_b64, "base64").byteLength !== OPENCLAW_DIM * 4)) {
			throw new Error(`backup holds a vector that is not ${OPENCLAW_DIM}d — refusing to delete`);
		}
	} catch (err) {
		receipt.error = err instanceof Error ? err.message : String(err);
		writeReceipt();
		throw err;
	}

	receipt.status = "failed-midway";
	try {
		for (let i = 0; i < ids.length; i += 500) {
			const part = ids.slice(i, i + 500);
			await store.deleteByIds(part);
			receipt.deleted += part.length;
		}
		receipt.countAfter = await store.getCount();
		receipt.stillPresent = (await store.getStoredStamps(ids)).size;
		receipt.status =
			receipt.countAfter === receipt.countBefore - ids.length && receipt.stillPresent === 0 ? "applied" : "verify-failed";
	} catch (err) {
		receipt.error = err instanceof Error ? err.message : String(err);
		writeReceipt();
		throw err;
	}
	writeReceipt();
	return receipt;
}

/** Re-add every backed-up row the store no longer holds. Idempotent. */
export async function restorePrune(dir: string, store: VectorStore): Promise<{ restored: number; alreadyPresent: number }> {
	const rows = readBackup(path.join(dir, "rows.jsonl.gz"));
	const present = await store.getStoredStamps(rows.map((r) => r.id));
	const missing = rows.filter((r) => !present.has(r.id));
	for (let i = 0; i < missing.length; i += 200) {
		await store.addChunksRaw(missing.slice(i, i + 200).map(fromBackupRow));
	}
	return { restored: missing.length, alreadyPresent: rows.length - missing.length };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export function renderPlan(plan: PrunePlan, heldBack: string[], apply: boolean): string {
	const lines: string[] = [];
	lines.push(`== openclaw prune — ${apply ? "APPLY" : "DRY RUN (nothing deleted; --apply to delete)"} — run ${plan.runId} on ${plan.host} ==`);
	lines.push(`   classes: ${[...PRUNE_ELIGIBLE].join(", ")} only · session archives (reset/deleted/renamed/gone) are never pruned`);
	for (const a of plan.agents) {
		const counts = RECONCILE_CLASSES.filter((c) => a.byClass.has(c)).map((c) => `${c}=${a.byClass.get(c)!.length}`).join(" ");
		lines.push(`  ${a.decision === "prune" ? "🗑" : "·"} ${a.agent.padEnd(8)} ${a.decision.padEnd(5)} ${counts.padEnd(44)} ${a.reason}`);
	}
	for (const h of heldBack) lines.push(h.startsWith("live re-check") || h.startsWith("(offline") ? `   ${h}` : `   held back by the live re-check — ${h}`);
	lines.push(`   total to delete: ${planIds(plan).length}`);
	return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function assertAuthority(): void {
	const authority = process.env.ANDENKEN_INDEX_AUTHORITY ?? "thinkpad";
	let device = "";
	try {
		device = fs.readFileSync(path.join(process.env.HOME ?? "", ".current-device"), "utf-8").trim();
	} catch {
		device = (process.env.HOSTNAME ?? "").trim();
	}
	if (device !== authority && process.env.ANDENKEN_ALLOW_REPLICA_INDEX !== "1") {
		throw new Error(`refused: this is '${device}'; only the index authority '${authority}' prunes openclaw.lance (INVARIANT §7.3)`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const allowMass = args.includes("--allow-mass-decrease");
	const offline = args.includes("--offline");
	const ri = args.indexOf("--restore");
	assertAuthority();

	if (ri >= 0) {
		const dir = args[ri + 1];
		if (!dir) throw new Error("--restore needs the prune directory (data/openclaw-prune/<...>)");
		const store = new VectorStore(getOpenclawDbPath(), OPENCLAW_DIM, { readOnly: true });
		const r = await restorePrune(dir, store);
		await store.close();
		console.log(`♻ restored ${r.restored} rows (${r.alreadyPresent} already present) from ${dir}`);
		return;
	}
	if (apply && offline) throw new Error("--offline skips the live re-check, so it cannot be combined with --apply");

	// The threshold is fixed here: only --allow-mass-decrease passes a mass decrease.
	const { run, manifest, status, binding, report } = await loadStagedReport(DEFAULT_MAX_RATIO);
	if (!binding.ok || !run) throw new Error(`refused: ${binding.ok ? "no staged run" : binding.reason}`);
	let plan = planPrune(report, manifest, status, { allowMassDecrease: allowMass });

	let heldBack: string[] = [];
	if (offline) {
		heldBack.push("(offline: the live re-check was skipped — this plan is not what --apply would delete)");
	} else if (planIds(plan).length > 0) {
		const agentsDir = process.env.ANDENKEN_OPENCLAW_AGENTS_DIR ?? "$HOME/openclaw/config/agents";
		const containerHome = process.env.ANDENKEN_OPENCLAW_CONTAINER_HOME ?? "/home/node/.openclaw";
		const asked = recheckRequest(plan).agents.map((a) => a.agent);
		const live = sshRecheck(run.host, agentsDir, containerHome)(recheckRequest(plan));
		({ plan, heldBack } = applyRecheck(plan, live));
		const passed = asked.filter((a) => plan.agents.find((x) => x.agent === a)?.decision === "prune");
		heldBack.unshift(
			`live re-check on ${run.host} (read-only): ${passed.length}/${asked.length} unchanged since the run` +
				(passed.length ? ` — ${passed.map((a) => `${a} rev ${live.get(a)?.revision}`).join(", ")}` : ""),
		);
	}
	console.log(renderPlan(plan, heldBack, apply));
	if (!apply) return;
	if (planIds(plan).length === 0) {
		console.log("✅ nothing to delete — no change");
		return;
	}

	const dir = path.join(getPruneRoot(), `${new Date().toISOString().replace(/[:.]/g, "-")}-${run.runId}`);
	// `readOnly` in this store means only "never create a missing axis"; deletes
	// still go through. A prune against an absent openclaw.lance must fail, not
	// conjure an empty table.
	const store = new VectorStore(getOpenclawDbPath(), OPENCLAW_DIM, { readOnly: true });
	const receipt = await executePrune(plan, store, dir, heldBack);
	await store.close();
	console.log(
		`${receipt.status === "applied" ? "✅" : "❌"} prune ${receipt.status}: deleted ${receipt.deleted}/${receipt.planned} · ` +
			`rows ${receipt.countBefore} → ${receipt.countAfter} · still present ${receipt.stillPresent}`,
	);
	console.log(`   backup: ${receipt.backupPath} (sha256 ${receipt.backupSha256?.slice(0, 16)}…)`);
	console.log(`   receipt: ${path.join(dir, "receipt.json")} · undo: ./run.sh prune:openclaw --restore ${dir}`);
	console.log("   next: ./run.sh compact openclaw → ./run.sh verify openclaw → ./run.sh sync:openclaw:oracle");
	if (receipt.status !== "applied") process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
