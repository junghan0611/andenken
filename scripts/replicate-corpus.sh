#!/usr/bin/env bash
# replicate-corpus.sh — push the session corpus to the devices that cannot pull it.
#
# Why a push at all. Measured 2026-09-02: `ssh oracle` works from thinkpad, but
# `ssh thinkpad` from oracle is refused, and opening it would not help — a laptop
# that is asleep or away from the network cannot be pulled from at any hour the
# server chooses. So the laptop delivers itself while it is awake, and the server
# never blocks on a peer it was never going to reach.
#
# That inversion is what lets the embedding run on the server. The server holds a
# complete corpus at the SAME path (`~/repos/gh/session`), so the command GLG
# types there is character-for-character the command he would type here.
#
# ADDITIVE, like gather. No --delete: a session that left one device's live store
# must not be erased from another device's copy of the corpus. The corpus is the
# only place some of these sessions still exist.
#
# Usage:
#   ./scripts/replicate-corpus.sh              # push to every push-transport peer
#   ./scripts/replicate-corpus.sh --dry-run
#   ./scripts/replicate-corpus.sh --to oracle
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

if [ -z "${ANDENKEN_SESSION_CORPUS:-}" ] && [ -f "$HOME/.env.local" ]; then
  ANDENKEN_SESSION_CORPUS="$(set -a; . "$HOME/.env.local" >/dev/null 2>&1; printf %s "${ANDENKEN_SESSION_CORPUS:-}")"
fi
CORPUS="${ANDENKEN_SESSION_CORPUS:-$HOME/repos/gh/session}"
CORPUS="${CORPUS/#\~/$HOME}"
[ -d "$CORPUS" ] || { echo "corpus not found: $CORPUS" >&2; exit 1; }
ROSTER="$CORPUS/DEVICES.json"

DRY=0
TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=1; shift ;;
    --to) TO="${2:?--to needs a device id}"; shift 2 ;;
    --help|-h) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

LOCAL_DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"
LOCAL_DEVICE="${LOCAL_DEVICE//[[:space:]]/}"

# Targets: active roster devices, other than this one, that we can ssh to. A
# `push` device is skipped — it is a source that delivers itself, not a replica
# we can reach — which is exactly why we are pushing in the first place.
mapfile -t TARGETS < <(ROSTER="$ROSTER" LOCAL="$LOCAL_DEVICE" python3 -c '
import json, os
for d in json.load(open(os.environ["ROSTER"])).get("devices", []):
    if d.get("state") != "active" or d.get("id") == os.environ["LOCAL"]:
        continue
    if d.get("transport") != "ssh":
        continue
    print(d["id"], d.get("target", d["id"]))
')

[ ${#TARGETS[@]} -gt 0 ] || { echo "no ssh-reachable replica in $ROSTER"; exit 0; }

RSYNC_FLAGS=(-a --info=stats2)
[ "$DRY" = "1" ] && RSYNC_FLAGS+=(--dry-run)

# Refresh the inventory before shipping so the manifest that lands on the replica
# describes what actually travelled with it.
if [ "$DRY" = "0" ]; then
  ./scripts/corpus-manifest.sh update | head -2
fi

for row in "${TARGETS[@]}"; do
  read -r device target <<<"$row"
  [ -z "$TO" ] || [ "$TO" = "$device" ] || continue
  echo "== replicate corpus → $device ($target) =="
  if ! REMOTE_HOME="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" 'printf %s "$HOME"' 2>/dev/null)"; then
    echo "   ⚠ $device unreachable — skipped"
    continue
  fi
  DEST="$target:$REMOTE_HOME/${CORPUS#$HOME/}/"
  # Same path on both machines is the point; refuse rather than silently land
  # the corpus somewhere else.
  case "$CORPUS" in
    "$HOME"/*) ;;
    *) echo "❌ corpus is outside \$HOME ($CORPUS) — cannot mirror the path remotely" >&2; exit 1 ;;
  esac
  rsync "${RSYNC_FLAGS[@]}" "$CORPUS/" "$DEST" | tail -8
done

echo "== done =="
[ "$DRY" = "1" ] && echo "(dry run — nothing was written)"
exit 0
