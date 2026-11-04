/**
 * The OpenClaw harvest lock, Node side.
 *
 * One lock guards every writer of `openclaw.lance` and its staging directory:
 * flock(2) on `<data dir>/.openclaw-harvest.lock`, held on FD 8 by the shell
 * entry (`run.sh` through scripts/lib/openclaw-lock.sh). A Node writer never
 * takes it; it proves that it runs inside it. `pnpm exec tsx` does not pass FD 8
 * through, so run.sh launches these writers with `node --import tsx` — the same
 * rule as corpus custody (corpus-custody.ts).
 *
 * What is checked, exactly, and nothing else: FD 8 is open on a regular file
 * with the lock path's device and inode (a symlinked lock path is refused), and
 * `/proc/self/fdinfo/8` lists a held FLOCK WRITE lock on that open file
 * description. Unlike `flock -n`, the fdinfo read cannot take a lock nobody held,
 * so a pass means this description already holds it. No environment variable is
 * read: a variable that says "the lock is held" is a claim, and the descriptor
 * is the proof. Off Linux (no /proc) the check refuses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "./store.js";

export const OPENCLAW_LOCK_FD = 8;
export const OPENCLAW_LOCK_FILE = ".openclaw-harvest.lock";

export function openclawLockPath(dataDir: string = getDataDir()): string {
	return path.join(dataDir, OPENCLAW_LOCK_FILE);
}

export class OpenclawLockRefused extends Error {
	readonly exitCode = 1;
	constructor(writer: string, reason: string, door: string) {
		super(`${writer} refused: it writes only under the openclaw harvest lock (${reason}) — run it through ./run.sh ${door}`);
		this.name = "OpenclawLockRefused";
	}
}

/** A held lock line of an fdinfo file: `lock:\t1: FLOCK  ADVISORY  WRITE <pid> <dev>:<ino> 0 EOF`. */
export function fdinfoHoldsFlockWrite(fdinfo: string): boolean {
	return /^lock:\s+\d+:\s+FLOCK\s+\S+\s+WRITE\b/m.test(fdinfo);
}

/** Why this process does not hold the lock, or null when it does. */
export function openclawLockAbsence(dataDir: string = getDataDir()): string | null {
	const lock = openclawLockPath(dataDir);
	let lockStat: fs.Stats;
	try {
		lockStat = fs.lstatSync(lock);
	} catch {
		return `${lock} does not exist`;
	}
	if (!lockStat.isFile()) return `${lock} is not a regular file`;
	let fdStat: fs.Stats;
	try {
		fdStat = fs.fstatSync(OPENCLAW_LOCK_FD);
	} catch {
		return `FD ${OPENCLAW_LOCK_FD} is not open`;
	}
	if (!fdStat.isFile() || fdStat.dev !== lockStat.dev || fdStat.ino !== lockStat.ino) {
		return `FD ${OPENCLAW_LOCK_FD} is not ${lock}`;
	}
	let fdinfo: string;
	try {
		fdinfo = fs.readFileSync(`/proc/self/fdinfo/${OPENCLAW_LOCK_FD}`, "utf-8");
	} catch {
		return `/proc/self/fdinfo/${OPENCLAW_LOCK_FD} is unreadable`;
	}
	return fdinfoHoldsFlockWrite(fdinfo) ? null : `FD ${OPENCLAW_LOCK_FD} is ${lock} but does not hold its flock`;
}

/** Throw OpenclawLockRefused (exit 1) unless this process runs inside the lock. */
export function assertOpenclawWriteLock(writer: string, door: string, dataDir?: string): void {
	const absence = openclawLockAbsence(dataDir);
	if (absence) throw new OpenclawLockRefused(writer, absence, door);
}
