#!/usr/bin/env tsx
/**
 * Corpus archive glue (issue #18 / agent-config #32, contract v1) — API 0.
 *
 * Everything runs in a temp HOME: a corpus whose root has a `.git` directory
 * (archive mode), the fake owner helper (corpus-archive-fake.ts: the real
 * interface and the real lock check, recorded calls, settable exit codes), and
 * PATH stubs for pnpm / curl / ssh / rsync / node-indexer. The ssh stub runs the
 * replica's command locally against a replica HOME, so the replica-side custody
 * command is executed, not just matched. No provider, no host, no real corpus.
 *
 * Covered: custody acquire / re-entry / busy / foreign / missing hook; gather's
 * preflight → copy → ledger → checkpoint order and the authority-only
 * checkpoint; the Node custody check on every corpus writer and `node --import
 * tsx` vs `pnpm exec tsx`; sync-sessions end to end (custody reaches the
 * indexer, a failed checkpoint stops indexing); replicate's per-replica
 * preflight → rsync (replica lock held) → bundle → receive and its failures;
 * the retired legacy-4b path and estimate.ts on a pinned dir.
 */

import { ok, strictEqual, deepStrictEqual } from "node:assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFakeArchiveHelper } from "./corpus-archive-fake.ts";
import { CONTROL_V1_PIN, MANIFEST_POLICY_FIELD } from "./session-policy.ts";
import { makeStamp } from "./embedding-profile.ts";
import { DEAD_ENDPOINT, PROFILE, profileEnv } from "./test-support-generation.ts";

const REPO = import.meta.dirname;
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ ${name}\n     ${(msg.length > 900 ? msg.slice(0, 900) + " …" : msg).split("\n").join("\n     ")}`);
  }
}

// --- layout ----------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-archive-"));
const home = path.join(root, "home");
const corpus = path.join(home, "corpus");
const lockPath = path.join(corpus, ".git", "corpus-custody.lock");
const replicaHome = path.join(root, "replica-home");
const replicaCorpus = path.join(replicaHome, "corpus");
const replicaLock = path.join(replicaCorpus, ".git", "corpus-custody.lock");
const stubBin = path.join(root, "bin");
const calls = path.join(root, "calls");
const archiveLog = path.join(root, "archive.log");
const helper = writeFakeArchiveHelper(path.join(root, "helper"));
for (const d of [home, path.join(corpus, ".git"), path.join(replicaCorpus, ".git"), stubBin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, ".current-device"), "dev\n");
const live = path.join(home, ".pi", "agent", "sessions", "--p--");
fs.mkdirSync(live, { recursive: true });
// Above the 200KB admission floor (scripts/corpus-admit.py), so gather really copies it.
fs.writeFileSync(path.join(live, "2026-10-01T00-00-00-000Z_01900000-0000-7000-8000-000000000001.jsonl"), `${JSON.stringify({ type: "session", pad: "x".repeat(210 * 1024) })}\n`);
const roster = (devices: unknown[]) => fs.writeFileSync(path.join(corpus, "DEVICES.json"), JSON.stringify({ devices }));
roster([{ id: "dev", state: "active", transport: "local" }]);

const stub = (name: string, body: string) => fs.writeFileSync(path.join(stubBin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
// ssh: `printf %s "$HOME"` answers the replica HOME. Only two command shapes are
// EXECUTED locally as the replica (its HOME, its helper log host): the custody
// command (`exec 8>>…/.git/corpus-custody.lock …`) and commands confined to the
// replica's job area (`<replica HOME>/.cache/andenken`: mktemp, chmod, sha256sum,
// the payload cleanup). Anything naming an andenken data path, and everything
// else — e.g. push_replica's `rm -f` of absolute /home/…/andenken/data paths — is
// recorded and never run.
stub("ssh", `while [ "$1" = "-o" ]; do shift 2; done; target="$1"; shift; cmd="$*"
echo "ssh $target $cmd" >>"${calls}"
[ "\${SSH_DOWN:-0}" = "1" ] && exit 255
if [ "$cmd" = 'printf %s "$HOME"' ]; then printf %s "${replicaHome}"; exit 0; fi
case "$cmd" in
  *"/repos/gh/andenken/data"*) exit 0 ;;
  "exec 8>>${replicaHome}/"*"/.git/corpus-custody.lock && flock -n 8 || exit 75;"*) ;;
  *"${replicaHome}/.cache/andenken"*) ;;
  *) exit 0 ;;
