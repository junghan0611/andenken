#!/usr/bin/env tsx
/**
 * Synthetic suite for status-contract.ts (`./run.sh status:contract --json`).
 *
 * API 0: temp HOME + ANDENKEN_DATA, ANDENKEN_ENV_MODE=process-only (the real
 * ~/.env.local is never opened), providers pointed at a dead loopback port,
 * and `fetch` replaced by a counter that throws. Every fixture is a tiny
 * 1024d store built here.
 *
 * What it pins:
 *   - absent (no path / no table) vs readable-empty vs present
 *   - a GENUINE I/O failure (EACCES) is unreadable/unknown, never absent and
 *     never the guard's `store-stamp-invalid`; a malformed stamp IS that
 *     named guard refusal
 *   - selected provider ≠ stamped generation; expected digest vs observed
 *     runtime revision (null, not-probed)
 *   - coverage stays unknown across an A→B change: never B from newer source
 *     mtimes, never A from receipts that do not bind the table version
 *   - no network, no embedding, no writes (tree snapshot before/after)
 *   - existing guard readers keep folding I/O into `invalid` (behaviour kept)
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0;
let fail = 0;
function ok(cond: unknown, label: string) {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-contract-"));
const home = path.join(root, "home");
const data = path.join(root, "data");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(home, ".current-device"), "testdev\n");

for (const k of Object.keys(process.env)) if (k.startsWith("ANDENKEN_")) delete process.env[k];
process.env.HOME = home;
process.env.ANDENKEN_DATA = data;
process.env.ANDENKEN_ENV_MODE = "process-only";
process.env.ANDENKEN_INDEX_AUTHORITY = "testdev";
const DEAD = "http://127.0.0.1:9";
process.env.ANDENKEN_SESSION_PROFILE = "ollama-bge-m3-1024";
process.env.ANDENKEN_SESSION_ENDPOINT = DEAD;
process.env.ANDENKEN_MD_PROFILE = "ollama-bge-m3-1024";
process.env.ANDENKEN_MD_ENDPOINT = DEAD;

let fetchCalls = 0;
globalThis.fetch = (async () => {
	fetchCalls++;
	throw new Error("network forbidden in status-contract tests");
}) as typeof fetch;

const { PROFILES, profileFingerprint, readStoreStamp, readAttestations, writeAttestation } = await import("./embedding-profile.ts");
const { VectorStore, describeAxisAbsence, getSessionsDbPath, getMdDbPath, getOpenclawDbPath } = await import("./store.ts");
const { collectStatusContract } = await import("./status-contract.ts");

const LOCAL = PROFILES["ollama-bge-m3-1024"];
const HARVEST = PROFILES["openrouter-bge-m3-1024"];
const DIM = LOCAL.dimensions;
const vec = (x: number) => { const v = new Array<number>(DIM).fill(0); v[0] = x; v[1] = 1; return v; };
const row = (i: number, file = "/src/a.jsonl") => ({ id: `r${i}`, text: `row ${i}`, vector: vec(i), sessionFile: file, project: "p", lineNumber: i, timestamp: "2026-11-26T00:00:00Z", role: "user", source: "pi", metadata: {} });

/** path → size:mtimeMs for every readable entry; the no-write witness. */
function tree(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			const st = fs.statSync(p);
			out.set(p, `${st.size}:${st.mtimeMs}:${st.mode}`);
			if (e.isDirectory()) walk(p);
		}
	};
	walk(dir);
	return out;
}
const sameTree = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

const S = getSessionsDbPath();
const M = getMdDbPath();
const O = getOpenclawDbPath();

