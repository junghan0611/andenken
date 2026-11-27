#!/usr/bin/env tsx
/**
 * scripts/synthetic-fixture.ts — PROPOSAL (not wired). Builds ONE disposable,
 * synthetic-only sessions store with the production extractors and VectorStore
 * used as libraries, then proves that a read-only consumer left it unchanged.
 *
 * Not an operational runner: no run.sh sync/candidate path, no sessions writer
 * lock, no TTY, no real corpus, no ~/.env.local, no fallback endpoint. Nothing
 * is written outside the fresh root it creates.
 *
 * Inputs (exactly one):
 *   --input synthetic              built-in synthetic sessions (default)
 *   --input freeze --freeze-dir D --freeze-sha256 H --aggregate H
 *                  --plan P --plan-sha256 H --expect-send N --expect-held N
 *                                  exact-corpus mode: ONLY the freeze's allowlisted
 *                                  synthetic JSONL, relative layout preserved;
 *                                  every pin verified before any product import
 *
 * Embedding (default API 0):
 *   (default)                      in-process mock Ollama on a random loopback port
 *   --native --ack-synthetic-only  the profile's own loopback endpoint; the provider
 *                                  proves the runtime digest before its first request
 *
 * The root is printed on stdout (`root: <path>`) and kept for review. The receipt
 * and every exported list carry root-relative paths only. See
 * probes/synthetic-fixtures/README.md.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), "..");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const PROFILE_ID = "ollama-bge-m3-1024";
const DEVICE = "synth";
const ROOT_PREFIX = "andenken-synthfx-";
/** Synthetic allowlist: device `synth`, project `--synthetic-…--`, native UUIDv7 suffix. */
export const SYNTHETIC_ALLOW =
	/^synth\/\.pi\/agent\/sessions\/--synthetic-[a-z0-9-]+--\/[0-9TZ-]+_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/;
const CHILD_ENV = ["ANDENKEN_ENV_MODE", "ANDENKEN_DATA", "ANDENKEN_SESSION_PROFILE", "ANDENKEN_SESSION_ENDPOINT", "ANDENKEN_DISABLE_RECALL_TRACKING", "ANDENKEN_SYNTHFX_ROOT", "ANDENKEN_SYNTHFX_ARGS"];

export class Refused extends Error {}
function die(code: string, detail = ""): never {
	process.stderr.write(`refused: ${code}${detail ? ` — ${detail}` : ""}\n`);
	process.exit(2);
}
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (f: string) => sha(fs.readFileSync(f));
const HEX = /^[0-9a-f]{64}$/;

interface Args {
	input: "synthetic" | "freeze";
	native: boolean;
	ack: boolean;
	freezeDir?: string; freezeSha?: string; aggregate?: string; plan?: string; planSha?: string;
	expectSend?: number; expectHeld?: number;
}
function parseArgs(argv: string[]): Args {
	const a: Args = { input: "synthetic", native: false, ack: false };
	const num = (k: string, n: string) => (/^[0-9]+$/.test(n) ? Number(n) : die("arg-not-integer", k));
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const v = () => argv[++i] ?? die("arg-missing-value", k);
		switch (k) {
			case "--input": { const m = v(); if (m !== "synthetic" && m !== "freeze") die("input-unknown", m); a.input = m; break; }
			case "--native": a.native = true; break;
			case "--ack-synthetic-only": a.ack = true; break;
			case "--freeze-dir": a.freezeDir = v(); break;
			case "--freeze-sha256": a.freezeSha = v(); break;
			case "--aggregate": a.aggregate = v(); break;
			case "--plan": a.plan = v(); break;
			case "--plan-sha256": a.planSha = v(); break;
			case "--expect-send": a.expectSend = num(k, v()); break;
			case "--expect-held": a.expectHeld = num(k, v()); break;
			default: die("arg-unknown", k);
		}
	}
	if (a.native && !a.ack) die("native-needs-ack", "--ack-synthetic-only");
	const freezeKeys = ["freezeDir", "freezeSha", "aggregate", "plan", "planSha", "expectSend", "expectHeld"] as const;
	if (a.input === "synthetic") {
		for (const k of freezeKeys) if (a[k] !== undefined) die("freeze-arg-without-freeze-input", k);
	} else {
		for (const k of freezeKeys) if (a[k] === undefined) die("arg-required", k);
		for (const k of ["freezeSha", "aggregate", "planSha"] as const) if (!HEX.test(a[k]!)) die("pin-malformed", k);
		for (const k of ["freezeDir", "plan"] as const) if (!path.isAbsolute(a[k]!)) die("path-not-absolute", k);
	}
	return a;
}