esac
HOME="${replicaHome}" FAKE_ARCHIVE_HOST=replica bash -c "$cmd"`);
// rsync: recorded. Bundle copies (a file to target:path, or target:file back) are
// performed locally; BUNDLE_CORRUPT=1 alters the outgoing copy. The corpus
// transfer (a directory to target:) is recorded only.
stub("rsync", `echo "rsync $*" >>"${calls}"
last="\${@: -1}"; src="\${@: -2:1}"
if [ -f "$src" ] && [[ "$last" == *:* ]]; then cp "$src" "\${last#*:}"; [ "\${BUNDLE_CORRUPT:-0}" = 1 ] && echo x >>"\${last#*:}"; exit 0; fi
if [[ "$src" == *:* ]] && [ -f "\${src#*:}" ]; then cp "\${src#*:}" "$last"; exit 0; fi
case "$last" in *:*) exit "\${RSYNC_RC:-0}" ;; esac
exec ${spawnSync("bash", ["-lc", "command -v rsync"], { encoding: "utf-8" }).stdout.trim() || "/usr/bin/rsync"} "$@"`);

const baseEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: `${stubBin}:${process.env.PATH}`,
    HOME: home,
    ANDENKEN_SESSION_CORPUS: corpus,
    ANDENKEN_CORPUS_ARCHIVE_HELPER: helper,
    FAKE_ARCHIVE_LOG: archiveLog,
    ANDENKEN_INDEX_AUTHORITY: "dev",
    ANDENKEN_DATA: path.join(root, "nodata"),
    ANDENKEN_DISABLE_RECALL_TRACKING: "1",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
};
const reset = () => {
  fs.writeFileSync(calls, "");
  fs.writeFileSync(archiveLog, "");
};
const lines = (f: string) => fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
/** archive log reduced to `phase lock host` (manifest kept separately when asked). */
const phases = () => lines(archiveLog).map((l) => l.split(" ").slice(0, 3).join(" "));
function run(cmd: string, args: string[], over: Record<string, string | undefined> = {}, cwd = REPO) {
  reset();
  const r = spawnSync(cmd, args, { cwd, env: baseEnv(over), encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
}
const script = (name: string) => path.join(REPO, "scripts", name);
/** Run `body` in bash with the custody library sourced from this repo. */
const bash = (body: string, over: Record<string, string | undefined> = {}) =>
  run("bash", ["-c", `set -euo pipefail\ncd ${JSON.stringify(REPO)}\n. scripts/lib/corpus-custody.sh\n${body}`], over);

/** Hold `lock` with flock in another process until released. */
async function holdLock(lock: string): Promise<ChildProcess> {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  // One process: the shell takes the lock on its own FD and then becomes `sleep`,
  // so killing it releases the lock (flock(1) with a command forks a child that
  // would keep holding it).
  const p = spawn("bash", ["-c", `exec 9>>"$0" && flock 9 && exec sleep 60`, lock], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (spawnSync("flock", ["-n", lock, "true"]).status !== 0) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  p.kill();
  throw new Error("could not hold the lock");
}

// ============================================================================
console.log("\n# shell custody (scripts/lib/corpus-custody.sh)");
await check("no root .git → acquire is a no-op: no FD 8, no env, gather calls no helper", () => {
  const plain = path.join(home, "plain");
  fs.mkdirSync(plain, { recursive: true });
  const r = bash(`corpus_custody_acquire ${JSON.stringify(plain)} t; [ -e /proc/$$/fd/8 ] && echo FD8 || echo NOFD8; echo "env=\${ANDENKEN_CORPUS_CUSTODY_FD:-}"`);
  strictEqual(r.status, 0, r.out);
  ok(r.out.includes("NOFD8") && r.out.includes("env=\n") || r.out.trim().endsWith("env="), r.out);
  const g = run(script("gather-corpus.sh"), ["--only", "dev"], { ANDENKEN_SESSION_CORPUS: plain });
  strictEqual(g.status, 0, g.out);
  deepStrictEqual(lines(archiveLog), []);
  ok(fs.existsSync(path.join(plain, "MANIFEST.json")));
});
await check("archive mode, owner hook absent → gather exit 10 before anything is copied or recorded", () => {
  const r = run(script("gather-corpus.sh"), ["--only", "dev"], { ANDENKEN_CORPUS_ARCHIVE_HELPER: path.join(root, "no-such-helper.py") });
  strictEqual(r.status, 10, r.out);
  ok(r.out.includes("corpus-archive-hook-missing"), r.out);
  ok(!fs.existsSync(path.join(corpus, "dev")) && !fs.existsSync(path.join(corpus, "MANIFEST.json")), "nothing copied, no ledger");
});
await check("local / standalone gather: custody + preflight only, never a checkpoint", () => {
  const r = run(script("gather-corpus.sh"), ["--only", "dev"]);
  strictEqual(r.status, 0, r.out);
  deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
  ok(r.out.includes("no checkpoint (local / standalone gather"), r.out);
  ok(fs.existsSync(path.join(corpus, "dev", ".pi", "agent", "sessions", "--p--")), "copied");
  fs.rmSync(path.join(corpus, "MANIFEST.json"));
  fs.rmSync(path.join(corpus, "MANIFEST.sha256"), { force: true });
});
await check("--checkpoint on the authority: preflight (old ledger) → copy → ledger → checkpoint (new ledger), both on the caller's FD", () => {
  const r = run(script("gather-corpus.sh"), ["--only", "dev", "--checkpoint"]);
  strictEqual(r.status, 0, r.out);
  const log = lines(archiveLog);
  deepStrictEqual(phases(), ["preflight lock=caller-fd host=local", "checkpoint lock=caller-fd host=local"]);
  ok(log[0].includes("manifest=none"), log[0]);
  ok(!log[1].includes("manifest=none"), "checkpoint saw the refreshed ledger");
  strictEqual(fs.statSync(lockPath).isFile(), true);
});
await check("--checkpoint on a replica device: gathers under custody, never checkpoints", () => {
  fs.writeFileSync(path.join(home, ".current-device"), "rep\n");
  try {
    const r = run(script("gather-corpus.sh"), ["--only", "rep", "--checkpoint"]);
    strictEqual(r.status, 0, r.out);
    deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
    ok(r.out.includes("no checkpoint here"), r.out);
  } finally {
    fs.writeFileSync(path.join(home, ".current-device"), "dev\n");
  }
});
await check("--checkpoint without ~/.current-device, hostname = authority → no checkpoint (authority is the device file only)", () => {
  const host = spawnSync("hostname", { encoding: "utf-8" }).stdout.trim();
  fs.rmSync(path.join(home, ".current-device"));
  try {
    const r = run(script("gather-corpus.sh"), ["--only", host, "--checkpoint"], { ANDENKEN_INDEX_AUTHORITY: host });
    strictEqual(r.status, 0, r.out);
    deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
  } finally {
    fs.writeFileSync(path.join(home, ".current-device"), "dev\n");
  }
});
for (const [phase, rc] of [["preflight", "10"], ["checkpoint", "15"]] as const) {
  await check(`${phase} fails (rc ${rc}) → gather exits ${rc}`, () => {
    const r = run(script("gather-corpus.sh"), ["--only", "dev", "--checkpoint"], { [`FAKE_ARCHIVE_RC_${phase.toUpperCase()}`]: rc });
    strictEqual(r.status, Number(rc), r.out);
    if (phase === "preflight") deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
  });
}
await check("--strict --checkpoint with an unreachable device → exit 1, no checkpoint of an incomplete gather", () => {
  roster([{ id: "dev", state: "active", transport: "local" }, { id: "far", state: "active", transport: "ssh", target: "farhost" }]);
  try {
    const r = run(script("gather-corpus.sh"), ["--strict", "--checkpoint"], { SSH_DOWN: "1" });
    strictEqual(r.status, 1, r.out);
    deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
    ok(r.out.includes("no archive checkpoint"), r.out);
  } finally {
    roster([{ id: "dev", state: "active", transport: "local" }]);
  }
});
await check("--annex-bin: relative or missing → gather exit 2 before any helper call; an existing absolute dir is passed through", () => {
  for (const bad of ["bin", path.join(root, "no-such-bin")]) {
    const r = run(script("gather-corpus.sh"), ["--only", "dev"], { ANDENKEN_CORPUS_ANNEX_BIN: bad });
    strictEqual(r.status, 2, r.out);
    ok(r.out.includes("corpus-annex-bin-invalid"), r.out);
    deepStrictEqual(lines(archiveLog), []);
  }
  const dir = path.join(root, "annex-bin");
  fs.mkdirSync(dir, { recursive: true });
  const r = run(script("gather-corpus.sh"), ["--only", "dev"], { ANDENKEN_CORPUS_ANNEX_BIN: dir });
  strictEqual(r.status, 0, r.out);
  ok(lines(archiveLog)[0].endsWith(`--annex-bin ${dir}`), lines(archiveLog)[0]);
});
await check("custody held by another process → gather exit 75, no helper call", async () => {
  const h = await holdLock(lockPath);
  try {
    const r = run(script("gather-corpus.sh"), ["--only", "dev"]);
    strictEqual(r.status, 75, r.out);
    ok(r.out.includes("corpus-custody-busy"), r.out);
    deepStrictEqual(lines(archiveLog), []);
  } finally {
    h.kill();
  }
});
await check("read-only ledger commands (form / verify) take no custody: they run while it is held elsewhere", async () => {
  const h = await holdLock(lockPath);
  try {
    for (const c of ["form", "verify"]) {
      const r = run(script("corpus-manifest.sh"), [c]);
      strictEqual(r.status, 0, `${c}: ${r.out}`);
    }
  } finally {
    h.kill();
  }
});
await check("a parent wrapper's custody is re-entered by child gather and ledger update (same open file description)", () => {
  const r = bash(`corpus_custody_acquire ${JSON.stringify(corpus)} parent\n./scripts/gather-corpus.sh --only dev --checkpoint\n./scripts/corpus-manifest.sh update >/dev/null\necho PARENT_DONE`);
  strictEqual(r.status, 0, r.out);
  ok(r.out.includes("PARENT_DONE"), r.out);
  deepStrictEqual(phases(), ["preflight lock=caller-fd host=local", "checkpoint lock=caller-fd host=local"]);
  strictEqual((r.out.match(/corpus custody: held on FD 8/g) ?? []).length, 1, "taken once, by the parent");
});
for (const [label, pre, fdEnv] of [
  ["set to 8, FD 8 not open", "", "8"],
  ["set to 8, FD 8 open on another file", `exec 8>${JSON.stringify(path.join(root, "other"))}\n`, "8"],
  ["set to 9 (the lock never lives elsewhere)", "", "9"],
  ["set but empty", "", ""],
] as const) {
  await check(`claimed inherited custody that is lost (${label}) → 75 corpus-custody-fd-lost, the lock is NOT reopened`, () => {
    const r = bash(`${pre}corpus_custody_acquire ${JSON.stringify(corpus)} t && echo GOT
