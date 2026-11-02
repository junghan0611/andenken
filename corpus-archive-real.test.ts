/**
 * The archive glue against the REAL owner helper (agent-config #32), synthetic only.
 *
 * Everything lives under one temp dir: a temp HOME with a canonical corpus, a
 * temp replica HOME with its own corpus, and a private copy of the helper. No
 * real corpus, DB, replica or network is touched; the embedding provider and
 * the indexer are stubbed (API 0), and push_replica's index rsync / ssh rm are
 * recorded, never run.
 *
 * The helper is pinned by SHA-256 (the version the coordinator fixed). The
 * suite hashes the source, refuses on a mismatch before ANY helper run, copies
 * it into the temp dir and runs only that copy (re-hashed at the end). Needs
 * git, git-annex, flock and rsync on PATH; otherwise it prints SKIPPED and exits
 * 77. The default free-space floor of the helper (5 GiB) applies, as in
 * production: the glue passes no --floor-bytes.
 *
 * Covered: the call interface (argv, --lock-fd 8 inherited, lock=caller-fd),
 * readiness without a HEAD binding (a local gather / writer with the corpus
 * ahead of HEAD), the global path (checkpoint → corpus rsync under the replica
 * lock → canonical.bundle → receive → reverse bundle → merge-log, both sides
 * then record both copies, sources are pointers in Git, no remote configured,
 * job dirs removed), a lost descriptor (75), and a real restore failure (19)
 * surfacing through sync --global as 19.
 *
 * Run: ./run.sh test:archive-real
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deepStrictEqual, ok, strictEqual } from "node:assert";

const REPO = import.meta.dirname;
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const PINNED_SHA256 = process.env.ANDENKEN_ARCHIVE_HELPER_SHA256 ?? "3c1be9b283178a7539294c0cb793dea4be5e5a596bf8cb091bf6e122d19d9bbf";
const HELPER_SOURCE = process.env.ANDENKEN_ARCHIVE_HELPER_SOURCE ?? path.join(os.homedir(), "repos", "gh", "agent-config", "skills", "memory-sync", "scripts", "corpus-archive.py");

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${String((e as Error).message ?? e).split("\n").join("\n     ")}`);
  }
}
const which = (bin: string) => spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf-8" }).stdout.trim();
const sha256 = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// --- prerequisites and the hash gate (before any helper run) ---
const missing = ["git", "git-annex", "flock", "rsync", "python3"].filter((b) => !which(b));
if (missing.length > 0 || !fs.existsSync(HELPER_SOURCE)) {
  console.log(`SKIPPED: ${missing.length ? `not on PATH: ${missing.join(", ")}` : `helper absent: ${HELPER_SOURCE}`}`);
  process.exit(77);
}
const sourceSha = sha256(HELPER_SOURCE);
if (sourceSha !== PINNED_SHA256) {
  console.log(`REFUSED helper-hash-mismatch: ${HELPER_SOURCE}\n  expected ${PINNED_SHA256}\n  actual   ${sourceSha}\nNo helper was run.`);
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-archive-real-"));
const helper = path.join(root, "helper", "corpus-archive.py");
fs.mkdirSync(path.dirname(helper), { recursive: true });
fs.copyFileSync(HELPER_SOURCE, helper);
fs.chmodSync(helper, 0o755);
strictEqual(sha256(helper), PINNED_SHA256, "private helper copy");
console.log(`helper ${PINNED_SHA256} (private copy ${helper})`);

const home = path.join(root, "home");
const corpus = path.join(home, "corpus");
const replicaHome = path.join(root, "replica-home");
const replicaCorpus = path.join(replicaHome, "corpus");
const tmpdir = path.join(root, "tmp");
const stubBin = path.join(root, "bin");
const calls = path.join(root, "calls");
for (const d of [corpus, replicaCorpus, tmpdir, stubBin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(calls, "");
fs.writeFileSync(path.join(home, ".current-device"), "dev\n");

const live = path.join(home, ".pi", "agent", "sessions", "--home-u-repos-x--");
fs.mkdirSync(live, { recursive: true });
let serial = 1;
/** A new live session above the 200KB admission floor; returns its corpus-relative path. */
function newSession(): string {
  const name = `2026-10-0${serial}T00-00-00-000Z_01900000-0000-7000-8000-00000000000${serial}.jsonl`;
  fs.writeFileSync(path.join(live, name), `${JSON.stringify({ type: "session", n: serial, pad: "x".repeat(210 * 1024) })}\n`);
  serial++;
  return path.join("dev", ".pi", "agent", "sessions", "--home-u-repos-x--", name);
}

