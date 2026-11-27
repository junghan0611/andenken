/**
 * synthetic-fixture.test.ts — SYNTHETIC suite for scripts/synthetic-fixture.ts (API 0).
 *
 * Runs the builder only in its default mock mode (in-process mock Ollama on a
 * random loopback port). Never uses --native, never reads a real session, the
 * corpus, ~/.env.local or a production store. Every freeze it verifies is one
 * this file wrote into its own temp dir; every root the builder creates is
 * removed by the exact path the builder printed.
 *
 *   tsx synthetic-fixture.test.ts
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { extractForPolicy } from "./session-policy.ts";
import { withEmbedSplit } from "./session-indexer.ts";
import { embedSplitFor, getProfile, profileFingerprint } from "./embedding-profile.ts";

const REPO = import.meta.dirname;
const BUILDER = path.join(REPO, "scripts", "synthetic-fixture.ts");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
let passed = 0;
let failed = 0;
function ok(c: unknown, msg: string, detail?: unknown): void {
	if (c) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.log(`  ❌ ${msg}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); }
}
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (f: string) => sha(fs.readFileSync(f));

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "andenken-synthfx-test-"));
const home = path.join(scratch, "home");
fs.mkdirSync(home);

/** Run the builder with a clean env; remove the root it printed (exact path). */
function build(args: string[], keep = false): { status: number | null; stdout: string; stderr: string; root: string | null; receipt: any } {
	const r = spawnSync(TSX, [BUILDER, ...args], { env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: fs.realpathSync(os.tmpdir()) }, encoding: "utf-8" });
	const root = /^root: (.+)$/m.exec(r.stdout)?.[1] ?? null;
	let receipt: any = null;
	if (root && fs.existsSync(path.join(root, "out", "receipt.json"))) receipt = JSON.parse(fs.readFileSync(path.join(root, "out", "receipt.json"), "utf-8"));
	const res = { status: r.status, stdout: r.stdout, stderr: r.stderr, root, receipt };
	if (root && !keep) fs.rmSync(root, { recursive: true, force: true });
	return res;
}
const refusal = (r: { stderr: string }) => /^refused: ([a-z0-9-]+)/m.exec(r.stderr)?.[1] ?? null;

console.log("\n# argument gates (parent refuses before creating a root)");
for (const [args, code] of [
	[["--native"], "native-needs-ack"],
	[["--plan-sha256", "0".repeat(64)], "freeze-arg-without-freeze-input"],
	[["--input", "freeze"], "arg-required"],
	[["--fixture", "/x.jsonl"], "arg-unknown"],
	[["--input", "freeze", "--expect-send", "5x"], "arg-not-integer"],
] as Array<[string[], string]>) {
	const r = build(args);
	ok(r.status === 2 && refusal(r) === code && r.root === null, `${args.join(" ")} → ${code}, no root`, [r.status, refusal(r), r.root]);
}

console.log("\n# synthetic input, mock embedding");
{
	const r = build([], true);
	ok(r.status === 0 && r.receipt, "builder exits 0 with a receipt", [r.status, r.stderr.slice(0, 200)]);
	const x = r.receipt ?? {};
	ok(x.embedding === "mock" && x.embeddingStats?.truncatableRequests === 0 && x.embeddingStats?.inputs === x.extraction?.sendRows, "mock embedding: every row sent once, no truncatable request");
	ok(x.extraction?.s0Held === 1, "the runtime-assembled credential shape is held by S0", x.extraction?.s0Held);
	ok(x.store?.written === x.extraction?.sendRows && x.store?.dim === 1024 && x.store?.ftsIndexed === x.store?.written && x.store?.ftsQuery === "ok", "store: written = sent, dim 1024, FTS indexed all, query ok");
	ok(x.store?.stamp?.fingerprint === profileFingerprint(getProfile("ollama-bge-m3-1024")!), "stamp fingerprint = profile fingerprint");
	ok(x.verification?.storeUnchangedByConsumer && x.verification?.inputsUnchanged, "read-only consumer changed neither store nor inputs");
	const text = JSON.stringify(x);
	ok(!text.includes(r.root!) && !text.includes(os.homedir()) && !text.includes(REPO), "receipt carries no host path");
	if (r.root) {
		const v1 = spawnSync("bash", [path.join(r.root, "out", "verify.sh")], { encoding: "utf-8" });
		const v2 = spawnSync("bash", [path.join(r.root, "out", "verify.sh")], { encoding: "utf-8" });
		ok(v1.status === 0 && v1.stdout === v2.stdout && v1.stdout.startsWith("OK store="), "verify.sh: OK, same digests twice", v1.stdout);
		fs.appendFileSync(path.join(r.root, "data", "sessions.lance", "andenken-profile.json"), " ");
		ok(spawnSync("bash", [path.join(r.root, "out", "verify.sh")]).status !== 0, "verify.sh fails after a one-byte store change");
		fs.rmSync(r.root, { recursive: true, force: true });
	}
}