flock -n ${JSON.stringify(lockPath)} true && echo STILL_FREE`, { ANDENKEN_CORPUS_CUSTODY_FD: fdEnv });
    strictEqual(r.status, 75, r.out);
    ok(r.out.includes("corpus-custody-fd-lost") && !r.out.includes("GOT"), r.out);
    const after = spawnSync("flock", ["-n", lockPath, "true"]);
    strictEqual(after.status, 0, "nobody took the lock");
  });
}
await check("unset → standalone: takes its own (free), 75 when another holds it", async () => {
  const free = bash(`corpus_custody_acquire ${JSON.stringify(corpus)} t && echo GOT`);
  ok(free.status === 0 && free.out.includes("GOT"), free.out);
  const h = await holdLock(lockPath);
  try {
    strictEqual(bash(`corpus_custody_acquire ${JSON.stringify(corpus)} t`).status, 75);
  } finally {
    h.kill();
  }
});
await check("wrapper level: gather / ledger update launched with a claimed but absent FD 8 → 75 before any work", () => {
  for (const [cmd, args] of [[script("gather-corpus.sh"), ["--only", "dev"]], [script("corpus-manifest.sh"), ["update"]]] as const) {
    const r = run(cmd, [...args], { ANDENKEN_CORPUS_CUSTODY_FD: "8" });
    strictEqual(r.status, 75, `${cmd}: ${r.out}`);
    ok(r.out.includes("corpus-custody-fd-lost"), r.out);
    deepStrictEqual(lines(archiveLog), []);
  }
});

// ============================================================================
console.log("\n# Node custody (corpus-custody.ts)");
// One line: it travels through a bash double-quoted string.
const probe = `import { assertCorpusCustody } from ${JSON.stringify(path.join(REPO, "corpus-custody.ts"))}; try { assertCorpusCustody("probe"); console.log("CUSTODY_OK"); } catch (e) { console.error(e.message); process.exit(e.exitCode ?? 1); }`;
const nodeProbe = `node --import tsx --input-type=module -e ${JSON.stringify(probe)}`;
await check("under wrapper custody, `node --import tsx` passes the check", () => {
  const r = bash(`corpus_custody_acquire ${JSON.stringify(corpus)} t >/dev/null\n${nodeProbe}`);
  strictEqual(r.status, 0, r.out);
  ok(r.out.includes("CUSTODY_OK"), r.out);
});
await check("under wrapper custody, `pnpm exec tsx` loses FD 8 → 75 custody-fd-lost", () => {
  const r = bash(`corpus_custody_acquire ${JSON.stringify(corpus)} t >/dev/null\npnpm exec tsx -e ${JSON.stringify(probe)}`);
  strictEqual(r.status, 75, r.out);
  ok(r.out.includes("custody-fd-lost"), r.out);
});
await check("no custody descriptor at all → 75 custody-absent", () => {
  const r = bash(nodeProbe);
  strictEqual(r.status, 75, r.out);
  ok(r.out.includes("custody-absent"), r.out);
});
await check("FD 8 open on another file → 75 custody-fd-lost", () => {
  const r = bash(`exec 8>${JSON.stringify(path.join(root, "other"))}\n${nodeProbe}`, { ANDENKEN_CORPUS_CUSTODY_FD: "8" });
  strictEqual(r.status, 75, r.out);
  ok(r.out.includes("custody-fd-lost"), r.out);
});
await check("FD 8 on the lock file but the lock held through another open → 75 custody-foreign", async () => {
  const h = await holdLock(lockPath);
  try {
    const r = bash(`exec 8>>${JSON.stringify(lockPath)}\n${nodeProbe}`, { ANDENKEN_CORPUS_CUSTODY_FD: "8" });
    strictEqual(r.status, 75, r.out);
    ok(r.out.includes("custody-foreign"), r.out);
  } finally {
    h.kill();
  }
});
await check("no root .git → no check (legacy corpora unchanged)", () => {
  const r = bash(nodeProbe, { ANDENKEN_SESSION_CORPUS: path.join(home, "plain") });
  strictEqual(r.status, 0, r.out);
  ok(r.out.includes("CUSTODY_OK"), r.out);
});

// The archive marker: absent = legacy; a real directory = archive; anything else refused (10), in both languages.
const odd = (name: string, make: (g: string) => void) => {
  const c = path.join(home, `odd-${name}`);
  fs.mkdirSync(c, { recursive: true });
  make(path.join(c, ".git"));
  return c;
};
const realGitDir = path.join(root, "elsewhere-git");
fs.mkdirSync(realGitDir, { recursive: true });
const shapes: [string, string][] = [
  ["gitfile", odd("gitfile", (g) => fs.writeFileSync(g, "gitdir: /elsewhere\n"))],
  ["symlink to a directory", odd("symlink", (g) => fs.symlinkSync(realGitDir, g))],
  ["dangling symlink", odd("dangling", (g) => fs.symlinkSync(path.join(root, "nothing-here"), g))],
];
for (const [label, c] of shapes) {
  await check(`.git as a ${label} → exit 10 corpus-archive-marker-invalid (shell gather, also --dry-run; Node writer), API 0`, () => {
    for (const args of [["--only", "dev"], ["--only", "dev", "--dry-run"]]) {
      const g = run(script("gather-corpus.sh"), args, { ANDENKEN_SESSION_CORPUS: c });
      strictEqual(g.status, 10, g.out);
      ok(g.out.includes("corpus-archive-marker-invalid"), g.out);
    }
    deepStrictEqual(lines(archiveLog), []);
    ok(!fs.existsSync(path.join(c, "dev")) && !fs.existsSync(path.join(c, "MANIFEST.json")), "nothing copied, no ledger");
    const n = bash(nodeProbe, { ANDENKEN_SESSION_CORPUS: c });
    strictEqual(n.status, 10, n.out);
    ok(n.out.includes("corpus-archive-marker-invalid"), n.out);
  });
}
await check("an unreadable corpus root (lstat EACCES, not ENOENT) → 10 in both, never legacy", () => {
  const c = odd("unreadable", () => {});
  fs.chmodSync(c, 0o000);
  try {
    const g = run(script("gather-corpus.sh"), ["--only", "dev", "--dry-run"], { ANDENKEN_SESSION_CORPUS: c });
    strictEqual(g.status, 10, g.out);
    ok(g.out.includes("corpus-archive-marker-invalid"), g.out);
    const n = bash(nodeProbe, { ANDENKEN_SESSION_CORPUS: c });
    strictEqual(n.status, 10, n.out);
    ok(n.out.includes("corpus-archive-marker-invalid"), n.out);
  } finally {
    fs.chmodSync(c, 0o755);
  }
});
await check("custody lock path is a symlink → shell acquire 75 and Node 75 custody-lock-not-regular", () => {
  const c = odd("locklink", (g) => fs.mkdirSync(g));
  const target = path.join(root, "lock-target");
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, path.join(c, ".git", "corpus-custody.lock"));
  const a = bash(`corpus_custody_acquire ${JSON.stringify(c)} t`, { ANDENKEN_SESSION_CORPUS: c });
  strictEqual(a.status, 75, a.out);
  ok(a.out.includes("corpus-custody-lock-not-regular"), a.out);
  const n = bash(`exec 8>>${JSON.stringify(target)}\nflock -n 8\n${nodeProbe}`, { ANDENKEN_SESSION_CORPUS: c, ANDENKEN_CORPUS_CUSTODY_FD: "8" });
  strictEqual(n.status, 75, n.out);
  ok(n.out.includes("custody-lock-not-regular"), n.out);
});
await check("producer first: the wrapper holds custody BEFORE Node starts (a separate open finds it busy), and Node passes", () => {
  const r = bash(`corpus_custody_acquire ${JSON.stringify(corpus)} t >/dev/null
