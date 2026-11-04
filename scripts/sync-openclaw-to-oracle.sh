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
#   ./scripts/sync-openclaw-to-oracle.sh --require-fts
#
# Safety:
#   - API 0 by default: local pre-publish + remote post-transfer verify.
#   - --smoke runs one remote search:openclaw query (one paid query embedding).
#   - Refuses on a non-authority device and before a completed local store exists.
#   - --require-fts (opt-in; without it nothing here changes): BEFORE any
#     transfer, the local store must pass `verify openclaw --require-fts` and the
#     replica must answer `fts:openclaw --protocol` with the exact protocol line —
#     a question about its CODE, not its data, so a replica whose current store
#     still lacks the index can receive its first indexed one. AFTER transfer,
#     the replica's own `verify openclaw --require-fts` must print the exact
#     healthy line. A replica that ignores the flag, echoes the command or only
#     passes the ordinary verify is refused: before transfer when it does not
#     answer the protocol, after it when it does not print the healthy line.
#     Cannot be combined with --no-verify (exit 2).
set -euo pipefail
cd "$(dirname "$0")/.." # repo root

HOST=oracle
DRY_RUN=0
VERIFY=1
SMOKE=0
REQUIRE_FTS=0
AUTHORITY="${ANDENKEN_INDEX_AUTHORITY:-thinkpad}"
DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host requires value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --smoke) SMOKE=1; shift ;;
    --require-fts) REQUIRE_FTS=1; shift ;;
    --help|-h) sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

if [ "$REQUIRE_FTS" = "1" ] && [ "$VERIFY" = "0" ]; then
  echo "❌ --require-fts is a verify requirement; it cannot be combined with --no-verify" >&2
  exit 2
fi

if [ "$DEVICE" != "$AUTHORITY" ]; then
  echo "❌ openclaw publish refused: this device is '$DEVICE', authority is '$AUTHORITY'." >&2
  echo "   Harvest and publish only from the authority; Oracle is query-only." >&2
  exit 1
fi

# Same lock as the harvest, the prune, compact and the FTS bootstrap: a publish
# must never ship a store that another command is halfway through changing.
# `prune:openclaw --publish` already holds it; this child inherits FD 8 and
# re-enters, proven by the descriptor (scripts/lib/openclaw-lock.sh).
. scripts/lib/openclaw-lock.sh
openclaw_lock_acquire "sync:openclaw:oracle"

DATA_DIR="${ANDENKEN_DATA:-data}"
# The exact lines openclaw-fts.ts prints (OPENCLAW_FTS_PROTOCOL / _HEALTHY_MARK).
FTS_PROTOCOL="openclaw-fts-required v1"
FTS_HEALTHY="openclaw-fts-required v1: healthy"

if [ ! -d "$DATA_DIR/openclaw.lance" ]; then
  echo "❌ $DATA_DIR/openclaw.lance not found. Run local ./run.sh sync:openclaw first." >&2
  exit 1
fi

REMOTE_ROOT="/home/junghan/repos/gh/andenken"
RSYNC_FLAGS=(-az --delete)
if [ "$DRY_RUN" = "1" ]; then
  RSYNC_FLAGS+=(--dry-run)
fi

if [ "$VERIFY" = "1" ] && [ "$REQUIRE_FTS" = "1" ]; then
  echo "== local verify openclaw --require-fts before publish (API 0) =="
  if out="$(./run.sh verify openclaw --require-fts)"; then rc=0; else rc=$?; fi
  printf '%s\n' "$out"
  if [ "$rc" != "0" ] || ! printf '%s\n' "$out" | grep -qxF "$FTS_HEALTHY"; then
    echo "❌ publish refused: the local store is not FTS-ready (verify rc=$rc). Nothing was transferred." >&2
    echo "   Build the index with ./run.sh fts:openclaw, then publish again." >&2
    exit 1
  fi
  echo "== replica protocol: fts:openclaw --protocol (opens nothing there) =="
  if proto="$(ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh fts:openclaw --protocol")"; then prc=0; else prc=$?; fi
  if [ "$prc" != "0" ] || ! printf '%s\n' "$proto" | grep -qxF "$FTS_PROTOCOL"; then
    echo "❌ publish refused: ${HOST} did not answer '$FTS_PROTOCOL' (rc=$prc) — its checkout cannot run the FTS-required verify. Nothing was transferred." >&2
    exit 1
  fi
elif [ "$VERIFY" = "1" ]; then
  echo "== local verify openclaw before publish (API 0) =="
  ./run.sh verify openclaw
fi

echo "== sync openclaw.lance → ${HOST}:${REMOTE_ROOT}/data/openclaw.lance =="
rsync "${RSYNC_FLAGS[@]}" \
  "$DATA_DIR/openclaw.lance/" \
  "${HOST}:${REMOTE_ROOT}/data/openclaw.lance/"

if [ "$DRY_RUN" = "1" ]; then
  echo "== dry-run complete (no remote verify) =="
  exit 0
fi

if [ "$VERIFY" = "1" ] && [ "$REQUIRE_FTS" = "1" ]; then
  echo "== remote verify openclaw --require-fts (API 0) =="
  if rout="$(ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh verify openclaw --require-fts")"; then rrc=0; else rrc=$?; fi
  printf '%s\n' "$rout"
  if [ "$rrc" != "0" ] || ! printf '%s\n' "$rout" | grep -qxF "$FTS_HEALTHY"; then
    echo "❌ ${HOST} did not confirm '$FTS_HEALTHY' after the transfer (rc=$rrc). The store was transferred; the replica is NOT confirmed FTS-ready." >&2
    exit 1
  fi
elif [ "$VERIFY" = "1" ]; then
  echo "== remote verify openclaw (API 0) =="
  ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh verify openclaw"
fi

if [ "$SMOKE" = "1" ]; then
  echo "== remote smoke search:openclaw (paid query embedding: tiny) =="
  ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh search:openclaw '메멘토 하트비트' --limit 3"
fi

echo "== $(date --iso-8601=seconds) openclaw oracle sync done =="
