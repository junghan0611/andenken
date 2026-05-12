#!/usr/bin/env bash
# sync-md-to-oracle.sh — copy completed local md index to Oracle without re-embedding.
#
# Purpose:
#   md full indexing is paid-remote. Build once locally, then rsync the LanceDB
#   directory + manifest to Oracle. Oracle must already have ANDENKEN_MD_* in
#   ~/.env.local for query-time embeddings; this script does not edit remote env.
#
# Usage:
#   ./scripts/sync-md-to-oracle.sh
#   ./scripts/sync-md-to-oracle.sh --dry-run
#   ./scripts/sync-md-to-oracle.sh --host oracle --smoke
#
# Safety:
#   - API 0 by default: rsync + remote status/verify only.
#   - --smoke runs one remote search:md query (one paid query embedding call).
#   - Refuses to run before data/md.lance and data/md-manifest.json exist.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

HOST=oracle
DRY_RUN=0
VERIFY=1
SMOKE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host requires value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --smoke) SMOKE=1; shift ;;
    --help|-h) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

if [ ! -d data/md.lance ]; then
  echo "❌ data/md.lance not found. Run local md indexing first:"
  echo "   ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 ./run.sh index:md"
  exit 1
fi
if [ ! -f data/md-manifest.json ]; then
  echo "❌ data/md-manifest.json not found. Refusing to push a DB without manifest."
  exit 1
fi

REMOTE_ROOT="/home/junghan/repos/gh/andenken"
RSYNC_FLAGS=(-az --delete)
if [ "$DRY_RUN" = "1" ]; then
  RSYNC_FLAGS+=(--dry-run)
fi

echo "== sync md.lance → ${HOST}:${REMOTE_ROOT}/data/md.lance =="
rsync "${RSYNC_FLAGS[@]}" \
  data/md.lance/ \
  "${HOST}:${REMOTE_ROOT}/data/md.lance/"

echo "== sync md-manifest.json → ${HOST}:${REMOTE_ROOT}/data/md-manifest.json =="
rsync -az ${DRY_RUN:+--dry-run} \
  data/md-manifest.json \
  "${HOST}:${REMOTE_ROOT}/data/md-manifest.json"

if [ "$DRY_RUN" = "1" ]; then
  echo "== dry-run complete (no remote verify) =="
  exit 0
fi

if [ "$VERIFY" = "1" ]; then
  echo "== remote status + verify md (API 0) =="
  ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh status && ./run.sh verify md"
fi

if [ "$SMOKE" = "1" ]; then
  echo "== remote smoke search:md (paid query embedding: tiny) =="
  ssh "$HOST" "cd '$REMOTE_ROOT' && ./run.sh search:md '보편 학문' --limit 5"
fi

echo "== $(date --iso-8601=seconds) md oracle sync done =="
