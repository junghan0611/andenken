#!/usr/bin/env tsx
/**
 * Fixture tests for the openclaw full-text index, its doors and the harvest lock —
 * run ONLY inside the namespace barrier of scripts/test-openclaw-fts-sandboxed.sh.
 *
 * Why the barrier: on 2026-11-04 an earlier run of this file reached a real host.
 * Its ssh/rsync were PATH stubs, and a `bash -c` whose stdin was a socket re-read
 * the system profile, which rewrote PATH so the real binaries ran. PATH stubs are
 * kept as an emulation layer (they record and answer the calls a publish makes);
 * they are not what keeps this test off the network. The kernel namespaces are.
 *
 * G1 — the barrier, proven before anything else loads. Only node built-ins are
 * imported statically; store / openclaw-* modules load after G1 passes.
 *   static (exit 10, no active probe on failure): a user namespace (uid_map is
 *     not the initial identity map), a network namespace other than the host's
 *     (inode passed by the launcher), loopback-only devices and no usable IPv4 /
 *     IPv6 route, only the expected mounts (read-only code view, deps, tools,
 *     store; read-write run dir), descriptors classified (no socket outside this
 *     namespace's AF_UNIX table, stdio in the run dir), the exact env allow-list,
 *     and no host HOME content, /etc, /run, repo data/ or .git visible;
 *   active (exit 11): a TCP connect to TEST-NET-1 must fail ENETUNREACH (IPv6 is
 *     labelled, not over-claimed); ssh/rsync are not on PATH; positive controls
 *     (bash under a socket stdin keeps PATH, node --import tsx, pnpm exec tsx,
 *     flock + fdinfo, a LanceDB native table, run-dir writes); and the pure
 *     judge must reject forged facts. No negative is ever run on the host.
 * --barrier-only stops after G1 with exit 0; G2 is not reached.
 *
 * G2 — the FTS contract (openclaw-fts.ts, openclaw-lock.ts, scripts/lib/openclaw-lock.sh):
 *   1. lifecycle on INDEXED rows — rows inserted before the index, then a text
 *      change, a delete and a restore of those rows — and on the unindexed tail,
 *      each asserted before and after optimize;
 *   2. the harvest lock is proven by the descriptor (same inode + fdinfo FLOCK
 *      WRITE), never by a variable;
 *   3. the fts:openclaw door — ready/--check write nothing, absent axis and a
 *      table-less directory are refused without creating anything;
 *   4. the importer — no-staged, zero-delta and dry runs never touch the index;
 *      an ensure failure after rows/cursor/receipt exits nonzero, a later no-op
 *      does not recover it, the required publish stays blocked until the
 *      explicit bootstrap;
 *   5. the opt-in required publish refuses a replica that does not answer the
 *      protocol BEFORE transfer, and one that does not print the healthy line
 *      after it; the default publish is unchanged. Every publish names
 *      `--host fixture.invalid`, and the stubs refuse any other host;
 *   6. compact openclaw and prune --apply/--restore run only inside the lock.
 *
 * Artifacts stay in the run dir: g1-report.json, run-manifest.json and, per
 * spawn, cases/case-NNN.{json,out,err,exe}. A failed run deletes nothing; a
 * fully passing run removes only its fixture stores (fx/).
 * Observations are printed as `obs` and never counted as passes.
 * Run it: `./run.sh test:openclaw-fts:barrier` (G1) or `./run.sh test:openclaw`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as dns from "node:dns";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// ═════════════════════════════════════════════════════════════════════════════
// G1 — the barrier judge: pure, then the facts it reads, then the entry.
// ═════════════════════════════════════════════════════════════════════════════

export interface BarrierContext { root: string; evidence: string; repo: string; bindir: string; hostHome: string; hostNetns: string }
export interface BarrierFacts {
	uidMap: string | null;
	netns: string | null;
	netDev: string | null;
	route: string | null;
	/** null when /proc/net/ipv6_route is absent. */
	ipv6Route: string | null;
	/** Socket inodes of THIS network namespace's AF_UNIX table; null when unreadable. */
	unixInodes: string[] | null;
	/** null when /proc/self/fd could not be enumerated; `target` null + `error` when a readlink failed other than ENOENT. */
	fds: Array<{ fd: number; target: string | null; error?: string }> | null;
	env: Record<string, string>;
	mounts: Array<{ point: string; opts: string }>;
	/** Paths that must not exist and do. */
	present: string[];
	/** Entries of the host home and the repo's parent (they may hold only the bind skeleton). */
	homeEntries: string[] | null;
	repoParentEntries: string[] | null;
	/** Entries of the run dir as seen inside (only the bound root/ and bin/ may show). */
	runEntries: string[] | null;
	/** Observation only: /proc/self/status Cpus_allowed_list. */
	cpusAllowed: string | null;
}
export interface Verdict { ok: boolean; failures: string[]; notes: string[] }

/**
 * The runtime env allow-list. The launcher sets six keys (HOME, LANG,
 * NOSYSBASHRC, PATH, pnpm_config_pm_on_fail, pnpm_config_verify_deps_before_run);
 * the seventh, PWD, appears at
 * runtime — observed in the 2026-11-04 15:48 barrier run, its setter unmeasured
 * (bwrap's --chdir is the hypothesis). PWD is accepted only when it equals the
 * read-only repo path the launcher chdirs to.
 *
 * pnpm_config_pm_on_fail=ignore: in the 15:57 run `pnpm exec` (pnpm 11.20.0
 * against packageManager pnpm@10.33.0) failed with EROFS writing a `_tmp_*` file
 * into the read-only repo. The pnpm 11 bundle reads this setting from the
 * `pnpm_config_` env prefix and, on `ignore`, does not try to switch to the
 * declared version. That this is the only cause is not proven. The value must be
 * exactly `ignore`; missing, any other value, or any other extra key fails.
 *
 * pnpm_config_verify_deps_before_run=warn: a preventive literal for the one
 * other install path the same bundle has before `exec` — a dependency-status
 * check that installs on mismatch by default and only warns on `warn`. That
 * path was not observed to fire. `warn` keeps the check (it is not `false`); the
 * value must be exactly `warn`, else the run fails.
 */
export const PNPM_PM_ON_FAIL = "ignore";
export const PNPM_VERIFY_DEPS = "warn";
const ENV_KEYS = ["HOME", "LANG", "NOSYSBASHRC", "PATH", "PWD", "pnpm_config_pm_on_fail", "pnpm_config_verify_deps_before_run"];
const RTF_REJECT = 0x0200;

