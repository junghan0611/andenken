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
 *   - the known profiles (local Ollama BGE-M3 1024d,
 *     OpenRouter BGE-M3 1024d for documents produced on another host)
 *   - a fingerprint over the fields that decide vector geometry
 *   - the request transport: Ollama-native `/api/embed` with `truncate:false`
 *     for the loopback profile, OpenAI-compatible `/v1/embeddings` otherwise
 *   - strict validation of an embeddings response (either transport)
 *   - a fail-closed input-length bound, plus the runtime's own refusal of an
 *     oversize input classified as permanent
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
	/** Default endpoint for loopback profiles (the runtime contract). */
	endpoint?: string;
	/** Who computes the vectors: the runtime / API provider. Part of the fingerprint. */
	provider: "ollama" | "openrouter";
	/**
	 * Tokenizer bound used by `maxInputCodepoints`: tokens ≤ NFKC code points
	 * + this overhead (specials + the sentencepiece leading "▁"). Holds for
	 * a unigram sentencepiece vocab without byte fallback (XLM-R / BGE-M3).
	 * null = no proven bound → length is not enforced by codepoints (hosted
	 * 32K-context models where chunks are far below the window).
	 */
	tokenOverhead: number | null;
	/**
	 * How requests reach the runtime. `ollama-native`: POST `/api/embed` with
	 * `truncate: false` and `options.num_ctx = maxInputTokens`, so an oversize
	 * input is an error from the runtime instead of a silently truncated vector
	 * (Ollama's `/v1/embeddings` cannot say `truncate:false`). Loopback only.
	 * `openai-v1`: POST `/v1/embeddings`.
	 *
	 * PART of the fingerprint (agent-config acceptance, 2026-11-26): rows
	 * embedded through `/v1` carry no proof that no input was truncated, so a
	 * `/v1` store and a native no-truncate store are different generations
	 * until a live parity measurement says otherwise (a short parity probe is
	 * diagnostic only). Native → native resume under the same pin is the same
	 * generation; a store or plan from the `/v1` era is refused by fingerprint.
	 */
	transport: "ollama-native" | "openai-v1";
}

/**
 * The ONLY generations current code knows (2026-11-25: Qwen / 4096d are not
 * known here at all; an earlier generation is restored with its own code,
 * configuration and data together, never read by this code).
 */
export const PROFILES: Readonly<Record<string, EmbeddingProfile>> = Object.freeze({
	// Runtime contract from nixos-config: Ollama 0.32.3 on loopback
	// 127.0.0.1:11435, bge-m3:latest at this digest, ctx 2048, batch ≤ 4, 30 s.
	// Requests use the native /api/embed with truncate:false (see `transport`).
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
		provider: "ollama",
		paidRemote: false,
		endpoint: "http://127.0.0.1:11435",
		tokenOverhead: 3,
		transport: "ollama-native",
	},
	// Documents embedded on another host (Oracle OpenClaw, its producer only).
	// Same family as the local profile, DIFFERENT generation: Ollama query
	// vectors are accepted against these only through an explicit, human-made
	// query-compatibility attestation on the store (see below).
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
		provider: "openrouter",
		paidRemote: true,
		tokenOverhead: 3,
		transport: "openai-v1",
	},
});

/**
 * The OpenClaw harvest generation. OpenClaw (Oracle) embeds its own agents'
 * memory with OpenRouter `baai/bge-m3`; the harvest imports those vectors as
 * they are, so this is the profile the harvest store is stamped with and the
 * profile any OpenClaw QUERY vector must belong to.
 */
export const OPENCLAW_PROFILE: EmbeddingProfile = PROFILES["openrouter-bge-m3-1024"];

/**
 * What OpenClaw's own `memory_index_meta_v1` must say for an agent's vectors to
 * belong to OPENCLAW_PROFILE. Literal producer strings, measured read-only on
 * Oracle 2026-11-25 (6/6 agents): model "baai/bge-m3", provider "openai" (the
 * producer's client label, kept as written — not our endpoint identity),
 * vectorDims 1024. An agent whose meta differs is a different generation and
 * the import refuses it.
 */
export const OPENCLAW_PRODUCER = Object.freeze({ model: "baai/bge-m3", provider: "openai", vectorDims: 1024 });

