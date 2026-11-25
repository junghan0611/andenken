/**
 * embedding-profile.test.ts — SYNTHETIC suite (API 0) for the embedding
 * generation contract: profile identity, response validation, input-length
 * fail-closed, Ollama digest check, namespaced env refusal, store stamps and
 * same-dimension mixing refusal on a real (temp) LanceDB.
 *
 * fetch is replaced by a stub that throws unless a test routes it; HOME and
 * ANDENKEN_DATA point at fresh temp dirs; credential-shaped env is removed.
 * No runtime is started and no network is reached.
 *
 *   ./run.sh test:profile
 */

import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-profile-test-"));
process.env.HOME = path.join(TMP, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.ANDENKEN_DATA = path.join(TMP, "data");
for (const k of Object.keys(process.env)) {
	if (/KEY|TOKEN|SECRET|PASSWORD|^ANDENKEN_(SESSION|MD|ORG|OPENCLAW|VLLM)_/.test(k)) delete process.env[k];
}

const {
	PROFILES,
	EmbeddingInputTooLong,
	EmbeddingResponseInvalid,
	EmbeddingRuntimeRefusedLength,
	StoreProfileRefused,
	isContextLengthRefusal,
	assertInputsFit,
	decideStoreAccess,
	getProfile,
	lengthPlan,
	maxInputCodepoints,
	profileFingerprint,
	profileOfProvider,
	readStoreStamp,
	stampPath,
	validateEmbeddingResponse,
	verifyRuntimeIdentity,
	writeStoreStamp,
	writeAttestation,
	readAttestations,
	attestationPath,
} = await import("./embedding-profile.ts");
type EmbeddingProfile = import("./embedding-profile.ts").EmbeddingProfile;
const { VLLMProvider, createSessionProviderFromEnv, createMdProviderFromEnv, createOpenclawQueryProviderFromEnv } =
	await import("./embedding-provider.ts");
const { VectorStore } = await import("./store.ts");

// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const tests: Array<[string, () => unknown | Promise<unknown>]> = [];
const test = (name: string, fn: () => unknown | Promise<unknown>) => tests.push([name, fn]);

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let route: Route | null = null;
let fetchCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	fetchCalls++;
	if (!route) throw new Error("unplanned fetch in API-0 suite");
	return route(String(input), init);
}) as typeof fetch;
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const BGE = PROFILES["ollama-bge-m3-1024"];
const OR_BGE = PROFILES["openrouter-bge-m3-1024"];
/** Small-dimension twins so the LanceDB tests stay tiny. */
const tiny = (base: EmbeddingProfile, id: string, extra: Partial<EmbeddingProfile> = {}): EmbeddingProfile => ({
	...base,
	id,
	dimensions: 4,
	...extra,
});
const vec = (seed: number, dim: number) => Array.from({ length: dim }, (_, i) => ((seed * 31 + i * 7) % 13) + 1);
const okBody = (n: number, dim: number, model?: string, reorder = true) => {
	const data = Array.from({ length: n }, (_, index) => ({ index, embedding: vec(index, dim) }));
	return { ...(model ? { model } : {}), data: reorder ? data.reverse() : data };
};
/** Ollama `/api/embed` reply: positional `embeddings`, `prompt_eval_count`. */
const nativeBody = (n: number, dim: number, model?: string) => ({
	...(model ? { model } : {}),
	embeddings: Array.from({ length: n }, (_, i) => vec(i, dim)),
	prompt_eval_count: n * 3,
});

// ---------------------------------------------------------------------------
// P — profiles
// ---------------------------------------------------------------------------

test("P1 the runtime contract is encoded exactly (model, digest, loopback, ctx, batch, timeout)", () => {
	strictEqual(BGE.model, "bge-m3:latest");
	strictEqual(BGE.digest, "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab");
	strictEqual(BGE.endpoint, "http://127.0.0.1:11435");
	deepStrictEqual([BGE.dimensions, BGE.maxInputTokens, BGE.maxBatchSize, BGE.timeoutMs], [1024, 2048, 4, 30_000]);
	strictEqual(BGE.paidRemote, false);
	deepStrictEqual(Object.keys(PROFILES).sort(), ["ollama-bge-m3-1024", "openrouter-bge-m3-1024"], "no Qwen / 4096 generation is known");
	strictEqual(BGE.provider, "ollama");
	strictEqual(OR_BGE.provider, "openrouter");
	strictEqual(getProfile("nope"), null);
	strictEqual(getProfile("__proto__"), null);
});

test("P2 same family and dimension, different runtime → different fingerprint", () => {
	strictEqual(BGE.dimensions, OR_BGE.dimensions);
	ok(profileFingerprint(BGE) !== profileFingerprint(OR_BGE));
	ok(profileFingerprint(BGE) !== profileFingerprint({ ...BGE, digest: "0".repeat(64) }));
	ok(profileFingerprint(BGE) !== profileFingerprint({ ...BGE, queryInstruction: "q: " }));
	strictEqual(profileFingerprint(BGE), profileFingerprint({ ...BGE, maxBatchSize: 1, timeoutMs: 5 }));
});

// ---------------------------------------------------------------------------
// R — response validation
// ---------------------------------------------------------------------------

test("R1 reordered reply → input order", () => {
	const out = validateEmbeddingResponse(okBody(3, 4), 3, 4);
	deepStrictEqual(out, [vec(0, 4), vec(1, 4), vec(2, 4)]);
});