function assertDisposableRoot(root: string): void {
	const st = fs.lstatSync(root);
	if (!st.isDirectory() || st.isSymbolicLink()) die("root-not-real-directory");
	if (fs.realpathSync(root) !== root) die("root-path-has-symlink");
	if ((st.mode & 0o077) !== 0) die("root-mode-not-private", (st.mode & 0o777).toString(8));
	for (const forbidden of [os.userInfo().homedir, REPO]) {
		if (root === forbidden || root.startsWith(forbidden + path.sep)) die("root-under-forbidden");
	}
}

/** Regular files under `dir`, relative and sorted; symlink, special file, hardlink or symlinked dir refuses. */
function walkStrict(dir: string): string[] {
	if (fs.realpathSync(dir) !== dir) die("path-has-symlink");
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isSymbolicLink()) die("symlink-in-tree", path.relative(dir, p));
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) { if (fs.statSync(p).nlink !== 1) die("hardlinked-file", path.relative(dir, p)); out.push(path.relative(dir, p)); }
			else die("special-file-in-tree", path.relative(dir, p));
		}
	};
	walk(dir);
	return out.sort();
}

// ===========================================================================
// Parent: fresh root + env built from nothing
// ===========================================================================
if (!process.env.ANDENKEN_SYNTHFX_ROOT) {
	const args = parseArgs(process.argv.slice(2));
	const tmpBase = fs.realpathSync(os.tmpdir());
	const root = fs.mkdtempSync(path.join(tmpBase, ROOT_PREFIX));
	assertDisposableRoot(root);
	const home = path.join(root, "home");
	fs.mkdirSync(home, { mode: 0o700 });
	fs.writeFileSync(path.join(home, ".current-device"), `${DEVICE}\n`);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: tmpBase,
		ANDENKEN_ENV_MODE: "process-only",
		ANDENKEN_DATA: path.join(root, "data"),
		ANDENKEN_SESSION_PROFILE: PROFILE_ID,
		ANDENKEN_DISABLE_RECALL_TRACKING: "1",
		ANDENKEN_SYNTHFX_ROOT: root,
		ANDENKEN_SYNTHFX_ARGS: JSON.stringify(args),
	};
	const r = spawnSync(TSX, [SELF], { env, stdio: ["ignore", "inherit", "inherit"], cwd: root });
	process.stdout.write(`root: ${root}\n`);
	process.exit(r.status ?? 1);
}

// ===========================================================================
// Child: environment proof before any product import
// ===========================================================================
const ROOT = process.env.ANDENKEN_SYNTHFX_ROOT!;
const ARGS = JSON.parse(process.env.ANDENKEN_SYNTHFX_ARGS!) as Args;
assertDisposableRoot(ROOT);
if (process.env.HOME !== path.join(ROOT, "home") || fs.existsSync(path.join(ROOT, "home", ".env.local"))) die("home-not-fixture-home");
if (process.env.ANDENKEN_ENV_MODE !== "process-only") die("env-mode-not-process-only");
if (process.env.ANDENKEN_DATA !== path.join(ROOT, "data") || fs.existsSync(process.env.ANDENKEN_DATA)) die("data-not-fresh-in-root");
for (const k of Object.keys(process.env)) if (k.startsWith("ANDENKEN_") && !CHILD_ENV.includes(k)) die("env-unexpected-andenken-var", k);
for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(k)) die("env-credential-shaped-var", k);
if (process.env.ANDENKEN_SESSION_ENDPOINT !== undefined) die("endpoint-preset");

const corpus = path.join(ROOT, "corpus");
const report: Record<string, unknown> = { input: ARGS.input, embedding: ARGS.native ? "native" : "mock" };
let expect: { send: number; held: number; perFile: Map<string, { send: number; held: number }> } | null = null;
let planProfile: { fingerprint: string; split: { target: number; maxCodepoints: number } } | null = null;
let originalPins: Array<{ file: string; sha256: string }> = [];

