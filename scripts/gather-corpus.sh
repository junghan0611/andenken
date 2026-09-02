#!/usr/bin/env bash
# gather-corpus.sh — collect admitted session JSONL from every device into the
# ~/repos/gh/session corpus.
#
# The corpus is the SSOT for GLG's session memory axis — a lifetime folder in the
# same class as the garden, meant to survive laptop and server replacements. Two
# rules follow from that and are not negotiable:
#
#   1. ADDITIVE ONLY. This script never passes --delete and never removes a file.
#      A session that vanishes from a device's live store stays in the corpus.
#   2. REAL COPIES. No hardlinks. A hardlinked corpus shares inodes with the live
#      runtime store, so it is not an independent artifact and cannot be moved to
#      another machine on its own.
#
# Layout — each device dir keeps the runtime's own path shape, so the corpus is
# the live path with a prefix bolted on. session-indexer.ts `detectSource` and
# `extractProjectName` both key off `/.claude/` and the `projects`/`sessions`
# path segments, so they keep working unchanged, and the device is recoverable
# from the path via the existing `sessionFileContains` filter (no schema change):
#
#   ~/repos/gh/session/
#   ├── thinkpad/
#   │   ├── .claude/projects/-home-junghan-repos-gh-andenken/<uuid>.jsonl
#   │   └── .pi/agent/sessions/--home-junghan-repos-gh-andenken--/<ts>_<uuid7>.jsonl
#   └── oracle/
#       ├── .claude/projects/...
#       └── .pi/agent/sessions/...
#
# Admission is decided by scripts/corpus-admit.py (mirrors session-indexer.ts).
# It is re-evaluated on every run, so a session that was below the 300KB floor
# last time is picked up once it grows past it.
#
# Usage:
#   ./scripts/gather-corpus.sh                  # all devices
#   ./scripts/gather-corpus.sh --dry-run        # plan only, copy nothing
#   ./scripts/gather-corpus.sh --only oracle    # one device
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

# One name for one thing. `ANDENKEN_SESSION_CORPUS` is what the indexer reads
# (session-indexer.ts `getCorpusRoot`) and what sync-sessions.sh keys its gather
# step off, so the gatherer must write to that same root — a second spelling here
# would let a custom path gather into one directory while the indexer read
# another, and the mismatch would show up only as an index that quietly stops
# growing. `SESSION_CORPUS` stays accepted as a fallback for direct callers.
CORPUS="${ANDENKEN_SESSION_CORPUS:-${SESSION_CORPUS:-$HOME/repos/gh/session}}"
CORPUS="${CORPUS/#\~/$HOME}"
ADMIT="$PWD/scripts/corpus-admit.py"
REMOTES=(oracle)

DRY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=1; shift ;;
    --only) ONLY="${2:?--only needs a device name}"; shift 2 ;;
    --help|-h) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Local device name. ~/.current-device is the machine's own label; the corpus
# dir must match it so a restored corpus keeps its provenance.
LOCAL_DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"
LOCAL_DEVICE="${LOCAL_DEVICE//[[:space:]]/}"
[ -n "$LOCAL_DEVICE" ] || { echo "cannot determine local device name" >&2; exit 1; }

LISTDIR="$(mktemp -d)"
trap 'rm -rf "$LISTDIR"' EXIT

# rsync flags shared by every device. -a keeps mtime, which is what makes the
# corpus comparable to the live store. --delete is absent on purpose (rule 1).
RSYNC_FLAGS=(-a --info=stats2)
[ "$DRY" = "1" ] && RSYNC_FLAGS+=(--dry-run)

gather_device() {
  local device="$1" list="$2" src="$3"
  local dest="$CORPUS/$device"
  local n; n=$(wc -l < "$list")
  echo "== $device: $n admitted files → $dest =="
  [ "$n" -gt 0 ] || { echo "   nothing to copy"; return 0; }
  [ "$DRY" = "1" ] || mkdir -p "$dest"
  rsync "${RSYNC_FLAGS[@]}" --files-from="$list" "$src" "$dest/" | tail -12
}

# --- local device ---
if [ -z "$ONLY" ] || [ "$ONLY" = "$LOCAL_DEVICE" ]; then
  echo "== enumerating $LOCAL_DEVICE (local) =="
  python3 "$ADMIT" > "$LISTDIR/$LOCAL_DEVICE.txt"
  gather_device "$LOCAL_DEVICE" "$LISTDIR/$LOCAL_DEVICE.txt" "$HOME/"
fi

# --- remote devices ---
# corpus-admit.py is piped over ssh rather than run from a remote checkout, so
# gathering never depends on the remote having an andenken working tree.
#
# An unreachable remote is a warning, not a failure. The corpus is additive, so
# skipping a device loses nothing that a later run will not pick up — whereas
# failing hard here would mean a laptop off the network stops indexing its own
# sessions too.
UNREACHABLE=()
for remote in "${REMOTES[@]}"; do
  [ -z "$ONLY" ] || [ "$ONLY" = "$remote" ] || continue
  echo "== enumerating $remote (remote) =="
  if ! REMOTE_HOME="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$remote" 'printf %s "$HOME"' 2>/dev/null)"; then
    echo "   ⚠ $remote unreachable — skipped (corpus keeps what it already has)"
    UNREACHABLE+=("$remote")
    continue
  fi
  ssh -o BatchMode=yes "$remote" 'python3 - ' < "$ADMIT" > "$LISTDIR/$remote.txt"
  gather_device "$remote" "$LISTDIR/$remote.txt" "$remote:$REMOTE_HOME/"
done

echo "== done =="
[ "$DRY" = "1" ] && echo "(dry run — nothing was written)"
if [ "$DRY" = "0" ] && [ -d "$CORPUS" ]; then
  echo "corpus: $(find "$CORPUS" -name '*.jsonl' | wc -l) files, $(du -sh "$CORPUS" | cut -f1)"
fi
if [ ${#UNREACHABLE[@]} -gt 0 ]; then
  echo "⚠ not gathered this run: ${UNREACHABLE[*]}"
fi

# The corpus carries its own inventory instead of a git history (GLG ruling
# 2026-09-02) — see scripts/corpus-manifest.sh. Refresh it here so "what do we
# have" is never stale relative to what was just gathered. Incremental: only
# new or changed files are hashed, so a steady-state run costs milliseconds.
if [ "$DRY" = "0" ]; then
  ./scripts/corpus-manifest.sh update | tail -n +2
fi
exit 0
