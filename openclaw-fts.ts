/**
 * openclaw-fts.ts — the full-text (BM25) index of openclaw.lance.
 *
 * `search-openclaw` has always been hybrid: a vector leg and a BM25 leg over OUR
 * LanceDB store. The importer never built the full-text index the other tracks
 * build after writing, so the BM25 leg answered `unavailable/no-fts-index` and
 * results came from vectors alone (issue #16's diagnostic, observed on both
 * hosts 2026-11-04). The index is built from the `text` column the harvest
 * already stores: no re-embedding, no upstream change, no row touched.
 *
 * Three uses, one notion of health (`ftsReady`, store.ts): `text_idx` exists and
 * a native full-text query runs `ok`. Index statistics are reported, unknown
 * when unreadable, and are not part of the bar; neither is coverage of every row
 * nor retrieval quality.
 *
 *   ./run.sh fts:openclaw            bootstrap: create the index on an existing
 *                                    table that lacks it; `ready` writes nothing
 *   ./run.sh fts:openclaw --check    read-only report; exit 0 only when ready
 *   ./run.sh fts:openclaw --protocol print the required-mode protocol line; opens
 *                                    nothing (a publisher asks a replica this
 *                                    before it trusts the replica's verify)
 *
 * The importer calls `ensureOpenclawFts()` after a run that wrote rows. A run that
 * wrote nothing (nothing staged, every row unchanged, dry run) does not touch the
 * index — a no-op stays a no-op, so a store whose index is missing stays missing
 * until this door or a writing import builds it.
 *
 * Opening order is the absent-axis rule (store.ts): health is read through a
 * read-only store, which refuses a missing axis — or a directory that holds no
 * table — instead of creating one. Only when a table exists and lacks the index
 * does a writable handle open, for that one `createIndex` (replace:false).
 */

import {
	VectorStore,
	getOpenclawDbPath,
	ftsReady,
	isAxisAbsentError,
	EXIT_AXIS_ABSENT,
	type FtsHealth,
} from "./store.js";
import { indexAuthorityRefusal } from "./session-policy.js";
import { assertOpenclawWriteLock, OpenclawLockRefused } from "./openclaw-lock.js";

const OPENCLAW_DIM = 4096;

/** What `--protocol` prints; a publisher refuses a replica that does not print it. */
export const OPENCLAW_FTS_PROTOCOL = "openclaw-fts-required v1";
/** The line `verify openclaw --require-fts` prints only when every required check passed. */
export const OPENCLAW_FTS_HEALTHY_MARK = "openclaw-fts-required v1: healthy";

export class OpenclawFtsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenclawFtsError";
	}
}

export function describeFtsHealth(h: FtsHealth): string {
	if (!h.table) return "no table";
	const stats = h.indexed === null ? "stats unknown" : `indexed ${h.indexed} · unindexed ${h.unindexed}`;
	const query = h.query === null ? "query not run" : h.query.status === "ok" ? "native query ok" : `native query ${h.query.status} (${h.query.code})`;
	return `${h.index ? "text_idx FTS on text" : "no text_idx"} · ${stats} · ${query}`;
}

/** Read-only. Throws AxisAbsentError when the axis (or its table) is absent. */
export async function readOpenclawFtsHealth(dbPath: string = getOpenclawDbPath()): Promise<FtsHealth> {
	const store = new VectorStore(dbPath, OPENCLAW_DIM, { readOnly: true });
	try {
		await store.init();
		return await store.ftsHealth();
	} finally {
		await store.close();
	}
}

/**
 * Create the index on an existing table when it is missing, then require health.
 * Never creates a table. Throws AxisAbsentError (absent axis) or OpenclawFtsError.
 */
export async function ensureOpenclawFts(
	dbPath: string = getOpenclawDbPath(),
): Promise<{ outcome: "created" | "existing"; health: FtsHealth }> {
	const before = await readOpenclawFtsHealth(dbPath);
	if (!before.table) throw new OpenclawFtsError("openclaw.lance holds no table — nothing to index");
	let outcome: "created" | "existing" = "existing";
	if (!before.index) {
		const writer = new VectorStore(dbPath, OPENCLAW_DIM);
		try {
			const r = await writer.createFtsIndex();
			if (r === "no-table") throw new OpenclawFtsError("openclaw.lance holds no table — nothing to index");
			outcome = r;
		} finally {
			await writer.close();
		}
	}
	const after = await readOpenclawFtsHealth(dbPath);
	if (!ftsReady(after)) throw new OpenclawFtsError(`FTS index not healthy after ensure: ${describeFtsHealth(after)}`);
	return { outcome, health: after };
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const known = new Set(["--check", "--protocol"]);
	const unknown = args.filter((a) => !known.has(a));
	if (unknown.length > 0 || args.length > 1) {
		console.error(`usage: ./run.sh fts:openclaw [--check | --protocol] (got: ${args.join(" ")})`);
		return 2;
	}
	if (args[0] === "--protocol") {
		console.log(OPENCLAW_FTS_PROTOCOL);
		return 0;
	}

	if (args[0] === "--check") {
		const h = await readOpenclawFtsHealth();
		const ready = ftsReady(h);
		console.log(`openclaw FTS: ${ready ? "ready" : "not ready"} — ${describeFtsHealth(h)}`);
		return ready ? 0 : 1;
	}

	const refusal = indexAuthorityRefusal("fts:openclaw");
	if (refusal) throw new OpenclawFtsError(`refused: ${refusal}`);
	assertOpenclawWriteLock("fts:openclaw", "fts:openclaw");
	const { outcome, health } = await ensureOpenclawFts();
	console.log(`openclaw FTS: ${outcome === "created" ? "created" : "ready (nothing written)"} — ${describeFtsHealth(health)}`);
	console.log("   💰 API: 0 calls — built from the stored text; vectors untouched");
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			if (isAxisAbsentError(err)) {
				console.log(JSON.stringify(err.absence));
				process.exit(EXIT_AXIS_ABSENT);
			}
			console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
			process.exit(err instanceof OpenclawLockRefused ? err.exitCode : 1);
		},
	);
}
