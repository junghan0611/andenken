#!/usr/bin/env tsx
/**
 * status-contract.ts — `./run.sh status:contract --json`, contract v1.
 *
 * A machine-readable statement of what each axis (sessions / md / openclaw)
 * IS on this host, kept separate from `status` / `status:json` (which stay
 * byte-for-byte as they were). Read-only by construction:
 *
 *   - no network: providers are BUILT (env → profile) but never asked anything;
 *     the runtime digest is reported as expected, observed = null, not-probed
 *   - no embedding: no query vector is made
 *   - no writes: stores are opened `readOnly` (never created), stamps and
 *     receipts are read, nothing is stamped, compacted or recorded
 *
 * Two states per axis, never merged:
 *
 *   index.state   absent | empty | present | unreadable
 *                 empty = a READABLE table with zero rows; absent = no path or
 *                 no table; unreadable = an I/O error made the answer unknown
 *                 (it is never reported as absent or empty)
 *   query.state   ready | empty | absent | refused | unknown
 *                 refused carries the SAME code the search path would refuse
 *                 with (provider selection and decideStoreAccess are reused);
 *                 unknown = a fact the decision needs could not be read
 *
 * The selected provider (profile / model / fingerprint) is reported apart from
 * the stamped DB generation, and the expected runtime digest apart from the
 * observed runtime revision (always null + not-probed in v1).
 *
 * Coverage is `unknown` with a reason unless an EXISTING receipt binds the
 * exact LanceDB table version AND the source snapshot/scope. No existing
 * receipt records a table version (session/md manifests are per-file
 * mtime/size; the candidate receipt pins a plan/corpus but not the table
 * version; the OpenClaw import receipt pins a staging mtime), so v1 always
 * answers unknown — by rule, never by comparing source mtimes to the index.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	decideStoreAccess,
	profileFingerprint,
	profileOfProvider,
	readAttestationsTyped,
	readStoreStampTyped,
	type EmbeddingProfile,
} from "./embedding-profile.js";
import {
	createMdProviderFromEnv,
	createOpenclawQueryProviderFromEnv,
	createSessionProviderFromEnv,
	envMode,
	providerNamespaceDeclared,
	type EmbeddingProvider,
} from "./embedding-provider.js";
import { getDataDir, getMdDbPath, getOpenclawDbPath, getSessionsDbPath, VectorStore } from "./store.js";

export const CONTRACT_KIND = "andenken-status-contract";
export const CONTRACT_VERSION = 1;

export type Axis = "sessions" | "md" | "openclaw";

export interface ErrorEvidence {
	/** errno (EACCES, EIO, ...) when the OS gave one, else "unknown". */
	errno: string;
	/** Where the read failed. */
	at: string;
	message: string;
}

export interface IndexFacts {
	state: "absent" | "empty" | "present" | "unreadable";
	/** absent: which shape (`no-path` / `no-table`). */
	absentShape?: "no-path" | "no-table";
	rows: number | null;
	/** Dimension of one sampled stored vector (null when empty / unknown). */
	vectorDim: number | null;
	/** LanceDB table version as read now (null when not read). */
	tableVersion: number | null;
	error?: ErrorEvidence;
}

export interface GenerationFacts {
	profileId: string;
	provider: string;
	model: string;
	fingerprint: string;
	digest: string | null;
	dimensions: number;
	producer?: { kind: string; model: string; provider: string; vectorDims: number };
}

export interface StampFacts {
	state: "absent" | "ok" | "invalid" | "unreadable" | "not-read";
	generation?: GenerationFacts;
	error?: ErrorEvidence;
}

export interface AttestationFacts {
	state: "absent" | "ok" | "invalid" | "unreadable" | "not-read";
	count?: number;
	error?: ErrorEvidence;
}

export interface SelectedProvider {
	/** The env namespace the search path would build from. */
	selection: string;
	state: "selected" | "not-configured" | "refused";
	code?: string;
	profileId?: string;
	model?: string;
	fingerprint?: string;
	dimensions?: number;
	runtime?: { expectedDigest: string | null; observedRevision: null; probe: "not-probed" };
}

export interface QueryFacts {
	state: "ready" | "empty" | "absent" | "refused" | "unknown";
	/** ready/empty: why access is granted (decideStoreAccess basis). */
	basis?: "stamp" | "attested" | "empty-store";
	/** refused / unknown: named code. */
	code?: string;
	provider: SelectedProvider;
}