flock -n ${JSON.stringify(lockPath)} true && echo BEFORE=free || echo BEFORE=held
${nodeProbe}`);
  strictEqual(r.status, 0, r.out);
  ok(r.out.includes("BEFORE=held") && r.out.includes("CUSTODY_OK"), r.out);
});
await check("scope of the Node check: a matching FD that NOBODY held passes too (flock takes it there) — it proves no other holder, not who took it first", () => {
  const r = bash(`exec 8>>${JSON.stringify(lockPath)}\n${nodeProbe}`, { ANDENKEN_CORPUS_CUSTODY_FD: "8" });
  strictEqual(r.status, 0, r.out);
  ok(r.out.includes("CUSTODY_OK"), r.out);
});

const nodata = path.join(root, "nodata");
fs.mkdirSync(nodata, { recursive: true });
const writerEnv = profileEnv("SESSION", DEAD_ENDPOINT);
for (const [name, args] of [
  ["indexer.ts sessions", ["indexer.ts", "sessions"]],
  ["indexer.ts durable", ["indexer.ts", "durable"]],
  ["cli.ts reindex", ["cli.ts", "reindex"]],
  ["scripts/durable-admit.ts", ["scripts/durable-admit.ts", path.join(root, "snap.sqlite"), "--device", "dev"]],
] as const) {
  await check(`${name} without custody on an archive corpus → exit 75 before any provider / store work`, () => {
    const r = run(TSX, [...args], writerEnv);
    strictEqual(r.status, 75, r.out);
    ok(r.out.includes("corpus-custody custody-absent"), r.out);
    deepStrictEqual(fs.readdirSync(nodata), [], "data dir untouched");
  });
}
await check("indexer.ts durable --dry-run is read-only and not gated by custody", () => {
  const r = run(TSX, ["indexer.ts", "durable", "--dry-run"], writerEnv);
  ok(!r.out.includes("corpus-custody"), r.out);
});

// ============================================================================
console.log("\n# retired / legacy-only entries");
await check("sync-sessions-legacy-4b.sh → exit 2, nothing done", () => {
  const r = run(script("sync-sessions-legacy-4b.sh"), ["--push"]);
  strictEqual(r.status, 2, r.out);
  ok(r.out.includes("retired"), r.out);
  deepStrictEqual(lines(calls), []);
});
await check("estimate.ts sessions on a pinned dir → exit 2 (it counts legacy selection only); legacy dir unchanged behaviour", () => {
  const pinned = path.join(root, "pinned-data");
  fs.mkdirSync(path.join(pinned, "sessions.lance"), { recursive: true });
  fs.writeFileSync(path.join(pinned, "session-policy.json"), JSON.stringify(CONTROL_V1_PIN));
  fs.writeFileSync(path.join(pinned, "session-manifest.json"), JSON.stringify({ files: {}, lastUpdated: "", [MANIFEST_POLICY_FIELD]: CONTROL_V1_PIN }));
  const r = run(TSX, ["estimate.ts", "sessions"], { ANDENKEN_DATA: pinned });
  strictEqual(r.status, 2, r.out);
  ok(r.out.includes("pinned-estimator-unsupported"), r.out);
  fs.writeFileSync(path.join(pinned, "session-policy.json"), "{");
  strictEqual(run(TSX, ["estimate.ts", "sessions"], { ANDENKEN_DATA: pinned }).status, 2);
});

// ============================================================================
console.log("\n# sync-sessions.sh end to end (archive mode, --local, stubbed provider / indexer)");
const fakeRepo = path.join(root, "repo");
fs.cpSync(path.join(REPO, "scripts"), path.join(fakeRepo, "scripts"), { recursive: true });
fs.mkdirSync(path.join(fakeRepo, "data"), { recursive: true });
const realNode = process.execPath;
stub("pnpm", `case "$*" in
  "exec tsx indexer.ts policy") exec "${TSX}" "${REPO}/indexer.ts" policy ;;
  "exec tsx indexer.ts status --json") echo "pnpm status" >>"${calls}"; echo '{"sessions":{"actual_dim":'"\${STATUS_DIM:-1024}"',"to_index":1,"count":5}}' ;;
  "exec tsx scripts/profile-preflight.ts sessions") echo "pnpm preflight profile=$ANDENKEN_SESSION_PROFILE endpoint=$ANDENKEN_SESSION_ENDPOINT provider=$ANDENKEN_SESSION_PROVIDER" >>"${calls}" ;;
  "exec tsx indexer.ts verify sessions") echo "pnpm verify" >>"${calls}" ;;
  *) echo "pnpm $*" >>"${calls}"; exit 99 ;;