// ---------------------------------------------------------------------------
// 1a. freeze input: verify everything before runtime, copy allowlist only
// ---------------------------------------------------------------------------
if (ARGS.input === "freeze") {
	const FZ = ARGS.freezeDir!;
	if (FZ === ROOT || FZ.startsWith(ROOT + path.sep) || ROOT.startsWith(FZ + path.sep)) die("freeze-root-overlap");
	const freezeFile = path.join(FZ, "freeze.json");
	if (shaFile(freezeFile) !== ARGS.freezeSha) die("freeze-sha256-mismatch");
	if (shaFile(ARGS.plan!) !== ARGS.planSha) die("plan-sha256-mismatch");
	const freeze = JSON.parse(fs.readFileSync(freezeFile, "utf-8")) as { fixtures?: unknown; sessions?: unknown };
	if (freeze.fixtures !== ARGS.aggregate) die("freeze-aggregate-disagrees");
	// Aggregate: every file under the freeze dir except freeze.json, sorted, sha256 of `${rel}\0${sha}\n`.
	const files = walkStrict(FZ).filter((r) => r !== "freeze.json").map((rel) => ({ rel, sha256: shaFile(path.join(FZ, rel)), size: fs.statSync(path.join(FZ, rel)).size }));
	if (sha(files.map((f) => `${f.rel}\0${f.sha256}\n`).join("")) !== ARGS.aggregate) die("aggregate-recompute-mismatch");
	const jsonl = files.filter((f) => f.rel.startsWith("corpus/")).map((f) => ({ ...f, rel: f.rel.slice("corpus/".length) }));
	const barred = files.filter((f) => !f.rel.startsWith("corpus/"));
	const outside = jsonl.find((f) => !SYNTHETIC_ALLOW.test(f.rel));
	if (outside) die("corpus-file-outside-synthetic-allowlist", outside.rel);
	if (jsonl.length !== freeze.sessions) die("session-count-disagrees");
	const plan = JSON.parse(fs.readFileSync(ARGS.plan!, "utf-8"));
	if (plan.kind !== "andenken-candidate-plan" || plan.policy !== "control-v1" || plan.profile?.id !== PROFILE_ID) die("plan-kind-policy-or-profile");
	const pinLines = jsonl.map((f) => `${f.rel}\t${f.size}\t${f.sha256}`);
	if (sha([...pinLines].sort().join("\n")) !== plan.corpusPin?.sha256 || plan.corpusPin?.files !== jsonl.length) die("plan-corpus-pin-mismatch");
	const per = new Map<string, any>((plan.perFile ?? []).map((p: any) => [p.file, p]));
	if (per.size !== jsonl.length) die("plan-file-set-size-disagrees");
	for (const f of jsonl) {
		const p = per.get(f.rel);
		if (!p || p.sha256 !== f.sha256 || p.size !== f.size) die("plan-perfile-mismatch", f.rel);
	}
	if (plan.totals?.toSend?.chunks !== ARGS.expectSend || plan.totals?.safetyHeld?.chunks !== ARGS.expectHeld) die("plan-totals-disagree-with-expectation");
	if ([...per.values()].reduce((n, p) => n + p.toSendChunks, 0) !== ARGS.expectSend) die("plan-perfile-sum-disagrees");
	for (const [f, h] of Object.entries(plan.sources ?? {})) if (shaFile(path.join(REPO, f)) !== h) die("plan-source-drift", f);
	expect = { send: ARGS.expectSend!, held: ARGS.expectHeld!, perFile: new Map([...per].map(([k, p]) => [k, { send: p.toSendChunks, held: p.safetyHeldChunks }])) };
	planProfile = { fingerprint: plan.profile.fingerprint, split: plan.split };
	originalPins = [...walkStrict(FZ).map((rel) => ({ file: path.join(FZ, rel), sha256: shaFile(path.join(FZ, rel)) })), { file: ARGS.plan!, sha256: ARGS.planSha! }];
	for (const f of jsonl) {
		const dst = path.join(corpus, f.rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(path.join(FZ, "corpus", f.rel), dst, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(dst, 0o600);
		if (shaFile(dst) !== f.sha256 || fs.statSync(dst).nlink !== 1) die("copy-not-exact", f.rel);
	}
	const barredSha = new Set(barred.map((f) => f.sha256));
	for (const rel of walkStrict(ROOT)) if (barredSha.has(shaFile(path.join(ROOT, rel)))) die("barred-file-in-root", rel);
	report.freeze = { freezeSha256: ARGS.freezeSha, aggregate: ARGS.aggregate, aggregateFiles: files.length, allowlisted: jsonl.length, barred: barred.length, planSha256: ARGS.planSha, corpusPin: plan.corpusPin.sha256 };
}

// ---------------------------------------------------------------------------
// 1b. synthetic input: built-in sessions (pi JSONL ≥ 200KB, Claude JSONL, closed durable)
// ---------------------------------------------------------------------------
let durFile: string | null = null;
if (ARGS.input === "synthetic") {
	const A = "ANCHOR-Z9Q4";
	const ts = "2099-01-01T00:00:00.000Z";
	const pad = (s: string, n: number) => s + "x".repeat(Math.max(0, n - s.length));
	const piMsg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "message", timestamp: ts, message: { role, content, ...extra } });
	const write = (rel: string, lines: string[]) => { const f = path.join(corpus, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 }); };
	const longTurn = "p".repeat(1990) + `\n\n${A}-LONG decision B because of cost.\n` + "q".repeat(2500);
	// toolResult lines reach the 200KB discovery floor without becoming rows.
	const filler = Array.from({ length: 60 }, () => piMsg("toolResult", [{ type: "text", text: "y".repeat(3600) }]));
	const fakeKey = ["AK", "IA", "Q".repeat(16)].join(""); // assembled at runtime; shape only
	write("synth/.pi/agent/sessions/--synthetic-builtin--/2099-01-01T00-00-00_0198aaaa-bbbb-7ccc-8ddd-000000000001.jsonl", [
		piMsg("user", pad(`${A} user decision line`, 40)),
		piMsg("assistant", [{ type: "text", text: pad(`${A}-ASSIST answer`, 150) }, { type: "toolCall", name: "bash", arguments: { cmd: "echo synth" } }]),
		piMsg("user", pad(`${A}-S0 synthetic credential shape ${fakeKey} end`, 80)),
		piMsg("assistant", [{ type: "text", text: `\n[tool:done] ${A} grep — found decision B${"x".repeat(90)}\n` }], { api: "entwurf" }),
		piMsg("assistant", [{ type: "text", text: longTurn }]),
		piMsg("user", "short"),
		...filler,
	]);
	const ccMsg = (type: string, content: unknown) => JSON.stringify({ type, timestamp: ts, message: { role: type, content } });
	write("synth/.claude/projects/-synthetic-builtin/11111111-2222-4333-8444-555555555555.jsonl", [
		ccMsg("user", [{ type: "text", text: pad(`${A}-CC user turn`, 60) }]),
		ccMsg("user", [{ type: "tool_result", tool_use_id: "t", content: pad(`${A}-CCTR`, 300) }]),
		ccMsg("assistant", [{ type: "text", text: pad(`${A}-CC assistant`, 150) }]),
	]);
	type Db = { exec(s: string): void; prepare(s: string): { run(...p: unknown[]): unknown }; close(): void };
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => Db };
	durFile = path.join(ROOT, "durable", "bucket", "session", "session.sqlite");
	fs.mkdirSync(path.dirname(durFile), { recursive: true });
	const db = new DatabaseSync(durFile);
	db.exec(`CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
	CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL);
	CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
	CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL);
	CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL, key_value TEXT NOT NULL, scope_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, record TEXT NOT NULL);
	CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (document_id, seq));
	INSERT INTO durable_schema VALUES (1, 1); INSERT INTO conversations VALUES (1, NULL, NULL, '{"id":1}');`);
	let seq = 1;
	const ent = (id: number, kind: string, role: string, text: string) =>
		db.prepare("INSERT INTO entries VALUES (?, 1, NULL, ?, ?)").run(id, seq++, JSON.stringify({ id, conversationId: 1, kind, model: [{ role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop" } : {}) }] }));
	const sub = (id: number, entry: number, answer: number, requestId?: string) =>
		db.prepare("INSERT INTO submissions VALUES (?, 1, ?, 'done', ?)").run(id, requestId ? JSON.stringify(requestId) : null, JSON.stringify({ id, conversationId: 1, type: "input", status: "done", entry, answer, ...(requestId ? { requestId } : {}) }));
	ent(10, "pi.user", "user", `${A} 응`); sub(11, 10, 12);
	ent(12, "pi.assistant", "assistant", `${A}-DUR answer. ` + longTurn);
	ent(20, "pi.user", "user", "sibling mail notice"); sub(21, 20, 22, "entwurf-doorbell:x");
	ent(22, "pi.assistant", "assistant", `${A}-DBELL reply`);
	db.close();
	for (const sfx of ["-wal", "-shm"]) if (fs.existsSync(durFile + sfx)) die("durable-not-closed");
}

// ---------------------------------------------------------------------------
// 2. Product modules + dependency record
// ---------------------------------------------------------------------------
const SI = await import(path.join(REPO, "session-indexer.ts"));
const { extractForPolicy } = await import(path.join(REPO, "session-policy.ts"));
const { partitionMessagesForEmbedding } = await import(path.join(REPO, "session-selection.ts"));
const EP = await import(path.join(REPO, "embedding-profile.ts"));
const { createSessionProviderFromEnv } = await import(path.join(REPO, "embedding-provider.ts"));
const { VectorStore, getSessionsDbPath } = await import(path.join(REPO, "store.ts"));
const profile = EP.getProfile(PROFILE_ID)!;
const split = EP.embedSplitFor(profile)!;
if (planProfile && (planProfile.fingerprint !== EP.profileFingerprint(profile) || planProfile.split.target !== split.target || planProfile.split.maxCodepoints !== split.maxCodepoints)) die("profile-or-split-disagrees-with-plan");
{
	const top = fs.readdirSync(REPO).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
	const lines = [...top, "pnpm-lock.yaml", "package.json"].map((f) => `${f}\0${shaFile(path.join(REPO, f))}\n`);
	const lance = JSON.parse(fs.readFileSync(path.join(REPO, "node_modules/@lancedb/lancedb/package.json"), "utf-8")).version;
	let head: string | null = null;
	try {
		const ref = fs.readFileSync(path.join(REPO, ".git", "HEAD"), "utf-8").trim();
		head = ref.startsWith("ref: ") ? fs.readFileSync(path.join(REPO, ".git", ref.slice(5)), "utf-8").trim() : ref;
	} catch { head = null; }
	report.dependency = { builderSha256: shaFile(SELF), node: process.version, lancedb: lance, gitHEAD: head, repoTopLevelTs: top.length, repoDigest: sha(lines.join("")), profileFingerprint: EP.profileFingerprint(profile), digestPin: profile.digest };
}

// ---------------------------------------------------------------------------
// 3. Extraction: discovery gate, control-v1 + whole-message S0, profiled split
// ---------------------------------------------------------------------------
type Row = { id: string; text: string; sessionFile: string; project: string; lineNumber: number; timestamp: string; role: string; source: string; metadata: Record<string, string> };
const POLICY = { selection: "control-v1", s0: "whole-message-v1", pinned: true } as const;
const inputs = walkStrict(corpus).map((rel) => path.join(corpus, rel));
const piRoot = path.join(corpus, DEVICE, ".pi", "agent", "sessions");
const discoveredPi = SI.findSessionFiles(piRoot);
const piInputs = inputs.filter((f) => f.startsWith(piRoot + path.sep));
if (discoveredPi.length !== piInputs.length || discoveredPi.some((f: string) => !piInputs.includes(f))) die("discovery-disagrees");
const rows: Row[] = [];
let held = 0;
const perFile: Record<string, { send: number; held: number }> = {};
await SI.withEmbedSplit(split, async () => {
	for (const f of inputs) {
		const rel = path.relative(corpus, f);
		const r = await extractForPolicy(f, POLICY, corpus);
		perFile[rel] = { send: r.send.length, held: r.held.length };
		const e = expect?.perFile.get(rel);
		if (expect && (!e || e.send !== r.send.length || e.held !== r.held.length)) die("extraction-disagrees-with-plan", rel);
		held += r.held.length;
		rows.push(...r.send);
	}
	if (durFile) {
		const { planDurable } = await import(path.join(REPO, "durable-plan.ts"));
		const { extractDurableRows } = await import(path.join(REPO, "durable-source.ts"));
		const opts = { liveRoots: [path.join(ROOT, "no-live-root")] };
		const plan = await planDurable(durFile, opts);
		const ex = await extractDurableRows(durFile, plan, { after: 0, upTo: plan.watermark.safeProcessedId }, { device: DEVICE, session: "session" }, opts);
		const p = partitionMessagesForEmbedding(ex.groups);
		perFile[path.relative(ROOT, durFile)] = { send: p.send.length, held: p.held.length };
		held += p.held.length;
		rows.push(...p.send);
	}
});
if (expect && (rows.length !== expect.send || held !== expect.held)) die("totals-disagree-with-expectation", `${rows.length}/${held}`);
if (new Set(rows.map((r) => r.id)).size !== rows.length) die("duplicate-row-id");
if (rows.some((r) => EP.codepointsNfkc(r.text) > split.maxCodepoints)) die("row-over-limit");
const relOf = (r: Row) => {
	const base = r.source === "pi-durable" ? path.relative(ROOT, r.sessionFile) : path.relative(corpus, r.sessionFile);
	return `${base}${r.source === "pi-durable" ? `:e${r.lineNumber}` : `:${r.lineNumber}`}${r.metadata.part !== undefined ? `#${r.metadata.part}` : ""}`;
};
const ledger = rows.map((r) => {
	if (r.source !== "pi-durable") {
		const relId = relOf(r);
		if (r.id !== `${corpus}${path.sep}${relId}`) die("row-id-not-source-relative");
		const src = JSON.parse(fs.readFileSync(r.sessionFile, "utf-8").split("\n")[r.lineNumber - 1]);
		const c = src?.message?.content;
		const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("\n") : "";
		if (r.metadata.part === undefined && !text.includes(r.text)) die("row-line-mismatch", relId);
	}
	return [relOf(r), r.role, r.timestamp, EP.codepointsNfkc(r.text), sha(r.text)].join("\t");
});
report.extraction = { files: Object.keys(perFile).length, sendRows: rows.length, s0Held: held, perFile, ...(expect ? { expectedSend: expect.send, expectedHeld: expect.held } : {}) };

// ---------------------------------------------------------------------------
// 4. Embedding: mock (default) or the profile's native loopback endpoint
// ---------------------------------------------------------------------------
let mock: any = null;
if (ARGS.native) {
	if (!profile.endpoint || !EP.isLoopbackEndpoint(profile.endpoint) || !profile.digest) die("native-profile-not-loopback-pinned");
	process.env.ANDENKEN_SESSION_ENDPOINT = profile.endpoint;
} else {
	const TS = await import(path.join(REPO, "test-support-generation.ts"));
	mock = await TS.startMockOllama();
	process.env.ANDENKEN_SESSION_ENDPOINT = mock.endpoint;
}
const provider = createSessionProviderFromEnv();
if (!provider || (provider as any).profile?.id !== PROFILE_ID) die("provider-not-profiled");
const vectors: number[][] = [];
for (let i = 0; i < rows.length; i += profile.maxBatchSize) vectors.push(...(await provider.embedDocumentBatch(rows.slice(i, i + profile.maxBatchSize).map((r) => r.text))));
if (vectors.length !== rows.length || vectors.some((v) => v.length !== profile.dimensions)) die("embedding-shape");
report.embeddingStats = mock
	? { tagsRequests: mock.tags, embedRequests: mock.requests, inputs: mock.received.length, truncatableRequests: mock.truncatable }
	: { inputs: vectors.length, stats: (provider as any).getStats?.() ?? null };
if (mock && (mock.truncatable !== 0 || mock.received.length !== rows.length || mock.tags < 1)) die("mock-contract");
await mock?.close();

// ---------------------------------------------------------------------------
// 5. Store: stamp on create, rows, real FTS, dimension
// ---------------------------------------------------------------------------
const dbPath = getSessionsDbPath();
if (dbPath !== path.join(ROOT, "data", "sessions.lance")) die("store-path-not-in-root");
const store = new VectorStore(dbPath, profile.dimensions, { profile });
await store.ensureTable();
await store.assertProfileForWrite();
await store.addChunksRaw(rows.map((r, i) => ({ ...r, vector: vectors[i] })));
const fts = await store.createFtsIndex();
const written = await store.getCount();
const dim = await store.getActualVectorDim();
const health = await store.ftsHealth();
await store.close();
const stamp = EP.readStoreStamp(dbPath);
if (stamp.state !== "ok" || stamp.stamp.fingerprint !== EP.profileFingerprint(profile)) die("stamp-not-ok");
if (written !== rows.length || dim !== profile.dimensions || !health.index || health.indexed !== rows.length || health.query?.status !== "ok") die("store-check");
report.store = { written, dim, fts, ftsIndexed: health.indexed, ftsUnindexed: health.unindexed, ftsQuery: health.query?.status, stamp: { profileId: stamp.stamp.profileId, fingerprint: stamp.stamp.fingerprint, digest: stamp.stamp.digest, dimensions: stamp.stamp.dimensions, preprocess: stamp.stamp.preprocess } };

// ---------------------------------------------------------------------------
// 6. Read-only consumer between two tree hashes
// ---------------------------------------------------------------------------
const treeHash = (dir: string) => {
	const files = walkStrict(dir).map((rel) => ({ p: path.relative(ROOT, path.join(dir, rel)), s: shaFile(path.join(dir, rel)) }));
	return { files, list: files.map((f) => `${f.s}  ${f.p}\n`).join("") };
};
const inputDirs = [corpus, ...(durFile ? [path.join(ROOT, "durable")] : [])];
const inputsBefore = inputDirs.map(treeHash);
const storeBefore = treeHash(dbPath);
{
	const reader = new VectorStore(dbPath, profile.dimensions, { profile, readOnly: true });
	await reader.init();
	await reader.checkProfile("query");
	const term = rows[0].text.match(/[A-Za-z]{5,}/)?.[0] ?? die("no-fts-probe-term");
	const f = await reader.fullTextSearch(term, 5, undefined, () => {});
	const v = await reader.search(vectors[0], 3);
	await reader.close();
	if (f.length === 0) die("consumer-fts-zero-hits");
	report.consumer = { ftsHits: f.length, vectorHits: v.length, topVectorIsRow0: v[0]?.id === rows[0].id };
}
const storeAfter = treeHash(dbPath);
const inputsAfter = inputDirs.map(treeHash);
const originalsChanged = originalPins.filter((p) => shaFile(p.file) !== p.sha256).length;
const inputsList = inputsBefore.map((t) => t.list).join("");
report.verification = {
	storeUnchangedByConsumer: storeBefore.list === storeAfter.list,
	inputsUnchanged: inputsList === inputsAfter.map((t) => t.list).join(""),
	originalsRechecked: originalPins.length, originalsChanged,
	storeDigest: sha(storeBefore.list), storeFiles: storeBefore.files.length, inputsDigest: sha(inputsList),
};

const out = path.join(ROOT, "out");
fs.mkdirSync(out, { mode: 0o700 });
fs.writeFileSync(path.join(out, "INPUTS.sha256"), inputsList);
fs.writeFileSync(path.join(out, "STORE.sha256"), storeBefore.list);
fs.writeFileSync(path.join(out, "STORE.files"), storeBefore.files.map((f) => f.p).join("\n") + "\n");
fs.writeFileSync(path.join(out, "ROWS.tsv"), "rel_id\trole\ttimestamp\tcodepoints\ttext_sha256\n" + ledger.join("\n") + "\n");
fs.writeFileSync(path.join(out, "verify.sh"), `#!/usr/bin/env bash
# Run BEFORE and AFTER any consumer: both must print OK with the same digests. Read-only.
set -euo pipefail
cd "$(dirname "$0")/.."
sha256sum --quiet -c out/INPUTS.sha256
sha256sum --quiet -c out/STORE.sha256
diff <(find data/sessions.lance -type f | LC_ALL=C sort) <(LC_ALL=C sort out/STORE.files) >/dev/null || { echo "store file set changed"; exit 1; }
test -z "$(find . -type l)" || { echo "symlink present"; exit 1; }
echo "OK store=$(sha256sum out/STORE.sha256 | cut -d' ' -f1) inputs=$(sha256sum out/INPUTS.sha256 | cut -d' ' -f1)"
`, { mode: 0o700 });
const receipt = JSON.stringify(report, null, 1) + "\n";
if (receipt.includes(ROOT) || receipt.includes(REPO) || receipt.includes(os.userInfo().homedir)) die("receipt-carries-host-path");
fs.writeFileSync(path.join(out, "receipt.json"), receipt);
process.stdout.write(receipt);
const v = report.verification as Record<string, unknown>;
process.exit(v.storeUnchangedByConsumer && v.inputsUnchanged && originalsChanged === 0 ? 0 : 1);
