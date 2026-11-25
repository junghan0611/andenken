/**
 * embedding-profile.ts — the identity of an embedding generation.
 *
 * A vector store is queryable only by vectors from the SAME model, not merely
 * the same dimension. Two 1024d models (or one model served by two runtimes
 * whose weights differ) produce vectors that a dimension guard cannot tell
 * apart, and the result of mixing them is not an error but quietly wrong
 * ranking. So a generation is named by a profile, and every store written by a
 * profile-aware writer carries a stamp of that profile.
 *
 * What lives here, all API 0:
 *   - the known profiles (current 4096d production, local Ollama BGE-M3 1024d,
 *     OpenRouter BGE-M3 1024d for documents produced on another host)
 *   - a fingerprint over the fields that decide vector geometry
 *   - strict validation of an OpenAI-compatible /v1/embeddings response
 *   - a fail-closed input-length bound for runtimes that silently truncate
 *   - the store stamp (read / write / compatibility decision)
 *
 * What does NOT live here: starting a runtime, choosing a corpus, or deciding
 * that two different profiles are "compatible enough". Cross-profile querying
 * (e.g. Ollama query vectors against OpenRouter document vectors) is refused
 * until a separate isolated parity measurement says otherwise — equal
 * dimension is never that evidence.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface EmbeddingProfile {
	/** Stable profile name, used in env (`ANDENKEN_<NS>_PROFILE`) and stamps. */
	id: string;
	/** Model family, for humans. Not part of the fingerprint on its own. */
	family: string;
	/** The exact `model` string sent to the endpoint. */
	model: string;
	/**
	 * Runtime weight digest (sha256 hex) when the runtime exposes one (Ollama
	 * `/api/tags`). null = the runtime offers no digest (hosted API); identity
	 * then rests on the endpoint class + model string only.
	 */
	digest: string | null;
	dimensions: number;
	/** Context window in tokens as configured on the runtime. */
	maxInputTokens: number;
	/** Inputs per request. */
	maxBatchSize: number;
	timeoutMs: number;
	queryInstruction: string;
	documentInstruction: string;
	/** "loopback" profiles refuse any endpoint that is not 127.0.0.1/::1/localhost. */
	endpointClass: "loopback" | "hosted";
	paidRemote: boolean;
	/** Fixed endpoint for loopback profiles (the runtime contract). */
	endpoint?: string;
	/**
	 * True only for the profile that produced the stores that existed before
	 * stamps did. An unstamped non-empty 4096d store is accepted as this
	 * profile — and only this one. Existing stores are never stamped
	 * retroactively by this module.
	 */
	legacyUnstamped?: boolean;
	/**
	 * Tokenizer bound used by `maxInputCodepoints`: tokens ≤ NFKC code points
	 * + this overhead (specials + the sentencepiece leading "▁"). Holds for
	 * a unigram sentencepiece vocab without byte fallback (XLM-R / BGE-M3).
	 * null = no proven bound → length is not enforced by codepoints (hosted
	 * 32K-context models where chunks are far below the window).
	 */
	tokenOverhead: number | null;
}

const QWEN_QUERY_INSTRUCTION =
	"Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

