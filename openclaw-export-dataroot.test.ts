/**
 * openclaw-export-dataroot.test.ts — SYNTHETIC suite (API 0, no real ssh) for
 * where scripts/export-openclaw.sh cleans and stages.
 *
 * The exporter must use the same absolute data root as the importer / reconcile
 * (store.ts getDataDir) and the harvest lock (scripts/lib/openclaw-lock.sh), and
 * must refuse an invalid one BEFORE the lock and the staging cleanup.
 *
 * Each case runs a scratch copy of the exporter + lock helper whose repo-local
 * `data/` holds a DECOY staging directory and watermark; the decoy must stay
 * byte-identical in every case. The device is `cyborg` and the authority is set
 * explicitly to `cyborg` (no replica bypass). ssh/rsync are PATH stubs that log
 * and fail, the host is `fixture.invalid` (no route even for a real ssh), the
 * env is cleared to an allow-list, stdin is /dev/null. A stub routing check
 * runs in the same shell first and aborts (97) if ssh is not the stub.
 *
 *   pnpm exec tsx openclaw-export-dataroot.test.ts
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = import.meta.dirname;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-export-dataroot-"));
let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${detail ? `\n       ${detail.slice(0, 600)}` : ""}`);
	}
};

function tree(dir: string): string {
	if (!fs.existsSync(dir)) return "absent";
	const out: string[] = [];
	const walk = (d: string) => {
		for (const n of fs.readdirSync(d).sort()) {
			const f = path.join(d, n);
			const st = fs.lstatSync(f);
			if (st.isDirectory()) walk(f);
			else out.push(`${path.relative(dir, f)}\t${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`);
		}
	};
	walk(dir);
	return out.join("\n");
}

const STAGED = ["openclaw-chunks.jsonl.gz", "host", "run.json", "manifest.jsonl.gz", "status.json"];
function seedStaging(data: string, tag: string, watermarkHost: string): void {
	fs.mkdirSync(path.join(data, "openclaw-staging"), { recursive: true });
	for (const f of STAGED) fs.writeFileSync(path.join(data, "openclaw-staging", f), `${tag} ${f}\n`);
	fs.writeFileSync(path.join(data, "openclaw-watermark.json"), JSON.stringify({ _host: watermarkHost, a: 1 }) + "\n");
}

/** A scratch repo: the exporter, its lock helper, and a decoy repo-local data/. */
function scratchRepo(n: number): { repo: string; decoy: string } {
	const repo = path.join(ROOT, `repo-${n}`);
	fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
	// EXPORTER_UNDER_TEST: run the suite against another exporter copy (red proof against an older revision).
	fs.copyFileSync(process.env.EXPORTER_UNDER_TEST ?? path.join(REPO, "scripts", "export-openclaw.sh"), path.join(repo, "scripts", "export-openclaw.sh"));
	fs.copyFileSync(path.join(REPO, "scripts", "lib", "openclaw-lock.sh"), path.join(repo, "scripts", "lib", "openclaw-lock.sh"));
	const decoy = path.join(repo, "data");
	// A decoy watermark from another host: an exporter that read it in delta mode would refuse by host.
	seedStaging(decoy, "DECOY", "decoy-host");
	return { repo, decoy };
}

