#!/usr/bin/env tsx
/**
 * Publish-failure regression for scripts/sync-sessions.sh (push_replica /
 * publish_replica).
 *
 * The production functions are cut out of the script text and run under the
 * script's own `set -euo pipefail`, called the way the script calls them.
 * rsync, ssh and pnpm are shell stubs and `scripts/replicate-corpus.sh` is a stub
 * file in a temp cwd, so nothing reaches a host. API 0.
 *
 * The defect this pins: `push_replica || return 1` runs push_replica in a
 * condition context, where bash suppresses errexit, so a failed early rsync
 * (e.g. rc 23 on sessions.lance) was swallowed when a later step succeeded.
 *
 * Publish order (issue #18): verify → corpus (--strict; in archive mode this
 * step also carries the archive: preflight → rsync → bundle → receive) → index +
 * paired files. A failure before the index step leaves the replica's index
 * untouched; a 0-row index is never published. The paired files
 * (durable-manifest, session-policy, s0-held) each ship when present and are
 * removed on the replica, in one ssh, when absent. The archive steps themselves
 * are exercised in corpus-archive-glue.test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

let passed = 0;
let failed = 0;
function eq<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  }
}

const repo = import.meta.dirname;
const script = fs.readFileSync(path.join(repo, "scripts", "sync-sessions.sh"), "utf-8");
function cut(name: string): string {
  const m = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"));
  if (!m) throw new Error(`${name}() not found in scripts/sync-sessions.sh`);
  return m[0];
}
const functions = cut("push_replica") + cut("publish_replica");

const STUBS = `
rsync() { local src="\${@: -2:1}"; echo "rsync $src" >>"$CALLS"
  case "$src" in
    data/sessions.lance/) return "\${RC_LANCE:-0}" ;;
    data/session-manifest.json) return "\${RC_SMAN:-0}" ;;
    data/durable-manifest.json) return "\${RC_DMAN:-0}" ;;
    data/session-policy.json) return "\${RC_POL:-0}" ;;
    data/s0-held.json) return "\${RC_LED:-0}" ;;
  esac; }
ssh() { echo "ssh \${@: -1}" >>"$CALLS"; return "\${RC_SSH:-0}"; }
pnpm() { echo "verify" >>"$CALLS"; return "\${RC_VERIFY:-0}"; }
`;

type Paired = "durable-manifest.json" | "session-policy.json" | "s0-held.json";
interface Case {
  present: Paired[];
  rc?: Partial<Record<"RC_LANCE" | "RC_SMAN" | "RC_DMAN" | "RC_POL" | "RC_LED" | "RC_SSH" | "RC_REPL" | "RC_VERIFY", string>>;
  /** Local index rows as sync-sessions read them (default 1). */
  rows?: string;
  /** The call line; the default is how the script itself calls publish. */
  call?: string;
}
function run(c: Case): { status: number | null; ok: boolean; calls: string[] } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-publish-"));
  fs.mkdirSync(path.join(cwd, "data", "sessions.lance"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "data", "session-manifest.json"), "{}");
  for (const f of c.present) fs.writeFileSync(path.join(cwd, "data", f), "{}");
  fs.mkdirSync(path.join(cwd, "scripts"));
  fs.writeFileSync(path.join(cwd, "scripts", "replicate-corpus.sh"), '#!/usr/bin/env bash\necho "replicate $*" >>"$CALLS"\nexit "${RC_REPL:-0}"\n', { mode: 0o755 });
  const calls = path.join(cwd, "calls");
  fs.writeFileSync(calls, "");
  const body = `set -euo pipefail\nLOCAL_DEVICE=thinkpad\nINDEX_AUTHORITY=thinkpad\nROWS=${c.rows ?? "1"}\n${STUBS}\n${functions}\n${c.call ?? "publish_replica"}\necho PUBLISH_OK\n`;
  const r = spawnSync("bash", ["-c", body], { cwd, env: { ...process.env, CALLS: calls, ...c.rc }, encoding: "utf-8" });
  const out = { status: r.status, ok: r.stdout.includes("PUBLISH_OK"), calls: fs.readFileSync(calls, "utf-8").trim().split("\n").filter(Boolean) };
  fs.rmSync(cwd, { recursive: true, force: true });
  return out;
}