export interface ReceiptFacts {
	name: string;
	state: "absent" | "present" | "unreadable";
	bindsTableVersion: false;
	bindsSourceSnapshot: boolean;
	note: string;
	error?: ErrorEvidence;
}

export interface CoverageFacts {
	state: "unknown";
	reason: string;
	receipts: ReceiptFacts[];
}

export interface AxisContract {
	axis: Axis;
	path: string;
	index: IndexFacts;
	stamp: StampFacts;
	attestation: AttestationFacts;
	query: QueryFacts;
	coverage: CoverageFacts;
}

export interface StatusContract {
	kind: typeof CONTRACT_KIND;
	version: typeof CONTRACT_VERSION;
	generatedAt: string;
	host: string;
	dataDir: string;
	envMode: "default" | "process-only" | "invalid";
	readOnly: { network: false; embedding: false; writes: false; runtimeProbe: false };
	axes: Record<Axis, AxisContract>;
}

// ---------------------------------------------------------------------------

function errEvidence(e: unknown, at: string): ErrorEvidence {
	const errno = (e as NodeJS.ErrnoException)?.code;
	const message = e instanceof Error ? e.message : String(e);
	return { errno: typeof errno === "string" ? errno : "unknown", at, message: message.slice(0, 200) };
}

/**
 * Index facts with I/O kept apart from absence. `describeAxisAbsence` uses
 * `existsSync`, which answers `false` for EACCES too — fine for a search that
 * then refuses, wrong for a report: an unreadable axis is not an absent one.
 */