export const PROFILES: Readonly<Record<string, EmbeddingProfile>> = Object.freeze({
	"openrouter-qwen3-8b-4096": {
		id: "openrouter-qwen3-8b-4096",
		family: "qwen3-embedding-8b",
		model: "qwen/qwen3-embedding-8b",
		digest: null,
		dimensions: 4096,
		maxInputTokens: 32768,
		maxBatchSize: 100,
		timeoutMs: 30_000,
		queryInstruction: QWEN_QUERY_INSTRUCTION,
		documentInstruction: "",
		endpointClass: "hosted",
		paidRemote: true,
		legacyUnstamped: true,
		tokenOverhead: null,
	},
	// Runtime contract from nixos-config: Ollama 0.32.3, /v1 on loopback
	// 127.0.0.1:11435, bge-m3:latest at this digest, ctx 2048, batch ≤ 4, 30 s.
	"ollama-bge-m3-1024": {
		id: "ollama-bge-m3-1024",
		family: "bge-m3",
		model: "bge-m3:latest",
		digest: "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab",
		dimensions: 1024,
		maxInputTokens: 2048,
		maxBatchSize: 4,
		timeoutMs: 30_000,
		queryInstruction: "",
		documentInstruction: "",
		endpointClass: "loopback",
		paidRemote: false,
		endpoint: "http://127.0.0.1:11435",
		tokenOverhead: 3,
	},
	// Documents embedded on another host (Oracle OpenClaw). Same family as the
	// local profile, DIFFERENT profile: query vectors from Ollama are not
	// accepted against these until an isolated parity test is recorded.
	"openrouter-bge-m3-1024": {
		id: "openrouter-bge-m3-1024",
		family: "bge-m3",
		model: "baai/bge-m3",
		digest: null,
		dimensions: 1024,
		maxInputTokens: 8192,
		maxBatchSize: 32,
		timeoutMs: 30_000,
		queryInstruction: "",
		documentInstruction: "",
		endpointClass: "hosted",
		paidRemote: true,
		tokenOverhead: 3,
	},
});

export function getProfile(id: string): EmbeddingProfile | null {
	return Object.prototype.hasOwnProperty.call(PROFILES, id) ? PROFILES[id] : null;
}

/** Fields that decide vector geometry. Batch, timeout and price do not. */
export function profileFingerprint(p: EmbeddingProfile): string {
	const canonical = JSON.stringify([
		"andenken-embedding-profile-v1",
		p.endpointClass,
		p.model,
		p.digest,
		p.dimensions,
		p.queryInstruction,
		p.documentInstruction,
	]);
	return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function isLoopbackEndpoint(endpoint: string): boolean {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	const h = u.hostname;
	return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

export type EmbeddingResponseCode =
	| "response-not-object"
	| "data-not-array"
	| "count-mismatch"
	| "index-invalid"
	| "index-duplicate"
	| "embedding-not-array"
	| "dimension-mismatch"
	| "dimension-unknown"
	| "non-finite"
	| "zero-vector"
	| "model-mismatch";

/**
 * A response that cannot be trusted as one vector per input, in input order.
 * Permanent for the request that produced it: retrying the same request at
 * the same runtime does not make a wrong-shaped answer right, so callers must
 * treat it like a wrong-dimension failure, never as transient.
 */
export class EmbeddingResponseInvalid extends Error {
	readonly nonRetryable = true;
	constructor(readonly code: EmbeddingResponseCode) {
		super(`embedding-response-invalid: ${code}`);
		this.name = "EmbeddingResponseInvalid";
	}
}

/**
 * Validate an OpenAI-compatible embeddings response and return the vectors
 * in input order. `expectedDim` must be a positive integer — an unknown
 * dimension is a configuration error, not something to learn from the reply.
 * `expectedModel`, when given, must equal `body.model` if the body names one
 * (a runtime that substitutes another model is refused).
 */
export function validateEmbeddingResponse(
	body: unknown,
	inputCount: number,
	expectedDim: number,
	expectedModel?: string,
): number[][] {
	if (!Number.isInteger(expectedDim) || expectedDim <= 0) throw new EmbeddingResponseInvalid("dimension-unknown");
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new EmbeddingResponseInvalid("response-not-object");
	}
	const b = body as { data?: unknown; model?: unknown };
	if (expectedModel !== undefined && typeof b.model === "string" && b.model !== expectedModel) {
		throw new EmbeddingResponseInvalid("model-mismatch");
	}
	if (!Array.isArray(b.data)) throw new EmbeddingResponseInvalid("data-not-array");
	if (b.data.length !== inputCount) throw new EmbeddingResponseInvalid("count-mismatch");
	const out: (number[] | undefined)[] = new Array(inputCount);
	for (const item of b.data) {
		if (item === null || typeof item !== "object") throw new EmbeddingResponseInvalid("embedding-not-array");
		const { index, embedding } = item as { index?: unknown; embedding?: unknown };
		if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= inputCount) {
			throw new EmbeddingResponseInvalid("index-invalid");
		}
		if (out[index] !== undefined) throw new EmbeddingResponseInvalid("index-duplicate");
		if (!Array.isArray(embedding)) throw new EmbeddingResponseInvalid("embedding-not-array");
		if (embedding.length !== expectedDim) throw new EmbeddingResponseInvalid("dimension-mismatch");
		let sumSq = 0;
		for (const x of embedding) {
			if (typeof x !== "number" || !Number.isFinite(x)) throw new EmbeddingResponseInvalid("non-finite");
			sumSq += x * x;
		}
		if (!(sumSq > 0) || !Number.isFinite(sumSq)) throw new EmbeddingResponseInvalid("zero-vector");
		out[index] = embedding as number[];
	}
	// count == inputCount and no duplicate index ⇒ every slot is filled.
	return out as number[][];
}