// stdin is never a socket here: Node's default stdio pipes are socketpairs, and a
// `bash -c` with a socket on stdin takes itself for an rsh/ssh session and sources
// the system bashrc (on NixOS that resets PATH; measured: git-annex disappeared).
const sh = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`${args.join(" ")} rc=${r.status}: ${r.stderr.slice(-600)}`);
  return r.stdout.trim();
};
const git = (repo: string, ...a: string[]) => sh(repo, ["git", ...a], { ...process.env, HOME: repo === corpus ? home : replicaHome });

const ATTRS = `*.jsonl annex.backend=SHA256E annex.largefiles=anything
session.sqlite annex.backend=SHA256E annex.largefiles=anything
/MANIFEST.json annex.largefiles=nothing
/MANIFEST.sha256 annex.largefiles=nothing
/CLAUDE.md annex.largefiles=nothing
/README.md annex.largefiles=nothing
/.gitattributes annex.largefiles=nothing
`;
function initRepo(repo: string, name: string, dotfiles: "branch" | "local") {
  git(repo, "init", "-q", "-b", "main", ".");
  git(repo, "config", "user.name", "fixture");
  git(repo, "config", "user.email", "fixture@invalid");
  git(repo, "annex", "init", "-q", name);
  git(repo, "config", "gc.pruneExpire", "never");
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "maintenance.auto", "false");
  if (dotfiles === "branch") git(repo, "annex", "config", "--set", "annex.dotfiles", "true");
  else git(repo, "config", "annex.dotfiles", "true");
}

