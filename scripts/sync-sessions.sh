#!/usr/bin/env bash
# sync-sessions.sh — sessions-only incremental, OpenRouter Qwen3-Embedding-8B 4096d.
#
# Operating cadence: hourly cron (30min~1h). Manifest-driven; never destroys
# the index. Full rebuilds go through scripts/rebuild-sessions-full.sh.
#
# Safety boundaries (PR-B):
#   - Wrong sessions DB dim → API 0 abort. (operator must run rebuild-sessions-full.sh first)
#   - to_index == 0          → API 0 exit, or rsync-only replica push with --push.
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

# --- corpus root: resolve from ~/.env.local when the caller did not export it ---
# `./run.sh` load_env's the file first, but a direct invocation (or a systemd
# unit) does not — and an unset corpus root silently falls back to this
# machine's live stores, which would rebuild the wrong, smaller corpus without
# saying so. Read it in a subshell so nothing else from that file leaks into
# this script's carefully scoped SESSION_* environment.
if [ -z "${ANDENKEN_SESSION_CORPUS:-}" ] && [ -f "$HOME/.env.local" ]; then
  ANDENKEN_SESSION_CORPUS="$(set -a; . "$HOME/.env.local" >/dev/null 2>&1; printf %s "${ANDENKEN_SESSION_CORPUS:-}")"
  [ -n "$ANDENKEN_SESSION_CORPUS" ] && export ANDENKEN_SESSION_CORPUS || unset ANDENKEN_SESSION_CORPUS
fi

# --- args ---
PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

# --- Single-writer lock (flock) ---
# The sessions index is a single-writer LanceDB store. The hourly cron and a
# manual memory-sync (or ./run.sh sync:sessions) can otherwise run at once and
# race the writer. Take a non-blocking exclusive lock; if another sync already
# holds it, exit cleanly — that run indexes the same pending files, so no work
# is lost. The lock auto-releases when this process exits (fd 9 closes). The
# lockfile lives under data/ (gitignored), so it never enters version control.
LOCKFILE="data/.sync-sessions.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -n 9; then
    echo "⚠ another sync-sessions is already running (lock: $LOCKFILE) — exiting"
    exit 0
  fi
fi

# --- Step 0: gather the corpus (API 0) ---
# Only when discovery is pointed at the corpus. There, the live runtime stores
# are NOT scanned — the indexer reads `<corpus>/<device>/…` and nothing else — so
# without this step a session written since the last gather would never be seen,
# and "incremental embedding" would quietly mean "incremental over a frozen
# snapshot". Gather first, then everything downstream is honest.
#
# Cheap enough to run every cycle: rsync moves only the delta (~1s / <1MB on a
# steady-state corpus of ~2.1k files). An unreachable device is a warning inside
# gather-corpus.sh, so a laptop off the network still indexes its own sessions.
if [ -n "${ANDENKEN_SESSION_CORPUS:-}" ] && [ "${SKIP_GATHER:-0}" != "1" ]; then
  echo "== gather corpus: $ANDENKEN_SESSION_CORPUS =="
  if ! ./scripts/gather-corpus.sh > "$LOCKFILE.gather" 2>&1; then
    echo "❌ gather-corpus failed — refusing to index a corpus of unknown freshness"
    tail -20 "$LOCKFILE.gather"
    exit 1
  fi
  grep -E '^(⚠|corpus:)' "$LOCKFILE.gather" || true
fi

# --- env: SESSIONS namespace ONLY ---
# Org / legacy env: never set, never unset, never read by this script.
# Price precedence: explicit session env > OpenRouter alias > 0.01 default.
#
# API KEY TIMING (PR-B v2 boundary):
#   - The key is *not* required for the API0 paths below (status:json read,
#     wrong-dim abort, to_index=0 exit, or --push replica sync). We weak-set
#     it here so those paths work key-less.
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

# --- Replica push (API 0; DB and manifest always travel together) ---
#
# This pushes with `rsync --delete` into oracle's index path, so it is only ever
# correct in one direction. INVARIANT.md §7.1: the single writer is the canonical
# host (thinkpad) and oracle is a query replica that must not run the indexer —
# oracle-native sessions become searchable by reaching thinkpad as SOURCE FILES
# (the corpus gather), never as replica-side embeddings.
#
# The guard names that host so a push from the wrong side fails loudly instead of
# silently overwriting the canonical index with an older or half-built copy. It is
# an env var rather than a comment because the failure is irreversible: set
# ANDENKEN_INDEX_AUTHORITY deliberately if the canonical host ever moves.
INDEX_AUTHORITY="${ANDENKEN_INDEX_AUTHORITY:-thinkpad}"
LOCAL_DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"
LOCAL_DEVICE="${LOCAL_DEVICE//[[:space:]]/}"

push_replica() {
  if [ "$LOCAL_DEVICE" != "$INDEX_AUTHORITY" ]; then
    echo "❌ --push refused: this is '$LOCAL_DEVICE', the index authority is '$INDEX_AUTHORITY'."
    echo "   The authority BUILDS the index; pushing from anywhere else overwrites it"
    echo "   (rsync --delete) with a copy that is at best older."
    echo "   To pull the authority's index here instead, rsync FROM $INDEX_AUTHORITY."
    echo "   To move the authority, set ANDENKEN_INDEX_AUTHORITY deliberately."
    return 1
  fi
  echo "== rsync sessions.lance → oracle =="
  rsync -az --delete \
    data/sessions.lance/ \
    oracle:/home/junghan/repos/gh/andenken/data/sessions.lance/ \
    2>&1 | tail -3

  # Manifest must travel with the DB: oracle is a replica, and a stale remote
  # manifest would make a local run there skip files the pushed DB no longer has.
  echo "== rsync session-manifest.json → oracle =="
  rsync -az \
    data/session-manifest.json \
    oracle:/home/junghan/repos/gh/andenken/data/session-manifest.json \
    2>&1 | tail -3
}

# --- Step 3: no-work guard (API 0; --push still replicates local maintenance) ---
if [ "$TO_INDEX" = "0" ]; then
  echo "✅ sessions: to-index=0 — no embedding work, no API call"
  if [ "$PUSH" = "1" ]; then
    push_replica
  fi
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
    push_replica
  else
    echo "⚠ skipping --push: index step did not complete cleanly"
  fi
fi

echo "== $(date --iso-8601=seconds) done =="
[ "$INDEX_OK" = "1" ]