/** Pure: facts in, verdict out. No I/O, no spawn. */
export function judgeBarrier(f: BarrierFacts, c: BarrierContext): Verdict {
	const failures: string[] = [];
	const notes: string[] = [];
	const under = (p: string, base: string) => p === base || p.startsWith(base + "/");

	if (f.uidMap === null) failures.push("uid_map unreadable");
	else if (/^\s*0\s+0\s+4294967295\s*$/.test(f.uidMap.trim())) failures.push("initial user namespace (identity uid_map)");

	const ns = f.netns?.match(/^net:\[(\d+)\]$/)?.[1];
	if (!ns) failures.push(`network namespace unreadable (${f.netns})`);
	else if (ns === c.hostNetns) failures.push("same network namespace as the host");

	if (f.netDev === null) failures.push("/proc/net/dev unreadable");
	else {
		const ifs = f.netDev.split("\n").slice(2).map((l) => l.split(":")[0].trim()).filter(Boolean);
		const other = ifs.filter((i) => i !== "lo");
		if (other.length) failures.push(`network devices besides lo: ${other.join(",")}`);
	}
	if (f.route === null) failures.push("/proc/net/route unreadable");
	else {
		const routes = f.route.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((x) => x[0]);
		const usable = routes.filter((x) => x[0] !== "lo");
		if (usable.length) failures.push(`IPv4 routes via ${usable.map((x) => x[0]).join(",")}`);
	}
	if (f.ipv6Route === null) notes.push("ipv6_route absent — IPv6 state unknown/disabled here");
	else {
		const rows = f.ipv6Route.split("\n").map((l) => l.trim().split(/\s+/)).filter((x) => x.length >= 10);
		const usable = rows.filter((x) => x[9] !== "lo" && (parseInt(x[8], 16) & RTF_REJECT) === 0);
		if (usable.length) failures.push(`usable IPv6 routes via ${usable.map((x) => x[9]).join(",")}`);
	}

	const roPoints = ["/nix/store", c.bindir, c.repo, `${c.repo}/node_modules`];
	const allowed = new Set(["/", "/tmp", "/proc", "/dev", c.root, ...roPoints]);
	for (const m of f.mounts) {
		if (!allowed.has(m.point) && !m.point.startsWith("/proc/") && !m.point.startsWith("/dev/")) failures.push(`unexpected mount ${m.point}`);
	}
	for (const p of roPoints) {
		const m = f.mounts.filter((x) => x.point === p);
		if (m.length === 0) failures.push(`expected mount missing: ${p}`);
		else if (!m.every((x) => x.opts.split(",").includes("ro"))) failures.push(`mount not read-only: ${p}`);
	}

	const unix = f.unixInodes === null ? null : new Set(f.unixInodes);
	if (unix === null) failures.push("/proc/net/unix unreadable");
	if (f.fds === null) failures.push("/proc/self/fd could not be enumerated (unknown)");
	for (const std of [0, 1, 2]) {
		if (f.fds !== null && !f.fds.some((x) => x.fd === std && x.target !== null)) failures.push(`fd ${std} missing or unreadable`);
	}
	for (const { fd, target, error } of f.fds ?? []) {
		if (target === null) { failures.push(`fd ${fd} readlink failed (${error ?? "unknown"})`); continue; }
		if (fd === 0) { if (target !== "/dev/null") failures.push(`fd 0 is ${target}, not /dev/null`); continue; }
		if (fd === 1 || fd === 2) { if (!under(target, c.evidence)) failures.push(`fd ${fd} is ${target}, not a log in the launcher's evidence dir`); continue; }
		const sock = target.match(/^socket:\[(\d+)\]$/)?.[1];
		if (sock !== undefined) { if (!unix?.has(sock)) failures.push(`fd ${fd} is a socket outside this namespace's AF_UNIX table`); continue; }
		if (target.startsWith("anon_inode:") || target.startsWith("pipe:")) continue;
		if ([c.root, c.repo, "/nix/store", "/dev", "/proc"].some((b) => under(target, b))) continue;
		failures.push(`fd ${fd} is ${target}`);
	}

	const keys = Object.keys(f.env).sort();
	if (JSON.stringify(keys) !== JSON.stringify(ENV_KEYS)) failures.push(`env keys ${keys.join(",")} ≠ ${ENV_KEYS.join(",")}`);
	if (f.env.PATH !== c.bindir) failures.push("PATH is not the tool directory");
	if (f.env.HOME !== `${c.root}/home`) failures.push("HOME is not the run dir home");
	if (f.env.PWD !== c.repo) failures.push("PWD is missing or not the read-only repo path");
	if (f.env.pnpm_config_pm_on_fail !== PNPM_PM_ON_FAIL) failures.push(`pnpm_config_pm_on_fail is missing or not "${PNPM_PM_ON_FAIL}"`);
	if (f.env.pnpm_config_verify_deps_before_run !== PNPM_VERIFY_DEPS) failures.push(`pnpm_config_verify_deps_before_run is missing or not "${PNPM_VERIFY_DEPS}"`);

	if (f.present.length) failures.push(`must be absent but exist: ${f.present.join(", ")}`);
	const skeleton = (entries: string[] | null, allowedNames: string[], what: string) => {
		if (entries === null) return;
		const extra = entries.filter((e) => !allowedNames.includes(e));
		if (extra.length) failures.push(`${what} shows host entries: ${extra.slice(0, 5).join(", ")}`);
	};
	const firstBelow = (base: string, p: string) => (under(p, base) && p !== base ? p.slice(base.length + 1).split("/")[0] : null);
	skeleton(f.homeEntries, [firstBelow(c.hostHome, c.root), firstBelow(c.hostHome, c.repo)].filter((x): x is string => !!x), "host home");
	skeleton(f.repoParentEntries, [path.basename(c.repo)], "repo parent");
	skeleton(f.runEntries, [path.basename(c.root), ...(path.dirname(c.bindir) === path.dirname(c.root) ? [path.basename(c.bindir)] : [])], "run dir");

	return { ok: failures.length === 0, failures, notes };
}

function readOr(p: string): string | null {
	try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}
function listOr(p: string): string[] | null {
	try { return fs.readdirSync(p); } catch { return null; }
}
export function readBarrierFacts(c: BarrierContext): BarrierFacts {
	const names = listOr("/proc/self/fd");
	const fds: BarrierFacts["fds"] = names === null ? null : [];
	for (const n of names ?? []) {
		try { fds!.push({ fd: Number(n), target: fs.readlinkSync(`/proc/self/fd/${n}`) }); }
		catch (e) {
			const code = (e as NodeJS.ErrnoException).code ?? "unknown";
			if (code === "ENOENT") continue; // the listing's own transient handle, already closed
			fds!.push({ fd: Number(n), target: null, error: code });
		}
	}
	const unixTable = readOr("/proc/net/unix");
	const mountinfo = readOr("/proc/self/mountinfo") ?? "";
	const sensitive = [
		...[".ssh", ".env.local", ".config", ".pi", ".claude", ".gnupg", ".cache", ".netrc", ".aws", ".local/share", ".current-device"].map((x) => path.join(c.hostHome, x)),
		...["data", ".git", ".env", ".env.local", ".claude", ".agent-reports", ".review", "acceptance-cases.local.json", "dist"].map((x) => path.join(c.repo, x)),
		"/etc", "/run", "/sys", "/var", "/root",
		c.evidence, path.join(path.dirname(c.root), "view"),
	];
	return {
		uidMap: readOr("/proc/self/uid_map"),
		netns: (() => { try { return fs.readlinkSync("/proc/self/ns/net"); } catch { return null; } })(),
		netDev: readOr("/proc/net/dev"),
		route: readOr("/proc/net/route"),
		ipv6Route: readOr("/proc/net/ipv6_route"),
		unixInodes: unixTable === null ? null : unixTable.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[6]).filter((x): x is string => !!x),
		fds,
		env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
		mounts: mountinfo.split("\n").filter(Boolean).map((l) => {
			const x = l.split(" ");
			return { point: x[4].replace(/\\040/g, " "), opts: x[5] };
		}),
		present: sensitive.filter((p) => fs.existsSync(p)),
		homeEntries: listOr(c.hostHome),
		repoParentEntries: listOr(path.dirname(c.repo)),
		runEntries: listOr(path.dirname(c.root)),
		cpusAllowed: readOr("/proc/self/status")?.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]?.trim() ?? null,
	};
}

interface Args extends BarrierContext { barrierOnly: boolean }
function parseArgs(argv: string[]): Args | string {
	const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
	const [root, evidence, hostNetns, hostHome, repo, bindir] = ["--root", "--evidence", "--host-netns", "--host-home", "--repo", "--bindir"].map(get);
	if (!root || !evidence || !hostNetns || !hostHome || !repo || !bindir) return "missing --root/--evidence/--host-netns/--host-home/--repo/--bindir — run it through scripts/test-openclaw-fts-sandboxed.sh";
	if (!/^\d+$/.test(hostNetns)) return "--host-netns is not an inode number";
	for (const p of [root, evidence, hostHome, repo, bindir]) if (!path.isAbsolute(p)) return `${p} is not an absolute path`;
	return { root, evidence, hostNetns, hostHome, repo, bindir, barrierOnly: argv.includes("--barrier-only") };
}

// ── entry: static facts first; any failure exits 10 before anything else ─────
/** The shape of the arguments, never their values: flag → abs | digits | other | absent. */
function argvShape(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of ["--root", "--evidence", "--host-netns", "--host-home", "--repo", "--bindir"]) {
		const i = argv.indexOf(k);
		const v = i >= 0 ? argv[i + 1] : undefined;
		out[k] = v === undefined ? "absent" : /^\d+$/.test(v) ? "digits" : path.isAbsolute(v) ? "abs" : "other";
	}
	out["--barrier-only"] = argv.includes("--barrier-only") ? "present" : "absent";
	out.extra = String(argv.filter((a) => a.startsWith("--") && !(a in out)).length);
	return out;
}
const parsed = parseArgs(process.argv.slice(2));
if (typeof parsed === "string") {
	console.log(`BARRIER-REFUSED ${parsed}`);
	console.log(`G1-ARGV-SHAPE ${JSON.stringify(argvShape(process.argv.slice(2)))}`);
	process.exit(10);
}
const ARGS: Args = parsed;
console.log(`BARRIER-ENTRY pid=${process.pid}`);
const FACTS = readBarrierFacts(ARGS);
const STATIC = judgeBarrier(FACTS, ARGS);
/**
 * The static facts, sanitized, on stdout (the launcher's inner.out, outside the
 * sandbox) BEFORE any decision: nothing is written to the run dir until the
 * barrier is proven. Env values never leave; only keys and two comparisons.
 */