export function getProfile(id: string): EmbeddingProfile | null {
	return Object.prototype.hasOwnProperty.call(PROFILES, id) ? PROFILES[id] : null;
}

/**
 * Fields that decide vector geometry — and, since v3, the transport, because
 * it decides whether an oversize input could have been silently truncated.
 * Batch, timeout and price do not.
 */
export function profileFingerprint(p: EmbeddingProfile): string {
	const canonical = JSON.stringify([
		"andenken-embedding-profile-v3",
		p.transport,
		p.provider,
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

/**
 * The RUNTIME refused a request because an input exceeds its context window
 * (Ollama `/api/embed` with `truncate:false`). Permanent for that request: the
 * same text at the same runtime is refused again, so it is never retried. It
 * means the client-side bound above let through something the runtime counts
 * as longer — a bound to fix, not a transient. Carries the HTTP status only,
 * never the body text.
 */
export class EmbeddingRuntimeRefusedLength extends Error {
	readonly nonRetryable = true;
	readonly code = "runtime-input-exceeds-context";
	constructor(readonly status: number) {
		super(`runtime-input-exceeds-context: the runtime refused an oversize input (HTTP ${status})`);
		this.name = "EmbeddingRuntimeRefusedLength";
	}
}

/**
 * Does an error body from the runtime say "input longer than the context"?
 * Phrases read from the installed Ollama 0.32.3 binary (2026-11-26): "the input
 * length exceeds the context length", "input length (%d tokens) exceeds the
 * model's maximum context length (%d tokens)", "input exceeds maximum context
 * length and cannot be truncated further", "input after truncation exceeds
 * maximum context length". Matched on the `error` field of a JSON body, else on
 * the raw text.
 */
export function isContextLengthRefusal(bodyText: string): boolean {
	let msg = bodyText;
	try {
		const j = JSON.parse(bodyText) as { error?: unknown };
		if (j && typeof j.error === "string") msg = j.error;
	} catch {
		/* not JSON: use the raw text */
	}
	return /exceeds (the )?(model's )?(maximum )?context length/i.test(msg);
}

/** The native request body: no truncation, the profile's context, no dimensions knob. */
export function nativeEmbedBody(p: EmbeddingProfile, inputs: readonly string[]): Record<string, unknown> {
	return { model: p.model, input: [...inputs], truncate: false, options: { num_ctx: p.maxInputTokens } };
}

/**
 * Map an Ollama `/api/embed` reply (`{ model, embeddings: number[][],
 * prompt_eval_count }`) onto the shape `validateEmbeddingResponse` checks.
 * Native embeddings are positional (no index field), so position is the index;
 * count, dimension, finite, non-zero and model checks apply unchanged.
 */
export function nativeToValidatable(body: unknown): { model?: unknown; data?: unknown; usage?: { prompt_tokens?: unknown } } | unknown {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
	const b = body as { model?: unknown; embeddings?: unknown; prompt_eval_count?: unknown };
	return {
		...(b.model !== undefined ? { model: b.model } : {}),
		data: Array.isArray(b.embeddings) ? b.embeddings.map((embedding, index) => ({ index, embedding })) : undefined,
		usage: { prompt_tokens: b.prompt_eval_count },
	};
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
// Store stamp (v2: provider / revision / preprocess)
// ---------------------------------------------------------------------------

export const STAMP_FILE = "andenken-profile.json";
export const STAMP_KIND = "andenken-store-profile-v2";

/** Text preparation that shaped the stored vectors. */
export interface StampPreprocess {
	queryInstruction: string;
	documentInstruction: string;
	/** The split policy the writer used (null = the store's producer split, e.g. a harvest). */
	split: { target: number; maxCodepoints: number } | null;
	/**
	 * `false` when the writer's runtime was asked not to truncate (native
	 * transport): an oversize input could not have become a vector. Absent on a
	 * harvest and on stamps written before the field existed (same generation).
	 */
	truncate?: false;
}

/**
 * For a HARVEST store: what the producer (OpenClaw) says it embedded with, per
 * its own exported meta, and the per-agent revision last imported.
 */
export interface StampProducer {
	kind: "openclaw-harvest";
	model: string;
	provider: string;
	vectorDims: number;
	/** Per agent: OpenClaw's memory_index_state revision last imported (an index revision, not a model revision). */
	revisions: Record<string, string | number | null>;
	/** Per agent: OpenClaw's chunkingVersion last imported. */
	chunkingVersions?: Record<string, number | null>;
}

export interface StoreStamp {
	kind: typeof STAMP_KIND;
	profileId: string;
	fingerprint: string;
	provider: string;
	model: string;
	/** Runtime revision: the weight digest when the runtime exposes one. */
	digest: string | null;
	dimensions: number;
	preprocess: StampPreprocess;
	producer?: StampProducer;
	createdAt: string;
}

/**
 * The stamp lives INSIDE the LanceDB directory so every copy of the store
 * (rsync, backup, candidate promotion) carries it with the rows.
 */
export function stampPath(dbPath: string): string {
	return path.join(dbPath, STAMP_FILE);
}

export type StampRead = { state: "absent" } | { state: "ok"; stamp: StoreStamp } | { state: "invalid" };

const isStr = (v: unknown): v is string => typeof v === "string";

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
		const pre = s.preprocess as Partial<StampPreprocess> | undefined;
		const prod = s.producer as Partial<StampProducer> | undefined;
		if (
			s.kind !== STAMP_KIND ||
			!isStr(s.profileId) ||
			!isStr(s.fingerprint) ||
			!/^[0-9a-f]{64}$/.test(s.fingerprint) ||
			!isStr(s.provider) ||
			!isStr(s.model) ||
			!(s.digest === null || isStr(s.digest)) ||
			!Number.isInteger(s.dimensions) ||
			(s.dimensions as number) <= 0 ||
			!pre ||
			!isStr(pre.queryInstruction) ||
			!isStr(pre.documentInstruction) ||
			!(pre.split === null || (typeof pre.split === "object" && Number.isInteger(pre.split?.target) && Number.isInteger(pre.split?.maxCodepoints))) ||
			(pre.truncate !== undefined && pre.truncate !== false) ||
			(prod !== undefined &&
				(prod.kind !== "openclaw-harvest" || !isStr(prod.model) || !isStr(prod.provider) || prod.vectorDims !== s.dimensions || typeof prod.revisions !== "object" || prod.revisions === null))
		) {
			return { state: "invalid" };
		}
		return { state: "ok", stamp: s as StoreStamp };
	} catch {
		return { state: "invalid" };
	}
}

export function makeStamp(p: EmbeddingProfile, producer?: StampProducer, now: Date = new Date()): StoreStamp {
	const split = embedSplitFor(p);
	return {
		kind: STAMP_KIND,
		profileId: p.id,
		fingerprint: profileFingerprint(p),
		provider: p.provider,
		model: p.model,
		digest: p.digest,
		dimensions: p.dimensions,
		preprocess: {
			queryInstruction: p.queryInstruction,
			documentInstruction: p.documentInstruction,
			split: producer ? null : split ? { target: split.target, maxCodepoints: split.maxCodepoints } : null,
			...(!producer && p.transport === "ollama-native" ? { truncate: false as const } : {}),
		},
		...(producer ? { producer } : {}),
		createdAt: now.toISOString(),
	};
}

function writeJsonAtomic(file: string, value: unknown): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o644 });
	fs.renameSync(tmp, file);
}

