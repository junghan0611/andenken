/**
 * The one writer lock for sessions.lance (and the files that describe it:
 * session-manifest.json, durable-manifest.json, corpus durable snapshots).
 *
 *   <data dir>/.sessions-write.lock/owner      pid= token= command= startedAt= host=
 *
 * Shared with scripts/lib/sessions-lock.sh — same directory, same owner file,
 * same rules:
 *
 *   - Non-blocking. A held lock is refused by name and never waited on:
 *     `sessions-writer-busy` (owner pid alive) or `sessions-writer-stale-lock`
 *     (owner gone or unreadable). A stale lock is NOT reclaimed automatically;
 *     an operator removes it after checking no writer runs. Exit code 75.
 *   - Created atomically: the owner file is written in a temp directory that
 *     is then renamed onto the lock path, so the lock never exists without an
 *     owner.
 *   - Re-entry by token only: a wrapper that holds the lock passes its token to
 *     its own children (`ANDENKEN_SESSIONS_LOCK_TOKEN`); a child re-enters only
 *     when that token equals the owner's AND the owner pid is alive. Node
 *     callers never put the token into process.env — use `childEnv()`.
 *   - Release removes the lock only when it still carries this holder's token.
 *
 * One lock, non-blocking acquisition and token re-entry: no wait cycle exists,
 * so no deadlock.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDataDir } from "./store.js";

export const SESSIONS_LOCK_ENV = "ANDENKEN_SESSIONS_LOCK_TOKEN";
export const SESSIONS_LOCK_EXIT = 75;

export interface SessionsLockOwner {
  pid: number;
  token: string;
  command: string;
  startedAt: string;
  host: string;
}

export class SessionsLockRefused extends Error {
  readonly exitCode = SESSIONS_LOCK_EXIT;
  constructor(
    readonly reason: "sessions-writer-busy" | "sessions-writer-stale-lock",
    readonly lockDir: string,
    readonly owner: SessionsLockOwner | null,
  ) {
    super(
      reason === "sessions-writer-busy"
        ? `${reason}: ${owner?.command ?? "?"} (pid ${owner?.pid ?? "?"}, since ${owner?.startedAt ?? "?"}) holds ${lockDir}`
        : `${reason}: ${lockDir} names ${owner ? `pid ${owner.pid} (${owner.command}), which is gone` : "no readable owner"} — remove it after checking no writer runs`,
    );
    this.name = "SessionsLockRefused";
  }
}

export interface SessionsLockHandle {
  token: string;
  /** True when this call re-entered a lock its parent wrapper holds. */
  reentrant: boolean;
  /** A copy of `base` carrying the token, for this holder's own child processes. */
  childEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  release(): void;
}

export function sessionsLockDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, ".sessions-write.lock");
}

export function readSessionsLockOwner(lockDir: string): SessionsLockOwner | null {
  try {
    const fields = Object.fromEntries(
      fs.readFileSync(path.join(lockDir, "owner"), "utf-8").split("\n").filter(Boolean).map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
    const pid = Number(fields.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !fields.token) return null;
    return { pid, token: fields.token, command: fields.command ?? "", startedAt: fields.startedAt ?? "", host: fields.host ?? "" };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireSessionsLock(
  command: string,
  opts: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): SessionsLockHandle {
  const lockDir = sessionsLockDir(opts.dataDir);
  const env = opts.env ?? process.env;
  const inherited = env[SESSIONS_LOCK_ENV];
  const withToken = (token: string) => (base: NodeJS.ProcessEnv = process.env) => ({ ...base, [SESSIONS_LOCK_ENV]: token });

  if (inherited) {
    const owner = readSessionsLockOwner(lockDir);
    if (owner && owner.token === inherited && pidAlive(owner.pid)) {
      return { token: inherited, reentrant: true, childEnv: withToken(inherited), release: () => {} };
    }
    // A token that no live owner carries is ignored, never trusted.
  }

  const refuse = (): never => {
    const owner = readSessionsLockOwner(lockDir);
    throw new SessionsLockRefused(owner && pidAlive(owner.pid) ? "sessions-writer-busy" : "sessions-writer-stale-lock", lockDir, owner);
  };
  if (fs.existsSync(lockDir)) refuse();

  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const token = crypto.randomBytes(8).toString("hex");
  const tmp = fs.mkdtempSync(`${lockDir}.tmp.`);
  fs.writeFileSync(
    path.join(tmp, "owner"),
    `pid=${process.pid}\ntoken=${token}\ncommand=${command}\nstartedAt=${new Date().toISOString()}\nhost=${os.hostname()}\n`,
  );
  try {
    fs.renameSync(tmp, lockDir);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    refuse();
  }
  // rename(2) may replace an EMPTY directory that appeared after the check above; the
  // owner file read back must be ours.
  if (readSessionsLockOwner(lockDir)?.token !== token) refuse();

  return {
    token,
    reentrant: false,
    childEnv: withToken(token),
    release: () => {
      if (readSessionsLockOwner(lockDir)?.token !== token) return;
      const gone = `${lockDir}.rm.${process.pid}.${token}`;
      fs.renameSync(lockDir, gone);
      fs.rmSync(gone, { recursive: true, force: true });
    },
  };
}

export async function withSessionsLock<T>(
  command: string,
  fn: (lock: SessionsLockHandle) => Promise<T>,
  opts: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const lock = acquireSessionsLock(command, opts);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