// ---------------------------------------------------------------------------
// Input length (fail-closed against silent truncation)
// ---------------------------------------------------------------------------

export function codepointsNfkc(s: string): number {
	let n = 0;
	for (const _ of s.normalize("NFKC")) n++;
	return n;
}

/**
 * Largest NFKC code-point count of the text (instruction excluded) that is
 * guaranteed to fit, or null when the profile has no proven bound.
 */
export function maxInputCodepoints(p: EmbeddingProfile, kind: "query" | "document"): number | null {
	if (p.tokenOverhead === null) return null;
	const instr = kind === "query" ? p.queryInstruction : p.documentInstruction;
	return p.maxInputTokens - p.tokenOverhead - codepointsNfkc(instr);
}

export class EmbeddingInputTooLong extends Error {
	readonly nonRetryable = true;
	readonly code = "input-exceeds-context";
	constructor(
		readonly inputIndex: number,
		readonly codepoints: number,
		readonly limit: number,
	) {
		super(`input-exceeds-context: input ${inputIndex} has ${codepoints} code points > ${limit}`);
		this.name = "EmbeddingInputTooLong";
	}
}

/** Throws on the first text that could be truncated by the runtime. Texts exclude the instruction. */
export function assertInputsFit(p: EmbeddingProfile, kind: "query" | "document", texts: readonly string[]): void {
	const limit = maxInputCodepoints(p, kind);
	if (limit === null) return;
	for (let i = 0; i < texts.length; i++) {
		const n = codepointsNfkc(texts[i]);
		if (n > limit) throw new EmbeddingInputTooLong(i, n, limit);
	}
}

/** Plan-side summary: how many texts would be refused, and the longest one. */
export function lengthPlan(
	p: EmbeddingProfile,
	kind: "query" | "document",
	texts: Iterable<string>,
): { limit: number | null; total: number; over: number; maxCodepoints: number } {
	const limit = maxInputCodepoints(p, kind);
	let total = 0;
	let over = 0;
	let max = 0;
	for (const t of texts) {
		total++;
		const n = codepointsNfkc(t);
		if (n > max) max = n;
		if (limit !== null && n > limit) over++;
	}
	return { limit, total, over, maxCodepoints: max };
}

// ---------------------------------------------------------------------------
// Runtime identity (Ollama digest)
// ---------------------------------------------------------------------------

export type RuntimeIdentity =
	| { ok: true; digest: string }
	| { ok: false; code: "runtime-unreachable" | "runtime-bad-response" | "model-absent" | "digest-mismatch" | "endpoint-not-loopback" | "no-digest-surface" };