test("R2 every malformed shape is refused by code", () => {
	const code = (body: unknown, n = 2, dim = 4, model?: string) => {
		try {
			validateEmbeddingResponse(body, n, dim, model);
			return "accepted";
		} catch (e) {
			ok(e instanceof EmbeddingResponseInvalid);
			strictEqual((e as { nonRetryable?: boolean }).nonRetryable, true);
			return (e as InstanceType<typeof EmbeddingResponseInvalid>).code;
		}
	};
	const good = okBody(2, 4, undefined, false);
	strictEqual(code(null), "response-not-object");
	strictEqual(code([]), "response-not-object");
	strictEqual(code({}), "data-not-array");
	strictEqual(code({ data: [good.data[0]] }), "count-mismatch");
	strictEqual(code({ data: [...good.data, good.data[0]] }), "count-mismatch");
	strictEqual(code({ data: [{ embedding: vec(0, 4) }, good.data[1]] }), "index-invalid");
	strictEqual(code({ data: [{ index: 2, embedding: vec(0, 4) }, good.data[1]] }), "index-invalid");
	strictEqual(code({ data: [{ index: 0.5, embedding: vec(0, 4) }, good.data[1]] }), "index-invalid");
	strictEqual(code({ data: [good.data[1], good.data[1]] }), "index-duplicate");
	strictEqual(code({ data: [{ index: 0, embedding: "x" }, good.data[1]] }), "embedding-not-array");
	strictEqual(code({ data: [{ index: 0, embedding: vec(0, 3) }, good.data[1]] }), "dimension-mismatch");
	strictEqual(code({ data: [{ index: 0, embedding: [1, 2, NaN, 4] }, good.data[1]] }), "non-finite");
	strictEqual(code({ data: [{ index: 0, embedding: [1, 2, "3", 4] }, good.data[1]] }), "non-finite");
	strictEqual(code({ data: [{ index: 0, embedding: [0, 0, 0, 0] }, good.data[1]] }), "zero-vector");
	strictEqual(code({ data: [{ index: 0, embedding: [1e200, 1e200, 1, 1] }, good.data[1]] }), "zero-vector");
	strictEqual(code(good, 2, 0), "dimension-unknown");
	strictEqual(code({ ...good, model: "other" }, 2, 4, "bge-m3:latest"), "model-mismatch");
	strictEqual(code({ ...good, model: "bge-m3:latest" }, 2, 4, "bge-m3:latest"), "accepted");
	strictEqual(code(good, 2, 4, "bge-m3:latest"), "accepted"); // reply that names no model
});

// ---------------------------------------------------------------------------
// L — input length (silent truncation is refused before any request)
// ---------------------------------------------------------------------------

test("L1 bound = ctx − overhead − instruction; NFKC expansion counted", () => {
	strictEqual(maxInputCodepoints(BGE, "document"), 2048 - 3);
	strictEqual(maxInputCodepoints({ ...BGE, tokenOverhead: null }, "document"), null);
	const limit = 2045;
	assertInputsFit(BGE, "document", ["가".repeat(limit)]);
	throws(() => assertInputsFit(BGE, "document", ["a", "가".repeat(limit + 1)]), (e: unknown) => {
		ok(e instanceof EmbeddingInputTooLong);
		deepStrictEqual([e.inputIndex, e.codepoints, e.limit], [1, limit + 1, limit]);
		return true;
	});
	// "ﬃ" (1 code point) is "ffi" (3) after NFKC — counted as 3.
	throws(() => assertInputsFit(BGE, "document", ["ﬃ".repeat(700)]), EmbeddingInputTooLong);
	const plan = lengthPlan(BGE, "document", ["x", "y".repeat(3000), "z".repeat(2045)]);
	deepStrictEqual(plan, { limit: 2045, total: 3, over: 1, maxCodepoints: 3000 });
	// A profile with no proven bound is not enforced by code points.
	assertInputsFit({ ...BGE, tokenOverhead: null }, "document", ["y".repeat(100_000)]);
});

test("L2 provider with a profile refuses an oversize input with ZERO requests", async () => {
	const p = new VLLMProvider({ endpoint: BGE.endpoint!, model: BGE.model, dimensions: 1024, profile: BGE });
	fetchCalls = 0;
	await rejects(p.embedDocumentBatch(["ok", "x".repeat(5000)]), EmbeddingInputTooLong);
	await rejects(p.embedQuery("x".repeat(5000)), EmbeddingInputTooLong);
	strictEqual(fetchCalls, 0);
	strictEqual(p.getStats().httpAttempts, 0);
});

// ---------------------------------------------------------------------------
// V — provider validates every reply; invalid replies are not retried
// ---------------------------------------------------------------------------

test("V1 profile provider: batch ≤ 4, order kept, wrong model/dim refused after ONE attempt", async () => {
	const p = new VLLMProvider({ endpoint: BGE.endpoint!, model: BGE.model, dimensions: 1024, maxBatchSize: 4, profile: BGE });
	const sizes: number[] = [];
	const tagsOk = () => json({ models: [{ name: "bge-m3:latest", digest: BGE.digest }] });
	route = (url, init) => {
		if (url.endsWith("/api/tags")) return tagsOk();
		strictEqual(url, "http://127.0.0.1:11435/api/embed", "native transport, not /v1");
		const body = JSON.parse(String(init?.body)) as { model: string; input: string[]; dimensions?: number; truncate?: unknown; options?: { num_ctx?: unknown } };
		strictEqual(body.model, "bge-m3:latest");
		strictEqual(body.dimensions, undefined);
		strictEqual(body.truncate, false, "the runtime is told never to truncate");
		strictEqual(body.options?.num_ctx, 2048, "explicit context = profile window");
		sizes.push(body.input.length);
		return json(nativeBody(body.input.length, 1024, "bge-m3:latest"));
	};
	const out = await p.embedDocumentBatch(["a", "b", "c", "d", "e", "f"]);
	deepStrictEqual(sizes, [4, 2]);
	strictEqual(out.length, 6);
	deepStrictEqual(out[5], vec(1, 1024));
	strictEqual(p.getStats().reportedPromptTokens, 18, "prompt_eval_count is the reported usage");

	for (const bad of [nativeBody(1, 1024, "bge-m3:other"), nativeBody(1, 1023, "bge-m3:latest"), { embeddings: [] }, { data: okBody(1, 1024).data }, nativeBody(2, 1024, "bge-m3:latest")]) {
		fetchCalls = 0;
		route = () => json(bad);
		await rejects(p.embedQuery("q"), EmbeddingResponseInvalid);
		strictEqual(fetchCalls, 1, "identity already proven in this process; one embedding attempt, no retry");
	}
	route = null;
});