function sanitizedFacts(f: BarrierFacts, c: BarrierContext) {
	return {
		uidMap: f.uidMap?.trim() ?? null, netns: f.netns, hostNetns: c.hostNetns,
		netDevices: f.netDev?.split("\n").slice(2).map((l) => l.split(":")[0].trim()).filter(Boolean) ?? null,
		ipv4Routes: f.route?.split("\n").slice(1).filter((l) => l.trim()).length ?? null,
		ipv6Routes: f.ipv6Route === null ? "absent" : f.ipv6Route.split("\n").filter((l) => l.trim()).map((l) => { const x = l.trim().split(/\s+/); return `${x[1]} ${x[8]} ${x[9]}`; }),
		unixSockets: f.unixInodes?.length ?? null,
		fds: f.fds, mounts: f.mounts,
		envKeys: Object.keys(f.env).sort(), pathIsBindir: f.env.PATH === c.bindir, homeIsRunHome: f.env.HOME === `${c.root}/home`, pwdIsRepo: f.env.PWD === c.repo, pmOnFailIgnore: f.env.pnpm_config_pm_on_fail === PNPM_PM_ON_FAIL, verifyDepsWarn: f.env.pnpm_config_verify_deps_before_run === PNPM_VERIFY_DEPS,
		present: f.present, homeEntries: f.homeEntries, repoParentEntries: f.repoParentEntries, runEntries: f.runEntries,
		cpusAllowed: f.cpusAllowed,
	};
}
console.log(`G1-STATIC-FACTS ${JSON.stringify({ verdict: STATIC, facts: sanitizedFacts(FACTS, ARGS) })}`);
console.log(`\n=== G1 static: ${STATIC.ok ? "pass" : "FAIL"} ===`);
for (const x of STATIC.failures) console.log(`  FAIL ${x}`);
for (const x of STATIC.notes) console.log(`  note ${x}`);
if (!STATIC.ok) {
	console.log("BARRIER-STATIC-FAILED — no active probe, no fixture");
	process.exit(10);
}

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: string): void {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail.split("\n").slice(-6).join("\n       ")}` : ""}`); }
}
function obs(label: string, value: unknown): void {
	console.log(`  obs  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
function writeJson(p: string, v: unknown): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}

// ── G1 active: only after every static fact passed ───────────────────────────
function connectOutcome(host: string, port: number, ms = 3000): Promise<string> {
	return new Promise((resolve) => {
		const s = net.connect({ host, port });
		const t = setTimeout(() => { s.destroy(); resolve("TIMEOUT"); }, ms);
		s.once("connect", () => { clearTimeout(t); s.destroy(); resolve("CONNECTED"); });
		s.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(t); resolve(e.code ?? "ERROR"); });
	});
}
const g1Dir = path.join(ARGS.root, "g1");
fs.mkdirSync(g1Dir, { recursive: true });
const failBefore = fail;
console.log("\n=== G1 active ===");
const v4 = await connectOutcome("192.0.2.1", 9);
ok(`TCP connect to TEST-NET-1 fails ENETUNREACH (got ${v4})`, v4 === "ENETUNREACH");
let v6 = "not-run";
if (fail === failBefore) {
	v6 = await connectOutcome("2001:db8::1", 9);
	// Explicit classes only; anything else (EHOSTUNREACH = a route exists,
	// ECONNREFUSED, TIMEOUT, CONNECTED, an unknown code) fails closed.
	const V6: Record<string, string> = { ENETUNREACH: "unreachable", EADDRNOTAVAIL: "probe unavailable (≠ IPv6 disabled)", EAFNOSUPPORT: "probe unavailable (≠ IPv6 disabled)" };
	ok(`IPv6 TEST-NET connect is classified (got ${v6})`, v6 in V6);
	obs("IPv6 label", V6[v6] ?? "unclassified — failed closed");
	const dnsCode = await new Promise<string>((r) => dns.lookup("fixture.invalid", (e) => r(e ? (e.code ?? "ERROR") : "RESOLVED")));
	obs("dns.lookup(fixture.invalid) (observation only)", dnsCode);
	const tools = spawnSync("bash", ["-c", 'command -v ssh || echo none; command -v rsync || echo none; echo "${PATH%%:*}"'], { encoding: "utf-8" });
	const [sshAt, rsyncAt, firstPath] = (tools.stdout ?? "").trim().split("\n");
	ok("tool check (not an isolation proof): ssh and rsync are not on PATH", sshAt === "none" && rsyncAt === "none", tools.stdout);
	ok("positive: bash -c under a socket stdin keeps PATH = the tool directory", firstPath === ARGS.bindir, tools.stdout);
	ok("positive: /bin/sh and /usr/bin/env bash run", spawnSync("/bin/sh", ["-c", "echo ok"], { encoding: "utf-8" }).stdout.trim() === "ok" && spawnSync("/usr/bin/env", ["bash", "-c", "echo ok"], { encoding: "utf-8" }).stdout.trim() === "ok");
	fs.writeFileSync(path.join(g1Dir, "tiny.ts"), "const n: number = 41 + 1;\nconsole.log(`tiny ${n}`);\n");
	const tiny = spawnSync("node", ["--import", "tsx", path.join(g1Dir, "tiny.ts")], { cwd: ARGS.repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	ok("positive: node --import tsx runs a TS file", tiny.stdout.trim() === "tiny 42", tiny.stderr);
	const px = spawnSync("pnpm", ["exec", "tsx", "--version"], { cwd: ARGS.repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
	ok("positive: pnpm exec tsx --version (no network)", px.status === 0, px.stderr);
	obs("versions inside", { node: process.version, pnpm: spawnSync("pnpm", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).stdout.trim(), tsx: px.stdout.trim().split("\n").join(" ") });
	obs("Cpus_allowed_list inside", FACTS.cpusAllowed ?? "unreadable");
	const lk = path.join(g1Dir, "probe.lock");
	const fl = spawnSync("bash", ["-c", `exec 8>>"${lk}"; flock -n 8 && grep -c FLOCK "/proc/$BASHPID/fdinfo/8"`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	ok("positive: flock on a run-dir file shows in fdinfo", fl.stdout.trim() === "1", fl.stdout + fl.stderr);
	try {
		const lancedb = await import("@lancedb/lancedb");
		const db = await lancedb.connect(path.join(g1Dir, "native.lance"));
		const t = await db.createTable("t", [{ id: "g1", vector: [0.1, 0.2, 0.3, 0.4] }]);
		ok("positive: LanceDB native creates and counts a synthetic table", (await t.countRows()) === 1);
	} catch (e) {
		ok("positive: LanceDB native creates and counts a synthetic table", false, String(e));
	}
	const wf = path.join(g1Dir, "write.txt");
	fs.writeFileSync(wf, "w");
	ok("positive: the run dir is writable", fs.readFileSync(wf, "utf-8") === "w");

	// Pure negatives: the judge must reject forged facts (no I/O, no spawn).
	const forge = (label: string, mut: (f: BarrierFacts) => void) => {
		const f: BarrierFacts = JSON.parse(JSON.stringify(FACTS));
		mut(f);
		ok(`judge rejects: ${label}`, !judgeBarrier(f, ARGS).ok);
	};
	ok("judge accepts the observed facts", judgeBarrier(FACTS, ARGS).ok);
	forge("the initial identity uid_map", (f) => { f.uidMap = "         0          0 4294967295\n"; });
	forge("the host's network namespace", (f) => { f.netns = `net:[${ARGS.hostNetns}]`; });
	forge("an eth0 device", (f) => { f.netDev = (f.netDev ?? "h1\nh2\n") + "  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n"; });
	forge("an IPv4 route via eth0", (f) => { f.route = "Iface\tDestination\tGateway\neth0\t00000000\t0101A8C0\t0003\n"; });
	forge("a usable IPv6 default route", (f) => { f.ipv6Route = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 eth0\n"; });
	forge("a socket from another namespace", (f) => { f.fds!.push({ fd: 9, target: "socket:[999999999]" }); });
	forge("stdout on a host path", (f) => { f.fds = f.fds!.map((x) => (x.fd === 1 ? { fd: 1, target: "/home/elsewhere/log" } : x)); });
	forge("an extra env key", (f) => { f.env.SSH_AUTH_SOCK = "/run/user/1000/agent"; });
	forge("a different PATH", (f) => { f.env.PATH = `/run/wrappers/bin:${ARGS.bindir}`; });
	forge("a PWD other than the repo", (f) => { f.env.PWD = ARGS.root; });
	forge("a missing PWD", (f) => { delete f.env.PWD; });
	forge("pnpm_config_pm_on_fail other than ignore", (f) => { f.env.pnpm_config_pm_on_fail = "download"; });
	forge("a missing pnpm_config_pm_on_fail", (f) => { delete f.env.pnpm_config_pm_on_fail; });
	forge("pnpm_config_verify_deps_before_run = install", (f) => { f.env.pnpm_config_verify_deps_before_run = "install"; });
	forge("a missing pnpm_config_verify_deps_before_run", (f) => { delete f.env.pnpm_config_verify_deps_before_run; });
	forge("an unexpected mount", (f) => { f.mounts.push({ point: path.join(ARGS.hostHome, ".ssh"), opts: "ro" }); });
	forge("a writable repo mount", (f) => { f.mounts = f.mounts.map((m) => (m.point === ARGS.repo ? { ...m, opts: "rw,nosuid" } : m)); });
	forge("repo data/ visible", (f) => { f.present.push(path.join(ARGS.repo, "data")); });
	forge("other host home entries", (f) => { f.homeEntries = [...(f.homeEntries ?? []), ".ssh"]; });
	forge("an FD enumeration that failed", (f) => { f.fds = null; });
	forge("a readlink failure other than ENOENT", (f) => { f.fds!.push({ fd: 7, target: null, error: "EACCES" }); });
	forge("a missing fd 1", (f) => { f.fds = f.fds!.filter((x) => x.fd !== 1); });
	forge("stdout inside the run dir instead of the evidence dir", (f) => { f.fds = f.fds!.map((x) => (x.fd === 1 ? { fd: 1, target: path.join(ARGS.root, "x.log") } : x)); });
	forge("the evidence dir visible inside", (f) => { f.present.push(ARGS.evidence); });
}
const G1_ACTIVE_OK = fail === failBefore;
writeJson(path.join(ARGS.root, "g1-report.json"), {
	static: STATIC,
	active: { ok: G1_ACTIVE_OK, ipv4: v4, ipv6: v6, passed: pass, failed: fail - failBefore },
	facts: sanitizedFacts(FACTS, ARGS),
});
if (!G1_ACTIVE_OK) {
	writeJson(path.join(ARGS.root, "run-manifest.json"), { mode: ARGS.barrierOnly ? "barrier" : "full", g1: "active-failed", pass, fail });
	console.log(`\nBARRIER-ACTIVE-FAILED — no fixture (${pass} passed, ${fail} failed)`);
	process.exit(11);
}
if (ARGS.barrierOnly) {
	writeJson(path.join(ARGS.root, "run-manifest.json"), { mode: "barrier", g1: "pass", pass, fail });
	console.log(`\nBARRIER-OK (barrier-only; G2 not run) — ${pass} passed, ${fail} failed`);
	process.exit(0);
}

// ═════════════════════════════════════════════════════════════════════════════
// G2 — the FTS contract. Its modules load only now.
// ═════════════════════════════════════════════════════════════════════════════
const { VectorStore, ftsReady } = await import("./store.ts");
const { fdinfoHoldsFlockWrite } = await import("./openclaw-lock.ts");
const { OPENCLAW_FTS_PROTOCOL, OPENCLAW_FTS_HEALTHY_MARK } = await import("./openclaw-fts.ts");

const REPO = ARGS.repo;
const PROD_DATA = path.join(REPO, "data");
const ROOT = path.join(ARGS.root, "fx");
fs.mkdirSync(ROOT, { recursive: true });
const CASES = path.join(ARGS.root, "cases");
fs.mkdirSync(CASES, { recursive: true });
let caseN = 0;

interface Box { home: string; data: string; db: string; env: NodeJS.ProcessEnv }
let boxN = 0;
function box(device = "thinkpad"): Box {
	const dir = path.join(ROOT, `b${++boxN}`);
	const home = path.join(dir, "home");
	const data = path.join(dir, "data");
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(home, ".current-device"), `${device}\n`);
	// NOSYSBASHRC: NixOS /etc/bashrc returns at once instead of re-running
	// /etc/profile, which rewrites PATH (see `sh()` for why bash would read it).
	// A clean env per case: nothing inherited from the test process but PATH (the
	// tool dir), and the same fixed pnpm literals G1 verified, so a child pnpm does
	// not try to manage its own version or install dependencies again.
	const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH ?? "", LANG: "C.UTF-8", ANDENKEN_DATA: data, NOSYSBASHRC: "1", pnpm_config_pm_on_fail: PNPM_PM_ON_FAIL, pnpm_config_verify_deps_before_run: PNPM_VERIFY_DEPS };
	if (!data.startsWith(ROOT + "/")) throw new Error("box data escaped the fixture root");
	return { home, data, db: path.join(data, "openclaw.lance"), env };
}

function manifest(dir: string): string {
	if (!fs.existsSync(dir)) return "absent";
	const lines: string[] = [];
	const walk = (p: string) => {
		for (const d of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const f = path.join(p, d.name);
			if (d.isDirectory()) walk(f);
			else lines.push(`${path.relative(dir, f)}\t${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`);
		}
	};
	walk(dir);
	return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

interface Run { status: number | null; out: string; err: string; base: string }
/**
 * stdin is /dev/null on purpose. A spawnSync "pipe" is a socketpair, and bash
 * whose stdin is a socket assumes sshd started it and reads /etc/bashrc — on
 * NixOS that re-runs /etc/profile and rewrites PATH, so PATH stubs lose to the
 * real ssh/rsync. Measured 2026-11-04: stdin=pipe → PATH starts /run/wrappers/bin,
 * stdin=ignore → the stub dir; an earlier run of this file reached a real host
 * that way. The publish legs add a per-call guard on top (`pub()`).
 */
function sh(b: Box, script: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
	const n = String(++caseN).padStart(3, "0");
	const base = path.join(CASES, `case-${n}`);
	const env = { ...b.env, ...extraEnv, CASE_EXE: `${base}.exe` };
	// Each case records which binaries its own shell resolves, before the script runs.
	const exe = `{ for t in ssh rsync bash node; do printf '%s=%s\\n' "$t" "$(command -v "$t" || echo none)"; done; } > "$CASE_EXE"; `;
	const r = spawnSync("bash", ["-c", exe + script], { cwd: REPO, env, encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
	fs.writeFileSync(`${base}.out`, r.stdout ?? "");
	fs.writeFileSync(`${base}.err`, r.stderr ?? "");
	writeJson(`${base}.json`, { n, script, envKeys: Object.keys(env).sort(), status: r.status, signal: r.signal, error: r.error ? String(r.error) : null });
	return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", base };
}
const LOCKED = (cmd: string) => `. scripts/lib/openclaw-lock.sh && openclaw_lock_acquire fixture && ${cmd}`;

/** A background process that holds the lock through ITS OWN open file description. */
function holder(b: Box): ChildProcess {
	const lock = path.join(b.data, ".openclaw-harvest.lock");
	fs.mkdirSync(b.data, { recursive: true });
	const p = spawn("bash", ["-c", `exec 8>>"${lock}"; flock -n 8 || exit 9; echo held; exec sleep 60`], { env: b.env, stdio: ["ignore", "pipe", "ignore"] });
	return p;
}
async function heldBy(p: ChildProcess): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		p.stdout!.once("data", () => resolve());
		p.once("exit", (c) => reject(new Error(`holder exited ${c}`)));
	});
}

const DIM = 4096;
const VEC = Array.from({ length: DIM }, (_, i) => (i % 7) / 7);
function row(id: string, text: string, ts = "2026-11-04T00:00:00.000Z") {
	return { id, text, vector: VEC, sessionFile: "synthetic://fts", project: "ftsfixture", lineNumber: 0, timestamp: ts, role: "", source: "memory", metadata: { probe: "1" } };
}
async function withData<T>(data: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.ANDENKEN_DATA;
	process.env.ANDENKEN_DATA = data;
	try { return await fn(); }
	finally { if (prev === undefined) delete process.env.ANDENKEN_DATA; else process.env.ANDENKEN_DATA = prev; }
}
async function seedStore(db: string, rows: ReturnType<typeof row>[], withIndex: boolean): Promise<void> {
	const s = new VectorStore(db, DIM);
	await s.init();
	await s.addChunksRaw(rows);
	if (withIndex) await s.createFtsIndex();
	await s.close();
}
async function ftsIds(db: string, q: string): Promise<string[]> {
	const s = new VectorStore(db, DIM, { readOnly: true });
	await s.init();
	const r = (await s.fullTextSearch(q, 50, undefined, () => {})).map((x) => x.id);
	await s.close();
	return r;
}
async function rowCount(db: string): Promise<number> {
	const s = new VectorStore(db, DIM, { readOnly: true });
	await s.init();
	const n = await s.getCount();
	await s.close();
	return n;
}

const killers: ChildProcess[] = [];
try {
	// ═════════════════════════════════════════════════════════════════════════
	console.log("\n=== 1. lifecycle: indexed rows, then the unindexed tail, before and after optimize ===");
	{
		const b = box();
		await withData(b.data, async () => {
			const R1 = "fx:r1", R2 = "fx:r2", R3 = "fx:r3", R4 = "fx:r4";
			await seedStore(b.db, [
				row(R1, "ftsalphaqx FX7K2ID0001 탐침가나다를 보았다"),
				row(R2, "ftsbravoqx 두번째"),
				row(R3, "ftscharlieqx"),
			], false);

			const s = new VectorStore(b.db, DIM, { readOnly: true });
			await s.init();
			const h0 = await s.ftsHealth();
			ok("before the build: no index, the native query reports unavailable/no-fts-index", !h0.index && h0.query?.status === "unavailable" && (h0.query as { code?: string }).code === "no-fts-index");
			ok("createFtsIndex() on rows that already exist → created", (await s.createFtsIndex()) === "created");
			ok("createFtsIndex() again → existing (no second generation)", (await s.createFtsIndex()) === "existing");
			const h1 = await s.ftsHealth();
			ok("after the build: ready; LanceDB counts all 3 rows as INDEXED (precondition)", ftsReady(h1) && h1.indexed === 3 && h1.unindexed === 0, JSON.stringify(h1));
			await s.close();

			// changed-text update of an INDEXED row (the importer's delete + add)
			const w = new VectorStore(b.db, DIM);
			await w.init();
			await w.deleteByIds([R1]);
			await w.addChunksRaw([row(R1, "ftsalphanewqx FX7K2ID0001 새문장")]);
			// delete + restore of another INDEXED row (prune / prune --restore)
			await w.deleteByIds([R2]);
			await w.close();

			const pre = async (label: string) => {
				ok(`${label}: old text term of the updated indexed row is gone`, !(await ftsIds(b.db, "ftsalphaqx")).includes(R1));
				ok(`${label}: old Korean eojeol of the updated indexed row is gone`, !(await ftsIds(b.db, "탐침가나다를")).includes(R1));
				ok(`${label}: new text term returns the updated row`, (await ftsIds(b.db, "ftsalphanewqx")).includes(R1));
				ok(`${label}: an upper-case ID queried in lower case returns it`, (await ftsIds(b.db, "fx7k2id0001")).includes(R1));
			};
			await pre("indexed update, before optimize");
			ok("indexed delete, before optimize: the deleted row is absent", !(await ftsIds(b.db, "ftsbravoqx")).includes(R2));

			const w2 = new VectorStore(b.db, DIM);
			await w2.init();
			await w2.addChunksRaw([row(R2, "ftsbravoqx 두번째")]);
			await w2.close();
			ok("indexed restore, before optimize: the restored row returns", (await ftsIds(b.db, "ftsbravoqx")).includes(R2));

			// the unindexed tail: appended after the build, then changed
			const w3 = new VectorStore(b.db, DIM);
			await w3.init();
			await w3.addChunksRaw([row(R4, "ftsdeltaqx")]);
			await w3.close();
			ok("tail append, before optimize: found", (await ftsIds(b.db, "ftsdeltaqx")).includes(R4));
			const w4 = new VectorStore(b.db, DIM);
			await w4.init();
			await w4.deleteByIds([R4]);
			await w4.addChunksRaw([row(R4, "ftsdeltanewqx")]);
			await w4.close();
			ok("tail update, before optimize: old term gone", !(await ftsIds(b.db, "ftsdeltaqx")).includes(R4));
			ok("tail update, before optimize: new term found", (await ftsIds(b.db, "ftsdeltanewqx")).includes(R4));
			const rs = new VectorStore(b.db, DIM, { readOnly: true });
			await rs.init();
			obs("indexStats before optimize (report only)", await rs.ftsHealth());
			await rs.close();

			// optimize — the same native call `compact` makes
			const lancedb = await import("@lancedb/lancedb");
			const t = await (await lancedb.connect(b.db)).openTable("session_chunks");
			await t.optimize({ cleanupOlderThan: new Date() });

			await pre("indexed update, after optimize");
			ok("indexed delete + restore, after optimize: present once", (await ftsIds(b.db, "ftsbravoqx")).filter((i) => i === R2).length === 1);
			ok("tail, after optimize: old term gone, new term found", !(await ftsIds(b.db, "ftsdeltaqx")).includes(R4) && (await ftsIds(b.db, "ftsdeltanewqx")).includes(R4));
			ok("an untouched indexed row survives everything", (await ftsIds(b.db, "ftscharlieqx")).includes(R3));
			ok("row count after optimize = 4", (await rowCount(b.db)) === 4);
			const ra = new VectorStore(b.db, DIM, { readOnly: true });
			await ra.init();
			const h2 = await ra.ftsHealth();
			await ra.close();
			ok("after optimize: still ready", ftsReady(h2));
			obs("indexStats after optimize (report only)", h2);
		});
	}

	// ═════════════════════════════════════════════════════════════════════════
	console.log("\n=== 2. the harvest lock is the descriptor, never a variable ===");
	{
		const b = box();
		fs.mkdirSync(b.data, { recursive: true });
		const lock = path.join(b.data, ".openclaw-harvest.lock");
		const check = path.join(ROOT, "check-lock.mts");
		fs.writeFileSync(check, `import { openclawLockAbsence } from ${JSON.stringify(path.join(REPO, "openclaw-lock.ts"))};\nconst a = openclawLockAbsence();\nconsole.log(a === null ? "HELD" : "NOT-HELD " + a);\n`);
		const node = `node --import tsx ${check}`;

		const p = sh(b, `. scripts/lib/openclaw-lock.sh && openclaw_lock_path`);
		ok("the lock path follows ANDENKEN_DATA (fixture, not repo data/)", p.out.trim() === lock && !p.out.includes(PROD_DATA), p.out);

		ok("fdinfo parser: a held FLOCK WRITE line", fdinfoHoldsFlockWrite("pos:\t0\nflags:\t02102001\nlock:\t1: FLOCK  ADVISORY  WRITE 1402667 103:03:16386093 0 EOF\n"));
		ok("fdinfo parser: a blocked waiter (->) is not held", !fdinfoHoldsFlockWrite("lock:\t1: -> FLOCK  ADVISORY  WRITE 1 1:2:3 0 EOF\n"));
		ok("fdinfo parser: no lock line", !fdinfoHoldsFlockWrite("pos:\t0\nflags:\t02\n"));

		const same = sh(b, LOCKED(node));
		ok("same open file description inherited (helper → node --import tsx) → HELD", same.out.includes("HELD") && !same.out.includes("NOT-HELD"), same.out + same.err);
		const none = sh(b, node);
		ok("no FD 8 → refused", none.out.includes("NOT-HELD"), none.out);
		const raw = sh(b, node, { ANDENKEN_OPENCLAW_LOCK_HELD: "1" });
		ok("raw ANDENKEN_OPENCLAW_LOCK_HELD=1 without the descriptor → refused", raw.out.includes("NOT-HELD"), raw.out);
		const other = path.join(b.data, "other.lock");
		const subst = sh(b, `exec 8>>"${other}"; flock -n 8; ${node}`);
		ok("FD 8 locked on a substitute file → refused", subst.out.includes("NOT-HELD") && subst.out.includes("is not"), subst.out);
		const unlocked = sh(b, `exec 8>>"${lock}"; ${node}`);
		ok("FD 8 open on the lock file but never locked → refused", unlocked.out.includes("does not hold"), unlocked.out);
		const released = sh(b, `exec 8>>"${lock}"; flock -n 8; flock -u 8; ${node}`);
		ok("FD 8 whose lock was released → refused", released.out.includes("does not hold"), released.out);
		const exited = sh(b, `flock -n "${lock}" true; exec 8>>"${lock}"; ${node}`);
		ok("a lock taken by a process that already exited → refused", exited.out.includes("does not hold"), exited.out);
		const foreign = sh(b, `exec 8>>"${lock}"; flock -n 8; mv "${lock}" "${lock}.old"; : > "${lock}"; ${node}; rm -f "${lock}.old"`);
		ok("FD 8 on the old inode after the lock file was replaced (foreign inode) → refused", foreign.out.includes("is not"), foreign.out);

		const h = holder(b);
		killers.push(h);
		await heldBy(h);
		const indep = sh(b, `exec 8>>"${lock}"; ${node}`);
		ok("an independent description while another process holds it → refused", indep.out.includes("does not hold"), indep.out);
		const busy = sh(b, LOCKED("echo ACQUIRED"));
		ok("shell helper: another holder → exit 1, nothing runs", busy.status === 1 && !busy.out.includes("ACQUIRED") && busy.err.includes("holds the lock"), busy.err);
		const rawShell = sh(b, LOCKED("echo ACQUIRED"), { ANDENKEN_OPENCLAW_LOCK_HELD: "1" });
		ok("shell helper: raw LOCK_HELD=1 while another holds → still exit 1", rawShell.status === 1 && !rawShell.out.includes("ACQUIRED"));
		h.kill();
		await new Promise((r) => h.once("exit", r));

		const nested = sh(b, LOCKED(`bash -c '. scripts/lib/openclaw-lock.sh && openclaw_lock_acquire nested && echo REENTERED'`));
		ok("shell helper: a nested entry on the inherited FD re-enters (prune --publish → publish shape)", nested.status === 0 && nested.out.includes("REENTERED"), nested.err);
	}

	// ═════════════════════════════════════════════════════════════════════════
	console.log("\n=== 3. fts:openclaw door and verify --require-fts ===");
	{
		const b = box();
		const lock = path.join(b.data, ".openclaw-harvest.lock");
		await seedStore(b.db, [row("fx:d1", "ftsdoorqx 문장"), row("fx:d2", "ftsdoortwoqx")], false);
		const m0 = manifest(b.db);

		const proto = sh(b, "./run.sh fts:openclaw --protocol");
		ok("--protocol prints the exact protocol line", proto.status === 0 && proto.out.split("\n").includes(OPENCLAW_FTS_PROTOCOL), proto.out);
		const check0 = sh(b, "./run.sh fts:openclaw --check");
		ok("--check on a missing index → exit 1", check0.status === 1, check0.out + check0.err);
		ok("--check wrote nothing and took no lock", manifest(b.db) === m0 && !fs.existsSync(lock));

		const v0 = sh(b, "./run.sh verify openclaw");
		ok("default verify on a missing index: exit 0, FTS reported as a warning, no healthy line", v0.status === 0 && v0.out.includes("⚠ FTS:") && !v0.out.includes(OPENCLAW_FTS_HEALTHY_MARK), v0.out);
		const vr0 = sh(b, "./run.sh verify openclaw --require-fts");
		ok("verify --require-fts on a missing index: exit 1, no healthy line", vr0.status === 1 && !vr0.out.includes(OPENCLAW_FTS_HEALTHY_MARK), vr0.out);
		ok("both verifies wrote nothing", manifest(b.db) === m0);
		const vmd = sh(b, "./run.sh verify md --require-fts");
		ok("--require-fts on another track → exit 2", vmd.status === 2, vmd.err);

		const other = box("someotherhost");
		fs.cpSync(b.data, other.data, { recursive: true });
		const mo = manifest(other.db);
		const auth = sh(other, "./run.sh fts:openclaw");
		ok("fts:openclaw off the authority → refused, nothing written", auth.status !== 0 && manifest(other.db) === mo && auth.err.includes("index authority"), auth.err);

		const h = holder(b);
		killers.push(h);
		await heldBy(h);
		const busy = sh(b, "./run.sh fts:openclaw");
		ok("fts:openclaw while another holds the lock → exit 1, nothing written", busy.status === 1 && manifest(b.db) === m0, busy.err);
		h.kill();
		await new Promise((r) => h.once("exit", r));

		const direct = sh(b, "node --import tsx openclaw-fts.ts");
		ok("direct node openclaw-fts.ts outside the lock → exit 1, names ./run.sh fts:openclaw", direct.status === 1 && direct.err.includes("./run.sh fts:openclaw") && manifest(b.db) === m0, direct.err);

		const build = sh(b, "./run.sh fts:openclaw");
		ok("fts:openclaw → exit 0, created", build.status === 0 && build.out.includes("openclaw FTS: created"), build.out + build.err);
		const m1 = manifest(b.db);
		ok("--check after the build → exit 0", sh(b, "./run.sh fts:openclaw --check").status === 0);
		const vr1 = sh(b, "./run.sh verify openclaw --require-fts");
		ok("verify --require-fts after the build → exit 0 and the exact healthy line", vr1.status === 0 && vr1.out.split("\n").includes(OPENCLAW_FTS_HEALTHY_MARK), vr1.out);
		const again = sh(b, "./run.sh fts:openclaw");
		ok("fts:openclaw on a ready index → exit 0, nothing written", again.status === 0 && again.out.includes("nothing written") && manifest(b.db) === m1, again.out);
		ok("rows untouched by the build", (await rowCount(b.db)) === 2);

		// absent axis, and a directory that holds no table
		const a = box();
		fs.mkdirSync(a.data, { recursive: true });
		const ca = sh(a, "./run.sh fts:openclaw --check");
		ok("absent axis: --check → exit 4, nothing created", ca.status === 4 && !fs.existsSync(a.db), ca.out);
		const ba = sh(a, "./run.sh fts:openclaw");
		ok("absent axis: fts:openclaw → exit 4, nothing created", ba.status === 4 && !fs.existsSync(a.db), ba.out + ba.err);
		const va = sh(a, "./run.sh verify openclaw --require-fts");
		ok("absent axis: verify --require-fts → exit 1", va.status === 1 && !fs.existsSync(a.db), va.out);
		fs.mkdirSync(a.db);
		const tbl = path.join(a.db, "session_chunks.lance");
		const cp = sh(a, "./run.sh fts:openclaw --check");
		ok("directory without a table: --check → exit 4, no table created", cp.status === 4 && !fs.existsSync(tbl), cp.out);
		const bp = sh(a, "./run.sh fts:openclaw");
		ok("directory without a table: fts:openclaw → exit 4, no table created", bp.status === 4 && !fs.existsSync(tbl), bp.out + bp.err);
		const vp = sh(a, "./run.sh verify openclaw");
		ok("directory without a table: default verify → exit 1, no table created", vp.status === 1 && !fs.existsSync(tbl), vp.out + vp.err);
	}

	// ═════════════════════════════════════════════════════════════════════════
	console.log("\n=== 4. importer: write-only ensure, the failure order and its recovery ===");
	const stage = (b: Box, rows: Array<{ id: string; text: string; ts: number }>) => {
		const dir = path.join(b.data, "openclaw-staging");
		fs.mkdirSync(dir, { recursive: true });
		const lines = rows.map((r) => JSON.stringify({ agent: "fxa", id: r.id, path: "/fixture/" + r.id, source: "memory", updated_at: r.ts, text: r.text, embedding: JSON.stringify(VEC) }));
		fs.writeFileSync(path.join(dir, "openclaw-chunks.jsonl.gz"), zlib.gzipSync(lines.join("\n") + "\n"));
		fs.writeFileSync(path.join(dir, "host"), "fixturehost\n");
	};
	const unstage = (b: Box) => fs.rmSync(path.join(b.data, "openclaw-staging", "openclaw-chunks.jsonl.gz"), { force: true });
	const IMPORT = "node --import tsx openclaw-importer.ts";
	const T0 = Date.UTC(2026, 10, 4, 0, 0, 0);
	const fts = (b: Box) => sh(b, "./run.sh fts:openclaw --check").status === 0;

	// stub ssh/rsync for the publish legs below
	const stubs = path.join(ROOT, "stubs");
	fs.mkdirSync(stubs, { recursive: true });
	// The stubs answer only the fixture host; any other destination is refused (98).
	fs.writeFileSync(path.join(stubs, "rsync"), `#!/usr/bin/env bash
echo "rsync $*" >> "$CALLS"
case "\${@: -1}" in fixture.invalid:*) exit 0 ;; *) echo "rsync-stub: unexpected destination \${@: -1}" >> "$CALLS"; exit 98 ;; esac
`, { mode: 0o755 });
	fs.writeFileSync(path.join(stubs, "ssh"), `#!/usr/bin/env bash
cmd="\${@: -1}"
echo "ssh $cmd" >> "$CALLS"
[ "$1" = "fixture.invalid" ] || { echo "ssh-stub: unexpected host $1" >> "$CALLS"; exit 98; }
case "$cmd" in
  *"fts:openclaw --protocol"*)
    case "\${PROTO:-modern}" in
      modern) echo "⚠ env not found"; echo "openclaw-fts-required v1" ;;
      legacy) echo "Unknown: fts:openclaw"; exit 1 ;;
      echo) echo "$cmd" ;;
      general) echo "✅ All checks passed" ;;
      future) echo "openclaw-fts-required v2" ;;
    esac ;;
  *"verify openclaw --require-fts"*)
    case "\${RVERIFY:-modern}" in
      modern) echo "✅ All checks passed"; echo "openclaw-fts-required v1: healthy" ;;
      legacy) echo "✅ All checks passed" ;;
      echo) echo "$cmd" ;;
      failing) echo "openclaw-fts-required v1: healthy"; exit 1 ;;
    esac ;;
  *) echo "remote: $cmd" ;;
