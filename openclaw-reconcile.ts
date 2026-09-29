/**
 * openclaw-reconcile.ts — the freshness board and the reconcile DRY-RUN for the
 * OpenClaw harvest (tier 4, stages A + B, 2026-09-29).
 *
 * NOTHING HERE WRITES. Not to openclaw.lance, not to OpenClaw's databases, not to
 * the watermark. INVARIANT §7.3's append-only rule still holds in full: this file
 * only tells the operator what upstream looks like and which of our rows upstream
 * no longer carries. Deciding what to do about them is stage C, and stage C waits
 * for GLG.
 *
 * Two reports, both from the artifacts `export-openclaw.sh` stages:
 *
 *   freshness — per agent: snapshot rows, newest updated_at, chunking version,
 *     `memory status` identity / dirty / files ratio, and a PRESCRIPTION. An
 *     identity mismatch is not a dirty index: `openclaw memory index --agent X`
 *     without --force still rebuilds the whole index when identity is mismatched
 *     (memory-core manager-sync-ops `needsFullReindex`), and that calls the
 *     embedding provider. So it is printed as a paid rebuild behind a GLG gate,
 *     never as the routine incremental command. Nothing is run.
 *
 *   reconcile — held ids − upstream ids, per agent, classified. It refuses to
 *     compare anything that is not bound to one export run: the manifest, the
 *     run receipt, the host and (when chunks were staged) the import receipt must
 *     all name the same run. An agent whose read failed, whose digest does not
 *     verify, or that is absent upstream is never classified — a partial upstream
 *     must not look like an upstream that deleted things.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { VectorStore, getOpenclawDbPath, getDataDir } from "./store.js";
import {
	getStagingPath,
	readImportReceipt,
	readStagedRun,
	readWatermarkHost,
	type ImportReceipt,
	type StagedRun,
} from "./openclaw-importer.js";

const OPENCLAW_DIM = 4096;

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface ManifestAgent {
	agent: string;
	/** ok | delta-failed | manifest-failed | vacuum-failed | no-index */
	state: string;
	runId: string | null;
	rows: number;
	maxUpdatedAt: number | null;
	revision: number | null;
	chunkingVersion: number | null;
	/** Newest source mtime OpenClaw recorded as indexed, per source kind (memory_index_sources). */
	indexedMtime: Record<string, number | null>;
	digest: string | null;
	rowDigest: string | null;
	error?: string;
}

export interface ManifestChunk {
	agent: string;
	id: string;
	source: string;
	path: string;
	updated_at: number;
}

/** The workspace side of the `memory` source, scanned on the host. */
export interface ManifestSource {
	agent: string;
	runId: string | null;
	files: number;
	newestMtime: number | null;
	newestPath: string | null;
}

export interface Manifest {
	agents: Map<string, ManifestAgent>;
	chunks: Map<string, ManifestChunk[]>;
	sources: Map<string, ManifestSource>;
}

export function emptyManifest(): Manifest {
	return { agents: new Map(), chunks: new Map(), sources: new Map() };
}

export function parseManifestLines(lines: Iterable<string>): Manifest {
	const m = emptyManifest();
	for (const line of lines) {
		if (!line.trim()) continue;
		const r = JSON.parse(line);
		if (r.kind === "agent") {
			const meta = r.meta?.memory_index_meta_v1;
			m.agents.set(r.agent, {
				agent: r.agent,
				state: r.state,
				runId: r.run_id ?? null,
				rows: typeof r.rows === "number" ? r.rows : 0,
				maxUpdatedAt: r.max_updated_at ?? null,
				revision: r.revision ?? null,
				chunkingVersion: typeof meta?.chunkingVersion === "number" ? meta.chunkingVersion : null,
				indexedMtime: r.indexed_mtime ?? {},
				digest: r.digest ?? null,
				rowDigest: r.row_digest ?? null,
				error: r.error,
			});
		} else if (r.kind === "chunk") {
			const list = m.chunks.get(r.agent) ?? [];
			list.push({ agent: r.agent, id: r.id, source: r.source, path: r.path, updated_at: r.updated_at });
			m.chunks.set(r.agent, list);
		} else if (r.kind === "source") {
			m.sources.set(r.agent, {
				agent: r.agent,
				runId: r.run_id ?? null,
				files: r.files ?? 0,
				newestMtime: r.newest_mtime ?? null,
				newestPath: r.newest_path ?? null,
			});
		}
	}
	return m;
}

