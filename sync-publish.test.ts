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
  esac; }
ssh() { echo "ssh \${@: -1}" >>"$CALLS"; return "\${RC_SSH:-0}"; }
pnpm() { echo "verify" >>"$CALLS"; return 0; }
`;

interface Case {
  durable: boolean;
  rc?: Partial<Record<"RC_LANCE" | "RC_SMAN" | "RC_DMAN" | "RC_SSH", string>>;
  /** The call line; the default is how the script itself calls publish. */
  call?: string;
}
function run(c: Case): { status: number | null; ok: boolean; calls: string[] } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-publish-"));
  fs.mkdirSync(path.join(cwd, "data", "sessions.lance"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "data", "session-manifest.json"), "{}");
  if (c.durable) fs.writeFileSync(path.join(cwd, "data", "durable-manifest.json"), "{}");
  fs.mkdirSync(path.join(cwd, "scripts"));
  fs.writeFileSync(path.join(cwd, "scripts", "replicate-corpus.sh"), '#!/usr/bin/env bash\necho replicate >>"$CALLS"\n', { mode: 0o755 });
  const calls = path.join(cwd, "calls");
  fs.writeFileSync(calls, "");
  const body = `set -euo pipefail\nLOCAL_DEVICE=thinkpad\nINDEX_AUTHORITY=thinkpad\n${STUBS}\n${functions}\n${c.call ?? "publish_replica"}\necho PUBLISH_OK\n`;
  const r = spawnSync("bash", ["-c", body], { cwd, env: { ...process.env, CALLS: calls, ...c.rc }, encoding: "utf-8" });
  const out = { status: r.status, ok: r.stdout.includes("PUBLISH_OK"), calls: fs.readFileSync(calls, "utf-8").trim().split("\n").filter(Boolean) };
  fs.rmSync(cwd, { recursive: true, force: true });
  return out;
}

const LANCE = "rsync data/sessions.lance/";
const SMAN = "rsync data/session-manifest.json";
const DMAN = "rsync data/durable-manifest.json";
const RM = "ssh rm -f /home/junghan/repos/gh/andenken/data/durable-manifest.json";

console.log("\n# publish succeeds only when every step does");
{
  const r = run({ durable: true });
  eq([r.status, r.ok, r.calls], [0, true, ["verify", LANCE, SMAN, DMAN, "replicate"]], "all steps succeed (durable manifest present): index, both manifests, corpus");
}
{
  const r = run({ durable: false });
  eq([r.status, r.ok, r.calls], [0, true, ["verify", LANCE, SMAN, RM, "replicate"]], "all steps succeed (no durable manifest): its absence is propagated by removing exactly that file");
}

console.log("\n# a failed step fails the publish and stops it");
{
  const r = run({ durable: true, rc: { RC_LANCE: "23" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", LANCE]], "sessions.lance rsync rc 23 → publish fails; no manifest shipped, corpus not replicated");
}
{
  // Same condition context as publish_replica's own call (errexit suppressed inside).
  const r = run({ durable: true, rc: { RC_LANCE: "23" }, call: "push_replica || exit $?" });
  eq([r.status, r.ok, r.calls], [23, false, [LANCE]], "push_replica in a condition context returns the failed rsync's exact rc (23) and stops");
}
{
  const r = run({ durable: true, rc: { RC_SMAN: "23" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", LANCE, SMAN]], "session-manifest rsync fails → publish fails; durable manifest and corpus not shipped");
}
{
  const r = run({ durable: true, rc: { RC_DMAN: "12" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", LANCE, SMAN, DMAN]], "durable-manifest rsync fails → publish fails; corpus not replicated");
}
{
  const r = run({ durable: false, rc: { RC_SSH: "255" } });
  eq([r.status, r.ok, r.calls], [1, false, ["verify", LANCE, SMAN, RM]], "absence propagation (ssh rm) fails with 255 → publish fails; corpus not replicated");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
