#!/usr/bin/env tsx
/**
 * Fixture tests for the openclaw full-text index, its doors and the harvest lock.
 *
 * API 0, provider 0, network 0. Every store is a synthetic one under a temp
 * ANDENKEN_DATA with a temp HOME (no ~/.env.local, so no credential reaches a
 * child), and the run asserts it never fell through to this repo's data/. Vectors
 * are shape-only. ssh and rsync are PATH stubs that only log their arguments.
 *
 * What it pins (openclaw-fts.ts, openclaw-lock.ts, scripts/lib/openclaw-lock.sh):
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
 *      after it; the default publish is unchanged;
 *   6. compact openclaw and prune --apply/--restore run only inside the lock.
 *
 * Observations are printed as `obs` and never counted as passes.
 * Run it: `./run.sh test:openclaw` (or `pnpm exec tsx openclaw-fts.test.ts`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { VectorStore, ftsReady } from "./store.ts";
import { fdinfoHoldsFlockWrite } from "./openclaw-lock.ts";
import { OPENCLAW_FTS_PROTOCOL, OPENCLAW_FTS_HEALTHY_MARK } from "./openclaw-fts.ts";

const REPO = import.meta.dirname;
const PROD_DATA = path.join(REPO, "data");

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: string): void {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail.split("\n").slice(-6).join("\n       ")}` : ""}`); }
}
function obs(label: string, value: unknown): void {
	console.log(`  obs  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

// ── isolation ────────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-oc-fts-"));
const realRoot = fs.realpathSync(ROOT);
if (realRoot.startsWith(fs.realpathSync(REPO))) throw new Error(`fixture root ${realRoot} is inside the repo`);

/** Production state by metadata only (no DB open, no content read). */
function prodShape(): string {
	const out: string[] = [];
	const walk = (p: string) => {
		if (!fs.existsSync(p)) { out.push(`${p} absent`); return; }
		const st = fs.lstatSync(p);
		if (st.isDirectory()) { for (const d of fs.readdirSync(p).sort()) walk(path.join(p, d)); return; }
		out.push(`${path.relative(PROD_DATA, p)}\t${st.size}\t${st.mtimeMs}\t${st.ino}`);
	};
	walk(path.join(PROD_DATA, "openclaw.lance"));
	walk(path.join(PROD_DATA, ".openclaw-harvest.lock"));
	walk(path.join(PROD_DATA, "openclaw-watermark.json"));
	walk(path.join(PROD_DATA, "openclaw-staging"));
	return crypto.createHash("sha256").update(out.join("\n")).digest("hex");
}
const PROD_BEFORE = prodShape();

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
	const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH ?? "", LANG: "C.UTF-8", ANDENKEN_DATA: data, NOSYSBASHRC: "1" };
	if (!data.startsWith(realRoot) && !data.startsWith(ROOT)) throw new Error("box data escaped the fixture root");
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

interface Run { status: number | null; out: string; err: string }
/**
 * stdin is /dev/null on purpose. A spawnSync "pipe" is a socketpair, and bash
 * whose stdin is a socket assumes sshd started it and reads /etc/bashrc — on
 * NixOS that re-runs /etc/profile and rewrites PATH, so PATH stubs lose to the
 * real ssh/rsync. Measured 2026-11-04: stdin=pipe → PATH starts /run/wrappers/bin,
 * stdin=ignore → the stub dir; an earlier run of this file reached a real host
 * that way. The publish legs add a per-call guard on top (`pub()`).
 */
function sh(b: Box, script: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
	const r = spawnSync("bash", ["-c", script], { cwd: REPO, env: { ...b.env, ...extraEnv }, encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
	return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
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
	fs.writeFileSync(path.join(stubs, "rsync"), `#!/usr/bin/env bash\necho "rsync $*" >> "$CALLS"\nexit 0\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(stubs, "ssh"), `#!/usr/bin/env bash
cmd="\${@: -1}"
echo "ssh $cmd" >> "$CALLS"
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
		const pr = sh(probeBox, `${"[ \"$(command -v ssh)\" = \""}${stubs}/ssh" ] && [ "$(command -v rsync)" = "${stubs}/rsync" ] && echo STUBBED`, { PATH: `${stubs}:${probeBox.env.PATH}` });
		if (!pr.out.includes("STUBBED")) throw new Error(`ssh/rsync do not resolve to the stubs in the test shell — refusing to run any publish leg (${pr.out}${pr.err})`);
		ok("network guard: ssh and rsync resolve to the stubs in the test shell", true);
	}
	// NETWORK GUARD. Every publish leg runs only after the SAME shell proved that
	// `ssh` and `rsync` resolve to the stubs; otherwise it exits 97 before the
	// script starts. And before any leg, one probe must pass or the run aborts.
	const NET_GUARD = `[ "$(command -v ssh)" = "${stubs}/ssh" ] && [ "$(command -v rsync)" = "${stubs}/rsync" ] || { echo "NET-GUARD: ssh/rsync are not the stubs" >&2; exit 97; }`;
	const pub = (b: Box, flags: string, env: NodeJS.ProcessEnv = {}, wrap = (c: string) => c) => {
		const calls = path.join(ROOT, `calls-${crypto.randomBytes(4).toString("hex")}`);
		fs.writeFileSync(calls, "");
		const r = sh(b, `${NET_GUARD}; ${wrap(`bash scripts/sync-openclaw-to-oracle.sh ${flags}`)}`, { PATH: `${stubs}:${b.env.PATH}`, CALLS: calls, ...env });
		if (r.status === 97) throw new Error(`network guard tripped — aborting before a real ssh/rsync could run: ${r.err}`);
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
} finally {
	for (const k of killers) { try { k.kill(); } catch {} }
	const after = prodShape();
	ok("production data/openclaw.lance, its lock, watermark and staging: metadata unchanged by this run", after === PROD_BEFORE);
	fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
