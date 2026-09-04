/**
 * openclaw-importer.ts — import OpenClaw's own embedding index into openclaw.lance.
 *
 * This track is a HARVEST. OpenClaw embeds its agents' memory and sessions
 * itself, and it happens to use `qwen/qwen3-embedding-8b` at 4096d — the same
 * model and dimension as our sessions and md tracks. Nobody agreed to that; both
 * sides picked it independently. That coincidence is the whole reason this file
 * can exist: the rows already carry text AND vector, so importing them costs zero
 * embedding API calls.
 *
 * What we do NOT own here (GLG ruling 2026-09-03): OpenClaw's chunking, model, or
 * scope. Retrieval quality of these chunks is its configuration, not our tuning
 * target. We fetch and make findable.
 *
 * Two filters run, and only two:
 *   - credentials: a chunk whose text trips a credential pattern is DROPPED whole.
 *     We cannot redact the text, because the vector was computed from the text we
 *     would be editing; a redacted chunk would retrieve as the unredacted one and
 *     display as something else. Measured 2026-09-03: 0 of 4,683 chunks trip it,
 *     so the policy costs nothing today and exists for the day it does not.
 *   - empty dreaming logs: OpenClaw's consolidation writes "Ranked 0 candidate(s)"
 *     even on nights with nothing to promote. 32 of 2,292 memory chunks (1.4%).
 *
 * APPEND-ONLY. We never delete a row this import did not see. OpenClaw's index
 * still holds chunks for sessions whose transcripts it already deleted, so its
 * retention rule — which we have not measured — would otherwise become our loss.
 * A row that arrives again with the same id replaces itself; nothing else moves.
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as readline from "readline";
import { VectorStore, getOpenclawDbPath, getDataDir } from "./store.js";

const OPENCLAW_DIM = 4096;

/** Same rules as scripts/redact-credentials.py, token boundaries included. */
const CREDENTIAL_RULES: Array<[string, RegExp]> = [
	["github-oauth", /(?<![A-Za-z0-9_-])gho_[A-Za-z0-9]{36}(?![A-Za-z0-9])/],
	["slack", /(?<![A-Za-z0-9_-])xoxs-[A-Za-z0-9-]{10,}/],
	["google-ai", /(?<![A-Za-z0-9_-])AIzaSy[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/],
	["telegram", /(?<![A-Za-z0-9_-])\d{8,10}:AA[A-Za-z0-9_-]{30,35}(?![A-Za-z0-9_-])/],
	["replicate", /(?<![A-Za-z0-9_-])r8_[A-Za-z0-9]{37}(?![A-Za-z0-9])/],
	["huggingface", /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9])/],
];

function isEmptyDreamingLog(text: string): boolean {
	return /Ranked 0 candidate|Promoted 0 candidate/.test(text);
}

export type RowVerdict =
	| { kind: "import"; chunk: PreparedChunk }
	| { kind: "drop-credential"; rule: string }
	| { kind: "drop-boilerplate" }
	| { kind: "drop-vector"; reason: string };

export interface PreparedChunk {
	id: string;
	text: string;
	vector: number[];
	sessionFile: string;
	project: string;
	lineNumber: number;
	timestamp: string;
	role: string;
	source: string;
	metadata: Record<string, string>;
}

/**
 * One row in, one verdict out — no DB, no I/O.
 *
 * The import loop used to hold this inline, which meant the two drop filters and
 * the id scheme had no way to be tested. INVARIANT §8: a policy added without a
 * test change is assumed uncovered, and both filters here ARE policy — one of
 * them (credentials) currently matches nothing, so a broken detector and a clean
 * corpus produce identical output. That is exactly the case a fixture has to
 * carry instead of a run.
 */
