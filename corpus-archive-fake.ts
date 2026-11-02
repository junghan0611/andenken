/**
 * A stand-in for the agent-config corpus-archive helper, for API-0 synthetics.
 *
 * It honours the call interface of contract v1 (agent-config #32) and nothing
 * else: `python3 -I HELPER PHASE --corpus ABS [--lock-fd N] [--annex-bin DIR]
 * [phase args]`, one JSON line on stdout, the phase's exit code. The lock check
 * is the real helper's (`take_lock`): the descriptor must be the corpus's
 * `.git/corpus-custody.lock` (same dev/inode) and `flock -n` on it must succeed,
 * which it does only on the open file description that already holds it. It never
 * unlocks. Mutating phases without `--lock-fd` are a usage error (2).
 *
 * Every call is appended to $FAKE_ARCHIVE_LOG as one line:
 *   <phase> lock=<caller-fd|absent|refused> host=<FAKE_ARCHIVE_HOST or local> manifest=<sha8|none> [args…]
 * (`manifest` = the corpus MANIFEST.json as the phase saw it, so a test can tell
 * a checkpoint that ran after the ledger refresh from one that ran before it).
 * $FAKE_ARCHIVE_RC_<PHASE> (upper case, `-` → `_`) sets the exit code of a phase;
 * $FAKE_ARCHIVE_RC_<PHASE>_<HOST> (e.g. FAKE_ARCHIVE_RC_BUNDLE_REPLICA) wins for
 * that host only.
 * `bundle --out P` writes a small file at P.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SOURCE = String.raw`import errno, fcntl, hashlib, json, os, stat, sys
argv = sys.argv[1:]
phase = argv[0] if argv else ""
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
corpus = opt("--corpus")
fd = opt("--lock-fd")
log = os.environ.get("FAKE_ARCHIVE_LOG")
host = os.environ.get("FAKE_ARCHIVE_HOST", "local")
lock = "absent"
rc = 0
if fd is not None:
    try:
        st = os.fstat(int(fd))
        want = os.stat(os.path.join(corpus, ".git", "corpus-custody.lock"))
        if not stat.S_ISREG(st.st_mode) or (st.st_dev, st.st_ino) != (want.st_dev, want.st_ino):
            raise OSError("wrong file")
        fcntl.flock(int(fd), fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock = "caller-fd"
    except OSError:
        lock = "refused"
        rc = 75
elif phase in ("bundle", "checkpoint", "merge-log", "receive"):
    rc = 2
rest = [a for a in argv[1:] if a not in ("--corpus", corpus, "--lock-fd", fd)]
try:
    with open(os.path.join(corpus, "MANIFEST.json"), "rb") as f:
        manifest = hashlib.sha256(f.read()).hexdigest()[:8]
except OSError:
    manifest = "none"
if log:
    with open(log, "a") as f:
        f.write(" ".join([phase, "lock=" + lock, "host=" + host, "manifest=" + manifest] + rest) + "\n")
if rc == 0:
    key = "FAKE_ARCHIVE_RC_" + phase.upper().replace("-", "_")
    rc = int(os.environ.get(key + "_" + host.upper(), os.environ.get(key, "0")))
if rc == 0 and phase == "bundle" and opt("--out"):
    with open(opt("--out"), "w") as f:
        f.write("fake bundle\n")
print(json.dumps({"ok": rc == 0, "phase": phase, "lock": lock, "fake": True}))
sys.exit(rc)
`;

/** Write the fake helper into `dir` and return its absolute path. */
export function writeFakeArchiveHelper(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "corpus-archive.py");
  fs.writeFileSync(p, SOURCE, { mode: 0o755 });
  return p;
}