test("V3 digest-pinned provider proves runtime identity before its FIRST request; failure is permanent", async () => {
	const mk = () => new VLLMProvider({ endpoint: "http://127.0.0.1:40123", model: BGE.model, dimensions: 1024, profile: BGE });
	const seen: string[] = [];
	route = (url) => {
		seen.push(new URL(url).pathname);
		return url.endsWith("/api/tags") ? json({ models: [{ name: "bge-m3:latest", digest: "0".repeat(64) }] }) : json(nativeBody(1, 1024, "bge-m3:latest"));
	};
	const bad = mk();
	await rejects(bad.embedQuery("q"), (e: unknown) => (e as { code?: string }).code === "runtime-identity-digest-mismatch");
	await rejects(bad.embedDocumentBatch(["a"]), (e: unknown) => (e as { code?: string }).code === "runtime-identity-digest-mismatch");
	deepStrictEqual(seen, ["/api/tags"], "no embedding request after a failed identity; identity asked once");
	seen.length = 0;
	route = (url) => {
		seen.push(new URL(url).pathname);
		return url.endsWith("/api/tags") ? json({ models: [{ name: "bge-m3:latest", digest: BGE.digest }] }) : json(nativeBody(1, 1024, "bge-m3:latest"));
	};
	const good = mk();
	await good.embedQuery("q");
	await good.embedQuery("r");
	deepStrictEqual(seen, ["/api/tags", "/api/embed", "/api/embed"]);
	route = null;
});

// ---------------------------------------------------------------------------
// N — native transport: no truncation, runtime oversize refusal is permanent
// ---------------------------------------------------------------------------

test("N1 runtime oversize refusal (any status) → EmbeddingRuntimeRefusedLength after ONE attempt; body text never in the error", async () => {
	const p = new VLLMProvider({ endpoint: BGE.endpoint!, model: BGE.model, dimensions: 1024, profile: BGE });
	route = (url) => (url.endsWith("/api/tags") ? json({ models: [{ name: "bge-m3:latest", digest: BGE.digest }] }) : json(nativeBody(1, 1024, "bge-m3:latest")));
	await p.embedQuery("warm"); // identity proven once
	const bodies: Array<[number, string]> = [
		[400, "the input length exceeds the context length"],
		[500, "input length (2101 tokens) exceeds the model's maximum context length (2048 tokens)"],
		[400, "input exceeds maximum context length and cannot be truncated further"],
		[500, "input after truncation exceeds maximum context length"],
	];
	for (const [status, error] of bodies) {
		fetchCalls = 0;
		route = () => json({ error: `${error} SECRETMARK` }, status);
		await rejects(p.embedDocumentBatch(["a"]), (e: unknown) => {
			ok(e instanceof EmbeddingRuntimeRefusedLength, String(e));
			strictEqual((e as { code?: string }).code, "runtime-input-exceeds-context");
			strictEqual((e as { status?: number }).status, status);
			ok(!String((e as Error).message).includes("SECRETMARK"), "no body text in the message");
			return true;
		});
		strictEqual(fetchCalls, 1, `HTTP ${status}: no retry (a 5xx oversize is not transient)`);
	}
	// Another 400 is NOT an oversize refusal; another 5xx keeps the transport retry.
	fetchCalls = 0;
	route = () => json({ error: "model not found" }, 400);
	await rejects(p.embedQuery("q"), (e: unknown) => !(e instanceof EmbeddingRuntimeRefusedLength) && (e as { status?: number }).status === 400);
	strictEqual(fetchCalls, 1);
	route = null;
});

test("N2 isContextLengthRefusal: JSON error field or raw text; unrelated errors are not oversize", () => {
	ok(isContextLengthRefusal(JSON.stringify({ error: "the input length exceeds the context length" })));
	ok(isContextLengthRefusal("input length (9 tokens) exceeds the model's maximum context length (8 tokens)"));
	ok(!isContextLengthRefusal(JSON.stringify({ error: "model 'x' not found" })));
	ok(!isContextLengthRefusal(""));
});

test("N3 native transport is loopback-only even when constructed by hand; zero requests", async () => {
	const p = new VLLMProvider({ endpoint: "http://stub.invalid:11435", model: BGE.model, dimensions: 1024, profile: { ...BGE, digest: null } });
	fetchCalls = 0;
	route = () => json(nativeBody(1, 1024, "bge-m3:latest"));
	await rejects(p.embedQuery("q"), (e: unknown) => (e as { code?: string }).code === "native-transport-not-loopback");
	strictEqual(fetchCalls, 0);
	// The hosted profile keeps the OpenAI-compatible transport.
	strictEqual(OR_BGE.transport, "openai-v1");
	strictEqual(BGE.transport, "ollama-native");
	route = null;
});