esac
`, { mode: 0o755 });
	{
		const probeBox = box();
		const pr = sh(probeBox, `[ "$(command -v ssh)" = "${stubs}/ssh" ] && [ "$(command -v rsync)" = "${stubs}/rsync" ] && echo STUBBED`, { PATH: `${stubs}:${probeBox.env.PATH}` });
		if (!pr.out.includes("STUBBED")) throw new Error(`ssh/rsync do not resolve to the stubs in the test shell — refusing to run any publish leg (${pr.out}${pr.err})`);
		ok("stub routing (emulation layer, not the barrier): ssh and rsync resolve to the stubs", true);
	}
	// Stub routing guard (hygiene on top of the G1 barrier, not a substitute for
	// it): every publish leg runs only after the SAME shell resolved `ssh` and
	// `rsync` to the stubs, else it exits 97 before the script starts.
	const NET_GUARD = `[ "$(command -v ssh)" = "${stubs}/ssh" ] && [ "$(command -v rsync)" = "${stubs}/rsync" ] || { echo "NET-GUARD: ssh/rsync are not the stubs" >&2; exit 97; }`;
	const pub = (b: Box, flags: string, env: NodeJS.ProcessEnv = {}, wrap = (c: string) => c) => {
		const calls = path.join(ROOT, `calls-${crypto.randomBytes(4).toString("hex")}`);
		fs.writeFileSync(calls, "");
		const r = sh(b, `${NET_GUARD}; ${wrap(`bash scripts/sync-openclaw-to-oracle.sh --host fixture.invalid ${flags}`)}`, { PATH: `${stubs}:${b.env.PATH}`, CALLS: calls, ...env });
		if (r.status === 97) throw new Error(`network guard tripped — aborting before a real ssh/rsync could run: ${r.err}`);
		// The stub argv log is evidence of what the publish asked for: keep it with
		// the case (cases/ survives a passing run; fx/ does not).
		fs.copyFileSync(calls, `${r.base}.calls`);
		const log = fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean);
		return { ...r, rsync: log.filter((l) => l.startsWith("rsync")).length, ssh: log.filter((l) => l.startsWith("ssh")), log };
	};

	{
		// 4a. first harvest into an absent store
		const b = box();
		stage(b, [{ id: "c1", text: "ftsimportqx 하나", ts: T0 }, { id: "c2", text: "ftsimporttwoqx", ts: T0 + 1 }]);
		const r = sh(b, LOCKED(IMPORT));
		ok("first writing import → exit 0, the FTS index is created with the table", r.status === 0 && r.out.includes("FTS: created") && fts(b), r.out + r.err);
		ok("its rows are found by BM25", (await ftsIds(b.db, "ftsimportqx")).includes("fxa:c1"));
	}
	{
		// 4b–4f. a store whose index is missing, and the runs that write nothing
		const b = box();
		await seedStore(b.db, [row("fxa:c1", "ftsheldqx", new Date(T0).toISOString())], false);
		const m0 = manifest(b.db);
		stage(b, [{ id: "c1", text: "ftsheldqx", ts: T0 }]);
		const zero = sh(b, LOCKED(IMPORT));
		ok("zero-delta import (every row unchanged) → exit 0, 0 written", zero.status === 0 && zero.out.includes("0 chunks written"), zero.out + zero.err);
		ok("zero-delta import: the store is byte-identical and the index is still missing", manifest(b.db) === m0 && !fts(b));

		unstage(b);
		const none = sh(b, LOCKED(IMPORT));
		ok("no-staged import → exit 0, nothing staged", none.status === 0 && none.out.includes("nothing staged"));
		ok("no-staged import: store byte-identical, index still missing", manifest(b.db) === m0 && !fts(b));

		stage(b, [{ id: "c9", text: "ftsdryqx", ts: T0 + 9 }]);
		const wm = path.join(b.data, "openclaw-watermark.json");
		const wmBefore = fs.existsSync(wm) ? fs.readFileSync(wm, "utf-8") : "absent";
		const dry = sh(b, `${IMPORT} --dry-run`);
		ok("dry-run (direct entry, no lock) → exit 0", dry.status === 0, dry.out + dry.err);
		ok("dry-run: store byte-identical, index missing, watermark unchanged", manifest(b.db) === m0 && !fts(b) && (fs.existsSync(wm) ? fs.readFileSync(wm, "utf-8") : "absent") === wmBefore);

		const direct = sh(b, IMPORT);
		ok("direct writing import outside the lock → exit 1, names ./run.sh sync:openclaw, nothing written", direct.status === 1 && direct.err.includes("./run.sh sync:openclaw") && manifest(b.db) === m0, direct.err);
		const elsewhere = box("someotherhost");
		fs.cpSync(b.data, elsewhere.data, { recursive: true });
		const me = manifest(elsewhere.db);
		const auth = sh(elsewhere, LOCKED(IMPORT));
		ok("writing import off the authority (inside a lock) → exit 1, nothing written", auth.status === 1 && auth.err.includes("index authority") && manifest(elsewhere.db) === me, auth.err);
	}
	{
		// 4g–4h. ensure fails after rows/cursor/receipt; a no-op does not recover it;
		// the required publish stays blocked until the explicit bootstrap.
		const b = box();
		await seedStore(b.db, [row("fxa:c1", "ftsheldqx", new Date(T0).toISOString())], false);
		stage(b, [{ id: "c1", text: "ftsheldqx", ts: T0 }, { id: "c2", text: "ftsnewrowqx", ts: T0 + 5 }]);
		const fault = path.join(ROOT, "fts-fault.mts");
		fs.writeFileSync(fault, `import { VectorStore } from ${JSON.stringify(path.join(REPO, "store.ts"))};\nVectorStore.prototype.createFtsIndex = async function () { throw new Error("injected FTS failure"); };\n`);
		const wm = path.join(b.data, "openclaw-watermark.json");
		const receipt = path.join(b.data, "openclaw-staging", "last-import.json");
		const failed = sh(b, LOCKED(`node --import tsx --import ${fault} openclaw-importer.ts`));
		ok("ensure failure → exit 1 and the injected cause is the one reported", failed.status === 1 && failed.err.includes("injected FTS failure"), failed.err);
		ok("its message says what was written and names ./run.sh fts:openclaw", failed.err.includes("1 chunks imported, watermark and receipt written") && failed.err.includes("./run.sh fts:openclaw"), failed.err);
		ok("partial effects stay: the new row is stored", (await rowCount(b.db)) === 2);
		const mark = fs.existsSync(wm) ? JSON.parse(fs.readFileSync(wm, "utf-8")) : {};
		ok("partial effects stay: the watermark advanced to the new row", mark.fxa === T0 + 5, JSON.stringify(mark));
		const rc = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf-8")) : null;
		ok("partial effects stay: the import receipt records 1 imported", rc?.imported === 1 && rc?.unchanged === 1, JSON.stringify(rc));
		ok("the index is still missing", !fts(b));
		const runsh = fs.readFileSync(path.join(REPO, "run.sh"), "utf-8");
		const syncCase = runsh.slice(runsh.indexOf("  sync:openclaw)"), runsh.indexOf("  prune:openclaw)"));
		ok("run.sh sync:openclaw chains the importer with && before the reconcile (exit 1 stops it)", /node --import tsx openclaw-importer\.ts \\\n\s+&& pnpm exec tsx openclaw-reconcile\.ts reconcile/.test(syncCase));

		unstage(b);
		const noop = sh(b, LOCKED(IMPORT));
		ok("the next no-staged run exits 0 …", noop.status === 0);
		ok("… and the index is still missing (a no-op is not a recovery)", !fts(b));
		ok("required verify stays blocked", sh(b, "./run.sh verify openclaw --require-fts").status === 1);
		const blocked = pub(b, "--require-fts");
		ok("required publish refused before transfer: exit 1, rsync 0, ssh 0", blocked.status === 1 && blocked.rsync === 0 && blocked.ssh.length === 0, blocked.err + blocked.log.join("|"));

		const boot = sh(b, "./run.sh fts:openclaw");
		ok("explicit bootstrap → created", boot.status === 0 && boot.out.includes("created"), boot.out + boot.err);
		ok("required verify now passes with the healthy line", sh(b, "./run.sh verify openclaw --require-fts").out.split("\n").includes(OPENCLAW_FTS_HEALTHY_MARK));
		const okPub = pub(b, "--require-fts");
		ok("required publish proceeds: protocol, transfer once, remote required verify", okPub.status === 0 && okPub.rsync === 1 && okPub.ssh.length === 2 && okPub.ssh[0].includes("fts:openclaw --protocol") && okPub.ssh[1].includes("verify openclaw --require-fts"), okPub.out + okPub.err + okPub.log.join("|"));
		ok("the stubbed transfer read the fixture store, not repo data/", okPub.log.some((l) => l.includes(`${b.db}/`)) && !okPub.log.some((l) => l.includes(" data/openclaw.lance/")), okPub.log.join("|"));
	}

	// ═════════════════════════════════════════════════════════════════════════
	console.log("\n=== 5. publish: opt-in required mode, strict replica answers ===");
	{
		const b = box();
		await seedStore(b.db, [row("fx:p1", "ftspubqx")], true);
		const refusedBefore = (label: string, env: NodeJS.ProcessEnv) => {
			const r = pub(b, "--require-fts", env);
			ok(`${label} → exit 1, transfer 0`, r.status === 1 && r.rsync === 0, r.err + r.log.join("|"));
		};
		refusedBefore("replica on old code (Unknown command, exit 1)", { PROTO: "legacy" });
		refusedBefore("replica that echoes the command", { PROTO: "echo" });
		refusedBefore("replica that only prints a general success", { PROTO: "general" });
		refusedBefore("replica that answers another protocol version", { PROTO: "future" });
		const legacyVerify = pub(b, "--require-fts", { RVERIFY: "legacy" });
		ok("protocol ok but the remote verify prints no healthy line → exit 1 after one transfer, says not confirmed", legacyVerify.status === 1 && legacyVerify.rsync === 1 && legacyVerify.err.includes("NOT confirmed"), legacyVerify.err);
		const echoVerify = pub(b, "--require-fts", { RVERIFY: "echo" });
		ok("remote verify that echoes the command → exit 1", echoVerify.status === 1);
		const failingVerify = pub(b, "--require-fts", { RVERIFY: "failing" });
		ok("remote verify that prints the line but exits nonzero → exit 1", failingVerify.status === 1);
		const both = pub(b, "--require-fts --no-verify");
		ok("--require-fts with --no-verify → exit 2, nothing called", both.status === 2 && both.log.length === 0);
		const dry = pub(b, "--require-fts --dry-run");
		ok("--require-fts --dry-run: checks run, rsync only as a dry run, no remote verify", dry.status === 0 && dry.log.some((l) => l.startsWith("rsync") && l.includes("--dry-run")) && dry.ssh.length === 1, dry.log.join("|"));

		const legacyStore = box();
		await seedStore(legacyStore.db, [row("fx:l1", "ftslegacyqx")], false);
		const plain = pub(legacyStore, "");
		ok("default publish (no flag) of a store without FTS is unchanged: exit 0, transfer, plain remote verify", plain.status === 0 && plain.rsync === 1 && plain.ssh.length === 1 && plain.ssh[0].includes("verify openclaw") && !plain.ssh[0].includes("--require-fts"), plain.err + plain.log.join("|"));

		const h = holder(b);
		killers.push(h);
		await heldBy(h);
		const busy = pub(b, "--require-fts");
		ok("publish while another holds the lock → exit 1, nothing called", busy.status === 1 && busy.log.length === 0, busy.err);
		const rawEnv = pub(b, "--require-fts", { ANDENKEN_OPENCLAW_LOCK_HELD: "1" });
		ok("publish with raw ANDENKEN_OPENCLAW_LOCK_HELD=1 while another holds → exit 1, nothing called", rawEnv.status === 1 && rawEnv.log.length === 0);
		h.kill();
		await new Promise((r) => h.once("exit", r));
		const nested = pub(b, "--require-fts", {}, LOCKED);
		ok("publish nested inside a held lock (prune --publish shape) re-enters and completes", nested.status === 0 && nested.rsync === 1, nested.err);
	}

	// ═════════════════════════════════════════════════════════════════════════
	console.log("\n=== 6. compact openclaw and prune writers run only inside the lock ===");
	{
		const b = box();
		await seedStore(b.db, [row("fx:k1", "ftscompactqx"), row("fx:k2", "ftscompacttwoqx")], true);
		const direct = sh(b, "node --import tsx indexer.ts compact openclaw");
		ok("direct indexer compact openclaw outside the lock → refused, names ./run.sh compact openclaw", direct.status !== 0 && direct.err.includes("./run.sh compact openclaw"), direct.err);
		const elsewhere = box("someotherhost");
		fs.cpSync(b.data, elsewhere.data, { recursive: true });
		const me = manifest(elsewhere.db);
		const auth = sh(elsewhere, "./run.sh compact openclaw");
		ok("compact openclaw off the authority → refused, nothing written", auth.status !== 0 && auth.err.includes("index authority") && manifest(elsewhere.db) === me, auth.err.slice(-300));
		const h = holder(b);
		killers.push(h);
		await heldBy(h);
		const m0 = manifest(b.db);
		const busy = sh(b, "./run.sh compact openclaw");
		ok("compact openclaw while another holds the lock → exit 1, nothing written", busy.status === 1 && manifest(b.db) === m0, busy.err);
		h.kill();
		await new Promise((r) => h.once("exit", r));
		const c = sh(b, "./run.sh compact openclaw");
		ok("./run.sh compact openclaw → exit 0; rows and FTS kept", c.status === 0 && (await rowCount(b.db)) === 2 && fts(b) && (await ftsIds(b.db, "ftscompactqx")).includes("fx:k1"), c.out + c.err);
		const sessionsCompact = fs.readFileSync(path.join(REPO, "run.sh"), "utf-8");
		ok("run.sh: other compact targets keep their old launch line", sessionsCompact.includes('run_pinned pnpm exec tsx indexer.ts compact "${1:-all}"'));

		const pr = sh(b, "node --import tsx openclaw-prune.ts --restore /nonexistent");
		ok("direct prune --restore outside the lock → exit 1, names ./run.sh prune:openclaw", pr.status === 1 && pr.err.includes("./run.sh prune:openclaw"), pr.err);
		const pa = sh(b, "node --import tsx openclaw-prune.ts --apply");
		ok("direct prune --apply outside the lock → exit 1 before any plan", pa.status === 1 && pa.err.includes("./run.sh prune:openclaw"), pa.err);
		const pl = sh(b, LOCKED("node --import tsx openclaw-prune.ts --restore /nonexistent"));
		ok("inside the lock the restore passes the lock gate (fails later on its own input)", pl.status === 1 && !pl.err.includes("harvest lock"), pl.err);
	}

	// ═════════════════════════════════════════════════════════════════════════
	console.log("\n=== 7. static wiring ===");
	{
		const pubSrc = fs.readFileSync(path.join(REPO, "scripts", "sync-openclaw-to-oracle.sh"), "utf-8");
		ok("publish script literals equal openclaw-fts.ts constants", pubSrc.includes(`FTS_PROTOCOL="${OPENCLAW_FTS_PROTOCOL}"`) && pubSrc.includes(`FTS_HEALTHY="${OPENCLAW_FTS_HEALTHY_MARK}"`));
		const runsh = fs.readFileSync(path.join(REPO, "run.sh"), "utf-8");
		ok("run.sh help shows fts:openclaw, verify --require-fts and publish --require-fts", /^\s+fts:openclaw \[--check\|--protocol\]/m.test(runsh) && runsh.includes("verify openclaw --require-fts") && runsh.includes("--require-fts: refuse before transfer"));
		const sources = ["run.sh", "scripts/export-openclaw.sh", "scripts/sync-openclaw-to-oracle.sh", "openclaw-importer.ts", "openclaw-prune.ts", "indexer.ts", "openclaw-fts.ts", "openclaw-lock.ts"];
		ok("no source reads ANDENKEN_OPENCLAW_LOCK_HELD any more", sources.every((f) => !fs.readFileSync(path.join(REPO, f), "utf-8").includes("ANDENKEN_OPENCLAW_LOCK_HELD") || f === "openclaw-lock.ts"));
		const comp = runsh.slice(runsh.indexOf("  compact)"), runsh.indexOf("  cleanup)"));
		ok("run.sh compact openclaw: lock before the node --import tsx launch", comp.indexOf("openclaw_lock_acquire") >= 0 && comp.indexOf("openclaw_lock_acquire") < comp.indexOf("node --import tsx indexer.ts compact openclaw"));
	}
} catch (err) {
	ok("G2 ran to completion", false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
	for (const k of killers) { try { k.kill(); } catch {} }
}

// Production metadata is audited by the launcher, outside: data/ is not visible here.
writeJson(path.join(ARGS.root, "run-manifest.json"), { mode: "full", g1: "pass", pass, fail, cases: caseN, fixturesKept: fail !== 0 });
if (fail === 0) fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed${fail ? ` — run dir kept: ${ARGS.root}` : ""}`);
process.exit(fail === 0 ? 0 : 1);
