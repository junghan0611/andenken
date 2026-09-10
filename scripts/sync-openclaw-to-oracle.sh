#!/usr/bin/env bash
# sync-openclaw-to-oracle.sh — publish the authority's harvested OpenClaw axis.
#
# The harvest itself remains authority-only: Oracle must never run sync:openclaw.
# This copies the completed, local-only LanceDB store outward so Oracle can query
# the same axis. The database contains private bot conversations; it is copied
# only to the configured replica and never to the public md track.
#
# Usage:
#   ./scripts/sync-openclaw-to-oracle.sh
#   ./scripts/sync-openclaw-to-oracle.sh --dry-run
#   ./scripts/sync-openclaw-to-oracle.sh --host oracle --smoke
#
# Safety:
#   - API 0 by default: rsync + remote verify only.
#   - --smoke runs one remote search:openclaw query (one paid query embedding).
#   - Refuses on a non-authority device and before a completed local store exists.
set -euo pipefail
cd "$(dirname "$0")/.." # repo root

HOST=oracle
DRY_RUN=0
VERIFY=1
SMOKE=0
AUTHORITY="${ANDENKEN_INDEX_AUTHORITY:-thinkpad}"
DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host requires value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --smoke) SMOKE=1; shift ;;
    --help|-h) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

if [ "$DEVICE" != "$AUTHORITY" ]; then
  echo "❌ openclaw publish refused: this device is '$DEVICE', authority is '$AUTHORITY'." >&2
  echo "   Harvest and publish only from the authority; Oracle is query-only." >&2
  exit 1
fi

if [ ! -d data/openclaw.lance ]; then
  echo "❌ data/openclaw.lance not found. Run local ./run.sh sync:openclaw first." >&2
  exit 1
fi

REMOTE_ROOT="/home/junghan/repos/gh/andenken"
RSYNC_FLAGS=(-az --delete)
if [ "$DRY_RUN" = "1" ]; then
  RSYNC_FLAGS+=(--dry-run)
fi

echo "== sync openclaw.lance → ${HOST}:${REMOTE_ROOT}/data/openclaw.lance =="
rsync "${RSYNC_FLAGS[@]}" \
  data/openclaw.lance/ \
  "${HOST}:${REMOTE_ROOT}/data/openclaw.lance/"

if [ "$DRY_RUN" = "1" ]; then
  echo "== dry-run complete (no remote verify) =="
  exit 0
fi

if [ "$VERIFY" = "1" ]; then
  echo "== remote verify openclaw (API 0) =="
  ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh verify openclaw"
fi

if [ "$SMOKE" = "1" ]; then
  echo "== remote smoke search:openclaw (paid query embedding: tiny) =="
  ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh search:openclaw '메멘토 하트비트' --limit 3"
fi

echo "== $(date --iso-8601=seconds) openclaw oracle sync done =="