test("N4 transport is part of the generation: a /v1 store is refused for native writes and queries; native → native stays", async () => {
	ok(profileFingerprint(BGE) !== profileFingerprint({ ...BGE, transport: "openai-v1" }), "v1 and native never share a fingerprint");
	// A store written by the /v1-era twin of the same weights.
	const V1 = { ...A, transport: "openai-v1" as const };
	const db = newDb();
	const w = new VectorStore(db, 4, { profile: V1 });
	await w.ensureTable();
	await w.addChunks([row(1)]);
	await w.close();
	deepStrictEqual(decideStoreAccess(db, A, 1, 4, "write"), { ok: false, code: "store-profile-mismatch" });
	deepStrictEqual(decideStoreAccess(db, A, 1, 4, "query"), { ok: false, code: "query-generation-not-attested" }, "a /v1 store is another generation: only a human attestation could open it for queries");
	const nw = new VectorStore(db, 4, { profile: A });
	await nw.init();
	await rejects(nw.assertCompatibleDim(), (e: unknown) => e instanceof StoreProfileRefused && e.code === "store-profile-mismatch");
	await rejects(nw.reset(), StoreProfileRefused);
	await nw.close();
	// native → native: same pin, the store keeps growing.
	const ndb = newDb();
	const n1 = new VectorStore(ndb, 4, { profile: A });
	await n1.ensureTable();
	await n1.addChunks([row(1)]);
	await n1.close();
	const n2 = new VectorStore(ndb, 4, { profile: A });
	await n2.init();
	await n2.assertCompatibleDim();
	await n2.addChunks([row(2)]);
	strictEqual(await n2.getCount(), 2);
	await n2.close();
	const st = JSON.parse(fs.readFileSync(stampPath(ndb), "utf-8"));
	strictEqual(st.preprocess.truncate, false);
	st.preprocess.truncate = true;
	fs.writeFileSync(stampPath(ndb), JSON.stringify(st));
	strictEqual(readStoreStamp(ndb).state, "invalid", "truncate: true can never be recorded");
});

test("V2 legacy auto-detect provider still validates the whole reply against the first vector", async () => {
	const p = new VLLMProvider({ endpoint: "http://stub.invalid", model: "m" });
	route = () => json({ data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [1, 2] }] });
	await rejects(p.embedDocumentBatch(["a", "b"]), EmbeddingResponseInvalid);
	strictEqual(p.dimensions, 0); // not learned from a reply that failed
	route = () => json({ data: [{ index: 1, embedding: [4, 5, 6] }, { index: 0, embedding: [1, 2, 3] }] });
	deepStrictEqual(await p.embedDocumentBatch(["a", "b"]), [[1, 2, 3], [4, 5, 6]]);
	strictEqual(p.dimensions, 3);
	route = null;
});

// ---------------------------------------------------------------------------
// E — namespaced env: missing dims refused, profile conflicts refused
// ---------------------------------------------------------------------------

function withEnv(vars: Record<string, string>, fn: () => void) {
	const keys = Object.keys(vars);
	Object.assign(process.env, vars);
	try {
		fn();
	} finally {
		for (const k of keys) delete process.env[k];
	}
}
const quiet = <T>(fn: () => T): T => {
	const w = process.stderr.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return fn();
	} finally {
		process.stderr.write = w;
	}
};

test("E1 no PROFILE builds nothing: model strings, dimensions, presets and Gemini are gone", () => {
	const base = { ANDENKEN_SESSION_PROVIDER: "vllm", ANDENKEN_SESSION_ENDPOINT: "http://127.0.0.1:11435" };
	withEnv({ ...base, ANDENKEN_SESSION_MODEL: "bge-m3:latest", ANDENKEN_SESSION_DIMENSIONS: "1024" }, () =>
		strictEqual(quiet(createSessionProviderFromEnv), null, "a model string is not a generation"),
	);
	withEnv({ ANDENKEN_MD_PROVIDER: "openrouter", ANDENKEN_MD_ENDPOINT: "https://x.invalid", ANDENKEN_MD_MODEL: "qwen/qwen3-embedding-8b", ANDENKEN_MD_DIMENSIONS: "4096" }, () =>
		strictEqual(quiet(createMdProviderFromEnv), null, "the Qwen env lines build nothing"),
	);
	withEnv({ ANDENKEN_MD_PROVIDER: "gemini" }, () => strictEqual(quiet(createMdProviderFromEnv), null));
	for (const id of ["openrouter-qwen3-8b-4096", "openrouter-bge-m3-1024"]) {
		withEnv({ ANDENKEN_SESSION_PROFILE: id }, () => strictEqual(quiet(createSessionProviderFromEnv), null, `${id} is not a buildable generation here`));
	}
	strictEqual(createSessionProviderFromEnv(), null, "absent namespace → null");
});

test("E2 PROFILE builds the profile; conflicting geometry keys are refusals, not overrides", () => {
	const ns = (extra: Record<string, string> = {}) => ({ ANDENKEN_SESSION_PROVIDER: "vllm", ANDENKEN_SESSION_PROFILE: "ollama-bge-m3-1024", ...extra });
	withEnv(ns(), () => {
		const p = quiet(createSessionProviderFromEnv) as InstanceType<typeof VLLMProvider>;
		ok(p);
		strictEqual(p.profile?.id, "ollama-bge-m3-1024");
		deepStrictEqual([p.dimensions, p.configuredMaxBatchSize, p.isPaidRemote, p.model], [1024, 4, false, "bge-m3:latest"]);
	});
	withEnv(ns({ ANDENKEN_SESSION_ENDPOINT: "http://127.0.0.1:40123" }), () =>
		ok(quiet(createSessionProviderFromEnv), "any loopback port: identity is proven by digest, not by port"),
	);
	withEnv(ns({ ANDENKEN_SESSION_MAX_BATCH_SIZE: "2", ANDENKEN_SESSION_ENDPOINT: "http://127.0.0.1:11435/" }), () =>
		strictEqual((quiet(createSessionProviderFromEnv) as InstanceType<typeof VLLMProvider>).configuredMaxBatchSize, 2),
	);
	const refused: Record<string, string>[] = [
		{ ANDENKEN_SESSION_PROFILE: "unknown-profile" },
		{ ANDENKEN_SESSION_MODEL: "baai/bge-m3" },
		{ ANDENKEN_SESSION_DIMENSIONS: "4096" },
		{ ANDENKEN_SESSION_DIMENSIONS: "1024.0" },
		{ ANDENKEN_SESSION_QUERY_INSTRUCTION: "query: " },
		{ ANDENKEN_SESSION_ENDPOINT: "http://10.0.0.5:11435" },
		{ ANDENKEN_SESSION_PAID_REMOTE: "1" },
		{ ANDENKEN_SESSION_MAX_BATCH_SIZE: "8" },
		{ ANDENKEN_SESSION_TIMEOUT_MS: "60000" },
	];
	for (const extra of refused) {
		withEnv(ns(extra), () => strictEqual(quiet(createSessionProviderFromEnv), null, JSON.stringify(extra)));
	}
	withEnv(ns({ ANDENKEN_SESSION_MODEL: "bge-m3:latest", ANDENKEN_SESSION_DIMENSIONS: "1024" }), () =>
		ok(quiet(createSessionProviderFromEnv), "agreeing keys are allowed"),
	);
});