const D = "/home/junghan/repos/gh/andenken/data/";
const LANCE = "rsync data/sessions.lance/";
const SMAN = "rsync data/session-manifest.json";
const DMAN = "rsync data/durable-manifest.json";
const POL = "rsync data/session-policy.json";
const LED = "rsync data/s0-held.json";
const REPL = "replicate --strict";
const rm = (...f: Paired[]) => `ssh rm -f ${f.map((x) => D + x).join(" ")}`;
const LEGACY: Paired[] = ["durable-manifest.json"];
const PINNED: Paired[] = ["durable-manifest.json", "session-policy.json", "s0-held.json"];

console.log("\n# publish order: verify → corpus (+ archive) → index + paired files");
{
  const r = run({ present: LEGACY });
  eq([r.status, r.ok, r.calls], [0, true, ["verify", REPL, LANCE, SMAN, DMAN, rm("session-policy.json", "s0-held.json")]], "legacy dir: corpus first, then index, both manifests; absent pin/ledger removed on the replica in one ssh");
}
{
  const r = run({ present: [] });
  eq([r.status, r.ok, r.calls], [0, true, ["verify", REPL, LANCE, SMAN, rm("durable-manifest.json", "session-policy.json", "s0-held.json")]], "no durable manifest either: all three absences propagated, exactly those files");
}
{
  const r = run({ present: PINNED });
  eq([r.status, r.ok, r.calls], [0, true, ["verify", REPL, LANCE, SMAN, DMAN, POL, LED]], "pinned dir: policy pin and S0 ledger travel with the index; nothing removed");
}

console.log("\n# a failure before the index step leaves the replica's index untouched");
{
  const r = run({ present: PINNED, rows: "0" });
  eq([r.status, r.ok, r.calls], [1, false, []], "0-row local index → refused before verify; nothing shipped, nothing removed");
}
{
  const r = run({ present: PINNED, rc: { RC_VERIFY: "1" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify"]], "verify fails → nothing shipped");
}
{
  const r = run({ present: PINNED, rc: { RC_REPL: "3" } });
  eq([r.status, r.ok, r.calls], [3, false, ["verify", REPL]], "corpus replication fails (e.g. source form rc 3) → index NOT shipped; publish carries rc 3");
}
{
  const r = run({ present: PINNED, rc: { RC_REPL: "15" } });
  eq([r.status, r.ok, r.calls], [15, false, ["verify", REPL]], "archive step inside replicate fails (e.g. receive hook rc 15) → index NOT shipped; publish carries rc 15");
}
{
  const r = run({ present: PINNED, rc: { RC_REPL: "19" } });
  eq([r.status, r.ok, r.calls], [19, false, ["verify", REPL]], "replica restore failed (rc 19) → index NOT shipped; 19 reaches the caller, not a folded 1");
}

console.log("\n# a failed index step fails the publish and stops it");
{
  const r = run({ present: LEGACY, rc: { RC_LANCE: "23" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", REPL, LANCE]], "sessions.lance rsync rc 23 → publish fails; no manifest shipped");
}
{
  // Same condition context as publish_replica's own call (errexit suppressed inside).
  const r = run({ present: LEGACY, rc: { RC_LANCE: "23" }, call: "push_replica || exit $?" });
  eq([r.status, r.ok, r.calls], [23, false, [LANCE]], "push_replica in a condition context returns the failed rsync's exact rc (23) and stops");
}
{
  const r = run({ present: LEGACY, rc: { RC_SMAN: "23" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", REPL, LANCE, SMAN]], "session-manifest rsync fails → publish fails; paired files not shipped");
}
{
  const r = run({ present: LEGACY, rc: { RC_DMAN: "12" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", REPL, LANCE, SMAN, DMAN]], "durable-manifest rsync fails → publish fails; absences not propagated");
}
{
  const r = run({ present: PINNED, rc: { RC_POL: "12" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", REPL, LANCE, SMAN, DMAN, POL]], "policy pin rsync fails → publish fails; ledger not shipped");
}
{
  const r = run({ present: [], rc: { RC_SSH: "255" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", REPL, LANCE, SMAN, rm("durable-manifest.json", "session-policy.json", "s0-held.json")]], "absence propagation (ssh rm) fails with 255 → publish fails");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
