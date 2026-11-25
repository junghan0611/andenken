#!/usr/bin/env npx tsx
/**
 * Embedding provider unit suite — API 0.
 *
 *   HOME=$(mktemp -d) npx tsx test-provider.ts
 *
 * Covers the profile-only env factories (no model-string, preset, Gemini or
 * fallback path), the provider stats interface, and connection errors against
 * a closed loopback port. It never opens a network connection beyond
 * 127.0.0.1:1. A real runtime check is `scripts/profile-preflight.ts`, which
 * is an operator step, not a test.
 *
 * `~/.env.local` is read by the factories, so run with a temporary HOME; the
 * suite refuses to start when the real one is visible.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	VLLMProvider,
	createMdProviderFromEnv,
	createOpenclawQueryProviderFromEnv,
	createSessionProviderFromEnv,
} from "./embedding-provider.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✅ ${msg}`);
	} else {
		failed++;
		console.log(`  ❌ ${msg}`);
	}
}

function section(name: string) {
	console.log(`\n=== ${name} ===`);
}

if (fs.existsSync(path.join(process.env.HOME ?? "", ".env.local"))) {
	console.error("refused: ~/.env.local is visible — run with HOME=$(mktemp -d)");
	process.exit(2);
}
for (const k of Object.keys(process.env)) if (k.startsWith("ANDENKEN_")) delete process.env[k];

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
	const keys = Object.keys(env);
	for (const k of keys) process.env[k] = env[k];
	try {
		return fn();
	} finally {
		for (const k of keys) delete process.env[k];
	}
}

const P = "ollama-bge-m3-1024";

function testFactories() {
	section("Profile-only factories (unit)");

	assert(createSessionProviderFromEnv() === null, "sessions: absent namespace builds nothing");
	assert(createMdProviderFromEnv() === null, "md: absent namespace builds nothing");
	assert(createOpenclawQueryProviderFromEnv() === null, "openclaw query: absent namespace builds nothing");

	const s = withEnv({ ANDENKEN_SESSION_PROFILE: P }, () => createSessionProviderFromEnv());
	assert(s instanceof VLLMProvider, "sessions: profile builds a VLLMProvider");
	assert(s?.dimensions === 1024, `sessions: dimensions ${s?.dimensions}`);
	assert(s?.profile?.id === P, `sessions: profile ${s?.profile?.id}`);
	assert((s as VLLMProvider).endpoint === "http://127.0.0.1:11435", `sessions: default endpoint ${(s as VLLMProvider).endpoint}`);

	const m = withEnv({ ANDENKEN_MD_PROFILE: P, ANDENKEN_MD_ENDPOINT: "http://127.0.0.1:18080" }, () => createMdProviderFromEnv());
	assert((m as VLLMProvider | null)?.endpoint === "http://127.0.0.1:18080", "md: any loopback placement is accepted");

	const refusals: Array<[string, Record<string, string>]> = [
		["MODEL without PROFILE", { ANDENKEN_SESSION_PROVIDER: "vllm", ANDENKEN_SESSION_MODEL: "bge-m3:latest" }],
		["unknown profile", { ANDENKEN_SESSION_PROFILE: "qwen3-embedding-8b-4096" }],
		["hosted profile", { ANDENKEN_SESSION_PROFILE: "openrouter-bge-m3-1024" }],
		["PROVIDER=gemini", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_PROVIDER: "gemini" }],
		["PROVIDER=openrouter", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_PROVIDER: "openrouter" }],
		["conflicting MODEL", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_MODEL: "Qwen/Qwen3-Embedding-8B" }],
		["conflicting DIMENSIONS", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_DIMENSIONS: "4096" }],
		["TRUNCATE_DIMENSIONS", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_TRUNCATE_DIMENSIONS: "1" }],
		["non-loopback endpoint", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_ENDPOINT: "https://openrouter.ai/api/v1" }],
		["PAID_REMOTE=1", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_PAID_REMOTE: "1" }],
		["batch above profile", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_MAX_BATCH_SIZE: "64" }],
		["timeout above profile", { ANDENKEN_SESSION_PROFILE: P, ANDENKEN_SESSION_TIMEOUT_MS: "600000" }],
	];
	for (const [why, env] of refusals) {
		assert(withEnv(env, () => createSessionProviderFromEnv()) === null, `sessions refuses: ${why}`);
	}

	let threw = false;
	try {
		withEnv({ ANDENKEN_OPENCLAW_QUERY_PROFILE: "openrouter-bge-m3-1024" }, () => createOpenclawQueryProviderFromEnv());
	} catch {
		threw = true;
	}
	assert(threw, "openclaw query: a set namespace that does not build throws (no silent fallback)");
}

function testProviderInterface() {
	section("Provider interface (unit)");
	const v = new VLLMProvider({ endpoint: "http://127.0.0.1:1", model: "test", dimensions: 512 });
	const stats = v.getStats();
	assert(stats.calls === 0, `initial calls: ${stats.calls}`);
	assert(stats.estimatedTokens === 0, `initial tokens: ${stats.estimatedTokens}`);
	assert(stats.estimatedCostUSD === 0, `local cost: $${stats.estimatedCostUSD}`);
	v.resetStats();
	assert(v.getStats().calls === 0, "stats reset works");
	assert(v.isPaidRemote === false, "unprofiled test provider is not paid");
}

async function testConnectionErrors() {
	section("Connection errors on a closed loopback port (unit)");
	const refused = new VLLMProvider({ endpoint: "http://127.0.0.1:1", model: "test", dimensions: 512, timeoutMs: 2000 });
	try {
		await refused.embedQuery("test");
		assert(false, "should throw on connection refused");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		assert(msg.includes("unreachable") || msg.includes("ECONNREFUSED"), `connection refused: ${msg.slice(0, 80)}`);
	}
	const health = await refused.healthCheck();
	assert(!health.ok, `health check on a closed port: ok=${health.ok}`);
	assert(typeof health.error === "string", `health check error: ${health.error}`);
}

async function main() {
	testFactories();
	testProviderInterface();
	await testConnectionErrors();
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

main();