async function probeIndex(dbPath: string): Promise<IndexFacts> {
	const unknown = (error: ErrorEvidence): IndexFacts => ({ state: "unreadable", rows: null, vectorDim: null, tableVersion: null, error });
	try {
		const st = fs.statSync(dbPath);
		if (!st.isDirectory()) return unknown({ errno: "ENOTDIR", at: dbPath, message: "store path is not a directory" });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", absentShape: "no-path", rows: null, vectorDim: null, tableVersion: null };
		return unknown(errEvidence(e, dbPath));
	}
	const tableDir = path.join(dbPath, "session_chunks.lance");
	try {
		fs.statSync(tableDir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", absentShape: "no-table", rows: null, vectorDim: null, tableVersion: null };
		return unknown(errEvidence(e, tableDir));
	}
	// The read-only store never creates; vectorDim 0 + no profile = no guard and
	// no stamping path is reachable from a probe.
	const store = new VectorStore(dbPath, 0, { readOnly: true });
	try {
		const s = await store.probeShapeStrict();
		if (!s.table) return unknown({ errno: "unknown", at: tableDir, message: "table directory exists but LanceDB lists no table" });
		return { state: s.rows === 0 ? "empty" : "present", rows: s.rows, vectorDim: s.dim, tableVersion: s.version };
	} catch (e) {
		return unknown(errEvidence(e, tableDir));
	} finally {
		await store.close();
	}
}

function genOf(s: {
	profileId: string;
	provider: string;
	model: string;
	fingerprint: string;
	digest: string | null;
	dimensions: number;
	producer?: { kind: string; model: string; provider: string; vectorDims: number };
}): GenerationFacts {
	return {
		profileId: s.profileId,
		provider: s.provider,
		model: s.model,
		fingerprint: s.fingerprint,
		digest: s.digest,
		dimensions: s.dimensions,
		...(s.producer ? { producer: { kind: s.producer.kind, model: s.producer.model, provider: s.producer.provider, vectorDims: s.producer.vectorDims } } : {}),
	};
}

function readStamp(dbPath: string): StampFacts {
	const r = readStoreStampTyped(dbPath);
	if (r.state === "io-error") return { state: "unreadable", error: { errno: r.errno, at: path.join(dbPath, "andenken-profile.json"), message: "stamp read failed" } };
	if (r.state === "ok") return { state: "ok", generation: genOf(r.stamp) };
	return { state: r.state };
}

function readAttest(dbPath: string): AttestationFacts {
	const r = readAttestationsTyped(dbPath);
	if (r.state === "io-error") return { state: "unreadable", error: { errno: r.errno, at: path.join(dbPath, "andenken-query-attestation.json"), message: "attestation read failed" } };
	if (r.state === "ok") return { state: "ok", count: r.list.length };
	return { state: r.state };
}

function describeProvider(selection: string, p: EmbeddingProvider): SelectedProvider {
	const prof: EmbeddingProfile | null = profileOfProvider(p);
	if (!prof) return { selection, state: "refused", code: "unprofiled-provider" };
	return {
		selection,
		state: "selected",
		profileId: prof.id,
		model: prof.model,
		fingerprint: profileFingerprint(prof),
		dimensions: prof.dimensions,
		runtime: { expectedDigest: prof.digest, observedRevision: null, probe: "not-probed" },
	};
}

/**
 * The provider the SEARCH path would use for this axis, by the same factory
 * calls (cli.ts getSessionsProvider / getMdProvider / searchOpenclaw). A
 * factory that returns null makes search exit 1; here it becomes a named
 * refusal: not configured vs configured-but-refused.
 */
export function selectQueryProvider(axis: Axis): { provider: EmbeddingProvider | null; facts: SelectedProvider } {
	const fromNs = (ns: "SESSION" | "MD", selection: string, build: () => EmbeddingProvider | null) => {
		let p: EmbeddingProvider | null;
		try {
			p = build();
		} catch (e) {
			return { provider: null, facts: { selection, state: "refused" as const, code: "provider-config-error" } };
		}
		if (p) return { provider: p, facts: describeProvider(selection, p) };
		let declared = false;
		try { declared = providerNamespaceDeclared(ns); } catch { declared = true; }
		return declared
			? { provider: null, facts: { selection, state: "refused" as const, code: "query-provider-refused" } }
			: { provider: null, facts: { selection, state: "not-configured" as const, code: "query-provider-not-configured" } };
	};
	if (axis === "sessions") return fromNs("SESSION", "ANDENKEN_SESSION_*", createSessionProviderFromEnv);
	if (axis === "md") return fromNs("MD", "ANDENKEN_MD_*", createMdProviderFromEnv);
	let oc: EmbeddingProvider | null;
	try {
		oc = createOpenclawQueryProviderFromEnv();
	} catch {
		return { provider: null, facts: { selection: "ANDENKEN_OPENCLAW_QUERY_*", state: "refused", code: "openclaw-query-provider-refused" } };
	}
	if (oc) return { provider: oc, facts: describeProvider("ANDENKEN_OPENCLAW_QUERY_*", oc) };
	return fromNs("SESSION", "ANDENKEN_SESSION_* (openclaw fallback)", createSessionProviderFromEnv);
}

function decideQuery(dbPath: string, index: IndexFacts, stamp: StampFacts, attest: AttestationFacts, sel: ReturnType<typeof selectQueryProvider>): QueryFacts {
	const provider = sel.facts;
	if (index.state === "absent") return { state: "absent", code: "axis-absent", provider };
	if (index.state === "unreadable") return { state: "unknown", code: "index-unreadable", provider };
	if (!sel.provider) return { state: "refused", code: provider.code, provider };
	const prof = profileOfProvider(sel.provider);
	// The guard would read these files again and fold an I/O error into
	// `store-stamp-invalid` / `attestation-invalid`; a report says unknown.
	if (stamp.state === "unreadable") return { state: "unknown", code: "stamp-unreadable", provider };
	if (attest.state === "unreadable" && stamp.state === "ok" && prof && stamp.generation?.fingerprint !== profileFingerprint(prof)) {
		return { state: "unknown", code: "attestation-unreadable", provider };
	}
	// Same order as VectorStore.checkProfile: the dimension guard first.
	if (index.vectorDim !== null && index.vectorDim !== sel.provider.dimensions) return { state: "refused", code: "store-dimension-mismatch", provider };
	const d = decideStoreAccess(dbPath, prof, index.rows ?? 0, index.vectorDim, "query");
	if (!d.ok) return { state: "refused", code: d.code, provider };
	return { state: index.rows === 0 ? "empty" : "ready", basis: d.basis, provider };
}

// --- Coverage ---------------------------------------------------------------

interface ReceiptSpec {
	name: string;
	bindsSourceSnapshot: boolean;
	note: string;
}

const RECEIPTS: Record<Axis, ReceiptSpec[]> = {
	sessions: [
		{ name: "session-manifest.json", bindsSourceSnapshot: false, note: "per-file mtime/size checkpoint; records no LanceDB table version" },
		{ name: "durable-manifest.json", bindsSourceSnapshot: false, note: "pi-durable checkpoint per snapshot; records no LanceDB table version" },
		{ name: "candidate-receipt.json", bindsSourceSnapshot: true, note: "pins a plan / corpus snapshot and counts, but no LanceDB table version" },
	],
	md: [{ name: "md-manifest.json", bindsSourceSnapshot: false, note: "per-file mtime/size/hash checkpoint; records no LanceDB table version" }],
	openclaw: [
		{ name: "openclaw-watermark.json", bindsSourceSnapshot: false, note: "per-agent newest-chunk cursor; records no LanceDB table version" },
		{ name: "openclaw-staging/last-import.json", bindsSourceSnapshot: true, note: "pins a staging mtime and row counts, but no LanceDB table version" },
	],
};

function readReceipt(dataDir: string, spec: ReceiptSpec): ReceiptFacts {
	const file = path.join(dataDir, spec.name);
	const base = { name: spec.name, bindsTableVersion: false as const, bindsSourceSnapshot: spec.bindsSourceSnapshot, note: spec.note };
	try {
		fs.statSync(file);
		return { ...base, state: "present" };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...base, state: "absent" };
		return { ...base, state: "unreadable", error: errEvidence(e, file) };
	}
}

