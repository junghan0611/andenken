/**
 * env-mode.test.ts — SYNTHETIC suite (API 0) for ANDENKEN_ENV_MODE=process-only.
 *
 * A temp HOME holds a POISONED ~/.env.local: sourcing it creates a marker file
 * (executed), and parsing it yields an unknown profile for sessions / md /
 * OpenClaw query and a bogus corpus root (used). In process-only mode none of
 * that may happen; with the mode unset, the old behaviour is unchanged; any
 * other mode value refuses. For the TypeScript reader, ~/.env.local is also
 * swapped for a FIFO: opening it would block, so a prompt answer proves the
 * file was never opened.
 *
 * Shell entries run with a cleared env, stdin /dev/null, a stub ssh/rsync that
 * fail, an unroutable OpenClaw host and a non-authority device; nothing reaches
 * a runtime or a network.
 *
 *   ./run.sh test:env-mode
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = import.meta.dirname;
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-env-mode-"));
let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${detail ? `\n       ${detail.slice(0, 800)}` : ""}`);
	}
};

let n = 0;
function poisonedHome(): { home: string; marker: string; data: string } {
	const home = path.join(ROOT, `home-${++n}`);
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(home, ".current-device"), "testdev\n");
	const marker = path.join(home, "POISON-EXECUTED");
	fs.writeFileSync(
		path.join(home, ".env.local"),
		[
			`touch ${JSON.stringify(marker)}`,
			"export ANDENKEN_SESSION_PROFILE=poison-profile",
			"export ANDENKEN_MD_PROFILE=poison-profile",
			"export ANDENKEN_OPENCLAW_QUERY_PROFILE=poison-profile",
			"export ANDENKEN_SESSION_CORPUS=/poison/corpus",
			"export ANDENKEN_OPENCLAW_HOST=poison.invalid",
			"",
		].join("\n"),
	);
	const data = path.join(home, "data");
	fs.mkdirSync(data, { recursive: true });
	return { home, marker, data };
}

const stubs = path.join(ROOT, "stubs");
fs.mkdirSync(stubs, { recursive: true });
for (const name of ["ssh", "rsync"]) fs.writeFileSync(path.join(stubs, name), `#!/usr/bin/env bash\necho "${name}-stub $*" >&2\nexit 255\n`, { mode: 0o755 });

function baseEnv(home: string, over: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: home, LANG: "C.UTF-8", ANDENKEN_DISABLE_RECALL_TRACKING: "1", ...over };
}
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000) {
	const r = spawnSync(cmd, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: timeoutMs });
	return { status: r.status, signal: r.signal, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Child TS probe: which providers build, from which values. */
const PROBE = `
import { createSessionProviderFromEnv, createMdProviderFromEnv, createOpenclawQueryProviderFromEnv, envMode } from "./embedding-provider.ts";
const out: Record<string, unknown> = {};
try { out.mode = envMode(); } catch (e) { out.mode = "threw:" + (e as Error).message; }
for (const [k, f] of [["sessions", createSessionProviderFromEnv], ["md", createMdProviderFromEnv], ["openclaw", createOpenclawQueryProviderFromEnv]] as const) {
	try { const p = f() as { profile?: { id: string }; endpoint?: string } | null; out[k] = p ? { profile: p.profile?.id, endpoint: p.endpoint } : null; }
	catch (e) { out[k] = "threw:" + (e as Error).message; }
}
console.log("PROBE " + JSON.stringify(out));
`;
const probeFile = path.join(ROOT, "probe.mts");
fs.writeFileSync(probeFile, PROBE.replaceAll("./embedding-provider.ts", path.join(REPO, "embedding-provider.ts")));
function probe(env: NodeJS.ProcessEnv, timeoutMs = 30_000) {
	const r = run(TSX, [probeFile], env, timeoutMs);
	const line = r.out.split("\n").find((l) => l.startsWith("PROBE "));
	return { ...r, json: line ? (JSON.parse(line.slice(6)) as Record<string, unknown>) : null };
}

