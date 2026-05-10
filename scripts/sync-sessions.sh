#!/usr/bin/env bash
# sync-sessions.sh — sessions-only incremental, OpenRouter Qwen3-Embedding-8B 4096d.
#
# Operating cadence: hourly cron (30min~1h). Manifest-driven; never destroys
# the index. Full rebuilds go through scripts/rebuild-sessions-full.sh.
#
# Safety boundaries (PR-B):
#   - Wrong sessions DB dim → API 0 abort. (operator must run rebuild-sessions-full.sh first)
#   - to_index == 0          → API 0 exit.  (no work, no probe)
#   - to_index >= 1          → preflight 1 API call, then incremental embed.
#   - org track              → never touched. This script never reads/writes
#                              ANDENKEN_ORG_*, ANDENKEN_VLLM_*, or org.lance.
#
# Env scope notice:
#   This script exports ANDENKEN_SESSION_* in its own process so indexing
#   succeeds. Long-lived SEARCH consumers (pi extension, cli.ts) load env at
#   their own startup — they need ANDENKEN_SESSION_* in ~/.env.local (or the
#   parent shell) to use session_search after a track switch. See
#   scripts/rebuild-sessions-full.sh completion notice for details.
#
# Usage:
#   ./scripts/sync-sessions.sh             # incremental, no oracle push
#   ./scripts/sync-sessions.sh --push      # also rsync sessions.lance → oracle
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

# --- args ---
PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

# --- env: SESSIONS namespace ONLY ---
# Org / legacy env: never set, never unset, never read by this script.
# Price precedence: explicit session env > OpenRouter alias > 0.01 default.
#
# API KEY TIMING (PR-B v2 boundary):
#   - The key is *not* required for the API0 paths below (status:json read,
#     wrong-dim abort, to_index=0 exit). We weak-set it here so those paths
#     work key-less.
#   - The strict `:?` check happens just before Step 4 (preflight). Indexing
#     in Step 5 reuses the same exported value.
export ANDENKEN_SESSION_PROVIDER=openrouter
export ANDENKEN_SESSION_ENDPOINT=https://openrouter.ai/api
export ANDENKEN_SESSION_MODEL=qwen/qwen3-embedding-8b
export ANDENKEN_SESSION_PRESET=Qwen/Qwen3-Embedding-8B
export ANDENKEN_SESSION_DIMENSIONS=4096
export ANDENKEN_SESSION_API_KEY="${OPENROUTER_API_KEY:-}"   # weak: empty allowed for API0 paths
export ANDENKEN_SESSION_MAX_BATCH_SIZE=64
export ANDENKEN_SESSION_TIMEOUT_MS=60000
export ANDENKEN_SESSION_PAID_REMOTE=1
export ANDENKEN_SESSION_PRICE_PER_M_TOKENS="${ANDENKEN_SESSION_PRICE_PER_M_TOKENS:-${OPENROUTER_QWEN_8B_PRICE:-0.01}}"

# --- Step 1: status --json (API 0 — read DB schema + manifest) ---
# One JSON read gives us actual_dim and to_index. We never spawn `tsx -e`
# with top-level await here; the env's tsx CJS output has bitten us before.
STATUS_JSON=$(pnpm exec tsx indexer.ts status --json 2>/dev/null)

ACTUAL_DIM=$(printf '%s' "$STATUS_JSON" | python3 -c '
import sys, json
d = json.loads(sys.stdin.read())
v = d.get("sessions", {}).get("actual_dim")
print("" if v is None else v)
')

TO_INDEX=$(printf '%s' "$STATUS_JSON" | python3 -c '
import sys, json
d = json.loads(sys.stdin.read())
print(d.get("sessions", {}).get("to_index", 0))
')

# --- Step 2: wrong-dim guard (API 0 abort) ---
# DB exists with non-4096d → operator must do a destroy + full rebuild.
# This is the most important safety boundary in PR-B sessions cutover.
if [ -n "$ACTUAL_DIM" ] && [ "$ACTUAL_DIM" != "4096" ]; then
  echo "❌ sessions DB is ${ACTUAL_DIM}d; run scripts/rebuild-sessions-full.sh first"
  echo "   (no API call was made)"
  exit 1
fi

# --- Step 3: no-work guard (API 0 exit) ---
if [ "$TO_INDEX" = "0" ]; then
  echo "✅ sessions: to-index=0 — no work, no API call"
  exit 0
fi

# --- Step 4: preflight dim probe (API 1 — only when there is work) ---
# API key strictly required from this point. No earlier failure for API0 paths.
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY required for preflight / indexing}"
export ANDENKEN_SESSION_API_KEY="$OPENROUTER_API_KEY"

echo "preflight probe: 1 API call"
DIM=$(curl -sf -m 30 "$ANDENKEN_SESSION_ENDPOINT/v1/embeddings" \
  -H "Authorization: Bearer $ANDENKEN_SESSION_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$ANDENKEN_SESSION_MODEL\",\"input\":\"safety probe\"}" \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"][0]["embedding"]))' 2>/dev/null \
  || echo "0")
if [ "$DIM" != "4096" ]; then
  echo "❌ preflight dim=$DIM (expected 4096) — aborting"
  exit 1
fi
echo "✅ preflight dim=4096"

# --- Step 5: incremental indexing (manifest-driven; no --force) ---
START=$(date --iso-8601=seconds)
echo "== $START sync-sessions: incremental embedding (to_index=$TO_INDEX) =="
INDEX_OK=0
if pnpm exec tsx indexer.ts sessions; then
  INDEX_OK=1
fi

# --- Step 6: optional oracle push (only on successful index) ---
if [ "$PUSH" = "1" ]; then
  if [ "$INDEX_OK" = "1" ]; then
    echo "== rsync sessions.lance → oracle =="
    rsync -az --delete \
      data/sessions.lance/ \
      oracle:/home/junghan/repos/gh/andenken/data/sessions.lance/ \
      2>&1 | tail -3
  else
    echo "⚠ skipping --push: index step did not complete cleanly"
  fi
fi

echo "== $(date --iso-8601=seconds) done =="
[ "$INDEX_OK" = "1" ]