console.log("\n# freeze input (exact corpus), synthetic freeze written here");
const fz = path.join(scratch, "freeze");
const sessDir = path.join(fz, "corpus", "synth", ".pi", "agent", "sessions", "--synthetic-t--");
fs.mkdirSync(sessDir, { recursive: true });
const msg = (role: string, text: string, ts: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role, content: role === "user" ? text : [{ type: "text", text }] } });
// toolResult lines reach the 200KB discovery floor without becoming rows.
const fillers = Array.from({ length: 60 }, () => JSON.stringify({ type: "message", timestamp: "2099-01-01T00:09:00.000Z", message: { role: "toolResult", content: [{ type: "text", text: "f".repeat(3600) }] } }));
const files = ["0198aaaa-bbbb-7ccc-8ddd-000000000001", "0198aaaa-bbbb-7ccc-8ddd-000000000002"].map((id, i) => {
	const f = path.join(sessDir, `2099-01-0${i + 1}T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(f, [msg("user", `synthetic question number ${i} about lighthouses`, "2099-01-01T00:01:00.000Z"), msg("assistant", `synthetic answer ${i} `.padEnd(140, "z"), "2099-01-01T00:02:00.000Z"), ...fillers].join("\n") + "\n");
	return f;
});
fs.writeFileSync(path.join(fz, "barred.json"), JSON.stringify({ synthetic: "barred from the root by hash" }));
const rel = (f: string) => path.relative(fz, f);
const all = () => {
	const out: string[] = [];
	const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
	walk(fz);
	return out.filter((p) => rel(p) !== "freeze.json").map((p) => ({ rel: rel(p), sha256: shaFile(p), size: fs.statSync(p).size })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
};
const aggregateOf = () => sha(all().map((f) => `${f.rel}\0${f.sha256}\n`).join(""));
const profile = getProfile("ollama-bge-m3-1024")!;
const split = embedSplitFor(profile)!;
const per = await withEmbedSplit(split, async () =>
	Promise.all(files.map(async (f) => {
		const r = await extractForPolicy(f, { selection: "control-v1", s0: "whole-message-v1", pinned: true }, path.join(fz, "corpus"));
		return { file: path.relative(path.join(fz, "corpus"), f), sha256: shaFile(f), size: fs.statSync(f).size, toSendChunks: r.send.length, safetyHeldChunks: r.held.length };
	})),
);
const send = per.reduce((n, p) => n + p.toSendChunks, 0);
const writePins = () => {
	const freeze = { fixtures: aggregateOf(), sessions: files.length };
	fs.writeFileSync(path.join(fz, "freeze.json"), JSON.stringify(freeze));
	const pinLines = per.map((p) => `${p.file}\t${p.size}\t${p.sha256}`);
	const plan = {
		kind: "andenken-candidate-plan", policy: "control-v1",
		profile: { id: profile.id, fingerprint: profileFingerprint(profile) }, split,
		corpusPin: { files: per.length, sha256: sha([...pinLines].sort().join("\n")) },
		perFile: per, totals: { toSend: { chunks: send }, safetyHeld: { chunks: 0 } },
		sources: { "session-indexer.ts": shaFile(path.join(REPO, "session-indexer.ts")) },
	};
	fs.writeFileSync(path.join(scratch, "plan.json"), JSON.stringify(plan));
	return { freezeSha: shaFile(path.join(fz, "freeze.json")), aggregate: freeze.fixtures, planSha: shaFile(path.join(scratch, "plan.json")) };
};
const pins = writePins();
const freezeArgs = (o: Partial<{ freezeSha: string; aggregate: string; planSha: string; send: number; held: number }> = {}) => [
	"--input", "freeze", "--freeze-dir", fz, "--freeze-sha256", o.freezeSha ?? pins.freezeSha, "--aggregate", o.aggregate ?? pins.aggregate,
	"--plan", path.join(scratch, "plan.json"), "--plan-sha256", o.planSha ?? pins.planSha, "--expect-send", String(o.send ?? send), "--expect-held", String(o.held ?? 0),
];
{
	const before = all().map((f) => f.sha256).join() + shaFile(path.join(fz, "freeze.json"));
	const r = build(freezeArgs(), true);
	const x = r.receipt ?? {};
	ok(r.status === 0 && x.extraction?.sendRows === send && x.extraction?.s0Held === 0, `exact corpus: ${send} rows sent, 0 held`, [r.status, r.stderr.slice(0, 200)]);
	ok(x.freeze?.allowlisted === 2 && x.freeze?.barred === 1, "allowlist 2 JSONL; the non-corpus file is barred");
	ok(x.verification?.originalsRechecked === 5 && x.verification?.originalsChanged === 0, "originals (3 freeze files + freeze.json + plan) re-hashed unchanged", x.verification);
	if (r.root) {
		ok(!fs.readdirSync(r.root, { recursive: true }).some((p) => String(p).endsWith("barred.json")), "barred file never copied");
		const rows = fs.readFileSync(path.join(r.root, "out", "ROWS.tsv"), "utf-8").trim().split("\n").slice(1);
		ok(rows.length === send && rows.every((l) => /^synth\/\.pi\/agent\/sessions\/--synthetic-t--\/[^\t]+\.jsonl:\d+(#\d+)?\t/.test(l)), "ROWS.tsv: corpus-relative ids with line numbers");
		ok(spawnSync("bash", [path.join(r.root, "out", "verify.sh")]).status === 0, "verify.sh OK");
		fs.rmSync(r.root, { recursive: true, force: true });
	}
	ok(all().map((f) => f.sha256).join() + shaFile(path.join(fz, "freeze.json")) === before, "freeze dir unchanged by the run");
}
for (const [label, args, code] of [
	["wrong freeze sha", freezeArgs({ freezeSha: "0".repeat(64) }), "freeze-sha256-mismatch"],
	["wrong plan sha", freezeArgs({ planSha: "0".repeat(64) }), "plan-sha256-mismatch"],
	["wrong aggregate", freezeArgs({ aggregate: "a".repeat(64) }), "freeze-aggregate-disagrees"],
	["expect-send off by one", freezeArgs({ send: send + 1 }), "plan-totals-disagree-with-expectation"],
	["expect-held 1", freezeArgs({ held: 1 }), "plan-totals-disagree-with-expectation"],
] as Array<[string, string[], string]>) {
	const r = build(args);
	ok(r.status === 2 && refusal(r) === code, `${label} → ${code}`, [r.status, refusal(r)]);
}
{
	fs.appendFileSync(files[0], " ");
	const r = build(freezeArgs());
	ok(refusal(r) === "aggregate-recompute-mismatch", "one byte appended to a corpus file → aggregate-recompute-mismatch", refusal(r));
	fs.truncateSync(files[0], fs.statSync(files[0]).size - 1);
}
{
	const link = path.join(sessDir, "link.jsonl");
	fs.symlinkSync(files[0], link);
	const r = build(freezeArgs());
	ok(refusal(r) === "symlink-in-tree", "symlink in the freeze → symlink-in-tree", refusal(r));
	fs.rmSync(link);
}
{
	const off = path.join(fz, "corpus", "synth", ".pi", "agent", "sessions", "--real-project--");
	fs.mkdirSync(off);
	fs.copyFileSync(files[0], path.join(off, path.basename(files[0])));
	const p = writePins();
	const r = build(freezeArgs(p));
	ok(refusal(r) === "corpus-file-outside-synthetic-allowlist", "non-synthetic project dir → outside synthetic allowlist", refusal(r));
	fs.rmSync(off, { recursive: true });
	writePins();
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