/**
 * Ask the runtime which weights `profile.model` resolves to. Ollama exposes
 * them at `/api/tags` (models[].name / models[].digest). A profile without a
 * digest has no surface to check here and answers `no-digest-surface`.
 */
export async function verifyRuntimeIdentity(
	p: EmbeddingProfile,
	endpoint: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 5_000,
): Promise<RuntimeIdentity> {
	if (p.digest === null) return { ok: false, code: "no-digest-surface" };
	if (p.endpointClass === "loopback" && !isLoopbackEndpoint(endpoint)) return { ok: false, code: "endpoint-not-loopback" };
	let body: unknown;
	try {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), timeoutMs);
		try {
			const res = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/api/tags`, { signal: ctl.signal });
			if (!res.ok) return { ok: false, code: "runtime-bad-response" };
			body = await res.json();
		} finally {
			clearTimeout(t);
		}
	} catch {
		return { ok: false, code: "runtime-unreachable" };
	}
	const models = (body as { models?: unknown })?.models;
	if (!Array.isArray(models)) return { ok: false, code: "runtime-bad-response" };
	const hit = models.find(
		(m) => m && typeof m === "object" && ((m as { name?: unknown }).name === p.model || (m as { model?: unknown }).model === p.model),
	) as { digest?: unknown } | undefined;
	if (!hit) return { ok: false, code: "model-absent" };
	const digest = typeof hit.digest === "string" ? hit.digest.replace(/^sha256:/, "") : "";
	if (digest !== p.digest) return { ok: false, code: "digest-mismatch" };
	return { ok: true, digest };
}

// ---------------------------------------------------------------------------
// Store stamp
// ---------------------------------------------------------------------------

export const STAMP_FILE = "andenken-profile.json";
export const STAMP_KIND = "andenken-store-profile-v1";

export interface StoreStamp {
	kind: typeof STAMP_KIND;
	profileId: string;
	fingerprint: string;
	model: string;
	digest: string | null;
	dimensions: number;
	createdAt: string;
}

/**
 * The stamp lives INSIDE the LanceDB directory so every copy of the store
 * (rsync publish, backup, candidate promotion) carries it with the rows.
 */
export function stampPath(dbPath: string): string {
	return path.join(dbPath, STAMP_FILE);
}

export type StampRead = { state: "absent" } | { state: "ok"; stamp: StoreStamp } | { state: "invalid" };

export function readStoreStamp(dbPath: string): StampRead {
	let raw: string;
	try {
		raw = fs.readFileSync(stampPath(dbPath), "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "invalid" };
	}
	try {
		const s = JSON.parse(raw) as Partial<StoreStamp>;
		if (
			s.kind !== STAMP_KIND ||
			typeof s.profileId !== "string" ||
			typeof s.fingerprint !== "string" ||
			!/^[0-9a-f]{64}$/.test(s.fingerprint) ||
			typeof s.model !== "string" ||
			!(s.digest === null || typeof s.digest === "string") ||
			!Number.isInteger(s.dimensions) ||
			(s.dimensions as number) <= 0
		) {
			return { state: "invalid" };
		}
		return { state: "ok", stamp: s as StoreStamp };
	} catch {
		return { state: "invalid" };
	}
}

export function makeStamp(p: EmbeddingProfile, now: Date = new Date()): StoreStamp {
	return {
		kind: STAMP_KIND,
		profileId: p.id,
		fingerprint: profileFingerprint(p),
		model: p.model,
		digest: p.digest,
		dimensions: p.dimensions,
		createdAt: now.toISOString(),
	};
}

/**
 * Stamp a store. Refuses to overwrite a stamp of a different profile, and
 * refuses to stamp a store that already holds rows (`rowsBefore > 0`) with no
 * stamp — that would launder an unknown generation into a known one. Atomic
 * (write tmp + rename). The directory must already exist (a writer created it).
 */
export function writeStoreStamp(dbPath: string, p: EmbeddingProfile, rowsBefore: number): StoreStamp {
	const cur = readStoreStamp(dbPath);
	if (cur.state === "invalid") throw new StoreProfileRefused("store-stamp-invalid");
	if (cur.state === "ok") {
		if (cur.stamp.fingerprint !== profileFingerprint(p)) throw new StoreProfileRefused("store-profile-mismatch");
		return cur.stamp;
	}
	if (rowsBefore > 0) throw new StoreProfileRefused("store-unstamped-has-rows");
	if (!fs.existsSync(dbPath)) throw new StoreProfileRefused("store-dir-missing");
	const stamp = makeStamp(p);
	const tmp = `${stampPath(dbPath)}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(stamp, null, 2) + "\n", { mode: 0o644 });
	fs.renameSync(tmp, stampPath(dbPath));
	return stamp;
}