export function prepareRow(r: OpenclawRow): RowVerdict {
	const text = r.text ?? "";

	for (const [name, rx] of CREDENTIAL_RULES) {
		if (rx.test(text)) return { kind: "drop-credential", rule: name };
	}
	if (r.source === "memory" && isEmptyDreamingLog(text)) {
		return { kind: "drop-boilerplate" };
	}

	let vector: unknown;
	try {
		vector = JSON.parse(r.embedding);
	} catch {
		return { kind: "drop-vector", reason: "unparseable" };
	}
	if (!Array.isArray(vector)) return { kind: "drop-vector", reason: "not-an-array" };
	if (vector.length !== OPENCLAW_DIM) {
		return { kind: "drop-vector", reason: `dim=${vector.length}` };
	}

	return {
		kind: "import",
		chunk: {
			// Agent-scoped id: OpenClaw's chunk ids are unique per agent database,
			// not across them, and this track holds all six in one table.
			id: `${r.agent}:${r.id}`,
			text,
			vector: vector as number[],
			sessionFile: r.path,
			project: r.agent,
			lineNumber: 0,
			timestamp: new Date(r.updated_at).toISOString(),
			role: "",
			source: r.source,
			metadata: { agent: r.agent, ocSource: r.source, ocId: r.id },
		},
	};
}

/**
 * Which of these rows actually have to be written.
 *
 * The export asks `updated_at >= watermark`, so a run with nothing new still
 * brings the whole boundary millisecond back — measured 2026-09-04, 449 rows
 * (gpt 266, bbot 101, main 78), reproduced identically by two agents fourteen
 * minutes apart with the watermark unmoved. Rewriting those cost three LanceDB
 * fragments per run for zero new information.
 *
 * The fix is here and not in the query: the boundary must still be ASKED for,
 * because a row can commit in the same millisecond as the one that set the mark
 * but after our snapshot, and a strict `>` would lose it forever. What we can
 * skip is writing a row we already hold unchanged. Identity is (id, updated_at):
 * the id already encodes source, path, line span, chunk hash and model, so a
 * same-id row with the same stamp is the same row. A changed stamp — the case
 * only the time cursor can see, e.g. a re-embed under the same model string —
 * still writes.
 */
export function partitionByChange(
	batch: PreparedChunk[],
	held: Map<string, string>,
): { write: PreparedChunk[]; unchanged: number } {
	const write: PreparedChunk[] = [];
	let unchanged = 0;
	for (const c of batch) {
		if (held.get(c.id) === c.timestamp) unchanged++;
		else write.push(c);
	}
	return { write, unchanged };
}

/**
 * Advance one agent's watermark. Per agent because the bots reindex on their own
 * schedules — measured 2026-09-03, glg at 16:05 while mini was still on 09-02 —
 * and one global high-water mark would let a fast agent's clock hide a slow
 * agent's new rows. Monotonic: an out-of-order row never walks the mark backwards.
 */
export function mergeWatermark(
	mark: Record<string, number>,
	agent: string,
	updatedAt: number,
): Record<string, number> {
	mark[agent] = Math.max(mark[agent] ?? 0, updatedAt);
	return mark;
}

export interface OpenclawRow {
	agent: string;
	id: string;
	path: string;
	source: string;
	updated_at: number;
	text: string;
	embedding: string;
}

export interface ImportStats {
	seen: number;
	imported: number;
	droppedCredential: number;
	droppedBoilerplate: number;
	droppedDim: number;
	/** Rows we already held with the same stamp — accepted, but not rewritten. */
	unchanged: number;
	byAgent: Record<string, number>;
	watermark: Record<string, number>;
}

export function getStagingPath(): string {
	return path.join(getDataDir(), "openclaw-staging", "openclaw-chunks.jsonl.gz");
}

export function getWatermarkPath(): string {
	return path.join(getDataDir(), "openclaw-watermark.json");
}

/**
 * The host the staged export was actually taken from. `export-openclaw.sh`
 * writes it next to the artifact, because the host is chosen there (`--host`,
 * `ANDENKEN_OPENCLAW_HOST`) and the importer that runs after it in
 * `sync:openclaw` would otherwise have to guess from an env var the flag can
 * contradict.
 */