console.log("\n=== TypeScript layer: provider factories (sessions / md / openclaw query) ===");
{
	const h = poisonedHome();
	const d = probe(baseEnv(h.home));
	ok("default mode still reads ~/.env.local (unchanged): every namespace sees the poisoned profile and refuses it",
		d.json?.mode === "default" && d.json?.sessions === null && d.json?.md === null && String(d.json?.openclaw).includes("does not build") && d.out.includes("profile poison-profile — unknown profile"), d.out);
	const p = probe(baseEnv(h.home, { ANDENKEN_ENV_MODE: "process-only" }));
	ok("process-only, nothing in the process env: no namespace builds and the poison is never seen",
		p.json?.mode === "process-only" && p.json?.sessions === null && p.json?.md === null && p.json?.openclaw === null && !p.out.includes("poison"), p.out);
	const q = probe(baseEnv(h.home, {
		ANDENKEN_ENV_MODE: "process-only",
		ANDENKEN_SESSION_PROFILE: "ollama-bge-m3-1024",
		ANDENKEN_MD_PROFILE: "ollama-bge-m3-1024",
		ANDENKEN_MD_ENDPOINT: "http://127.0.0.1:18081",
	}));
	ok("process-only: sessions and md build from process values alone; openclaw query stays absent",
		JSON.stringify(q.json?.sessions) === JSON.stringify({ profile: "ollama-bge-m3-1024", endpoint: "http://127.0.0.1:11435" })
		&& JSON.stringify(q.json?.md) === JSON.stringify({ profile: "ollama-bge-m3-1024", endpoint: "http://127.0.0.1:18081" })
		&& q.json?.openclaw === null && !q.out.includes("poison"), q.out);
	const bad = probe(baseEnv(h.home, { ANDENKEN_ENV_MODE: "process_only" }));
	ok("an unknown mode refuses (no silent fallback to the dotenv)", String(bad.json?.mode).startsWith("threw:") && String(bad.json?.sessions).includes("not a known mode") && !bad.out.includes("poison-profile"), bad.out);
	ok("no TypeScript reader executes the dotenv", !fs.existsSync(h.marker));

	// FIFO: an open() of ~/.env.local would block; process-only must answer at once.
	const f = poisonedHome();
	fs.rmSync(path.join(f.home, ".env.local"));
	const mk = spawnSync("mkfifo", [path.join(f.home, ".env.local")]);
	if (mk.status === 0) {
		const fp = probe(baseEnv(f.home, { ANDENKEN_ENV_MODE: "process-only", ANDENKEN_SESSION_PROFILE: "ollama-bge-m3-1024" }), 20_000);
		ok("process-only never opens ~/.env.local (a FIFO there would block): answered promptly", fp.signal === null && fp.status === 0 && fp.json !== null, `${fp.signal} ${fp.out}`);
	} else {
		ok("mkfifo available for the never-opened proof", false, String(mk.stderr));
	}

	const idx = fs.readFileSync(path.join(REPO, "index.ts"), "utf-8");
	const body = idx.slice(idx.indexOf("function loadEnvLocal(): void {"), idx.indexOf("function wrapForExtension"));
	ok("pi extension loadEnvLocal returns on process-only before it touches the file (static)",
		body.indexOf('if (envMode() === "process-only") return;') > 0 && body.indexOf('if (envMode() === "process-only") return;') < body.indexOf("readFileSync"), body.slice(0, 400));
}