test("E3 OpenClaw query namespace is separate from sessions and refuses a broken config", () => {
	strictEqual(createOpenclawQueryProviderFromEnv(), null);
	withEnv({ ANDENKEN_OPENCLAW_QUERY_PROVIDER: "gemini" }, () => throws(() => quiet(createOpenclawQueryProviderFromEnv)));
	withEnv({ ANDENKEN_OPENCLAW_QUERY_PROFILE: "openrouter-bge-m3-1024" }, () =>
		throws(() => quiet(createOpenclawQueryProviderFromEnv), "no paid OpenRouter query path"),
	);
	withEnv({ ANDENKEN_OPENCLAW_QUERY_PROFILE: "ollama-bge-m3-1024", ANDENKEN_OPENCLAW_QUERY_ENDPOINT: "http://127.0.0.1:40123" }, () =>
		strictEqual(profileOfProvider(quiet(createOpenclawQueryProviderFromEnv)!)?.id, "ollama-bge-m3-1024"),
	);
});

// ---------------------------------------------------------------------------
// D — runtime digest (Ollama /api/tags)
// ---------------------------------------------------------------------------

test("D1 digest check: ok / mismatch / absent / unreachable / not loopback / no digest surface", async () => {
	const tags = (digest: string, name = "bge-m3:latest") => () => json({ models: [{ name: "other:latest", digest: "f".repeat(64) }, { name, model: name, digest }] });
	route = tags(BGE.digest!);
	deepStrictEqual(await verifyRuntimeIdentity(BGE, "http://127.0.0.1:11435"), { ok: true, digest: BGE.digest });
	route = tags(`sha256:${BGE.digest}`);
	strictEqual((await verifyRuntimeIdentity(BGE, "http://127.0.0.1:11435/")).ok, true);
	route = tags("0".repeat(64));
	deepStrictEqual(await verifyRuntimeIdentity(BGE, "http://127.0.0.1:11435"), { ok: false, code: "digest-mismatch" });
	route = tags(BGE.digest!, "bge-m3:567m");
	deepStrictEqual(await verifyRuntimeIdentity(BGE, "http://127.0.0.1:11435"), { ok: false, code: "model-absent" });
	route = () => json({ nope: 1 });
	deepStrictEqual(await verifyRuntimeIdentity(BGE, "http://127.0.0.1:11435"), { ok: false, code: "runtime-bad-response" });
	route = () => {
		throw new TypeError("fetch failed");
	};
	deepStrictEqual(await verifyRuntimeIdentity(BGE, "http://127.0.0.1:11435"), { ok: false, code: "runtime-unreachable" });
	fetchCalls = 0;
	deepStrictEqual(await verifyRuntimeIdentity(BGE, "http://192.168.0.2:11435"), { ok: false, code: "endpoint-not-loopback" });
	deepStrictEqual(await verifyRuntimeIdentity(OR_BGE, "https://openrouter.ai/api"), { ok: false, code: "no-digest-surface" });
	strictEqual(fetchCalls, 0);
	route = null;
});

// ---------------------------------------------------------------------------
// S — store stamp + generation guard on a real temp LanceDB
// ---------------------------------------------------------------------------

const A = tiny(BGE, "t-ollama-a");
const B = tiny(OR_BGE, "t-hosted-b"); // same dim, different generation
let dbN = 0;
const newDb = () => path.join(TMP, `db-${++dbN}.lance`);
const row = (i: number, dim = 4) => ({
	id: `r${i}`,
	text: `t${i}`,
	vector: vec(i, dim),
	sessionFile: `/f${i}`,
	project: "p",
	lineNumber: i,
	timestamp: "2026-11-25T00:00:00Z",
	role: "user",
	metadata: {},
});

test("S1 a profiled writer stamps the new store inside its directory; same profile reopens and appends", async () => {
	const db = newDb();
	const w = new VectorStore(db, 4, { profile: A });
	await w.init();
	await w.ensureTable();
	await w.assertCompatibleDim();
	await w.addChunks([row(1)]);
	const st = readStoreStamp(db);
	strictEqual(st.state, "ok");
	if (st.state === "ok") deepStrictEqual([st.stamp.profileId, st.stamp.fingerprint, st.stamp.dimensions], ["t-ollama-a", profileFingerprint(A), 4]);
	ok(stampPath(db).startsWith(db + path.sep));
	await w.close();
	// resume: a fresh process of the same generation continues
	const w2 = new VectorStore(db, 4, { profile: A });
	await w2.init();
	await w2.ensureTable();
	await w2.assertCompatibleDim();
	await w2.addChunks([row(2)]);
	strictEqual(await w2.getCount(), 2);
	await w2.close();
});