try {
	// ---------------------------------------------------------------- absent
	console.log("\n📋 absent — no path");
	{
		const before = tree(root);
		const c = await collectStatusContract();
		ok(c.kind === "andenken-status-contract" && c.version === 1, "kind + version 1");
		for (const a of ["sessions", "md", "openclaw"] as const) {
			ok(c.axes[a].index.state === "absent" && c.axes[a].index.absentShape === "no-path", `${a}: index absent (no-path)`);
			ok(c.axes[a].query.state === "absent", `${a}: query absent`);
			ok(c.axes[a].coverage.state === "unknown" && c.axes[a].coverage.reason === "index-absent", `${a}: coverage unknown index-absent`);
		}
		ok(sameTree(before, tree(root)) && !fs.existsSync(S) && !fs.existsSync(M) && !fs.existsSync(O), "absent: nothing created");
	}

	console.log("\n📋 absent — directory without a table");
	fs.mkdirSync(M);
	{
		const c = await collectStatusContract();
		ok(c.axes.md.index.state === "absent" && c.axes.md.index.absentShape === "no-table", "md: dir without table is absent(no-table), not empty");
		ok(!fs.existsSync(path.join(M, "session_chunks.lance")), "no table created by the read");
	}
	fs.rmdirSync(M);

	// ---------------------------------------------------------------- empty vs present
	console.log("\n📋 readable empty vs present");
	{
		const w = new VectorStore(M, DIM, { profile: LOCAL });
		await w.ensureTable();
		await w.close();
		const c = await collectStatusContract();
		const md = c.axes.md;
		ok(md.index.state === "empty" && md.index.rows === 0 && md.index.vectorDim === null, "md: readable zero-row table is empty");
		ok(typeof md.index.tableVersion === "number", "md: table version read");
		ok(md.query.state === "empty" && md.query.basis === "stamp", "md: query empty (stamp basis), not absent");
		ok(md.coverage.reason === "no-receipt", "md: empty with no receipt → coverage unknown no-receipt");
	}
	{
		const w = new VectorStore(S, DIM, { profile: LOCAL });
		await w.addChunks([row(1), row(2)]);
		await w.close();
		const c = await collectStatusContract();
		const s = c.axes.sessions;
		ok(s.index.state === "present" && s.index.rows === 2 && s.index.vectorDim === DIM, "sessions: present, 2 rows, 1024d");
		ok(s.query.state === "ready" && s.query.basis === "stamp", "sessions: query ready by stamp");
		ok(s.stamp.state === "ok" && s.stamp.generation?.profileId === LOCAL.id, "sessions: stamped generation reported");
		ok(s.query.provider.selection === "ANDENKEN_SESSION_*" && s.query.provider.profileId === LOCAL.id, "sessions: selected provider = the search path's namespace");
		ok(s.query.provider.fingerprint === profileFingerprint(LOCAL), "sessions: selected fingerprint");
		const rt = s.query.provider.runtime;
		ok(rt?.expectedDigest === LOCAL.digest && rt?.observedRevision === null && rt?.probe === "not-probed", "runtime: expected digest vs observed null / not-probed");
	}

	// ---------------------------------------------------------------- openclaw: selected ≠ stamped
	console.log("\n📋 openclaw — selected provider vs stamped generation");
	{
		const w = new VectorStore(O, DIM, {
			profile: HARVEST,
			producer: { kind: "openclaw-harvest", model: "baai/bge-m3", provider: "openai", vectorDims: DIM, revisions: {} },
		});
		await w.addChunks([row(1, "/oc/glg")]);
		await w.close();
		let c = await collectStatusContract();
		let o = c.axes.openclaw;
		ok(o.query.provider.selection === "ANDENKEN_SESSION_* (openclaw fallback)", "openclaw: falls back to the sessions provider, as search does");
		ok(o.stamp.generation?.profileId === HARVEST.id && o.query.provider.profileId === LOCAL.id, "openclaw: stamped generation and selected profile reported apart");
		ok(o.query.state === "refused" && o.query.code === "query-generation-not-attested", "openclaw: not attested → named refusal");
		writeAttestation(O, LOCAL, ["fixture:parity"], "status-contract.test");
		c = await collectStatusContract();
		o = c.axes.openclaw;
		ok(o.query.state === "ready" && o.query.basis === "attested" && o.attestation.count === 1, "openclaw: attested → ready (basis attested)");

		process.env.ANDENKEN_OPENCLAW_QUERY_PROFILE = "no-such-profile";
		c = await collectStatusContract();
		ok(c.axes.openclaw.query.state === "refused" && c.axes.openclaw.query.code === "openclaw-query-provider-refused", "openclaw: a declared-but-refused query namespace is refused, no fallback");
		delete process.env.ANDENKEN_OPENCLAW_QUERY_PROFILE;
	}

	// ---------------------------------------------------------------- provider selection refusals
	console.log("\n📋 provider selection");
	{
		delete process.env.ANDENKEN_MD_PROFILE;
		delete process.env.ANDENKEN_MD_ENDPOINT;
		let c = await collectStatusContract();
		ok(c.axes.md.query.state === "refused" && c.axes.md.query.code === "query-provider-not-configured" && c.axes.md.query.provider.state === "not-configured", "md: no namespace → not-configured");
		ok(c.axes.md.index.state === "empty", "md: index state unaffected by query provider");
		process.env.ANDENKEN_MD_PROFILE = "no-such-profile";
		c = await collectStatusContract();
		ok(c.axes.md.query.code === "query-provider-refused" && c.axes.md.query.provider.state === "refused", "md: declared but refused → query-provider-refused");
		process.env.ANDENKEN_MD_PROFILE = "ollama-bge-m3-1024";
		process.env.ANDENKEN_MD_ENDPOINT = DEAD;
	}

	// ---------------------------------------------------------------- unstamped rows
	console.log("\n📋 unstamped rows (guard)");
	{
		const U = path.join(root, "unstamped", "md.lance");
		const w = new VectorStore(U, DIM);
		await w.addChunks([row(1)]);
		await w.close();
		const prev = process.env.ANDENKEN_DATA;
		process.env.ANDENKEN_DATA = path.dirname(U);
		const c = await collectStatusContract();
		ok(c.axes.md.stamp.state === "absent" && c.axes.md.query.code === "store-unstamped", "unstamped rows → refused store-unstamped");
		process.env.ANDENKEN_DATA = prev;
	}

	// ---------------------------------------------------------------- guard vs genuine I/O
	console.log("\n📋 bad guard (malformed stamp) vs genuine unreadable (EACCES)");
	{
		const stamp = path.join(M, "andenken-profile.json");
		const good = fs.readFileSync(stamp, "utf-8");
		fs.writeFileSync(stamp, "{not json");
		let c = await collectStatusContract();
		ok(c.axes.md.stamp.state === "invalid" && c.axes.md.query.state === "refused" && c.axes.md.query.code === "store-stamp-invalid", "malformed stamp → named guard refusal store-stamp-invalid");
		fs.writeFileSync(stamp, good);

		fs.chmodSync(stamp, 0o000);
		const unreadableStamp = (() => { try { fs.readFileSync(stamp); return false; } catch { return true; } })();
		if (unreadableStamp) {
			c = await collectStatusContract();
			ok(c.axes.md.stamp.state === "unreadable" && c.axes.md.stamp.error?.errno === "EACCES", "stamp EACCES → stamp unreadable with errno");
			ok(c.axes.md.query.state === "unknown" && c.axes.md.query.code === "stamp-unreadable", "stamp EACCES → query unknown, not store-stamp-invalid");
			ok(readStoreStamp(M).state === "invalid", "existing guard reader still folds I/O into invalid (behaviour kept)");
		} else {
			console.log("  skip stamp EACCES (running with privileges that bypass mode bits)");
		}
		fs.chmodSync(stamp, 0o644);

		const att = path.join(O, "andenken-query-attestation.json");
		fs.chmodSync(att, 0o000);
		if ((() => { try { fs.readFileSync(att); return false; } catch { return true; } })()) {
			c = await collectStatusContract();
			ok(c.axes.openclaw.attestation.state === "unreadable" && c.axes.openclaw.query.state === "unknown" && c.axes.openclaw.query.code === "attestation-unreadable", "attestation EACCES → unknown, not attestation-invalid");
			ok(readAttestations(O).state === "invalid", "existing attestation reader still folds I/O into invalid");
		}
		fs.chmodSync(att, 0o644);

		fs.chmodSync(M, 0o000);
		if ((() => { try { fs.readdirSync(M); return false; } catch { return true; } })()) {
			c = await collectStatusContract();
			ok(describeAxisAbsence(M) !== null, "(the search guard calls this directory absent — existsSync folds EACCES)");
			ok(c.axes.md.index.state === "unreadable" && c.axes.md.index.error?.errno === "EACCES", "md dir EACCES → index unreadable, NOT absent");
			ok(c.axes.md.query.state === "unknown" && c.axes.md.query.code === "index-unreadable", "md dir EACCES → query unknown");
			ok(c.axes.md.coverage.reason === "index-unreadable", "md dir EACCES → coverage unknown index-unreadable");
			ok(c.axes.md.stamp.state === "not-read", "md dir EACCES → stamp not-read (not absent)");
		}
		fs.chmodSync(M, 0o755);

		const tdir = path.join(M, "session_chunks.lance");
		fs.chmodSync(tdir, 0o000);
		if ((() => { try { fs.readdirSync(tdir); return false; } catch { return true; } })()) {
			c = await collectStatusContract();
			ok(c.axes.md.index.state === "unreadable" && c.axes.md.query.state === "unknown", "table dir unreadable → index unreadable / query unknown, not empty");
		}
		fs.chmodSync(tdir, 0o755);
	}

	// ---------------------------------------------------------------- A/B coverage
	console.log("\n📋 A/B — coverage is never inferred");
	{
		const src = path.join(root, "src");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(path.join(src, "a.jsonl"), "{}\n");
		// Receipts that LOOK like coverage evidence: a manifest and a built
		// candidate receipt pinning a corpus — neither records a table version.
		fs.writeFileSync(path.join(data, "session-manifest.json"), JSON.stringify({ files: { [path.join(src, "a.jsonl")]: { mtime: 1, size: 3, chunks: 2 } } }));
		fs.writeFileSync(path.join(data, "candidate-receipt.json"), JSON.stringify({ status: "built", plan: { sha256: "x".repeat(64), corpusPin: "pin-A" }, counts: { rows: 2 } }));
		const A = await collectStatusContract();
		const a = A.axes.sessions;
		ok(a.coverage.state === "unknown" && a.coverage.reason === "no-receipt-binds-table-version", "A: receipts present but unbound → unknown (not 'covered')");
		ok(a.coverage.receipts.filter((r) => r.state === "present").length === 2, "A: the two receipts are listed as present");
		ok(a.coverage.receipts.every((r) => r.bindsTableVersion === false), "A: no receipt binds the table version");

		// B: the table changes and the source gets newer.
		const w = new VectorStore(S, DIM, { profile: LOCAL });
		await w.addChunks([row(3, "/src/b.jsonl")]);
		await w.close();
		const future = new Date(Date.now() + 86_400_000);
		fs.utimesSync(path.join(src, "a.jsonl"), future, future);
		const before = tree(root);
		const B = await collectStatusContract();
		const b = B.axes.sessions;
		ok(sameTree(before, tree(root)), "B: the contract read wrote nothing");
		ok(b.index.rows === 3 && (b.index.tableVersion ?? 0) > (a.index.tableVersion ?? 0), "B: table version observed to advance (fact, not coverage)");
		ok(b.coverage.state === "unknown" && b.coverage.reason === a.coverage.reason, "B: newer source + new table version → still unknown, same reason");
		const flat = JSON.stringify(B);
		ok(!/"(fresh|stale|covered|behind|up-to-date)"/.test(flat), "no freshness verdict anywhere in the payload");
	}

	// ---------------------------------------------------------------- no network / writes
	console.log("\n📋 no network, no embedding, no writes");
	{
		const before = tree(root);
		const c = await collectStatusContract();
		ok(sameTree(before, tree(root)), "full fixture set: tree unchanged after collect");
		ok(fetchCalls === 0, "fetch never called (no runtime probe, no embedding)");
		ok(c.readOnly.network === false && c.readOnly.embedding === false && c.readOnly.writes === false && c.readOnly.runtimeProbe === false, "readOnly flags stated");
		ok(!fs.existsSync(path.join(data, "recalls.jsonl")), "no recall log written");
	}

	// ---------------------------------------------------------------- CLI
	console.log("\n📋 CLI subprocess");
	{
		const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: os.tmpdir() };
		for (const [k, v] of Object.entries(process.env)) if (k.startsWith("ANDENKEN_") && v !== undefined) env[k] = v;
		const before = tree(root);
		const r = spawnSync(process.execPath, ["--import", "tsx", "status-contract.ts", "--json"], { cwd: path.dirname(new URL(import.meta.url).pathname), env, encoding: "utf-8" });
		ok(r.status === 0, `exit 0 (got ${r.status}; stderr ${r.stderr.slice(0, 200)})`);
		let parsed: { version?: number; axes?: Record<string, unknown> } = {};
		try { parsed = JSON.parse(r.stdout); } catch { /* checked below */ }
		ok(parsed.version === 1 && parsed.axes && Object.keys(parsed.axes).join(",") === "sessions,md,openclaw", "stdout is the v1 JSON");
		ok(sameTree(before, tree(root)), "CLI run wrote nothing");
		const noFlag = spawnSync(process.execPath, ["--import", "tsx", "status-contract.ts"], { cwd: path.dirname(new URL(import.meta.url).pathname), env, encoding: "utf-8" });
		ok(noFlag.status === 2, "without --json → usage, exit 2");
	}
} finally {
	for (const p of [M, path.join(M, "session_chunks.lance")]) { try { fs.chmodSync(p, 0o755); } catch { /* */ } }
	fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