/** Same digest the remote side computes: sha256 over the sorted ids joined by "\n". */
export function digestIds(ids: string[]): string {
	return crypto.createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

/**
 * The row digest the remote side computes: sorted by id, `id\tsource\tpath\tupdated_at`
 * per line. It covers the fields the classifier reads, which the id digest does not.
 */
export function digestRows(rows: ManifestChunk[]): string {
	const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return crypto
		.createHash("sha256")
		.update(sorted.map((r) => `${r.id}\t${r.source}\t${r.path}\t${r.updated_at}`).join("\n"))
		.digest("hex");
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface StatusEntry {
	agentId: string;
	dirty: boolean;
	identity: { status: string; code?: string; reason?: string };
	files: number;
	chunks: number | null;
	totalFiles: number | null;
	sources: Array<{ source: string; files: number; eligible: number | null }>;
}

export type StatusParse =
	| { ok: true; byAgent: Map<string, StatusEntry> }
	| { ok: false; reason: string };

/**
 * Parse `memory status --json`. Structural damage is a failure, not a partial
 * answer: an entry without a string agentId, or the same agent twice, cannot be
 * attributed, and a status that cannot be attributed must not vouch for anyone.
 */
export function parseStatus(raw: string | null, errTail = ""): StatusParse {
	if (raw === null) return { ok: false, reason: "no status JSON staged (status skipped or failed)" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const hint = errTail.trim().split("\n").pop() ?? "";
		return { ok: false, reason: `status output is not JSON${hint ? ` — ${hint}` : ""}` };
	}
	if (!Array.isArray(parsed)) return { ok: false, reason: "status JSON is not an array" };
	const byAgent = new Map<string, StatusEntry>();
	for (const r of parsed as any[]) {
		if (typeof r?.agentId !== "string" || r.agentId.length === 0) {
			return { ok: false, reason: "status JSON has an entry without an agentId" };
		}
		if (byAgent.has(r.agentId)) return { ok: false, reason: `status JSON lists '${r.agentId}' twice` };
		const s = r.status ?? {};
		const id = s.custom?.indexIdentity ?? {};
		byAgent.set(r.agentId, {
			agentId: r.agentId,
			dirty: Boolean(s.dirty),
			identity: { status: id.status ?? "unknown", code: id.code, reason: id.reason },
			files: s.files ?? 0,
			chunks: typeof s.chunks === "number" ? s.chunks : null,
			totalFiles: r.scan?.totalFiles ?? null,
			sources: (s.sourceCounts ?? []).map((c: any) => ({
				source: c.source,
				files: c.files ?? 0,
				eligible: typeof c.eligible === "number" ? c.eligible : null,
			})),
		});
	}
	return { ok: true, byAgent };
}

/**
 * Status is taken before the agent loop and again after it. The snapshot in
 * between is bound to that status only if nothing it reports moved across the
 * bracket AND the snapshot's row count equals the chunk count both calls saw.
 * Returns the reason an agent is unbound, or null when it is bound.
 */
export function generationUnbound(
	agent: string,
	m: ManifestAgent | undefined,
	pre: StatusParse,
	post: StatusParse,
): string | null {
	if (!pre.ok || !post.ok) return "status-unknown";
	const a = pre.byAgent.get(agent);
	const b = post.byAgent.get(agent);
	if (!a || !b) return "status-missing";
	if (a.identity.status !== b.identity.status || a.identity.code !== b.identity.code) return "identity moved during export";
	if (a.dirty !== b.dirty) return "dirty moved during export";
	if (a.chunks !== b.chunks) return `chunks moved during export (${a.chunks}→${b.chunks})`;
	if (m && m.state === "ok" && a.chunks !== null && a.chunks !== m.rows) {
		return `snapshot rows ${m.rows} ≠ status chunks ${a.chunks}`;
	}
	return null;
}

/** A source newer than the newest indexed source by more than this is reported as ahead. */
export const SOURCE_AHEAD_MS = 60 * 60 * 1000;

export function memorySourceLag(manifest: Manifest, agent: string): { lagMs: number; newestPath: string | null } | null {
	const src = manifest.sources.get(agent);
	const idx = manifest.agents.get(agent)?.indexedMtime?.memory ?? null;
	if (!src || src.newestMtime === null || idx === null || idx === undefined) return null;
	return { lagMs: src.newestMtime - idx, newestPath: src.newestPath };
}

// ── Freshness board (stage A) ─────────────────────────────────────────────────

export type FreshnessVerdict =
	| "fresh"
	| "source-ahead"
	| "incremental"
	| "paid-rebuild"
	| "unbound"
	| "read-failed"
	| "status-unknown"
	| "not-configured"
	| "inactive";

export interface FreshnessRow {
	agent: string;
	rows: number;
	maxUpdatedAt: number | null;
	chunkingVersion: number | null;
	revision: number | null;
	identity: string;
	dirty: boolean | null;
	filesRatio: string;
	/** workspace memory newest mtime − indexed memory newest mtime; null when either side is unknown. */
	memoryLagMs: number | null;
	verdict: FreshnessVerdict;
	prescription: string;
}

export function freshnessRows(manifest: Manifest, status: StatusParse, statusPost: StatusParse = status): FreshnessRow[] {
	const names = new Set<string>([...manifest.agents.keys()]);
	if (status.ok) for (const k of status.byAgent.keys()) names.add(k);
	const out: FreshnessRow[] = [];
	for (const agent of [...names].sort()) {
		const m = manifest.agents.get(agent);
		const s = status.ok ? status.byAgent.get(agent) : undefined;
		const lag = memorySourceLag(manifest, agent);
		const row: FreshnessRow = {
			agent,
			rows: m?.rows ?? 0,
			maxUpdatedAt: m?.maxUpdatedAt ?? null,
			chunkingVersion: m?.chunkingVersion ?? null,
			revision: m?.revision ?? null,
			identity: s ? (s.identity.code ? `${s.identity.status}:${s.identity.code}` : s.identity.status) : "?",
			dirty: s ? s.dirty : null,
			filesRatio: s
				? s.sources.map((c) => `${c.source[0]} ${c.files}/${c.eligible ?? "?"}`).join(" · ")
				: "",
			memoryLagMs: lag?.lagMs ?? null,
			verdict: "fresh",
			prescription: "",
		};
		const unbound = generationUnbound(agent, m, status, statusPost);
		if (!m || m.state === "vacuum-failed" || m.state === "manifest-failed" || m.state === "delta-failed") {
			row.verdict = "read-failed";
			row.prescription = `snapshot read failed (${m?.state ?? "no manifest line"}) — this agent is NOT fresh-checked this run`;
		} else if (!status.ok || !statusPost.ok) {
			row.verdict = "status-unknown";
			const reason = !status.ok ? status.reason : (statusPost as { reason: string }).reason;
			row.prescription = `memory status unavailable (${reason}) — identity unknown, not reported as fresh`;
		} else if (!s) {
			// Measured 2026-09-29: `claude` has a directory and a database but is not
			// a configured agent, so `memory status` answers `Unknown agent id`.
			row.verdict = row.rows === 0 ? "inactive" : "not-configured";
			row.prescription =
				row.rows === 0
					? "not a configured OpenClaw agent, 0 index rows — nothing to harvest"
					: `not a configured OpenClaw agent but its database holds ${row.rows} index rows — ask the OpenClaw owner`;
		} else if (unbound) {
			row.verdict = "unbound";
			row.prescription = `snapshot not bound to status (${unbound}) — upstream moved during the export; re-run before reading this agent`;
		} else if (s.identity.status !== "valid") {
			row.verdict = "paid-rebuild";
			row.prescription =
				`index identity ${s.identity.status} (${s.identity.code ?? s.identity.reason ?? "?"}): vector search paused. ` +
				`\`openclaw memory index --agent ${agent}\` would FULLY rebuild (provider cost) even without --force — GLG gate. Not run.`;
		} else if (s.dirty) {
			row.verdict = "incremental";
			row.prescription = `dirty: \`openclaw memory index --agent ${agent}\` (incremental; may still call the provider). Not run.`;
		} else if (lag && lag.lagMs > SOURCE_AHEAD_MS) {
			// Clean by status, but a workspace memory file is newer than anything the
			// index recorded — the watcher may have missed it (sol re-review P1).
			row.verdict = "source-ahead";
			row.prescription =
				`status says clean, but ${lag.newestPath} is ${fmtLag(lag.lagMs)} newer than the newest indexed memory source — ` +
				`\`openclaw memory index --agent ${agent}\` (incremental; may still call the provider). Not run.`;
		} else {
			row.verdict = "fresh";
			row.prescription = "clean";
		}
		if (lag && lag.lagMs > SOURCE_AHEAD_MS && row.verdict !== "source-ahead") {
			row.prescription += ` [memory source ahead of index by ${fmtLag(lag.lagMs)}: ${lag.newestPath}]`;
		}
		out.push(row);
	}
	return out;
}

function fmtLag(ms: number): string {
	return ms >= 86_400_000 ? `${Math.floor(ms / 86_400_000)}d` : `${Math.floor(ms / 3_600_000)}h`;
}

function kst(ms: number | null): string {
	if (ms === null) return "—";
	const d = new Date(ms + 9 * 3600_000);
	return d.toISOString().slice(0, 16).replace("T", " ");
}

export function renderFreshness(
	rows: FreshnessRow[],
	run: StagedRun | null,
	status: StatusParse,
	nowMs = Date.now(),
	statusPost: StatusParse = status,
): string {
	const lines: string[] = [];
	lines.push(`== openclaw freshness board — run ${run?.runId ?? "?"} on ${run?.host ?? "?"} (read-only; nothing was run) ==`);
	if (!status.ok) lines.push(`❌ memory status (before snapshots): ${status.reason}`);
	if (!statusPost.ok) lines.push(`❌ memory status (after snapshots): ${statusPost.reason}`);
	lines.push("agent    rows  newest(KST)       age  chunkV  identity                   dirty  mem-lag  files(m · s)");
	for (const r of rows) {
		const age = r.maxUpdatedAt === null ? "—" : `${Math.floor((nowMs - r.maxUpdatedAt) / 86_400_000)}d`;
		const lag = r.memoryLagMs === null ? "?" : r.memoryLagMs <= SOURCE_AHEAD_MS ? "ok" : fmtLag(r.memoryLagMs);
		lines.push(
			`${r.agent.padEnd(8)} ${String(r.rows).padStart(5)}  ${kst(r.maxUpdatedAt).padEnd(16)}  ${age.padStart(4)}  ` +
				`${String(r.chunkingVersion ?? "—").padStart(6)}  ${r.identity.padEnd(25)}  ${(r.dirty === null ? "?" : r.dirty ? "yes" : "no").padEnd(5)}  ${lag.padStart(7)}  ${r.filesRatio}`,
		);
	}
	const icon: Record<FreshnessVerdict, string> = {
		fresh: "✅",
		"source-ahead": "🔄",
		incremental: "🔄",
		"paid-rebuild": "⛔",
		unbound: "❓",
		"read-failed": "❌",
		"status-unknown": "❓",
		"not-configured": "⚠",
		inactive: "·",
	};
	lines.push("prescriptions:");
	for (const r of rows) lines.push(`  ${icon[r.verdict]} ${r.agent}: ${r.prescription}`);
	const bad = rows.filter((r) => r.verdict === "read-failed" || r.verdict === "status-unknown" || r.verdict === "unbound");
	if (bad.length > 0) lines.push(`   not fresh-checked: ${bad.map((r) => r.agent).join(", ")} — the board is NOT a clean bill for them`);
	lines.push("   mem-lag = newest workspace MEMORY.md / memory/**/*.md mtime − newest indexed memory source mtime; sessions are covered by the files ratio only.");
	return lines.join("\n");
}

// ── Reconcile dry-run (stage B) ───────────────────────────────────────────────

export interface HeldRow {
	id: string;
	sessionFile: string;
	source: string;
	/** ISO stamp the importer wrote — `new Date(updated_at).toISOString()`. */
	timestamp: string;
}

/**
 * Only this prefix counts as dreaming. Widening it to "any memory path gone
 * upstream" would make an accidental omission look like a canonical move
 * (sol review 2026-09-29, Q2 a/b).
 */
export const DREAMING_PREFIXES = ["memory/dreaming/"];

export const RECONCILE_CLASSES = [
	"dreaming",
	"superseded-confirmed",
	"superseded-unconfirmed",
	"session-reset",
	"session-deleted",
	"session-renamed",
	"path-gone-memory",
	"path-gone-sessions",
] as const;
export type ReconcileClass = (typeof RECONCILE_CLASSES)[number];

/** Classes a stage-C prune could take once GLG approves it — everything else is a retention decision or a hold. */
export const PRUNE_ELIGIBLE: ReadonlySet<ReconcileClass> = new Set(["dreaming", "superseded-confirmed"]);

/**
 * Classify one agent's held rows that upstream no longer carries.
 *
 * Order matters and is deliberate: a (source, path) still present upstream means
 * re-chunking whatever its prefix, so that test comes first. "Confirmed" means
 * every upstream id at that (source, path) is already in our store WITH the
 * stamp this snapshot carries — the replacement has actually arrived as this
 * generation, not merely been announced or held from an older one. A path whose
 * replacement was dropped by the importer (credential / boilerplate) therefore
 * stays unconfirmed, which is the conservative side.
 */
export function classifyGone(
	agent: string,
	gone: HeldRow[],
	upstream: ManifestChunk[],
	heldStamps: Map<string, string>,
): Map<ReconcileClass, HeldRow[]> {
	const key = (source: string, p: string) => `${source}\u0000${p}`;
	const bySourcePath = new Map<string, ManifestChunk[]>();
	for (const c of upstream) {
		const k = key(c.source, c.path);
		const list = bySourcePath.get(k) ?? [];
		list.push(c);
		bySourcePath.set(k, list);
	}
	const upstreamPaths = upstream.map((c) => c.path);
	const out = new Map<ReconcileClass, HeldRow[]>();
	const put = (k: ReconcileClass, r: HeldRow) => {
		const list = out.get(k) ?? [];
		list.push(r);
		out.set(k, list);
	};
	for (const r of gone) {
		const p = r.sessionFile;
		const same = bySourcePath.get(key(r.source, p));
		if (same) {
			const arrived = same.every(
				(c) => heldStamps.get(`${agent}:${c.id}`) === new Date(c.updated_at).toISOString(),
			);
			put(arrived ? "superseded-confirmed" : "superseded-unconfirmed", r);
		} else if (DREAMING_PREFIXES.some((x) => p.startsWith(x))) {
			put("dreaming", r);
		} else if (p.includes(".jsonl.reset.")) {
			put("session-reset", r);
		} else if (p.includes(".jsonl.deleted.")) {
			put("session-deleted", r);
		} else if (r.source === "sessions" && upstreamPaths.some((u) => u.startsWith(`${p}.`))) {
			// The live transcript left, and an archive of it (`<path>.reset.*` /
			// `<path>.deleted.*`) is indexed upstream under the new name.
			put("session-renamed", r);
		} else {
			put(r.source === "sessions" ? "path-gone-sessions" : "path-gone-memory", r);
		}
	}
	return out;
}

export type BindingResult = { ok: true } | { ok: false; reason: string };

/**
 * Everything the dry-run reads must be one export run. Each refusal names the
 * failure an operator would otherwise have to reconstruct from mtimes.
 */
export function checkBinding(input: {
	run: StagedRun | null;
	manifest: Manifest | null;
	receipt: ImportReceipt | null;
	chunksStaged: boolean;
	watermarkHost: string | null;
}): BindingResult {
	const { run, manifest, receipt, chunksStaged, watermarkHost } = input;
	if (!run) return { ok: false, reason: "no run.json staged — run ./run.sh sync:openclaw first" };
	if (!manifest || manifest.agents.size === 0) {
		return { ok: false, reason: `run ${run.runId} staged no manifest — the export did not complete` };
	}
	for (const a of [...manifest.agents.values(), ...manifest.sources.values()]) {
		if (a.runId !== run.runId) {
			return { ok: false, reason: `manifest line for '${a.agent}' belongs to run ${a.runId}, not ${run.runId} — stale or mixed staging` };
		}
	}
	if (watermarkHost !== null && watermarkHost !== run.host) {
		return { ok: false, reason: `export came from host '${run.host}' but the store's watermark belongs to '${watermarkHost}'` };
	}
	if (chunksStaged) {
		if (!receipt || receipt.runId !== run.runId) {
			return {
				ok: false,
				reason: `run ${run.runId} staged chunks that are not imported yet (import receipt: ${receipt?.runId ?? "none"}) — held ids would be compared before the replacements land`,
			};
		}
		if (receipt.host !== run.host || receipt.seen !== run.rows) {
			return {
				ok: false,
				reason: `import receipt of run ${run.runId} does not match its export (host ${receipt.host}/${run.host}, rows ${receipt.seen}/${run.rows})`,
			};
		}
	}
	return { ok: true };
}

export interface AgentReconcile {
	agent: string;
	/** ok = classified; anything else = not classified this run, with the reason. */
	guard: string;
	flags: string[];
	held: number;
	upstream: number;
	both: number;
	upstreamNotHeld: number;
	gone: Map<ReconcileClass, HeldRow[]>;
}

export interface ReconcileReport {
	binding: BindingResult;
	runId: string | null;
	host: string | null;
	agents: AgentReconcile[];
}

export function reconcile(input: {
	held: HeldRow[];
	manifest: Manifest;
	/** Status taken BEFORE the snapshots. */
	status: StatusParse;
	/** Status taken AFTER the snapshots — the other half of the generation bracket. */
	statusPost: StatusParse;
	binding: BindingResult;
	run: StagedRun | null;
	maxRatio?: number;
}): ReconcileReport {
	const { held, manifest, status, statusPost, binding, run } = input;
	const maxRatio = input.maxRatio ?? 0.2;
	const report: ReconcileReport = { binding, runId: run?.runId ?? null, host: run?.host ?? null, agents: [] };
	if (!binding.ok) return report;

	const heldIds = new Set(held.map((h) => h.id));
	const heldStamps = new Map(held.map((h) => [h.id, h.timestamp]));
	const heldByAgent = new Map<string, HeldRow[]>();
	for (const h of held) {
		const agent = h.id.slice(0, h.id.indexOf(":"));
		const list = heldByAgent.get(agent) ?? [];
		list.push(h);
		heldByAgent.set(agent, list);
	}

	const names = new Set<string>([...heldByAgent.keys(), ...manifest.agents.keys()]);
	for (const agent of [...names].sort()) {
		const mine = heldByAgent.get(agent) ?? [];
		const m = manifest.agents.get(agent);
		const up = manifest.chunks.get(agent) ?? [];
		const a: AgentReconcile = {
			agent,
			guard: "ok",
			flags: [],
			held: mine.length,
			upstream: up.length,
			both: 0,
			upstreamNotHeld: 0,
			gone: new Map(),
		};
		report.agents.push(a);

		if (!m) {
			// Disappearing from the discovery list is not an upstream deletion of
			// everything that agent ever said.
			a.guard = "absent-upstream";
			continue;
		}
		if (m.state !== "ok") {
			a.guard = `not-classified:${m.state}`;
			continue;
		}
		if (m.rows !== up.length || digestIds(up.map((c) => c.id)) !== m.digest || digestRows(up) !== m.rowDigest) {
			a.guard = "not-classified:digest-mismatch";
			continue;
		}

		const upIds = new Set(up.map((c) => `${agent}:${c.id}`));
		const gone = mine.filter((h) => !upIds.has(h.id));
		a.both = mine.length - gone.length;
		a.upstreamNotHeld = [...upIds].filter((id) => !heldIds.has(id)).length;
		a.gone = classifyGone(agent, gone, up, heldStamps);

		// Every hold below ends in "hold". An agent is clear only when BOTH status
		// calls answered for it, agree with each other and with the snapshot, the
		// identity is valid and the index is not dirty (sol re-review 2026-09-29:
		// a missing status entry and a dirty index were previously counted clear).
		const unbound = generationUnbound(agent, m, status, statusPost);
		if (unbound === "status-unknown") a.flags.push("status-unknown: hold");
		else if (unbound === "status-missing") a.flags.push("status-missing: hold");
		else {
			if (unbound) a.flags.push(`generation-unbound (${unbound}): hold`);
			const s = (status as { byAgent: Map<string, StatusEntry> }).byAgent.get(agent)!;
			if (s.identity.status !== "valid") a.flags.push(`identity-${s.identity.status}: upstream rebuild pending — hold`);
			if (s.dirty) a.flags.push("dirty: upstream catch-up pending — hold");
		}
		if (up.length === 0 && mine.length > 0) a.flags.push("upstream-empty: hold");
		if (mine.length > 0 && gone.length / mine.length > maxRatio) {
			a.flags.push(`mass-decrease ${Math.round((100 * gone.length) / mine.length)}% > ${Math.round(maxRatio * 100)}%`);
		}
	}
	return report;
}

/**
 * Why an agent's rows would not be touched even after GLG approves stage C.
 * `status-*` / `generation-unbound` / `identity` / `dirty` / `upstream-empty`
 * are about upstream being unknown or mid-change;
 * `mass-decrease` is about the size of the step. They are counted apart because
 * the first kind clears itself when upstream settles and the second needs an
 * explicit one-off decision (the first reconcile removes 38% at once).
 */
export function holdKind(a: AgentReconcile): "none" | "upstream" | "mass-decrease" {
	if (a.flags.some((f) => f.endsWith("hold"))) return "upstream";
	if (a.flags.some((f) => f.startsWith("mass-decrease"))) return "mass-decrease";
	return "none";
}

export function renderReconcile(report: ReconcileReport, samples = 2): string {
	const lines: string[] = [];
	lines.push(`== openclaw reconcile — DRY RUN, nothing deleted — run ${report.runId ?? "?"} on ${report.host ?? "?"} ==`);
	if (!report.binding.ok) {
		lines.push(`❌ refused: ${report.binding.reason}`);
		return lines.join("\n");
	}
	const short: Record<ReconcileClass, string> = {
		dreaming: "dream",
		"superseded-confirmed": "sup✓",
		"superseded-unconfirmed": "sup?",
		"session-reset": "reset",
		"session-deleted": "del",
		"session-renamed": "renamed",
		"path-gone-memory": "gone-m",
		"path-gone-sessions": "gone-s",
	};
	lines.push(
		"agent     held  upstr   both  up∖held   gone | " +
			RECONCILE_CLASSES.map((c) => short[c].padStart(7)).join(" ") +
			" | guard / flags",
	);
	const totals = new Map<ReconcileClass, number>();
	const prune = { none: 0, upstream: 0, "mass-decrease": 0 };
	let retention = 0;
	for (const a of report.agents) {
		const goneN = [...a.gone.values()].reduce((n, l) => n + l.length, 0);
		const cells = RECONCILE_CLASSES.map((c) => {
			const n = a.gone.get(c)?.length ?? 0;
			totals.set(c, (totals.get(c) ?? 0) + n);
			return String(n || (a.guard === "ok" ? 0 : "—")).padStart(7);
		}).join(" ");
		const note = [a.guard === "ok" ? "" : a.guard, ...a.flags].filter(Boolean).join("; ");
		lines.push(
			`${a.agent.padEnd(8)} ${String(a.held).padStart(5)}  ${String(a.upstream).padStart(5)}  ${String(a.both).padStart(5)}  ` +
				`${String(a.upstreamNotHeld).padStart(7)}  ${String(a.guard === "ok" ? goneN : "—").padStart(5)} | ${cells} | ${note}`,
		);
		if (a.guard !== "ok") continue;
		for (const [c, list] of a.gone) {
			if (PRUNE_ELIGIBLE.has(c)) prune[holdKind(a)] += list.length;
			else retention += list.length;
		}
	}
	lines.push(
		"total" +
			" ".repeat(40) +
			"| " +
			RECONCILE_CLASSES.map((c) => String(totals.get(c) ?? 0).padStart(7)).join(" "),
	);
	const pruneTotal = prune.none + prune.upstream + prune["mass-decrease"];
	lines.push(
		`summary: prune classes (dreaming + sup✓) ${pruneTotal} — clear of every guard ${prune.none}, ` +
			`behind mass-decrease only ${prune["mass-decrease"]}, behind an upstream hold ${prune.upstream}. ` +
			`Stage C is GLG's call; nothing is pruned here.`,
	);
	lines.push(`         retention-decision classes (reset / deleted / renamed / gone / sup?) ${retention} — kept; policy pending.`);
	const skipped = report.agents.filter((a) => a.guard !== "ok");
	if (skipped.length > 0) lines.push(`         not classified: ${skipped.map((a) => `${a.agent} (${a.guard})`).join(", ")}`);
	lines.push("   up∖held = upstream ids we do not hold: importer drops (credential / empty-dreaming / bad vector) or rows not imported yet.");
	if (samples === 0) lines.push("   per-class samples: ./run.sh report:openclaw [--samples N]");
	if (samples > 0) {
		lines.push("samples:");
		for (const a of report.agents) {
			for (const c of RECONCILE_CLASSES) {
				const list = a.gone.get(c);
				if (!list?.length) continue;
				for (const r of list.slice(0, samples)) lines.push(`  ${a.agent} ${short[c]}: ${r.sessionFile}  (${r.id.slice(0, a.agent.length + 13)}…)`);
			}
		}
	}
	return lines.join("\n");
}

// ── Staged artifacts ──────────────────────────────────────────────────────────

function stagingDir(): string {
	return path.join(getDataDir(), "openclaw-staging");
}

export function readStagedManifest(): Manifest | null {
	const p = path.join(stagingDir(), "manifest.jsonl.gz");
	if (!fs.existsSync(p)) return null;
	return parseManifestLines(zlib.gunzipSync(fs.readFileSync(p)).toString("utf-8").split("\n"));
}

/** `which` = "status" (before the snapshots) or "status-post" (after). */
export function readStagedStatus(which: "status" | "status-post" = "status"): StatusParse {
	const p = path.join(stagingDir(), `${which}.json`);
	const e = path.join(stagingDir(), `${which}.err`);
	const err = fs.existsSync(e) ? fs.readFileSync(e, "utf-8") : "";
	const run = readStagedRun();
	const rc = which === "status" ? run?.statusRc : run?.statusPostRc;
	if (run && rc !== "0") {
		return {
			ok: false,
			reason:
				rc === "skipped"
					? "status skipped (ANDENKEN_OPENCLAW_STATUS_CMD=off)"
					: rc === undefined
						? `${which} not recorded by this run`
						: `exit ${rc}${err.trim() ? ` — ${err.trim().split("\n").pop()}` : ""}`,
		};
	}
	return parseStatus(fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null, err);
}

async function main(): Promise<void> {
	const [cmd = "reconcile", ...rest] = process.argv.slice(2);
	const si = rest.indexOf("--samples");
	const samples = si >= 0 ? Math.max(0, Number(rest[si + 1] ?? 2) || 0) : 2;
	const run = readStagedRun();
	const manifest = readStagedManifest();
	const status = readStagedStatus("status");
	const statusPost = readStagedStatus("status-post");

	if (cmd === "freshness") {
		if (!run || !manifest) {
			console.log("❓ openclaw freshness: no staged run/manifest — run ./run.sh sync:openclaw");
			return;
		}
		console.log(renderFreshness(freshnessRows(manifest, status, statusPost), run, status, Date.now(), statusPost));
		return;
	}
	if (cmd !== "reconcile") throw new Error(`unknown subcommand '${cmd}' (freshness | reconcile)`);

	const binding = checkBinding({
		run,
		manifest,
		receipt: readImportReceipt(),
		chunksStaged: fs.existsSync(getStagingPath()),
		watermarkHost: readWatermarkHost(),
	});
	let held: HeldRow[] = [];
	if (binding.ok) {
		// readOnly: a missing openclaw.lance is an absent axis, not a table to create.
		const store = new VectorStore(getOpenclawDbPath(), OPENCLAW_DIM, { readOnly: true });
		held = await store.scanIdentities();
		await store.close();
	}
	const maxRatio = Number(process.env.ANDENKEN_OPENCLAW_RECONCILE_MAX_RATIO ?? "0.2");
	const report = reconcile({ held, manifest: manifest ?? emptyManifest(), status, statusPost, binding, run, maxRatio });
	console.log(renderReconcile(report, samples));
	if (!binding.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