// --- stubs: ssh/rsync act on the temp replica; provider / indexer / verify recorded ---
const realRsync = which("rsync");
const realNode = process.execPath;
const stub = (name: string, body: string) => fs.writeFileSync(path.join(stubBin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
// ssh: only target `rephost`, and only the custody command and the replica job
// area are executed (as the replica: its HOME). push_replica's index commands go
// to `oracle` and anything naming an andenken data path is recorded, never run.
stub("ssh", `while [ "$1" = "-o" ]; do shift 2; done; target="$1"; shift; cmd="$*"
echo "ssh $target $cmd" >>"${calls}"
[ "$target" = rephost ] || exit 0
if [ "$cmd" = 'printf %s "$HOME"' ]; then printf %s "${replicaHome}"; exit 0; fi
case "$cmd" in
  *"/repos/gh/andenken/data"*) exit 0 ;;
  "exec 8>>${replicaCorpus}/.git/corpus-custody.lock && flock -n 8 || exit 75;"*) ;;
  *"${replicaHome}/.cache/andenken"*) ;;
  *) exit 0 ;;
esac
HOME="${replicaHome}" exec bash -c "$cmd"`);
// rsync: \`rephost:\` paths become local paths under the replica HOME (the corpus
// transfer keeps its --rsync-path flock, run around the local rsync); any other
// remote (push_replica's oracle:…) is recorded only; local copies are real.
stub("rsync", `echo "rsync $*" >>"${calls}"
args=(); lock=""
for a in "$@"; do
  case "$a" in
    --rsync-path=*) lock="\${a#--rsync-path=flock -n }"; lock="\${lock% rsync}"; lock="\${lock//\\\\/}" ;;
    rephost:*) args+=("\${a#rephost:}") ;;
    *:*) exit 0 ;;
    *) args+=("$a") ;;
  esac
done
if [ -n "$lock" ]; then exec flock -n "$lock" ${realRsync} "\${args[@]}"; fi
exec ${realRsync} "\${args[@]}"`);
stub("pnpm", `case "$*" in
  "exec tsx indexer.ts policy") exec "${TSX}" "${REPO}/indexer.ts" policy ;;
  "exec tsx indexer.ts status --json") echo "pnpm status" >>"${calls}"; echo '{"sessions":{"actual_dim":4096,"to_index":1,"count":5}}' ;;
  "exec tsx indexer.ts verify sessions") echo "pnpm verify" >>"${calls}" ;;
  *) echo "pnpm $*" >>"${calls}"; exit 99 ;;
esac`);
stub("curl", `echo "curl" >>"${calls}"; python3 -c 'import json; print(json.dumps({"data":[{"embedding":[0]*4096}]}))'`);
stub("node", `if [ "$1 $2" = "--import tsx" ] && [[ "$3" == *.ts ]]; then
  c=missing
  if [ "$(stat -L -c %d:%i /proc/$$/fd/8 2>/dev/null)" = "$(stat -c %d:%i "$ANDENKEN_SESSION_CORPUS/.git/corpus-custody.lock" 2>/dev/null)" ] && flock -n 8; then c=held; fi
  n="$3"; [ "$n" = indexer.ts ] && n=indexer
  echo "node $n $4 custody=$c" >>"${calls}"; exit 0
fi
exec ${JSON.stringify(realNode)} "$@"`);

const fakeRepo = path.join(root, "repo");
fs.cpSync(path.join(REPO, "scripts"), path.join(fakeRepo, "scripts"), { recursive: true });
fs.mkdirSync(path.join(fakeRepo, "data"), { recursive: true });

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = {
    PATH: `${stubBin}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: tmpdir,
    ANDENKEN_SESSION_CORPUS: corpus,
    ANDENKEN_CORPUS_ARCHIVE_HELPER: helper,
    ANDENKEN_INDEX_AUTHORITY: "dev",
    ANDENKEN_DATA: path.join(fakeRepo, "data"),
    ANDENKEN_DISABLE_RECALL_TRACKING: "1",
    OPENROUTER_API_KEY: "dummy",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
};
function run(script: string, args: string[], over: Record<string, string | undefined> = {}) {
  fs.writeFileSync(calls, "");
  const r = spawnSync("bash", [path.join(fakeRepo, "scripts", script), ...args], { cwd: root, env: env(over), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, out: r.stdout + r.stderr };
}
const lines = (f: string) => fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
/** The helper's JSON line for `phase` as the glue logged it (`corpus-archive PHASE (rc N): {…}`). */
function helperJson(out: string, phase: string, where = "corpus-archive"): Record<string, unknown> {
  const m = [...out.matchAll(new RegExp(`${where} ${phase} \\(rc \\d+\\): (\\{.*\\})`, "g"))];
  ok(m.length > 0, `no ${where} ${phase} line in:\n${out}`);
  return JSON.parse(m[m.length - 1][1]);
}
const whereis = (repo: string, rel: string) =>
  (JSON.parse(git(repo, "annex", "whereis", "--json", "--", rel).split("\n")[0]).whereis as { description: string }[]).map((w) => w.description).sort();

// --- the one-time operator steps (outside andenken): repositories, bootstrap ---
for (const [f, body] of [[".gitattributes", ATTRS], ["README.md", "synthetic corpus\n"], ["CLAUDE.md", "@AGENTS.md\n"]] as const) {
  fs.writeFileSync(path.join(corpus, f), body);
}
fs.writeFileSync(path.join(corpus, "DEVICES.json"), JSON.stringify({ devices: [{ id: "dev", state: "active", transport: "local" }, { id: "rep", state: "active", transport: "ssh", target: "rephost" }] }));
initRepo(corpus, "canonical", "branch");
{
  const r = spawnSync("bash", [path.join(fakeRepo, "scripts", "corpus-manifest.sh"), "update"], { cwd: root, env: env(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  strictEqual(r.status, 0, r.stdout + r.stderr);
}
git(corpus, "add", "--", "README.md", "CLAUDE.md", ".gitattributes");
{
  const r = spawnSync("python3", ["-I", helper, "checkpoint", "--bootstrap", "--corpus", corpus, "--standalone"], { env: env(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  strictEqual(r.status, 0, r.stdout + r.stderr);
}
const C0 = git(corpus, "rev-parse", "HEAD");
// The replica as it stands before archive mode: a plain copy of the corpus (no .git), then its own repository.
fs.cpSync(corpus, replicaCorpus, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
initRepo(replicaCorpus, "replica", "local");
console.log(`bootstrap: canonical HEAD ${C0.slice(0, 12)} (operator step, outside andenken)`);

// ============================================================================
console.log("\n# readiness without a HEAD binding (local gather, writer gate)");
let firstPath = "";
await check("local gather: real preflight on the inherited FD (lock=caller-fd, ready), copy + ledger, HEAD unchanged", () => {
  firstPath = newSession();
  const r = run("gather-corpus.sh", ["--only", "dev"]);
  strictEqual(r.status, 0, r.out);
  const pre = helperJson(r.out, "preflight");
  deepStrictEqual([pre.result, pre.lock], ["ready", "caller-fd"], JSON.stringify(pre));
  ok(fs.existsSync(path.join(corpus, firstPath)), "copied");
  ok(fs.readFileSync(path.join(corpus, "MANIFEST.json"), "utf-8").includes(path.basename(firstPath)), "ledger lists it");
  strictEqual(git(corpus, "rev-parse", "HEAD"), C0, "no commit from a local gather");
});
await check("corpus ahead of HEAD: a second gather and the writer gate (preflight + form) still pass", () => {
  const r = run("gather-corpus.sh", ["--only", "dev"]);
  strictEqual(r.status, 0, r.out);
  strictEqual(helperJson(r.out, "preflight").result, "ready");
  const w = spawnSync("bash", ["-c", `set -euo pipefail; cd ${JSON.stringify(fakeRepo)}; . scripts/lib/corpus-custody.sh; corpus_custody_acquire "$ANDENKEN_SESSION_CORPUS" t; corpus_archive_ready "$ANDENKEN_SESSION_CORPUS" t; echo READY`], { cwd: root, env: env(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  strictEqual(w.status, 0, w.stdout + w.stderr);
  ok(w.stdout.includes("READY"), w.stdout + w.stderr);
  strictEqual(git(corpus, "rev-parse", "HEAD"), C0);
});
await check("a descriptor that is not the custody lock → the real helper refuses 75, propagated with `corpus-archive-lock`", () => {
  const w = spawnSync("bash", ["-c", `cd ${JSON.stringify(fakeRepo)}; . scripts/lib/corpus-custody.sh; exec 8>>${JSON.stringify(path.join(root, "other"))}; corpus_archive_phase "$ANDENKEN_SESSION_CORPUS" preflight`], { cwd: root, env: env(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  strictEqual(w.status, 75, w.stdout + w.stderr);
  ok(w.stderr.includes("corpus-archive-lock"), w.stderr);
});

// ============================================================================
console.log("\n# sync --global: checkpoint → replicate (receive, reverse merge-log) → index publish");
await check("--global commits once, ships the corpus and the archive, both sides end with two copies, nothing left behind", () => {
  const r = run("sync-sessions.sh", ["--global"]);
  strictEqual(r.status, 0, r.out);
  // canonical: exactly one checkpoint on top of the bootstrap, sources as annex pointers
  strictEqual(git(corpus, "rev-list", "--count", `${C0}..HEAD`), "1");
  ok(git(corpus, "cat-file", "-p", `HEAD:${firstPath}`).startsWith("/annex/objects/"), "source is a pointer in Git, not raw content");
  const gatherLog = fs.readFileSync(path.join(fakeRepo, "data", ".sync-sessions.lock.gather"), "utf-8");
  strictEqual(helperJson(gatherLog, "checkpoint").result, "committed");
  // replica: received and adopted the same main
  const recv = helperJson(r.out, "receive", "replica corpus-archive");
  strictEqual(recv.result, "adopted", JSON.stringify(recv));
  strictEqual(git(replicaCorpus, "rev-parse", "main"), git(corpus, "rev-parse", "main"));
  strictEqual(helperJson(r.out, "merge-log").result, "merged");
  // location log both ways
  deepStrictEqual(whereis(corpus, firstPath).length, 2, JSON.stringify(whereis(corpus, firstPath)));
  deepStrictEqual(whereis(replicaCorpus, firstPath).length, 2, JSON.stringify(whereis(replicaCorpus, firstPath)));
  // no remote configured anywhere (nothing could be pushed), job dirs removed
  for (const repo of [corpus, replicaCorpus]) {
    const remotes = spawnSync("git", ["config", "--get-regexp", "^remote\\."], { cwd: repo, encoding: "utf-8" }).stdout.trim();
    strictEqual(remotes, "", `${repo}: ${remotes}`);
  }
  deepStrictEqual(fs.readdirSync(path.join(replicaHome, ".cache", "andenken")), [], "replica job dir removed");
  deepStrictEqual(fs.readdirSync(tmpdir).filter((n) => n.startsWith("tmp.")), [], "local bundle dir removed (mktemp dirs; tsx keeps its own cache here)");
  // the index publish followed, recorded only (never run against a real host)
  const c = lines(calls);
  ok(c.some((l) => l.startsWith("rsync") && l.includes("oracle:/home/junghan/repos/gh/andenken/data/sessions.lance/")), c.join("\n"));
  ok(c.indexOf("node indexer sessions custody=held") >= 0, c.join("\n"));
});
await check("a second --global with no new session: at most one ledger-only commit (`generated` moves), replica follows", () => {
  const head = git(corpus, "rev-parse", "HEAD");
  const r = run("sync-sessions.sh", ["--global"]);
  strictEqual(r.status, 0, r.out);
  const n = Number(git(corpus, "rev-list", "--count", `${head}..HEAD`));
  ok(n <= 1, `commits: ${n}`);
  if (n === 1) deepStrictEqual(git(corpus, "diff", "--name-only", head, "HEAD").split("\n").sort(), ["MANIFEST.json"]);
  console.log(`     (observed: ${n} commit(s) for an unchanged corpus${n ? " — MANIFEST.json only" : ""})`);
  strictEqual(git(replicaCorpus, "rev-parse", "main"), git(corpus, "rev-parse", "HEAD"));
});

// ============================================================================
console.log("\n# a real restore failure (19), through sync --global");
await check("checkpoint whose staging AND restore fail → helper 19 → sync exits 19 (`corpus-archive-restore-failed`), indexer never launched, nothing shipped", () => {
  // The owner's own technique (test-corpus-archive.py fake_bin): annex add reports one failed
  // record, then the git wrapper refuses the restoring update-index. Passed as --annex-bin.
  const fb = path.join(root, "fakebin");
  fs.mkdirSync(fb);
  const mark = path.join(root, "refuse-update-index");
  fs.writeFileSync(path.join(fb, "git-annex"), `#!/bin/sh\n"${which("git-annex")}" "$@"; rc=$?\nif [ "$1" = add ]; then touch "${mark}"; echo '{"command":"add","file":"injected","success":false}'; fi\nexit $rc\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fb, "git"), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = update-index ] && [ -e "${mark}" ]; then echo "fixture: update-index refused" >&2; exit 1; fi; done\nexec "${which("git")}" "$@"\n`, { mode: 0o755 });
  newSession();
  const head = git(corpus, "rev-parse", "HEAD");
  const r = run("sync-sessions.sh", ["--global"], { ANDENKEN_CORPUS_ANNEX_BIN: fb });
  strictEqual(r.status, 19, r.out);
  ok(r.out.includes("REFUSED corpus-archive-restore-failed"), r.out);
  strictEqual(helperJson(fs.readFileSync(path.join(fakeRepo, "data", ".sync-sessions.lock.gather"), "utf-8"), "checkpoint").error, "restore");
  strictEqual(git(corpus, "rev-parse", "HEAD"), head, "no commit");
  const c = lines(calls);
  ok(!c.some((l) => l.startsWith("node ") || l.includes("oracle") || l.includes("corpus-custody.lock")), c.join("\n"));
});

strictEqual(sha256(helper), PINNED_SHA256, "helper copy unchanged at the end");
spawnSync("chmod", ["-R", "u+w", root]); // annex object dirs are read-only
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