const stubs = path.join(ROOT, "stubs");
fs.mkdirSync(stubs, { recursive: true });
for (const name of ["ssh", "rsync"]) {
	fs.writeFileSync(path.join(stubs, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\nexit 255\n`, { mode: 0o755 });
}
const home = (device: string) => {
	const h = path.join(ROOT, `home-${device}-${crypto.randomBytes(3).toString("hex")}`);
	fs.mkdirSync(h, { recursive: true });
	fs.writeFileSync(path.join(h, ".current-device"), `${device}\n`);
	return h;
};

function runExport(repo: string, env: Record<string, string>, args: string[] = []): { status: number | null; out: string; calls: string[] } {
	const calls = path.join(ROOT, `calls-${crypto.randomBytes(4).toString("hex")}`);
	fs.writeFileSync(calls, "");
	const guard = `[ "$(command -v ssh)" = "${stubs}/ssh" ] && [ "$(command -v rsync)" = "${stubs}/rsync" ] || { echo "NET-GUARD" >&2; exit 97; }`;
	const r = spawnSync("bash", ["-c", `${guard}; exec bash scripts/export-openclaw.sh "$@"`, "export", ...args], {
		cwd: repo,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
		env: {
			PATH: `${stubs}:${process.env.PATH ?? ""}`,
			LANG: "C.UTF-8",
			CALLS: calls,
			ANDENKEN_INDEX_AUTHORITY: "cyborg",
			ANDENKEN_OPENCLAW_HOST: "fixture.invalid",
			ANDENKEN_OPENCLAW_STATUS_CMD: "off",
			...env,
		},
	});
	if (r.status === 97) throw new Error(`network guard tripped: ${r.stderr}`);
	return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls: fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean) };
}

console.log("\n=== export-openclaw.sh data root (authority cyborg, decoy repo data/) ===");

{
	// A. explicit absolute ANDENKEN_DATA: that root is cleaned, locked and read; the decoy is untouched.
	const { repo, decoy } = scratchRepo(1);
	const fresh = path.join(ROOT, "fresh-a");
	seedStaging(fresh, "STALE", "fixture.invalid");
	const decoy0 = tree(decoy);
	const r = runExport(repo, { HOME: home("cyborg"), ANDENKEN_DATA: fresh });
	ok("A: reaches the (stubbed) ssh to fixture.invalid and fails there (no real host)", r.status === 255 && r.calls.length === 1 && r.calls[0].startsWith("ssh ") && r.calls[0].includes("fixture.invalid"), r.out + r.calls.join("|"));
	ok("A: announces the resolved data root", r.out.includes(`== openclaw data root: ${fresh} ==`), r.out);
	ok("A: the delta read ANDENKEN_DATA's watermark (host matches), not the decoy's", !r.out.includes("decoy-host"), r.out);
	ok("A: stale staging in ANDENKEN_DATA was cleared before the fetch", STAGED.every((f) => !fs.existsSync(path.join(fresh, "openclaw-staging", f))));
	ok("A: the lock lives in ANDENKEN_DATA", fs.existsSync(path.join(fresh, ".openclaw-harvest.lock")) && !fs.existsSync(path.join(decoy, ".openclaw-harvest.lock")));
	ok("A: decoy repo data/ byte-identical", tree(decoy) === decoy0);
}

{
	// B. relative ANDENKEN_DATA: refused before lock and cleanup.
	const { repo, decoy } = scratchRepo(2);
	const decoy0 = tree(decoy);
	const rel = path.join(repo, "rel-data");
	seedStaging(rel, "REL", "fixture.invalid");
	const rel0 = tree(rel);
	const r = runExport(repo, { HOME: home("cyborg"), ANDENKEN_DATA: "rel-data" });
	ok("B: relative ANDENKEN_DATA → exit 2 by name, no ssh", r.status === 2 && r.out.includes("must be an absolute path") && r.calls.length === 0, r.out);
	ok("B: nothing cleaned or locked under the relative root", tree(rel) === rel0 && !fs.existsSync(path.join(rel, ".openclaw-harvest.lock")));
	ok("B: decoy byte-identical", tree(decoy) === decoy0);
}

{
	// C. ANDENKEN_DATA unset and the importer default (~/repos/gh/andenken/data) ≠ the lock default (repo data/).
	const { repo, decoy } = scratchRepo(3);
	const decoy0 = tree(decoy);
	const h = home("cyborg");
	const r = runExport(repo, { HOME: h });
	ok("C: unset + disagreeing defaults → exit 2 by name, no ssh", r.status === 2 && r.out.includes("defaults disagree") && r.calls.length === 0, r.out);
	ok("C: the decoy (the lock default) was neither cleaned nor locked", tree(decoy) === decoy0 && !fs.existsSync(path.join(decoy, ".openclaw-harvest.lock")));
	ok("C: nothing created at the importer default", !fs.existsSync(path.join(h, "repos")));
}

{
	// D. ANDENKEN_DATA names a regular file.
	const { repo, decoy } = scratchRepo(4);
	const decoy0 = tree(decoy);
	const file = path.join(ROOT, "not-a-dir");
	fs.writeFileSync(file, "x");
	const r = runExport(repo, { HOME: home("cyborg"), ANDENKEN_DATA: file });
	ok("D: a non-directory data root → exit 2, no ssh, file unchanged", r.status === 2 && r.out.includes("is not a directory") && r.calls.length === 0 && fs.readFileSync(file, "utf-8") === "x", r.out);
	ok("D: decoy byte-identical", tree(decoy) === decoy0);
}

{
	// E. not the authority: the existing gate still refuses first; the replica bypass is not set.
	const { repo, decoy } = scratchRepo(5);
	const fresh = path.join(ROOT, "fresh-e");
	seedStaging(fresh, "STALE", "fixture.invalid");
	const fresh0 = tree(fresh);
	const decoy0 = tree(decoy);
	const r = runExport(repo, { HOME: home("thinkpad"), ANDENKEN_DATA: fresh });
	ok("E: device thinkpad ≠ authority cyborg → exit 1, no ssh", r.status === 1 && r.out.includes("only the index authority 'cyborg' harvests") && r.calls.length === 0, r.out);
	ok("E: neither the data root nor the decoy changed", tree(fresh) === fresh0 && tree(decoy) === decoy0);
}

{
	// F. --full with a valid root ignores every watermark but still cleans only ANDENKEN_DATA.
	const { repo, decoy } = scratchRepo(6);
	const fresh = path.join(ROOT, "fresh-f");
	seedStaging(fresh, "STALE", "another-host");
	const decoy0 = tree(decoy);
	const r = runExport(repo, { HOME: home("cyborg"), ANDENKEN_DATA: fresh }, ["--full"]);
	ok("F: --full reaches the stubbed ssh; the watermark file in ANDENKEN_DATA is kept (only staging is cleared)", r.status === 255 && r.calls.length === 1 && fs.existsSync(path.join(fresh, "openclaw-watermark.json")), r.out);
	ok("F: decoy byte-identical", tree(decoy) === decoy0);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
