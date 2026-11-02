/**
 * Corpus archive custody, Node side (issue #18 / agent-config #32, contract v1).
 *
 * Archive mode = the session corpus root (`ANDENKEN_SESSION_CORPUS`) has a
 * `.git` DIRECTORY. Only a `.git` that is entirely absent (lstat ENOENT) is
 * legacy; any other shape (a gitfile, a symlink — even to a directory) or an
 * lstat error other than ENOENT is refused with exit 10
 * (`corpus-archive-marker-invalid`), API 0 — the same rule as
 * scripts/lib/corpus-custody.sh. In archive mode, every Node process that writes from the corpus
 * (`indexer.ts sessions` / `durable`, `cli.ts reindex`, pi `/memory reindex`,
 * `scripts/durable-admit.ts`) must run under the custody lock the wrapper holds:
 * `<corpus>/.git/corpus-custody.lock`, locked with flock on an INHERITED file
 * descriptor named by `ANDENKEN_CORPUS_CUSTODY_FD` (scripts/lib/corpus-custody.sh
 * holds it on FD 8 and launches Node with `node --import tsx`, because
 * `pnpm exec tsx` does not pass that descriptor through).
 *
 * What is checked, exactly: the descriptor is an open regular file; the lock
 * path is a regular file by lstat (a symlinked lock is refused) with the same
 * dev/inode; and `flock -n` on the descriptor succeeds, i.e. no OTHER open file
 * description holds the lock. flock also succeeds on a matching descriptor that
 * nobody holds yet (it is then taken on that inherited descriptor), so this
 * check does not prove which process took it first — that the wrapper takes it
 * before launching Node is the wrapper's order, shown by the glue fixtures. Nothing
 * here opens the lock path or releases the lock: a process without a matching
 * inherited descriptor is refused (exit 75) before any provider, store or corpus
 * work. No `.git` → no check at all.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, type StdioOptions } from "node:child_process";

export const CORPUS_CUSTODY_LOCK = "corpus-custody.lock";

export class CorpusCustodyRefused extends Error {
  constructor(
    readonly code: string,
    detail: string,
    /** 75 for custody refusals; 10 for a wrong-shaped archive marker (the owner's "precondition"). */
    readonly exitCode: number = 75,
  ) {
    super(`corpus-custody ${code}: ${detail}`);
    this.name = "CorpusCustodyRefused";
  }
}

function fileKind(st: fs.Stats): string {
  if (st.isSymbolicLink()) return "a symlink";
  if (st.isFile()) return "a regular file (e.g. a gitfile)";
  return "not a directory";
}

/**
 * The corpus root when it is in archive mode (its `.git` is a real directory),
 * undefined when `.git` is absent (legacy). Any other shape, or an lstat error
 * other than ENOENT, throws CorpusCustodyRefused `corpus-archive-marker-invalid` (exit 10).
 */
export function archiveCorpusRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Same reading as durableCorpusRoot / the JSONL indexer: `~` expands to HOME.
  const corpus = env.ANDENKEN_SESSION_CORPUS?.replace(/^~(?=\/|$)/, os.homedir());
  if (!corpus) return undefined;
  const marker = path.join(corpus, ".git");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(marker);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CorpusCustodyRefused("corpus-archive-marker-invalid", `${marker} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}); only a real directory (archive) or no .git at all (legacy) is accepted. No API call was made`, 10);
  }
  if (st.isDirectory()) return corpus;
  throw new CorpusCustodyRefused("corpus-archive-marker-invalid", `${marker} exists but is ${fileKind(st)}; only a real directory (archive) or no .git at all (legacy) is accepted. No API call was made`, 10);
}

/**
 * Refuse (CorpusCustodyRefused, exit 75; 10 for a wrong-shaped marker) unless
 * this process inherited a matching custody descriptor (see the header for what
 * that proves). A no-op outside archive mode. `writer` names the caller.
 */
export function assertCorpusCustody(writer: string, env: NodeJS.ProcessEnv = process.env): void {
  const corpus = archiveCorpusRoot(env);
  if (!corpus) return;
  const how = "run it through its wrapper (./run.sh / sync-sessions.sh), which holds custody and launches `node --import tsx`";
  const raw = env.ANDENKEN_CORPUS_CUSTODY_FD;
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 3) {
    throw new CorpusCustodyRefused("custody-absent", `${writer}: ${corpus} is an archive-mode corpus and this process holds no custody descriptor; ${how}. No API call was made`);
  }
  const fd = Number(raw);
  const lock = path.join(corpus, ".git", CORPUS_CUSTODY_LOCK);
  let lockStat: fs.Stats | undefined;
  try {
    lockStat = fs.lstatSync(lock);
  } catch {
    lockStat = undefined;
  }
  if (lockStat && !lockStat.isFile()) {
    throw new CorpusCustodyRefused("custody-lock-not-regular", `${writer}: ${lock} is ${fileKind(lockStat)}, not a regular file. No API call was made`);
  }
  let same = false;
  try {
    const a = fs.fstatSync(fd);
    same = lockStat !== undefined && a.isFile() && a.dev === lockStat.dev && a.ino === lockStat.ino;
  } catch {
    same = false;
  }
  if (!same) {
    throw new CorpusCustodyRefused("custody-fd-lost", `${writer}: descriptor ${fd} is not ${lock} (lost on the way, e.g. through \`pnpm exec tsx\`); ${how}. No API call was made`);
  }
  // flock(1) on the inherited open file description: fails only when ANOTHER
  // open file description holds the lock.
  const stdio: StdioOptions = ["ignore", "ignore", "ignore"];
  for (let i = 3; i < fd; i++) stdio.push("ignore");
  stdio.push(fd);
  const r = spawnSync("flock", ["-n", String(fd)], { stdio });
  if (r.error || r.status !== 0) {
    throw new CorpusCustodyRefused("custody-foreign", `${writer}: ${lock} is held through another open file description. No API call was made`);
  }
}