export function getStagedHostPath(): string {
	return path.join(getDataDir(), "openclaw-staging", "host");
}

export function readStagedHost(): string | null {
	const p = getStagedHostPath();
	if (!fs.existsSync(p)) return null;
	const v = fs.readFileSync(p, "utf-8").trim();
	return v.length > 0 ? v : null;
}

/**
 * The watermark keys agents, and an agent name is a name inside ONE OpenClaw
 * host. Two hosts running an agent called `main` would share a cursor, and the
 * second one's rows below that cursor would never be fetched — silent loss, not
 * a visible failure.
 *
 * Recording the host inside the same file closes that without changing its shape
 * or resetting anyone's cursor: `_host` cannot collide with an agent, because an
 * agent name is a directory name under `config/agents`. Both ends check it — the
 * export before it spends an ssh round trip on the wrong cursor, and here,
 * because this file is what writes the cursor and can be run on its own.
 */
export const WATERMARK_HOST_KEY = "_host";

/**
 * The watermark is per agent, not global: agents reindex on their own schedules
 * (measured 2026-09-03 — glg at 16:05, mini still at 09-02), and one global
 * high-water mark would let a fast agent's clock hide a slow agent's new rows.
 */
export function readWatermarkFile(): Record<string, unknown> {
	const p = getWatermarkPath();
	if (!fs.existsSync(p)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Agent marks only — `_host` is metadata about the cursor, not a cursor. */
export function readWatermark(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(readWatermarkFile())) {
		if (k === WATERMARK_HOST_KEY) continue;
		if (typeof v === "number") out[k] = v;
	}
	return out;
}

/** The host this cursor was built against, or null for a file written before the key existed. */
export function readWatermarkHost(): string | null {
	const v = readWatermarkFile()[WATERMARK_HOST_KEY];
	return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * A cursor that came from another host is refused, never silently adopted.
 * `--full` is the deliberate way through: it ignores the watermark, so a new
 * host re-exports from zero and the mark it leaves is honestly its own.
 */
export function assertWatermarkHost(host: string | null): void {
	const recorded = readWatermarkHost();
	if (host === null || recorded === null || recorded === host) return;
	throw new Error(
		`openclaw watermark belongs to host '${recorded}' but this export came from '${host}'. ` +
			`Agent names are scoped to one host, so reusing the cursor would skip rows on the new one. ` +
			`Re-export with --full to start this host from zero, or point back at '${recorded}'.`,
	);
}

export function writeWatermark(mark: Record<string, number>, host?: string | null): void {
	fs.mkdirSync(getDataDir(), { recursive: true });
	const recorded = host ?? readWatermarkHost();
	const body: Record<string, unknown> = recorded ? { [WATERMARK_HOST_KEY]: recorded } : {};
	for (const [k, v] of Object.entries(mark)) body[k] = v;
	fs.writeFileSync(getWatermarkPath(), JSON.stringify(body, null, 2) + "\n");
}

export async function importOpenclaw(
	stagingPath: string = getStagingPath(),
	opts: { dryRun?: boolean; host?: string | null } = {},
): Promise<ImportStats> {
	const host = opts.host ?? readStagedHost();
	assertWatermarkHost(host);

	const stats: ImportStats = {
		seen: 0,
		imported: 0,
		droppedCredential: 0,
		droppedBoilerplate: 0,
		droppedDim: 0,
		unchanged: 0,
		byAgent: {},
		watermark: readWatermark(),
	};

	if (!fs.existsSync(stagingPath)) {
		throw new Error(
			`no staged export at ${stagingPath} — run scripts/export-openclaw.sh first`,
		);
	}

	const store = new VectorStore(getOpenclawDbPath(), OPENCLAW_DIM);
	await store.init();

	// Dimension is checked against the DB before a single row lands, the same
	// preflight discipline the paid tracks use — except here a mismatch would not
	// cost money, it would silently poison a store nobody can query.
	const actual = await store.getActualVectorDim();
	if (actual !== null && actual !== OPENCLAW_DIM) {
		throw new Error(
			`openclaw.lance holds ${actual}d vectors but this import produces ${OPENCLAW_DIM}d — refusing`,
		);
	}

	const rl = readline.createInterface({
		input: fs.createReadStream(stagingPath).pipe(zlib.createGunzip()),
		crlfDelay: Infinity,
	});

	let batch: Parameters<VectorStore["addChunksRaw"]>[0] = [];
	const flush = async () => {
		if (batch.length === 0) return;
		// Ask the store what it already holds, then write only what differs. The
		// boundary re-fetch is accepted in full and simply lands on rows we have.
		const held = await store.getStoredStamps(batch.map((c) => c.id));
		const { write, unchanged } = partitionByChange(batch, held);
		stats.unchanged += unchanged;
		if (!opts.dryRun && write.length > 0) {
			// Same id replaces itself. Deleting first keeps a re-exported chunk from
			// existing twice; it does not remove anything this import did not see.
			await store.deleteByIds(write.map((c) => c.id));
			await store.addChunksRaw(write);
		}
		// by-agent counts what was WRITTEN, so the line cannot claim work that the
		// unchanged skip just avoided.
		for (const c of write) stats.byAgent[c.project] = (stats.byAgent[c.project] ?? 0) + 1;
		stats.imported += write.length;
		batch = [];
	};

	for await (const line of rl) {
		if (!line.trim()) continue;
		stats.seen++;
		const r = JSON.parse(line) as OpenclawRow;
		const verdict = prepareRow(r);

		if (verdict.kind === "drop-credential") { stats.droppedCredential++; continue; }
		if (verdict.kind === "drop-boilerplate") { stats.droppedBoilerplate++; continue; }
		if (verdict.kind === "drop-vector") { stats.droppedDim++; continue; }

		batch.push(verdict.chunk);
		// The watermark advances on every ACCEPTED row, including one we end up not
		// rewriting: we did take it, and the cursor records what we took.
		mergeWatermark(stats.watermark, r.agent, r.updated_at);

		if (batch.length >= 200) await flush();
	}
	await flush();

	if (!opts.dryRun) writeWatermark(stats.watermark, host);
	await store.close();
	return stats;
}

/**
 * Direct entry: `pnpm exec tsx openclaw-importer.ts [--dry-run]`.
 * `run.sh sync:openclaw` runs the export first and then this.
 */
async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");

	// No staged artifact is the normal outcome of a run that fetched nothing, so
	// it exits clean. A direct call with a genuinely missing export still gets the
	// error from importOpenclaw(); this branch only covers the `sync:openclaw`
	// pipeline, where the exporter has just told us there was nothing to take.
	if (!fs.existsSync(getStagingPath())) {
		console.log("✅ OpenClaw harvest: nothing staged — no import, no API call");
		return;
	}

	const stats = await importOpenclaw(getStagingPath(), { dryRun });

	console.log(
		`📥 OpenClaw harvest: ${stats.imported} chunks written (of ${stats.seen} exported)`,
	);
	if (stats.unchanged > 0) {
		console.log(
			`   unchanged: ${stats.unchanged} already held with the same stamp — accepted, not rewritten`,
		);
	}
	const dropped =
		stats.droppedCredential + stats.droppedBoilerplate + stats.droppedDim;
	if (dropped > 0) {
		console.log(
			`   dropped: credential=${stats.droppedCredential} boilerplate=${stats.droppedBoilerplate} bad-vector=${stats.droppedDim}`,
		);
	}
	const agents = Object.entries(stats.byAgent)
		.sort((a, b) => b[1] - a[1])
		.map(([a, n]) => `${a}=${n}`)
		.join(" ");
	if (agents) console.log(`   by agent: ${agents}`);
	console.log(`   💰 API: 0 calls — vectors came already computed`);
	if (dryRun) console.log("   (dry run — nothing was written)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