console.log("\n=== shell layer: run.sh load_env and child scripts ===");
const sh = (h: { home: string; data: string }, args: string[], over: Record<string, string> = {}) =>
	run("bash", ["run.sh", ...args], baseEnv(h.home, { ANDENKEN_DATA: h.data, ANDENKEN_INDEX_AUTHORITY: "thinkpad", ...over }), 120_000);
{
	// sessions: sync:sessions --global refuses after load_env, before any gather
	const a = poisonedHome();
	const ad = sh(a, ["sync:sessions", "--global"]);
	ok("sessions, default: run.sh sources ~/.env.local (unchanged)", fs.existsSync(a.marker), ad.out);
	const b = poisonedHome();
	const bp = sh(b, ["sync:sessions", "--global"], { ANDENKEN_ENV_MODE: "process-only" });
	ok("sessions, process-only: not sourced, the refusal still happens, nothing gathered", !fs.existsSync(b.marker) && bp.status === 2 && bp.out.includes("env: process-only") && !bp.out.includes("poison") && !bp.out.includes("ssh-stub"), bp.out);

	// md: index:md with no process profile refuses by name; the poison is not used
	const c = poisonedHome();
	const cp = sh(c, ["index:md"], { ANDENKEN_ENV_MODE: "process-only", ANDENKEN_MD_ROOT: path.join(c.home, "empty-garden") });
	ok("md, process-only: not sourced, not parsed (no poison-profile), refused without a provider", !fs.existsSync(c.marker) && cp.status !== 0 && !cp.out.includes("poison"), cp.out);
	const c2 = poisonedHome();
	const c2d = sh(c2, ["index:md"], { ANDENKEN_MD_ROOT: path.join(c2.home, "empty-garden") });
	ok("md, default: sourced and the poisoned profile is what refuses (unchanged)", fs.existsSync(c2.marker) && c2d.out.includes("poison-profile"), c2d.out);

	// openclaw: sync:openclaw refuses at the authority gate after load_env; no ssh
	const e = poisonedHome();
	const ep = sh(e, ["sync:openclaw"], { ANDENKEN_ENV_MODE: "process-only" });
	ok("openclaw, process-only: not sourced; authority refusal; no ssh; poison host never used", !fs.existsSync(e.marker) && ep.status === 1 && ep.out.includes("only the index authority") && !ep.out.includes("ssh-stub") && !ep.out.includes("poison"), ep.out);
	const e2 = poisonedHome();
	const e2d = sh(e2, ["sync:openclaw"]);
	ok("openclaw, default: sourced (unchanged), same refusal, no ssh", fs.existsSync(e2.marker) && e2d.status === 1 && !e2d.out.includes("ssh-stub"), e2d.out);

	// unknown mode: refused before anything is sourced
	const g = poisonedHome();
	const gp = sh(g, ["sync:openclaw"], { ANDENKEN_ENV_MODE: "processonly" });
	ok("run.sh: an unknown mode → exit 2, nothing sourced", gp.status === 2 && gp.out.includes("not a known mode") && !fs.existsSync(g.marker), gp.out);

	// direct child scripts: the corpus-root fallback reads the dotenv in a subshell before --help
	for (const s of ["scripts/sync-sessions.sh", "scripts/corpus-manifest.sh", "scripts/replicate-corpus.sh"]) {
		const d1 = poisonedHome();
		const r1 = run("bash", [s, "--help"], baseEnv(d1.home));
		const d2 = poisonedHome();
		const r2 = run("bash", [s, "--help"], baseEnv(d2.home, { ANDENKEN_ENV_MODE: "process-only" }));
		const d3 = poisonedHome();
		const r3 = run("bash", [s, "--help"], baseEnv(d3.home, { ANDENKEN_ENV_MODE: "nope" }));
		ok(`${s}: default sources for the corpus root (unchanged); process-only does not; unknown mode → exit 2`,
			// The exit itself may be 1 (no corpus in the temp HOME): what matters is the marker and that both modes end alike.
			fs.existsSync(d1.marker) && !fs.existsSync(d2.marker) && r1.status === r2.status && !r2.out.includes("poison") && r3.status === 2 && !fs.existsSync(d3.marker), `${r1.status} ${r2.status} ${r3.status}\n${r2.out}`);
	}
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