/**
 * Coverage = "the index holds this source snapshot". Claimable only from a
 * receipt that binds BOTH the observed table version and the source
 * snapshot/scope. No v1 receipt records a table version, so this is unknown —
 * and deliberately never derived from source mtimes being newer (that does not
 * prove the index is behind) nor from a receipt that is merely present (that
 * does not prove it describes THIS table version).
 */
export function decideCoverage(axis: Axis, dataDir: string, index: IndexFacts): CoverageFacts {
	const receipts = RECEIPTS[axis].map((s) => readReceipt(dataDir, s));
	if (index.state === "absent") return { state: "unknown", reason: "index-absent", receipts };
	if (index.state === "unreadable") return { state: "unknown", reason: "index-unreadable", receipts };
	const bound = receipts.filter((r) => r.state === "present" && r.bindsTableVersion && r.bindsSourceSnapshot);
	if (bound.length === 0) {
		return {
			state: "unknown",
			reason: receipts.some((r) => r.state === "present") ? "no-receipt-binds-table-version" : "no-receipt",
			receipts,
		};
	}
	/* unreachable in v1: bindsTableVersion is the literal false */
	return { state: "unknown", reason: "no-receipt-binds-table-version", receipts };
}

// ---------------------------------------------------------------------------

function currentHost(): string {
	try {
		const v = fs.readFileSync(path.join(process.env.HOME ?? "", ".current-device"), "utf-8").trim();
		if (v.length > 0) return v;
	} catch { /* fall through */ }
	try { return os.hostname(); } catch { return "unknown"; }
}

async function collectAxis(axis: Axis, dbPath: string, dataDir: string): Promise<AxisContract> {
	const index = await probeIndex(dbPath);
	const readable = index.state === "empty" || index.state === "present";
	const stamp: StampFacts = readable ? readStamp(dbPath) : { state: "not-read" };
	const attestation: AttestationFacts = readable ? readAttest(dbPath) : { state: "not-read" };
	const sel = selectQueryProvider(axis);
	const query = decideQuery(dbPath, index, stamp, attestation, sel);
	return { axis, path: dbPath, index, stamp, attestation, query, coverage: decideCoverage(axis, dataDir, index) };
}

export async function collectStatusContract(now: Date = new Date()): Promise<StatusContract> {
	let mode: StatusContract["envMode"];
	try { mode = envMode(); } catch { mode = "invalid"; }
	const dataDir = getDataDir();
	return {
		kind: CONTRACT_KIND,
		version: CONTRACT_VERSION,
		generatedAt: now.toISOString(),
		host: currentHost(),
		dataDir,
		envMode: mode,
		readOnly: { network: false, embedding: false, writes: false, runtimeProbe: false },
		axes: {
			sessions: await collectAxis("sessions", getSessionsDbPath(), dataDir),
			md: await collectAxis("md", getMdDbPath(), dataDir),
			openclaw: await collectAxis("openclaw", getOpenclawDbPath(), dataDir),
		},
	};
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, "") === path.resolve(new URL(import.meta.url).pathname).replace(/\.ts$/, "");
if (isMain) {
	if (!process.argv.includes("--json")) {
		console.error("usage: status-contract.ts --json   (v1 is JSON only; the human view is ./run.sh status)");
		process.exit(2);
	}
	console.log(JSON.stringify(await collectStatusContract(), null, 2));
}