test("S2 same-dimension different generation: write, reset and query all refused; rows untouched", async () => {
	const db = newDb();
	const w = new VectorStore(db, 4, { profile: A });
	await w.ensureTable();
	await w.addChunks([row(1), row(2)].map((r) => ({ ...r, sessionFile: "/f" })));
	await w.close();

	const other = new VectorStore(db, 4, { profile: B });
	await other.init();
	await rejects(other.assertCompatibleDim(), (e: unknown) => e instanceof StoreProfileRefused && e.code === "store-profile-mismatch");
	await rejects(other.reset(), (e: unknown) => e instanceof StoreProfileRefused && e.code === "store-profile-mismatch");
	deepStrictEqual(await other.checkProfile("write"), { ok: false, code: "store-profile-mismatch" });
	const reader = new VectorStore(db, 4, { readOnly: true, profile: B });
	await reader.init();
	deepStrictEqual(await reader.checkProfile("query"), { ok: false, code: "query-generation-not-attested" });
	const unprofiled = new VectorStore(db, 4, { profile: null });
	await unprofiled.init();
	deepStrictEqual(await unprofiled.checkProfile(), { ok: false, code: "unprofiled-provider" });
	const silent = new VectorStore(db, 4, { readOnly: true });
	await silent.init();
	deepStrictEqual(await silent.checkProfile(), { ok: false, code: "no-profile-given" });
	await rejects(unprofiled.reset(), StoreProfileRefused);
	const check = new VectorStore(db, 4, { readOnly: true });
	await check.init();
	strictEqual(await check.getCount(), 2, "refused reset dropped nothing");
	strictEqual(readStoreStamp(db).state === "ok" && (readStoreStamp(db) as { stamp: { profileId: string } }).stamp.profileId, "t-ollama-a");
});

test("S3 unstamped non-empty store: an unknown generation for everyone, never stamped retroactively", async () => {
	const db = newDb();
	const preStamp = new VectorStore(db, 4); // a writer that names no generation
	await preStamp.ensureTable();
	await preStamp.addChunks([row(1)]);
	await preStamp.close();
	strictEqual(readStoreStamp(db).state, "absent");
	for (const p of [A, B]) {
		const s = new VectorStore(db, 4, { profile: p });
		await s.init();
		deepStrictEqual(await s.checkProfile("query"), { ok: false, code: "store-unstamped" });
		deepStrictEqual(await s.checkProfile("write"), { ok: false, code: "store-unstamped" });
		await rejects(s.reset(), StoreProfileRefused, "a generation cannot --force over an unknown store");
		strictEqual(await s.getCount(), 1);
	}
	throws(() => writeStoreStamp(db, A, 1), (e: unknown) => e instanceof StoreProfileRefused && e.code === "store-unstamped-has-rows");
});

test("S6 dimension unknown: a table is never created without a dimension", async () => {
	const s = new VectorStore(newDb());
	await rejects(s.ensureTable(), (e: unknown) => e instanceof StoreProfileRefused && e.code === "store-dimension-unknown");
});

test("S7 query attestation: names exact store + query fingerprints and evidence; query-only; invalid file refuses", async () => {
	const db = newDb();
	const w = new VectorStore(db, 4, { profile: B }); // documents of the hosted generation
	await w.ensureTable();
	await w.addChunks([row(1)]);
	await w.close();
	deepStrictEqual(decideStoreAccess(db, A, 1, 4, "query"), { ok: false, code: "query-generation-not-attested" });
	throws(() => writeAttestation(db, A, [], "glg"), (e: unknown) => (e as { code?: string }).code === "attestation-evidence-required");
	throws(() => writeAttestation(db, A, ["receipt"], " "), (e: unknown) => (e as { code?: string }).code === "attestation-attester-required");
	throws(() => writeAttestation(db, B, ["receipt"], "glg"), (e: unknown) => (e as { code?: string }).code === "attestation-not-needed-same-generation");
	throws(() => writeAttestation(db, { ...A, dimensions: 8 }, ["receipt"], "glg"), (e: unknown) => (e as { code?: string }).code === "store-dimension-mismatch");
	const rec = writeAttestation(db, A, ["parity #843", "acceptance receipt"], "glg");
	deepStrictEqual([rec.storeFingerprint, rec.queryFingerprint], [profileFingerprint(B), profileFingerprint(A)]);
	deepStrictEqual(decideStoreAccess(db, A, 1, 4, "query"), { ok: true, basis: "attested" });
	deepStrictEqual(decideStoreAccess(db, A, 1, 4, "write"), { ok: false, code: "store-profile-mismatch" }, "never permits writes");
	const other = { ...A, digest: "0".repeat(64) };
	deepStrictEqual(decideStoreAccess(db, other, 1, 4, "query"), { ok: false, code: "query-generation-not-attested" }, "another runtime digest is another generation");
	writeAttestation(db, A, ["again"], "glg");
	const list = readAttestations(db);
	ok(list.state === "ok" && list.list.length === 1, "idempotent per (store, query)");
	fs.writeFileSync(attestationPath(db), "[{}]");
	deepStrictEqual(decideStoreAccess(db, A, 1, 4, "query"), { ok: false, code: "attestation-invalid" });
	// attestations are bound to the store fingerprint: a store of another generation ignores them
	fs.rmSync(attestationPath(db));
});

test("S8 stamp v2 records provider / revision / preprocess; harvest producer merges, mismatch refuses", async () => {
	const db = newDb();
	const w = new VectorStore(db, 4, { profile: A });
	await w.ensureTable();
	const st = readStoreStamp(db);
	ok(st.state === "ok");
	if (st.state === "ok") {
		deepStrictEqual([st.stamp.kind, st.stamp.provider, st.stamp.digest], ["andenken-store-profile-v2", "ollama", A.digest]);
		deepStrictEqual(st.stamp.preprocess, { queryInstruction: "", documentInstruction: "", split: { target: 1845, maxCodepoints: 2045 }, truncate: false });
	}
	const hdb = newDb();
	const prod = { kind: "openclaw-harvest" as const, model: "baai/bge-m3", provider: "openai", vectorDims: 4, revisions: { a: 1 }, chunkingVersions: { a: 6 } };
	const h = new VectorStore(hdb, 4, { profile: B, producer: prod });
	await h.ensureTable();
	await h.addChunks([row(1)]);
	const merged = writeStoreStamp(hdb, B, 1, { ...prod, revisions: { b: 7 }, chunkingVersions: { b: 6 } });
	deepStrictEqual(merged.producer?.revisions, { a: 1, b: 7 });
	strictEqual(merged.preprocess.split, null, "a harvest records the producer's split, not ours");
	strictEqual(merged.preprocess.truncate, undefined, "a harvest records no truncation claim of ours");
	throws(() => writeStoreStamp(hdb, B, 1, { ...prod, model: "other" }), (e: unknown) => (e as { code?: string }).code === "store-producer-mismatch");
	// a v1 stamp (pre-2026-11-26 format) is unreadable, not silently accepted
	const v1 = newDb();
	fs.mkdirSync(v1, { recursive: true });
	fs.writeFileSync(stampPath(v1), JSON.stringify({ kind: "andenken-store-profile-v1", profileId: "x", fingerprint: "a".repeat(64), model: "m", digest: null, dimensions: 4, createdAt: "" }));
	strictEqual(readStoreStamp(v1).state, "invalid");
});

