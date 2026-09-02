#!/usr/bin/env bash
# rebuild-sessions-full.sh — Sessions full rebuild on OpenRouter Qwen3-Embedding-8B (4096d).
#
# Order (PR-B v2):
#   1. estimate --full     — API 0. Caller can stop here.
#   2. confirmation prompt — interactive, exact "yes" required. NO --yes flag.
#   3. preflight dim probe — API 1. Only after operator confirmed.
#   4. destroy             — sessions ONLY (data/sessions.lance + session-manifest.json).
#                            Org track is never touched.
#   5. force rebuild       — gated behind ANDENKEN_ALLOW_PAID_FULL_REBUILD=1
#                            (set by this script itself, not by env).
#   6. verify              — sanity check post-rebuild.
#
# Usage:
#   ./scripts/rebuild-sessions-full.sh             # interactive flow
#   ./scripts/rebuild-sessions-full.sh --dry-run   # estimate only, exit 0, API 0
#
# Notes:
#   - There is intentionally NO --yes / non-interactive flag in PR-B. Adding
#     one before the operator workflow stabilizes would re-open the door to
#     accidental large embeddings against a paid endpoint.
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

# --- env: SESSIONS namespace ONLY ---
#
# API KEY TIMING (PR-B v2 boundary):
#   - Step 1 (estimate) and Step 3 (confirmation reject) must run key-less.
#     `--dry-run` and "say no at the prompt" must NOT require OPENROUTER_API_KEY.
#   - The strict `:?` check happens just before Step 4 (preflight) and stays
#     in scope for Step 6 (force rebuild).
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

# --- Step 1: estimate (API 0) ---
echo "== Step 1/6: estimate (FULL REBUILD, API 0) =="
pnpm exec tsx indexer.ts estimate sessions --full
echo

# --- Step 2: --dry-run exits here ---
if [ "${1:-}" = "--dry-run" ]; then
  echo "(dry-run: no preflight, no destroy, no API call. estimate above is the full report.)"
  exit 0
fi

# --- Step 3: explicit confirmation (interactive only — no --yes flag) ---
echo "Proceed with FULL sessions rebuild?"
echo "  - Step 4: 1 preflight API call to verify endpoint dim=4096."
echo "  - Step 5: delete data/sessions.lance + data/session-manifest.json."
echo "  - Step 6: re-embed entire sessions corpus through OpenRouter (paid)."
echo "  - org track: NOT touched."
read -r -p "Type 'yes' to proceed (anything else aborts): " REPLY
if [ "$REPLY" != "yes" ]; then
  echo "aborted (no preflight, no destroy, no API call beyond Step 1 estimate which was 0)."
  exit 0
fi

# --- Step 4: preflight dim probe (API 1, only after confirm) ---
# API key strictly required from this point. Earlier API0 paths (estimate,
# --dry-run, confirmation reject) ran key-less by design.
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY required for preflight / indexing}"
export ANDENKEN_SESSION_API_KEY="$OPENROUTER_API_KEY"

echo "== Step 4/6: preflight dim probe (1 API call) =="
DIM=$(curl -sf -m 30 "$ANDENKEN_SESSION_ENDPOINT/v1/embeddings" \
  -H "Authorization: Bearer $ANDENKEN_SESSION_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$ANDENKEN_SESSION_MODEL\",\"input\":\"safety probe\"}" \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"][0]["embedding"]))' 2>/dev/null \
  || echo "0")
if [ "$DIM" != "4096" ]; then
  echo "❌ preflight dim=$DIM (expected 4096) — aborting before any destroy"
  exit 1
fi
echo "✅ preflight dim=4096"

# --- Step 5: destroy (sessions ONLY, paths enumerated) ---
echo "== Step 5/6: destroy sessions index =="
rm -rf data/sessions.lance data/session-manifest.json

# --- Step 6: full rebuild + verify ---
# ANDENKEN_ALLOW_PAID_FULL_REBUILD is set in-line ONLY for these commands so
# it does not leak to a parent shell. indexer.ts's paidRemote guard checks
# this env at runtime; with it set, force-rebuild against a paid provider
# proceeds.
echo "== Step 6/6: force rebuild + verify =="
ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 pnpm exec tsx indexer.ts sessions --force
ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 pnpm exec tsx indexer.ts verify sessions

echo "== $(date --iso-8601=seconds) full rebuild done =="
echo
echo "──────────────────────────────────────────────────────────────"
echo " ENV CUTOVER NOTICE — sessions track is now 4096d (OpenRouter)"
echo "──────────────────────────────────────────────────────────────"
echo " Indexing on this host succeeded with the env exported by this"
echo " script. SEARCH processes (pi extension, cli.ts search-sessions)"
echo " load env separately at process start — they will FAIL until you:"
echo
echo "   1. Add ANDENKEN_SESSION_PROVIDER=openrouter (and the rest of"
echo "      ANDENKEN_SESSION_*) to ~/.env.local."
echo "   2. Restart any long-lived pi extension / open shell that uses"
echo "      session_search or cli.ts search-sessions."
echo
echo " Without this, session_search will throw 'No sessions embedding"
echo " provider available' (PR-A v3 fail-loud guard)."
echo "──────────────────────────────────────────────────────────────"