esac`);
// The profiled preflight is `pnpm exec tsx scripts/profile-preflight.ts` (digest + 1 validated probe); a curl probe would be a regression.
stub("curl", `echo "curl" >>"${calls}"; exit 99`);
const PREFLIGHT = "pnpm preflight profile=ollama-bge-m3-1024 endpoint=http://127.0.0.1:11435 provider=vllm";
// node: the indexer launch is recorded with what it inherited; everything else is the real node.
stub("node", `if [ "$1 $2" = "--import tsx" ] && [[ "$3" == *.ts ]]; then
  c=missing
  if [ "$(stat -L -c %d:%i /proc/$$/fd/8 2>/dev/null)" = "$(stat -c %d:%i "$ANDENKEN_SESSION_CORPUS/.git/corpus-custody.lock" 2>/dev/null)" ] && flock -n 8; then c=held; fi
  n="$3"; [ "$n" = indexer.ts ] && n=indexer
  echo "node $n $4 custody=$c" >>"${calls}"; exit "\${INDEXER_RC:-0}"
fi
exec ${JSON.stringify(realNode)} "$@"`);
const ledgerShaOrNone = () => {
  const f = path.join(corpus, "MANIFEST.json");
  return fs.existsSync(f) ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : "none";
};
/** Calls after gather's own local copy (an rsync into the temp corpus). */
const afterGather = () => lines(calls).filter((l) => !(l.startsWith("rsync") && l.includes("--files-from=")));
const sync = (args: string[], over: Record<string, string | undefined> = {}) =>
  run("bash", [path.join(fakeRepo, "scripts", "sync-sessions.sh"), ...args], { ANDENKEN_DATA: path.join(fakeRepo, "data"), OPENROUTER_API_KEY: "dummy", ...over }, root);

await check("--local: custody → gather (preflight only, no commit) → status → probe → indexer launched holding custody", () => {
  const r = sync(["--local"]);
  strictEqual(r.status, 0, r.out);
  deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
  deepStrictEqual(afterGather(), ["pnpm status", PREFLIGHT, "node indexer sessions custody=held"]);
  ok(r.out.includes("profile: ollama-bge-m3-1024 (1024d, loopback http://127.0.0.1:11435)"), r.out);
});
await check("--local: ANDENKEN_SYNC_ENDPOINT is placement only and reaches the preflight; inherited Qwen SESSION_* lines never do", () => {
  const r = sync(["--local"], {
    ANDENKEN_SYNC_ENDPOINT: "http://127.0.0.1:45678",
    ANDENKEN_SESSION_MODEL: "qwen/qwen3-embedding-8b",
    ANDENKEN_SESSION_DIMENSIONS: "4096",
    ANDENKEN_SESSION_ENDPOINT: "https://openrouter.ai/api",
    ANDENKEN_SESSION_API_KEY: "sk-leak",
  });
  strictEqual(r.status, 0, r.out);
  deepStrictEqual(afterGather(), ["pnpm status", PREFLIGHT.replace("11435", "45678"), "node indexer sessions custody=held"]);
  ok(!r.out.includes("openrouter") && !r.out.includes("sk-leak"), r.out);
});
await check("generation gate: another ANDENKEN_SYNC_PROFILE, or a stampless sessions.lance, exits 2 before custody, gather, status, preflight (API 0)", () => {
  const bad = sync(["--local"], { ANDENKEN_SYNC_PROFILE: "openrouter-qwen3-8b-4096" });
  strictEqual(bad.status, 2, bad.out);
  ok(bad.out.includes("the only sync generation is ollama-bge-m3-1024"), bad.out);
  deepStrictEqual(phases(), []);
  deepStrictEqual(lines(calls), []);
  const legacy = path.join(root, "legacy-data");
  fs.mkdirSync(path.join(legacy, "sessions.lance"), { recursive: true });
  const r = sync(["--local"], { ANDENKEN_DATA: legacy });
  strictEqual(r.status, 2, r.out);
  ok(r.out.includes("no generation stamp"), r.out);
  deepStrictEqual(phases(), []);
  deepStrictEqual(lines(calls), []);
});
await check("a stamped 1024d store is accepted by the generation gate (the stamp is what counts)", () => {
  const stamped = path.join(root, "stamped-data");
  fs.mkdirSync(path.join(stamped, "sessions.lance"), { recursive: true });
  fs.writeFileSync(path.join(stamped, "sessions.lance", "andenken-profile.json"), JSON.stringify(makeStamp(PROFILE)));
  const r = sync(["--local"], { ANDENKEN_DATA: stamped });
  ok(!r.out.includes("no generation stamp") && !r.out.includes("the only sync generation"), r.out);
});
await check("a store of the wrong dimension (status says 4096) → exit 1 API 0: no preflight, no indexer", () => {
  const r = sync(["--local"], { STATUS_DIM: "4096" });
  strictEqual(r.status, 1, r.out);
  ok(r.out.includes("4096d, not the 1024d generation"), r.out);
  deepStrictEqual(afterGather(), ["pnpm status"]);
});

// --global is closed (profiled generation: publish is a separate gate). DORMANT until it reopens:
//   - gather --strict --checkpoint before status / preflight / indexer; publish after the index
//   - failed checkpoint (15) → child's rc, restore failure (19) → corpus-archive-restore-failed
//   - archive-skip-gather-refused for --global + SKIP_GATHER=1 on an archive corpus
//   - publish order: verify → corpus replicate (--strict) → index rsync; 0-row index never published
//   - the manifest/pin/ledger files travel with the index; absence travels too
for (const [label, over] of [
  ["plain", {}],
  ["with a failing checkpoint (15) it never gets that far", { FAKE_ARCHIVE_RC_CHECKPOINT: "15" }],
  ["with a restore failure (19) it never gets that far", { FAKE_ARCHIVE_RC_CHECKPOINT: "19" }],
  ["with SKIP_GATHER=1 on the archive corpus the global refusal wins (archive-skip-gather-refused is dormant)", { SKIP_GATHER: "1" }],
] as const) {
  await check(`--global (${label}) → exit 2 API 0: nothing gathered, custody not taken, no status / preflight / index / replicate / rsync`, () => {
    const before = ledgerShaOrNone();
    const r = sync(["--global"], { ...over });
    strictEqual(r.status, 2, r.out);
    ok(r.out.includes("publishes to the replica") && r.out.includes("separate gate"), r.out);
    ok(!r.out.includes("archive-skip-gather-refused") && !r.out.includes("refusing to index"), r.out);
    deepStrictEqual(phases(), []);
    deepStrictEqual(lines(calls), []);
    strictEqual(ledgerShaOrNone(), before);
  });
}
await check("--push (the deprecated alias of --global) is refused the same way", () => {
  const r = sync(["--push"]);
  strictEqual(r.status, 2, r.out);
  deepStrictEqual(lines(calls), []);
  deepStrictEqual(phases(), []);
});
await check("the indexer's own refusal code is the sync's (75 here, not a folded 1)", () => {
  const r = sync(["--local"], { INDEXER_RC: "75" });
  strictEqual(r.status, 75, r.out);
});
await check("custody held elsewhere → sync exit 75 before gather", async () => {
  const h = await holdLock(lockPath);
  try {
    const r = sync(["--local"]);
    strictEqual(r.status, 75, r.out);
    deepStrictEqual(lines(archiveLog), []);
    deepStrictEqual(lines(calls), []);
  } finally {
    h.kill();
  }
});
await check("sync launched with a claimed but absent custody FD → 75 before gather, nothing recorded", () => {
  const r = sync(["--local"], { ANDENKEN_CORPUS_CUSTODY_FD: "8" });
  strictEqual(r.status, 75, r.out);
  ok(r.out.includes("corpus-custody-fd-lost"), r.out);
  deepStrictEqual(lines(archiveLog), []);
  deepStrictEqual(lines(calls), []);
});
await check("owner hook absent → sync exit 10 before gather", () => {
  const r = sync(["--local"], { ANDENKEN_CORPUS_ARCHIVE_HELPER: path.join(root, "no-such-helper.py") });
  strictEqual(r.status, 10, r.out);
  deepStrictEqual(lines(calls), []);
});
// rebuild-sessions-full.sh is RETIRED (exit 2 right after cd): it must never reach custody, gather, estimate, lock or a request.
// DORMANT with it: custody-before-gather (75 when held), gather → ledger → ONE checkpoint before the estimate,
// checkpoint restore failure (19) → "refusing to destroy", and the archive-skip-gather-refused refusal for a rebuild.
const rebuild = (args: string[], over: Record<string, string | undefined> = {}) =>
  run("bash", [path.join(fakeRepo, "scripts", "rebuild-sessions-full.sh"), ...args], { ANDENKEN_DATA: path.join(fakeRepo, "data"), ...over }, root);
const ledgerSha = () => createHash("sha256").update(fs.readFileSync(path.join(corpus, "MANIFEST.json"))).digest("hex");
const pinnedRebuild = path.join(root, "pinned-rebuild");
fs.mkdirSync(path.join(pinnedRebuild, "sessions.lance"), { recursive: true });
fs.writeFileSync(path.join(pinnedRebuild, "session-policy.json"), JSON.stringify(CONTROL_V1_PIN));
fs.writeFileSync(path.join(pinnedRebuild, "session-manifest.json"), JSON.stringify({ files: {}, lastUpdated: "", [MANIFEST_POLICY_FIELD]: CONTROL_V1_PIN }));
const retired = (r: { status: number | null; out: string }) => {
  strictEqual(r.status, 2, r.out);
  ok(r.out.includes("retired"), r.out);
  deepStrictEqual(phases(), [], "custody never taken, no archive phase");
  deepStrictEqual(lines(calls), [], "no gather, estimate, status, probe, ssh or rsync");
};
await check("rebuild-sessions-full.sh is retired: exit 2, no custody / gather / checkpoint / estimate / request — plain, --dry-run, legacy dir", () => {
  const before = ledgerSha();
  retired(rebuild([]));
  retired(rebuild(["--dry-run"]));
  strictEqual(ledgerSha(), before, "ledger unchanged");
});
await check("retired rebuild with custody held elsewhere → still exit 2 (not 75): it never reaches custody", async () => {
  const h = await holdLock(lockPath);
  try {
    retired(rebuild([]));
  } finally {
    h.kill();
  }
});
await check("retired rebuild on a control-pinned dir, with SKIP_GATHER=1 on an archive corpus, and with a checkpoint rc set → the same exit 2, nothing done", () => {
  const before = ledgerSha();
  retired(rebuild([], { ANDENKEN_DATA: pinnedRebuild }));
  const r = rebuild([], { SKIP_GATHER: "1" });
  retired(r);
  ok(!r.out.includes("archive-skip-gather-refused"), "that refusal is dormant; the retirement wins");
  retired(rebuild(["--dry-run"], { SKIP_GATHER: "1" }));
  retired(rebuild([], { FAKE_ARCHIVE_RC_CHECKPOINT: "19" }));
  strictEqual(ledgerSha(), before);
});

// ============================================================================
console.log("\n# writers without a gather: owner preflight + read-only form first, else Node never starts");
fs.copyFileSync(path.join(REPO, "run.sh"), path.join(fakeRepo, "run.sh"));
fs.chmodSync(path.join(fakeRepo, "run.sh"), 0o755);
const runSh = (args: string[], over: Record<string, string | undefined> = {}) =>
  run("bash", [path.join(fakeRepo, "run.sh"), ...args], { ANDENKEN_DATA: path.join(fakeRepo, "data"), ...over }, root);
const nodeCalls = () => lines(calls).filter((l) => l.startsWith("node "));
const pointer = path.join(corpus, "dev", "ptr.jsonl");
const WRITERS = [
  ["index:durable", ["index:durable", "--device", "dev"], "node indexer durable custody=held"],
  ["corpus:durable-admit", ["corpus:durable-admit", path.join(root, "snap.sqlite"), "--device", "dev"], `node scripts/durable-admit.ts ${path.join(root, "snap.sqlite")} custody=held`],
  ["index:sessions", ["index:sessions"], "node indexer sessions custody=held"],
] as const;
for (const [label, args, launched] of WRITERS) {
  await check(`run.sh ${label}: preflight → form → one Node launch holding custody`, () => {
    const r = runSh([...args]);
    strictEqual(r.status, 0, r.out);
    deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
    deepStrictEqual(nodeCalls(), [launched]);
  });
  await check(`run.sh ${label}: preflight refused (13) → exit 13, Node 0 launches`, () => {
    const r = runSh([...args], { FAKE_ARCHIVE_RC_PREFLIGHT: "13" });
    strictEqual(r.status, 13, r.out);
    deepStrictEqual(nodeCalls(), []);
  });
  await check(`run.sh ${label}: an annex pointer in the corpus (form 3) → exit 3, Node 0 launches`, () => {
    fs.writeFileSync(pointer, "/annex/objects/SHA256E-s10--00.jsonl\n");
    try {
      const r = runSh([...args]);
      strictEqual(r.status, 3, r.out);
      deepStrictEqual(nodeCalls(), []);
    } finally {
      fs.rmSync(pointer);
    }
  });
}
await check("run.sh index:durable --dry-run stays read-only: no custody, no preflight", () => {
  const r = runSh(["index:durable", "--dry-run"]);
  deepStrictEqual(phases(), [], r.out);
});
await check("sync SKIP_GATHER=1: preflight + form still run under custody; refused (13 / form 3) → that code before status, probe and indexer", () => {
  const okRun = sync(["--local"], { SKIP_GATHER: "1" });
  strictEqual(okRun.status, 0, okRun.out);
  deepStrictEqual(phases(), ["preflight lock=caller-fd host=local"]);
  deepStrictEqual(lines(calls), ["pnpm status", PREFLIGHT, "node indexer sessions custody=held"]);
  const bad = sync(["--local"], { SKIP_GATHER: "1", FAKE_ARCHIVE_RC_PREFLIGHT: "13" });
  strictEqual(bad.status, 13, bad.out);
  deepStrictEqual(lines(calls), []);
  fs.writeFileSync(pointer, "/annex/objects/SHA256E-s10--00.jsonl\n");
  try {
    const f = sync(["--local"], { SKIP_GATHER: "1" });
    strictEqual(f.status, 3, f.out);
    deepStrictEqual(lines(calls), []);
  } finally {
    fs.rmSync(pointer);
  }
});
await check("…a legacy corpus (no .git): sync --global + SKIP_GATHER=1 is refused as --global too (exit 2, nothing run)", () => {
  const r = sync(["--global"], { SKIP_GATHER: "1", ANDENKEN_SESSION_CORPUS: path.join(home, "plain") });
  strictEqual(r.status, 2, r.out);
  ok(!r.out.includes("archive-skip-gather-refused"), r.out);
  deepStrictEqual(lines(calls), []);
});

// ============================================================================
console.log("\n# replicate-corpus.sh (archive mode; the replica's commands run locally as the replica)");
roster([{ id: "dev", state: "active", transport: "local" }, { id: "rep", state: "active", transport: "ssh", target: "rephost" }]);
const replicate = (args: string[], over: Record<string, string | undefined> = {}) => run(script("replicate-corpus.sh"), args, over);
const rRel = path.relative(home, corpus);
const jobDirs = () => (fs.existsSync(path.join(replicaHome, ".cache", "andenken")) ? fs.readdirSync(path.join(replicaHome, ".cache", "andenken")).filter((n) => n.startsWith("archive.")) : []);
const FULL = [
  "preflight lock=caller-fd host=replica",
  "bundle lock=caller-fd host=local",
  "receive lock=caller-fd host=replica",
  "bundle lock=caller-fd host=replica",
  "merge-log lock=caller-fd host=local",
];
await check("per replica: preflight → rsync (replica lock held) → one canonical.bundle → job dir + sha → receive → location log back → merge-log → cleanup", () => {
  const before = jobDirs();
  const r = replicate(["--strict"]);
  strictEqual(r.status, 0, r.out);
  deepStrictEqual(phases(), FULL);
  const c = lines(calls);
  const at = (f: (l: string) => boolean) => c.findIndex(f);
  const i = [
    at((l) => l.includes(" preflight --corpus")),
    at((l) => l.startsWith("rsync") && l.includes("--exclude=/.git/")),
    at((l) => l.includes("mktemp -d")),
    at((l) => l.startsWith("rsync -a") && l.includes("canonical.bundle")),
    at((l) => l.includes("chmod 600")),
    at((l) => l.includes("sha256sum") && l.includes("canonical.bundle")),
    at((l) => l.includes(" receive --corpus")),
    at((l) => l.includes(" bundle --corpus") && l.includes("rep.bundle")),
    at((l) => l.startsWith("rsync -a rephost:") && l.includes("rep.bundle")),
    at((l) => l.includes("rm -f") && l.includes("rmdir")),
  ];
  ok(i.every((x) => x >= 0) && i.every((x, k) => k === 0 || i[k - 1] < x), `${JSON.stringify(i)}\n${c.join("\n")}`);
  ok(c[i[1]].includes(`--rsync-path=flock -n ${replicaHome}/${rRel}/.git/corpus-custody.lock rsync`), c[i[1]]);
  ok(c[i[0]].includes(`exec 8>>${replicaLock} && flock -n 8 || exit 75;`), c[i[0]]);
  ok(new RegExp(`--bundle ${replicaHome}/\\.cache/andenken/archive\\.[A-Za-z0-9]+/canonical\\.bundle`).test(c[i[6]]), c[i[6]]);
  const merge = lines(archiveLog).find((l) => l.startsWith("merge-log"))!;
  ok(/--bundle \S+\/rep\.bundle --from rep$/.test(merge), merge);
  ok(/canonical\.bundle sha256=[0-9a-f]{64}/.test(r.out) && /rep\.bundle sha256=[0-9a-f]{64}/.test(r.out), r.out);
  deepStrictEqual(jobDirs(), before, "this run's replica job dir removed (payload only)");
});
await check("receive fails (rc 17) → exit 17; the replica job dir is kept (0700, canonical.bundle 0600, sha = the run's), no merge-log", () => {
  const before = new Set(jobDirs());
  const r = replicate(["--strict"], { FAKE_ARCHIVE_RC_RECEIVE: "17" });
  strictEqual(r.status, 17, r.out);
  deepStrictEqual(phases(), FULL.slice(0, 3));
  const kept = jobDirs().filter((d) => !before.has(d));
  strictEqual(kept.length, 1, r.out);
  const dir = path.join(replicaHome, ".cache", "andenken", kept[0]);
  ok(r.out.includes(`job dir kept for inspection: ${dir}`), r.out);
  strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  strictEqual(fs.statSync(path.join(dir, "canonical.bundle")).mode & 0o777, 0o600);
  const printed = /canonical\.bundle sha256=([0-9a-f]{64})/.exec(r.out)![1];
  strictEqual(spawnSync("sha256sum", [path.join(dir, "canonical.bundle")], { encoding: "utf-8" }).stdout.split(" ")[0], printed);
});
await check("receive fails with 19 (restore failed) → exit 19 and `corpus-archive-restore-failed`, nothing after it", () => {
  const r = replicate(["--strict"], { FAKE_ARCHIVE_RC_RECEIVE: "19" });
  strictEqual(r.status, 19, r.out);
  ok(r.out.includes("REFUSED corpus-archive-restore-failed"), r.out);
  deepStrictEqual(phases(), FULL.slice(0, 3));
});
await check("replica custody held there → its preflight exits 75 → replicate exits 75, corpus not shipped", async () => {
  const h = await holdLock(replicaLock);
  try {
    const r = replicate(["--strict"]);
    strictEqual(r.status, 75, r.out);
    deepStrictEqual(phases(), []);
    ok(!lines(calls).some((l) => l.startsWith("rsync")), lines(calls).join("\n"));
  } finally {
    h.kill();
  }
});
for (const [label, over, rc, want] of [
  ["replica preflight fails (rc 13)", { FAKE_ARCHIVE_RC_PREFLIGHT: "13" }, 13, FULL.slice(0, 1)],
  ["local bundle fails (rc 11)", { FAKE_ARCHIVE_RC_BUNDLE_LOCAL: "11" }, 11, FULL.slice(0, 2)],
  ["the bundle arrives altered (sha mismatch) → 18", { BUNDLE_CORRUPT: "1" }, 18, FULL.slice(0, 2)],
  ["replica location-log bundle fails (rc 16)", { FAKE_ARCHIVE_RC_BUNDLE_REPLICA: "16" }, 16, FULL.slice(0, 4)],
  ["canonical merge-log fails (rc 13)", { FAKE_ARCHIVE_RC_MERGE_LOG: "13" }, 13, FULL],
] as const) {
  await check(`${label} → replicate exits ${rc} (sync then ships no index)`, () => {
    const r = replicate(["--strict"], over);
    strictEqual(r.status, rc, r.out);
    deepStrictEqual(phases(), want);
    const c = lines(calls);
    if (label.startsWith("replica preflight")) ok(!c.some((l) => l.startsWith("rsync") || l.includes("mktemp")), "nothing shipped after a failed preflight");
    if (label.startsWith("local bundle")) ok(!c.some((l) => l.includes("mktemp") || l.includes(" receive ")), "no job dir, no receive without a bundle");
    if (rc === 18) ok(!c.some((l) => l.includes(" receive ")), "no receive of an altered bundle");
  });
}
await check("corpus rsync fails (e.g. the replica lock taken mid-way) → replicate fails, no bundle / receive", () => {
  const r = replicate(["--strict"], { RSYNC_RC: "1" });
  ok(r.status !== 0, r.out);
  deepStrictEqual(phases(), ["preflight lock=caller-fd host=replica"]);
});
await check("a roster id the location log cannot name → exit 2 before the replica is touched", () => {
  roster([{ id: "dev", state: "active", transport: "local" }, { id: "bad.id", state: "active", transport: "ssh", target: "rephost" }]);
  try {
    const r = replicate(["--strict"]);
    strictEqual(r.status, 2, r.out);
    deepStrictEqual(phases(), []);
  } finally {
    roster([{ id: "dev", state: "active", transport: "local" }, { id: "rep", state: "active", transport: "ssh", target: "rephost" }]);
  }
});
await check("replica --annex-bin: absent there → the replica refuses (2) before rsync; relative → refused locally (2) before anything", () => {
  const r = replicate(["--strict"], { ANDENKEN_REPLICA_ANNEX_BIN: path.join(root, "no-such-bin") });
  strictEqual(r.status, 2, r.out);
  ok(!lines(calls).some((l) => l.startsWith("rsync")), lines(calls).join("\n"));
  const rel = replicate(["--strict"], { ANDENKEN_REPLICA_ANNEX_BIN: "bin" });
  strictEqual(rel.status, 2, rel.out);
  ok(rel.out.includes("corpus-annex-bin-invalid"), rel.out);
  deepStrictEqual(lines(calls), []);
  const there = path.join(root, "annex-bin");
  fs.mkdirSync(there, { recursive: true });
  const okRun = replicate(["--strict"], { ANDENKEN_REPLICA_ANNEX_BIN: there });
  strictEqual(okRun.status, 0, okRun.out);
  ok(lines(archiveLog).filter((l) => l.includes("host=replica")).every((l) => l.includes(`--annex-bin ${there}`)), lines(archiveLog).join("\n"));
});
await check("--dry-run: no custody, no archive phase, nothing transferred", async () => {
  const h = await holdLock(lockPath);
  try {
    const r = replicate(["--dry-run"]);
    strictEqual(r.status, 0, r.out);
    deepStrictEqual(lines(archiveLog), []);
  } finally {
    h.kill();
  }
});
await check("replicate launched with a claimed but absent custody FD → 75 before anything", () => {
  const r = replicate(["--strict"], { ANDENKEN_CORPUS_CUSTODY_FD: "8" });
  strictEqual(r.status, 75, r.out);
  ok(r.out.includes("corpus-custody-fd-lost"), r.out);
  deepStrictEqual(phases(), []);
  ok(!lines(calls).some((l) => l.startsWith("rsync")), lines(calls).join("\n"));
});
await check("standalone replicate takes its own custody; busy → 75 before anything", async () => {
  const h = await holdLock(lockPath);
  try {
    const r = replicate(["--strict"]);
    strictEqual(r.status, 75, r.out);
    deepStrictEqual(lines(calls), []);
  } finally {
    h.kill();
  }
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