test("S4 dimension mismatch is reported before identity; a bad stamp is refused, not ignored", async () => {
	const db = newDb();
	const w = new VectorStore(db, 4, { profile: A });
	await w.ensureTable();
	await w.addChunks([row(1)]);
	await w.close();
	deepStrictEqual(decideStoreAccess(db, { ...A, dimensions: 8 }, 1, 4), { ok: false, code: "store-dimension-mismatch" });
	throws(() => new VectorStore(db, 8, { profile: A }), StoreProfileRefused);
	fs.writeFileSync(stampPath(db), "{not json");
	deepStrictEqual(decideStoreAccess(db, A, 1, 4), { ok: false, code: "store-stamp-invalid" });
	deepStrictEqual(decideStoreAccess(db, null, 1, 4), { ok: false, code: "unprofiled-provider" });
	// empty / absent store: allowed, the writer stamps on creation
	deepStrictEqual(decideStoreAccess(path.join(TMP, "never.lance"), A, 0, null), { ok: true, basis: "empty-store" });
	ok(!fs.existsSync(path.join(TMP, "never.lance")), "a decision never creates the axis");
});

test("S5 a profiled force rebuild of its OWN generation keeps the stamp", async () => {
	const db = newDb();
	const w = new VectorStore(db, 4, { profile: A });
	await w.ensureTable();
	await w.addChunks([row(1)]);
	await w.reset();
	strictEqual(await w.getCount(), 0);
	const st = readStoreStamp(db);
	ok(st.state === "ok" && st.stamp.fingerprint === profileFingerprint(A));
	await w.close();
});

// ---------------------------------------------------------------------------
// M — md chunks fit the BGE window (split, never truncated)
// ---------------------------------------------------------------------------

const { analyzeMdContent, splitToCodepoints } = await import("./md-chunker.ts");