export class StoreProfileRefused extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "StoreProfileRefused";
	}
}

export type StoreProfileDecision =
	| { ok: true; basis: "stamp" | "legacy-unstamped" | "empty-store" }
	| { ok: false; code: string };

/**
 * May vectors of profile `p` be written to / queried against this store?
 *
 *   stamp present  → fingerprints must be equal (same model, digest, dim, instructions)
 *   stamp invalid  → refuse
 *   no stamp, no rows (or no store) → allowed; a writer must stamp it on creation
 *   no stamp, rows → allowed ONLY for the `legacyUnstamped` profile at its
 *                    dimension; anything else is an unknown generation
 *
 * `storedDim` is the sampled vector dimension (null when the store is empty or
 * absent), `rows` the row count (0 when absent).
 */
export function decideStoreProfile(
	dbPath: string,
	p: EmbeddingProfile,
	rows: number,
	storedDim: number | null,
): StoreProfileDecision {
	const s = readStoreStamp(dbPath);
	if (s.state === "invalid") return { ok: false, code: "store-stamp-invalid" };
	if (storedDim !== null && storedDim !== p.dimensions) return { ok: false, code: "store-dimension-mismatch" };
	if (s.state === "ok") {
		if (s.stamp.dimensions !== p.dimensions) return { ok: false, code: "store-dimension-mismatch" };
		if (s.stamp.fingerprint !== profileFingerprint(p)) return { ok: false, code: "store-profile-mismatch" };
		return { ok: true, basis: "stamp" };
	}
	if (rows === 0) return { ok: true, basis: "empty-store" };
	if (p.legacyUnstamped === true) return { ok: true, basis: "legacy-unstamped" };
	return { ok: false, code: "store-unstamped-unknown-generation" };
}

/**
 * Store-access decision for a provider that may or may not carry a profile.
 * `null` = an unprofiled provider (legacy env without `*_PROFILE` whose
 * model is not the legacy one): it keeps the old dimension-only behaviour on
 * an UNSTAMPED store, and is refused by name on a stamped one — a stamped
 * generation is only ever touched by its own profile.
 */
export function decideStoreAccess(
	dbPath: string,
	p: EmbeddingProfile | null,
	rows: number,
	storedDim: number | null,
): StoreProfileDecision {
	if (p) return decideStoreProfile(dbPath, p, rows, storedDim);
	const s = readStoreStamp(dbPath);
	if (s.state === "invalid") return { ok: false, code: "store-stamp-invalid" };
	if (s.state === "ok") return { ok: false, code: "unprofiled-provider-on-stamped-store" };
	return { ok: true, basis: rows === 0 ? "empty-store" : "legacy-unstamped" };
}

/**
 * The profile a provider speaks for: its explicit one, else the legacy 4096
 * profile when model and dimension are exactly the legacy pair, else null.
 */
