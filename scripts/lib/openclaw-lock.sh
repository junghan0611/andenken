# shellcheck shell=bash
# openclaw-lock.sh — the OpenClaw harvest lock for shell entries.
#
# One lock guards every writer of openclaw.lance and its staging directory:
# flock(2) on <data dir>/.openclaw-harvest.lock (data dir = ANDENKEN_DATA, else
# this repo's data/), held on FD 8. Harvest, import, prune, restore, compact,
# FTS bootstrap and publish all take this same lock; Node writers verify it
# (openclaw-lock.ts) and are launched with `node --import tsx` so FD 8 reaches
# them.
#
# Re-entry is proven, not announced. A nested entry (prune --publish → publish,
# sync:openclaw → export) holds the lock when its inherited FD 8 is this file
# (same device and inode) AND that open file description holds the flock, as
# /proc/<pid>/fdinfo/8 shows. No environment variable is trusted: a variable can
# only claim the lock, the descriptor holds it. Otherwise the entry opens the
# file and takes the lock itself, non-blocking; a held lock refuses with exit 1.
# flock(1) is required — without it the entry refuses instead of running
# unlocked.
#
#   . scripts/lib/openclaw-lock.sh
#   openclaw_lock_acquire "sync:openclaw"   # exits 1 when another holder has it
#
# The lock is released when the last process holding FD 8 exits.

_OPENCLAW_LOCK_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

openclaw_lock_path() {
  printf '%s/.openclaw-harvest.lock' "${ANDENKEN_DATA:-$_OPENCLAW_LOCK_REPO/data}"
}

# 0 when this shell's FD 8 is the lock file and its description holds the flock.
openclaw_lock_inherited() {
  local lock
  lock="$(openclaw_lock_path)"
  [ -f "$lock" ] && [ ! -L "$lock" ] || return 1
  [ /dev/fd/8 -ef "$lock" ] 2>/dev/null || return 1
  grep -Eq '^lock:[[:space:]]+[0-9]+:[[:space:]]+FLOCK[[:space:]]+[^[:space:]]+[[:space:]]+WRITE([[:space:]]|$)' \
    "/proc/$BASHPID/fdinfo/8" 2>/dev/null
}

openclaw_lock_acquire() {
  local label="${1:-openclaw}" lock
  openclaw_lock_inherited && return 0
  lock="$(openclaw_lock_path)"
  if ! command -v flock >/dev/null 2>&1; then
    echo "❌ $label refused: flock(1) not found — the openclaw harvest lock cannot be taken, so nothing runs unlocked" >&2
    exit 1
  fi
  if [ -L "$lock" ] || { [ -e "$lock" ] && [ ! -f "$lock" ]; }; then
    echo "❌ $label refused: $lock is not a regular file" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$lock")"
  exec 8>>"$lock"
  if ! flock -n 8; then
    echo "❌ $label refused: another openclaw harvest/import/prune/compact/FTS/publish holds the lock ($lock)" >&2
    exit 1
  fi
}