test("M1 splitToCodepoints: line-first, hard split for a long line, lossless, every piece fits", () => {
	const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ` + "가나다".repeat(20) + "\n").join("");
	const pieces = splitToCodepoints(lines, 300);
	strictEqual(pieces.join(""), lines);
	ok(pieces.length > 1);
	ok(pieces.every((p) => [...p.normalize("NFKC")].length <= 300));
	ok(pieces.slice(0, -1).every((p) => p.endsWith("\n")), "cuts at line ends when a line fits");
	const long = "x".repeat(1000);
	const hard = splitToCodepoints(long, 300);
	deepStrictEqual(hard.map((p) => p.length), [300, 300, 300, 100]);
	const lig = "ﬃ".repeat(200); // 600 NFKC code points
	ok(splitToCodepoints(lig, 100).every((p) => [...p.normalize("NFKC")].length <= 100));
	deepStrictEqual(splitToCodepoints("short", 300), ["short"]);
});

test("M2 analyzeMdContent with the BGE limit: every embeddingInput fits; unset limit = old chunks unchanged", () => {
	const para = (i: number) => `Paragraph ${i}. ` + "English words fill this sentence to look like prose. ".repeat(12) + "\n\n";
	const body = Array.from({ length: 12 }, (_, i) => para(i)).join("");
	const md = `---\ntitle: t\ntags: [a]\n---\n${body}`;
	const limit = maxInputCodepoints(BGE, "document")!;
	const old = analyzeMdContent(md, "/x/notes/20260101T000000.md", "notes").chunks;
	const neu = analyzeMdContent(md, "/x/notes/20260101T000000.md", "notes", limit).chunks;
	ok(old.some((c) => [...c.embeddingInput.normalize("NFKC")].length > limit), "fixture exercises an over-limit chunk");
	ok(neu.every((c) => [...c.embeddingInput.normalize("NFKC")].length <= limit));
	strictEqual(neu.map((c) => c.embeddingInput).join(""), old.map((c) => c.embeddingInput).join(""), "no text lost");
	deepStrictEqual(neu.map((c) => c.chunkIndex), neu.map((_, i) => i));
	deepStrictEqual(analyzeMdContent(md, "/x/notes/20260101T000000.md", "notes").chunks, old, "deterministic, unchanged without a limit");
	throws(() => analyzeMdContent(md, "/x/notes/a.md", "notes", 10));
});

// ---------------------------------------------------------------------------
// X — session split under a profiled scope
// ---------------------------------------------------------------------------

const { extractSessionChunks, extractSessionChunksDetailed, withEmbedSplit, splitForEmbedding } = await import("./session-indexer.ts");
const { embedSplitFor } = await import("./embedding-profile.ts");
const { Readable } = await import("node:stream");

test("X1 embedSplitFor: BGE → target limit−200 / ceiling limit; no bound → none (historical split)", () => {
	deepStrictEqual(embedSplitFor(BGE), { target: 1845, maxCodepoints: 2045 });
	strictEqual(embedSplitFor({ ...BGE, tokenOverhead: null }), undefined);
	strictEqual(embedSplitFor(null), undefined);
});

test("X2 long turns: inside the BGE scope every part ≤ 2045 NFKC code points, lossless; outside unchanged", async () => {
	const file = path.join(TMP, "dev", ".pi", "agent", "sessions", "--x--", "2026-10-01T00-00-00-000Z_01900000-0000-7000-8000-000000000001.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// A 2100-char paragraph with no seam right before the 2000 mark produces a
	// 2000 + tail part under the historical split (> 2045); plus NFKC expanders.
	const para = "가".repeat(1990) + "\n" + "나".repeat(150);
	const lig = "ﬃ".repeat(1500); // 1500 UTF-16 units, 4500 NFKC code points
	const rows = [
		{ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: para } },
		{ type: "message", timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: lig } },
	];
	fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	const cp = (t: string) => [...t.normalize("NFKC")].length;
	const before = await extractSessionChunks(file);
	ok(before.some((c) => cp(c.text) > 2045), "fixture exceeds the bound under the historical split");
	const inside = await withEmbedSplit(embedSplitFor(BGE), () => extractSessionChunks(file));
	ok(inside.every((c) => cp(c.text) <= 2045));
	const after = await extractSessionChunks(file);
	deepStrictEqual(after, before, "outside the scope: byte-identical");
	strictEqual(await withEmbedSplit(undefined, () => extractSessionChunks(file)).then((x) => JSON.stringify(x)), JSON.stringify(before));
	// detailed (control-v1) path honours the same scope
	const det = await withEmbedSplit(embedSplitFor(BGE), () =>
		extractSessionChunksDetailed(Readable.from([fs.readFileSync(file)]), file, "control-v1"),
	);
	ok(det.selected.length > 0 && det.selected.every((c) => cp(c.text) <= 2045));
	// lossless modulo the seam whitespace splitForEmbedding already trims
	strictEqual(inside.filter((c) => c.lineNumber === 2).map((c) => c.text).join(""), lig);
	ok(splitForEmbedding(para).length >= 1);
});

// ---------------------------------------------------------------------------
// W — wrappers keep identity; contradictory env refused; splitter is linear
// ---------------------------------------------------------------------------

const { CachingProvider } = await import("./embedding-provider.ts");
const { splitTextToCodepoints } = await import("./embedding-profile.ts");

test("W1 CachingProvider forwards profile / model / isPaidRemote (pi extension wraps every provider)", async () => {
	const inner = new VLLMProvider({ endpoint: BGE.endpoint!, model: BGE.model, dimensions: 1024, profile: BGE });
	const wrapped = new CachingProvider(inner);
	strictEqual(profileOfProvider(wrapped as never)?.id, "ollama-bge-m3-1024");
	strictEqual((wrapped as unknown as { model: string }).model, "bge-m3:latest");
	strictEqual((wrapped as unknown as { isPaidRemote: boolean }).isPaidRemote, false);
	const paid = new CachingProvider(quiet(() => new VLLMProvider({ endpoint: "https://x.invalid", model: "m", dimensions: 4, paidRemote: true })));
	strictEqual((paid as unknown as { isPaidRemote: boolean }).isPaidRemote, true, "the /memory --force paid gate sees a paid endpoint");
	strictEqual(profileOfProvider(paid as never), null, "no profile is inferred from a model string");
	// a stamped BGE store accepts the WRAPPED profiled provider
	const db = newDb();
	const w = new VectorStore(db, 1024, { profile: profileOfProvider(wrapped as never) });
	await w.ensureTable();
	deepStrictEqual(await w.checkProfile(), { ok: true, basis: "stamp" });
	await w.close();
	strictEqual(readStoreStamp(db).state, "ok");
});

test("W2 PROVIDER=openrouter with a loopback profile is refused", () => {
	withEnv({ ANDENKEN_SESSION_PROVIDER: "openrouter", ANDENKEN_SESSION_PROFILE: "ollama-bge-m3-1024" }, () =>
		strictEqual(quiet(createSessionProviderFromEnv), null),
	);
	withEnv({ ANDENKEN_OPENCLAW_QUERY_PROVIDER: "openrouter", ANDENKEN_OPENCLAW_QUERY_PROFILE: "ollama-bge-m3-1024" }, () =>
		throws(() => quiet(createOpenclawQueryProviderFromEnv)),
	);
});

test("W3 splitTextToCodepoints on a 1 MB single-line blob is linear and lossless", () => {
	const blob = "a".repeat(1_000_000);
	const t0 = Date.now();
	const parts = splitTextToCodepoints(blob, 2045);
	const ms = Date.now() - t0;
	strictEqual(parts.join(""), blob);
	ok(parts.every((p) => p.length <= 2045));
	ok(ms < 5000, `took ${ms} ms`);
	const mixed = "가ﬃ".repeat(5000);
	const mp = splitTextToCodepoints(mixed, 2045);
	strictEqual(mp.join(""), mixed);
	ok(mp.every((p) => [...p.normalize("NFKC")].length <= 2045));
});

const { writerRefusal } = await import("./embedding-profile.ts");

test("W4 writer rule: only a profiled provider writes; nothing is inferred (explicit or wrapped)", () => {
	const unprofiled = quiet(() => new VLLMProvider({ endpoint: "https://x.invalid", model: "qwen/qwen3-embedding-8b", dimensions: 4096 }));
	ok(writerRefusal(unprofiled)?.startsWith("unprofiled-writer"));
	ok(writerRefusal(new CachingProvider(unprofiled) as never)?.startsWith("unprofiled-writer"));
	const bge = new VLLMProvider({ endpoint: BGE.endpoint!, model: BGE.model, dimensions: 1024, profile: BGE });
	strictEqual(writerRefusal(bge), null);
	strictEqual(writerRefusal(new CachingProvider(bge) as never), null);
});

// ---------------------------------------------------------------------------
for (const [name, fn] of tests) {
	try {
		await fn();
		passed++;
		console.log(`✓ ${name}`);
	} catch (e) {
		failed++;
		console.log(`✗ ${name}\n  ${e instanceof Error ? (e.stack ?? e.message).split("\n").slice(0, 6).join("\n  ") : String(e)}`);
	} finally {
		route = null;
	}
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