export function profileOfProvider(provider: {
	readonly dimensions: number;
	readonly profile?: EmbeddingProfile;
	readonly model?: string;
}): EmbeddingProfile | null {
	if (provider.profile) return provider.profile;
	const legacy = PROFILES["openrouter-qwen3-8b-4096"];
	if (typeof provider.model === "string" && provider.model.toLowerCase() === legacy.model && provider.dimensions === legacy.dimensions) {
		return legacy;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Splitting to fit (shared by md and sessions)
// ---------------------------------------------------------------------------

/**
 * Split `text` so every piece has ≤ `limit` NFKC code points: whole lines
 * first (a line keeps its trailing newline), then a line that alone is too
 * long is cut by code points. Lossless (`pieces.join("") === text`); every
 * piece is re-measured and a piece that still does not fit throws.
 */
export function splitTextToCodepoints(text: string, limit: number): string[] {
	if (codepointsNfkc(text) <= limit) return [text];
	const out: string[] = [];
	let cur = "";
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];
	for (const line of lines) {
		if (codepointsNfkc(cur + line) <= limit) {
			cur += line;
			continue;
		}
		if (cur.length > 0) out.push(cur);
		cur = "";
		if (codepointsNfkc(line) <= limit) {
			cur = line;
			continue;
		}
		// Linear: accumulate each code point's own NFKC length. Normalizing a
		// concatenation can only compose (shrink), never exceed that sum, so the
		// running count is a safe upper bound; each piece is re-measured below.
		let piece = "";
		let n = 0;
		for (const ch of line) {
			const w = codepointsNfkc(ch);
			if (piece.length > 0 && n + w > limit) {
				out.push(piece);
				piece = "";
				n = 0;
			}
			piece += ch;
			n += w;
		}
		cur = piece;
	}
	if (cur.length > 0) out.push(cur);
	for (const p of out) {
		if (codepointsNfkc(p) > limit) throw new EmbeddingInputTooLong(-1, codepointsNfkc(p), limit);
	}
	return out;
}

/**
 * How a profiled generation splits session text: the seam-aware splitter's
 * target, and a hard code-point ceiling applied after it. undefined = the
 * profile has no proven bound → the historical split, byte-for-byte.
 */
export interface EmbedSplit {
	/** Target for splitForEmbedding; its longest output is target + "\n" + tail(<200). */
	target: number;
	/** Every emitted part has ≤ this many NFKC code points (document side). */
	maxCodepoints: number;
}

export function embedSplitFor(p: EmbeddingProfile | null | undefined): EmbedSplit | undefined {
	if (!p) return undefined;
	const limit = maxInputCodepoints(p, "document");
	if (limit === null) return undefined;
	// splitForEmbedding's longest part = target + 1 + (minTail − 1) with
	// minTail = min(200, target/4); target = limit − 200 keeps that ≤ limit for
	// UTF-16-length text, and the code-point pass catches NFKC expansion.
	return { target: limit - 200, maxCodepoints: limit };
}

// ---------------------------------------------------------------------------
// Writer rule: the legacy generation is read-only
// ---------------------------------------------------------------------------

/**
 * Refusal code for an EMBEDDING WRITE (index / sync / durable / md /
 * /memory reindex) by `provider`, or null when it may write.
 *
 * The legacy Qwen 4096d generation (2026-11-25 decision: MD + sessions have no
 * active Qwen build) is read-only: it may still QUERY the preserved 4096d
 * stores and be used for rollback, but nothing embeds new rows with it. The
 * check is by identity (profileOfProvider), so it also catches a Qwen provider
 * configured the old way without `*_PROFILE`. Unprofiled stub/custom providers
 * keep the dimension + stamp guards (they can never write a stamped store).
 */
export function writerRefusal(provider: {
	readonly dimensions: number;
	readonly profile?: EmbeddingProfile;
	readonly model?: string;
}): string | null {
	const p = profileOfProvider(provider);
	if (p && p.legacyUnstamped === true) return `legacy-generation-read-only: ${p.id} may query preserved stores but no longer writes`;
	return null;
}