/**
 * Stamp a store. Refuses to overwrite a stamp of a different profile, and
 * refuses to stamp a store that already holds rows without one — that would
 * launder an unknown generation into a known one. A harvest writer passes its
 * `producer`: model / provider / dims must match the existing stamp's, and the
 * per-agent revisions are merged. Atomic (tmp + rename). The directory must
 * already exist (a writer created it).
 */
export function writeStoreStamp(dbPath: string, p: EmbeddingProfile, rowsBefore: number, producer?: StampProducer): StoreStamp {
	const cur = readStoreStamp(dbPath);
	if (cur.state === "invalid") throw new StoreProfileRefused("store-stamp-invalid");
	if (cur.state === "ok") {
		if (cur.stamp.fingerprint !== profileFingerprint(p)) throw new StoreProfileRefused("store-profile-mismatch");
		if (!producer) return cur.stamp;
		const old = cur.stamp.producer;
		if (!old) throw new StoreProfileRefused("store-producer-missing");
		if (old.model !== producer.model || old.provider !== producer.provider || old.vectorDims !== producer.vectorDims) {
			throw new StoreProfileRefused("store-producer-mismatch");
		}
		const next: StoreStamp = {
			...cur.stamp,
			producer: {
				...old,
				revisions: { ...old.revisions, ...producer.revisions },
				chunkingVersions: { ...(old.chunkingVersions ?? {}), ...(producer.chunkingVersions ?? {}) },
			},
		};
		writeJsonAtomic(stampPath(dbPath), next);
		return next;
	}
	if (rowsBefore > 0) throw new StoreProfileRefused("store-unstamped-has-rows");
	if (!fs.existsSync(dbPath)) throw new StoreProfileRefused("store-dir-missing");
	const stamp = makeStamp(p, producer);
	writeJsonAtomic(stampPath(dbPath), stamp);
	return stamp;
}

