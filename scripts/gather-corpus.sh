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
# WHICH devices is not decided here — `<corpus>/DEVICES.json` is the roster, so
# it travels with the corpus rather than living in this repo. A device declares
# how its sessions reach the corpus:
#
#   local  this machine (matched by ~/.current-device); gathered directly
#   ssh    pullable by another host via its `target` alias
#   push   delivers itself; nobody tries to pull it
#
# The push case is why the roster is not just a list of hostnames. Measured
# 2026-09-02: oracle -> thinkpad ssh is refused, and even if it were opened, a
# laptop that is asleep or away cannot be pulled from. So thinkpad pushes (see
# scripts/replicate-corpus.sh) and oracle gathers only itself — a host never
# blocks on a peer it was never supposed to reach.
#
# Usage:
#   ./scripts/gather-corpus.sh                  # all devices
#   ./scripts/gather-corpus.sh --dry-run        # plan only, copy nothing
#   ./scripts/gather-corpus.sh --only oracle    # one device
#   ./scripts/gather-corpus.sh --strict         # an unreachable active device FAILS
#
# --strict inverts the leniency below for callers that need a complete corpus.
# The default stays lenient on purpose (a laptop off the network must keep
# indexing itself); --strict exists for `sync-sessions.sh --global`, whose whole
# promise is that both machines agree afterwards.
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
ROSTER="$CORPUS/DEVICES.json"

DRY=0
ONLY=""
STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=1; shift ;;
    --only) ONLY="${2:?--only needs a device name}"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    # Print the whole header, Usage block included. It used to stop at line 32,
    # which cut off exactly the part a caller asks --help FOR — the flags. A help
    # range pinned to a line number drifts every time the header grows; this one
    # is anchored to the end of the comment block instead.
    --help|-h) sed -n "2,$(($(grep -n '^set -euo pipefail' "$0" | head -1 | cut -d: -f1) - 1))p" "$0"; exit 0 ;;
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

# --- roster ---
# Active devices, minus this one. Each row is "<id> <transport> <target>".
# A missing roster falls back to local-only, which is the honest reading of "no
# roster": gather what this machine has and claim nothing about peers.
PEERS=()
if [ -f "$ROSTER" ]; then
  while read -r line; do
    [ -n "$line" ] && PEERS+=("$line")
  done < <(ROSTER="$ROSTER" LOCAL="$LOCAL_DEVICE" python3 -c '
import json, os
roster = json.load(open(os.environ["ROSTER"]))
for d in roster.get("devices", []):
    if d.get("state") != "active":
        continue
    if d.get("id") == os.environ["LOCAL"]:
        continue
    print(d["id"], d.get("transport", "ssh"), d.get("target", d["id"]))
')
else
  echo "⚠ no roster at $ROSTER — gathering this device only"
fi

# corpus-admit.py is piped over ssh rather than run from a remote checkout, so
# gathering never depends on the remote having an andenken working tree.
#
# An unreachable remote is a warning, not a failure. The corpus is additive, so
# skipping a device loses nothing that a later run will not pick up — whereas
# failing hard here would mean a laptop off the network stops indexing its own
# sessions too.
UNREACHABLE=()
for peer in "${PEERS[@]}"; do
  read -r device transport target <<<"$peer"
  [ -z "$ONLY" ] || [ "$ONLY" = "$device" ] || continue

  if [ "$transport" = "push" ]; then
    # Not a gap: this device delivers itself. Say so, so a reader does not
    # mistake the silence for a device we forgot.
    echo "== $device: delivered by push — not pulled from here =="
    continue
  fi

  echo "== enumerating $device (remote: $target) =="
  if ! REMOTE_HOME="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" 'printf %s "$HOME"' 2>/dev/null)"; then
    echo "   ⚠ $device unreachable — skipped (corpus keeps what it already has)"
    UNREACHABLE+=("$device")
    continue
  fi
  ssh -o BatchMode=yes "$target" 'python3 - ' < "$ADMIT" > "$LISTDIR/$device.txt"
  gather_device "$device" "$LISTDIR/$device.txt" "$target:$REMOTE_HOME/"
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

# --strict fails LAST, after everything reachable was gathered and the manifest
# refreshed. A strict run that touched a peer it could not finish still leaves the
# corpus better than it found it — the exit code reports incompleteness, it does
# not undo work.
if [ "$STRICT" = "1" ] && [ ${#UNREACHABLE[@]} -gt 0 ]; then
  echo "❌ --strict: active device(s) not gathered: ${UNREACHABLE[*]}"
  echo "   The corpus is now incomplete for this run, so any claim that every"
  echo "   device is represented would be false. Reachable devices WERE gathered."
  exit 1
fi
exit 0