export class StoreProfileRefused extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "StoreProfileRefused";
	}
}

// ---------------------------------------------------------------------------
// Query-compatibility attestation (human-made, query side only)
// ---------------------------------------------------------------------------

export const ATTEST_FILE = "andenken-query-attestation.json";
export const ATTEST_KIND = "andenken-query-attestation-v1";

/**
 * A human's recorded judgment that vectors of `queryProfile` may query a store
 * of another generation (e.g. local Ollama BGE-M3 queries against OpenRouter
 * BGE-M3 documents). Equal dimension is never this evidence: the attestation
 * names the exact store fingerprint, the exact query fingerprint and the
 * evidence refs (parity measurement, user acceptance). It lives in the store
 * directory, travels with it, and never applies to WRITES.
 */
export interface QueryAttestation {
	kind: typeof ATTEST_KIND;
	storeFingerprint: string;
	queryProfileId: string;
	queryFingerprint: string;
	evidence: string[];
	attestedBy: string;
	attestedAt: string;
}

export function attestationPath(dbPath: string): string {
	return path.join(dbPath, ATTEST_FILE);
}

export type AttestRead = { state: "absent" } | { state: "ok"; list: QueryAttestation[] } | { state: "invalid" };

export function readAttestations(dbPath: string): AttestRead {
	let raw: string;
	try {
		raw = fs.readFileSync(attestationPath(dbPath), "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "invalid" };
	}
	try {
		const list = JSON.parse(raw) as unknown;
		if (!Array.isArray(list)) return { state: "invalid" };
		for (const a of list as Partial<QueryAttestation>[]) {
			if (
				a?.kind !== ATTEST_KIND ||
				!isStr(a.storeFingerprint) ||
				!isStr(a.queryProfileId) ||
				!isStr(a.queryFingerprint) ||
				!Array.isArray(a.evidence) ||
				a.evidence.length === 0 ||
				!a.evidence.every((x) => isStr(x) && x.trim().length > 0) ||
				!isStr(a.attestedBy) ||
				a.attestedBy.trim().length === 0 ||
				!isStr(a.attestedAt)
			) {
				return { state: "invalid" };
			}
		}
		return { state: "ok", list: list as QueryAttestation[] };
	} catch {
		return { state: "invalid" };
	}
}

/**
 * Record an attestation (the explicit human step). Requires a valid stamp, a
 * query profile of the same dimension but another fingerprint, at least one
 * evidence ref and a named attester. Idempotent per (store, query) pair.
 */
export function writeAttestation(
	dbPath: string,
	query: EmbeddingProfile,
	evidence: string[],
	attestedBy: string,
	now: Date = new Date(),
): QueryAttestation {
	const st = readStoreStamp(dbPath);
	if (st.state !== "ok") throw new StoreProfileRefused(st.state === "absent" ? "store-unstamped" : "store-stamp-invalid");
	if (st.stamp.dimensions !== query.dimensions) throw new StoreProfileRefused("store-dimension-mismatch");
	const qf = profileFingerprint(query);
	if (qf === st.stamp.fingerprint) throw new StoreProfileRefused("attestation-not-needed-same-generation");
	const ev = evidence.map((e) => e.trim()).filter((e) => e.length > 0);
	if (ev.length === 0) throw new StoreProfileRefused("attestation-evidence-required");
	if (attestedBy.trim().length === 0) throw new StoreProfileRefused("attestation-attester-required");
	const cur = readAttestations(dbPath);
	if (cur.state === "invalid") throw new StoreProfileRefused("attestation-invalid");
	const list = (cur.state === "ok" ? cur.list : []).filter(
		(a) => !(a.storeFingerprint === st.stamp.fingerprint && a.queryFingerprint === qf),
	);
	const rec: QueryAttestation = {
		kind: ATTEST_KIND,
		storeFingerprint: st.stamp.fingerprint,
		queryProfileId: query.id,
		queryFingerprint: qf,
		evidence: ev,
		attestedBy: attestedBy.trim(),
		attestedAt: now.toISOString(),
	};
	writeJsonAtomic(attestationPath(dbPath), [...list, rec]);
	return rec;
}

// ---------------------------------------------------------------------------
// Access decision
// ---------------------------------------------------------------------------

export type StoreProfileDecision =
	| { ok: true; basis: "stamp" | "attested" | "empty-store" }
	| { ok: false; code: string };

/**
 * May vectors of profile `p` be written to (`write`) or queried against
 * (`query`) this store? There is no legacy and no inference:
 *
 *   p null (unprofiled provider)   → refuse
 *   stamp invalid / attestation file invalid → refuse
 *   stored dim ≠ p dim             → refuse
 *   stamp, same fingerprint        → ok
 *   stamp, other fingerprint       → query only, and only with a matching
 *                                    attestation; writes always refuse
 *   no stamp, no rows / no store   → ok (a writer stamps it on creation)
 *   no stamp, rows                 → refuse: an unknown generation
 */
export function decideStoreAccess(
	dbPath: string,
	p: EmbeddingProfile | null,
	rows: number,
	storedDim: number | null,
	access: "write" | "query" = "write",
): StoreProfileDecision {
	if (!p) return { ok: false, code: "unprofiled-provider" };
	const s = readStoreStamp(dbPath);
	if (s.state === "invalid") return { ok: false, code: "store-stamp-invalid" };
	if (storedDim !== null && storedDim !== p.dimensions) return { ok: false, code: "store-dimension-mismatch" };
	if (s.state === "ok") {
		if (s.stamp.dimensions !== p.dimensions) return { ok: false, code: "store-dimension-mismatch" };
		if (s.stamp.fingerprint === profileFingerprint(p)) return { ok: true, basis: "stamp" };
		if (access === "query") {
			const a = readAttestations(dbPath);
			if (a.state === "invalid") return { ok: false, code: "attestation-invalid" };
			const qf = profileFingerprint(p);
			if (a.state === "ok" && a.list.some((x) => x.storeFingerprint === s.stamp.fingerprint && x.queryFingerprint === qf)) {
				return { ok: true, basis: "attested" };
			}
			return { ok: false, code: "query-generation-not-attested" };
		}
		return { ok: false, code: "store-profile-mismatch" };
	}
	if (rows === 0) return { ok: true, basis: "empty-store" };
	return { ok: false, code: "store-unstamped" };
}

/** Write-side shorthand (candidate build / resume). */
export function decideStoreProfile(
	dbPath: string,
	p: EmbeddingProfile,
	rows: number,
	storedDim: number | null,
): StoreProfileDecision {
	return decideStoreAccess(dbPath, p, rows, storedDim, "write");
}

/** The profile a provider speaks for: its explicit one, nothing inferred. */
export function profileOfProvider(provider: { readonly profile?: EmbeddingProfile }): EmbeddingProfile | null {
	return provider.profile ?? null;
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
// Writer rule
// ---------------------------------------------------------------------------

/**
 * Refusal code for an EMBEDDING WRITE (index / sync / durable / md /
 * /memory reindex) by `provider`, or null when it may write: only a provider
 * built from a known profile writes. Nothing is inferred from a model string.
 */
export function writerRefusal(provider: { readonly profile?: EmbeddingProfile }): string | null {
	return provider.profile ? null : "unprofiled-writer: set ANDENKEN_<NS>_PROFILE to a known generation";
}
