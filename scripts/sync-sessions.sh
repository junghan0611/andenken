#!/usr/bin/env bash
# sync-sessions.sh — fast sessions-only incremental for 30min/1h cron.
#
# Auto-selects embedding backend in this order:
#   1. localhost:11434 (ollama) — preferred when laptop is offline / on battery
#   2. ssh gpu1i tunnel (vLLM RTX 5080) — preferred when at desk / wired
#
# Both backends emit Qwen3-Embedding-4B 2560d. Index is cross-compatible.
#
# Usage:
#   ./scripts/sync-sessions.sh             # sessions-only, no oracle push
#   ./scripts/sync-sessions.sh --push      # also rsync to oracle
#   ./scripts/sync-sessions.sh --backend ollama   # force ollama
#   ./scripts/sync-sessions.sh --backend gpu1i    # force gpu1i tunnel
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

# --- args ---
PUSH=0
BACKEND="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --help|-h) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

# --- backend selection ---
ollama_up() { curl -sf -m 2 http://localhost:11434/api/version > /dev/null; }
gpu1i_up()  { curl -sf -m 2 http://localhost:18000/health > /dev/null; }

ensure_gpu1i() {
  gpu1i_up && return 0
  ssh -fN -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -L 18000:localhost:8000 gpu1i
  gpu1i_up
}

probe_dim() {
  local url="$1"; local model="$2"
  curl -sf -m 10 "$url/v1/embeddings" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"input\":\"safety probe\"}" \
    | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"][0]["embedding"]))' \
    2>/dev/null || echo "0"
}

case "$BACKEND" in
  auto)
    if ollama_up; then BACKEND=ollama
    elif ensure_gpu1i; then BACKEND=gpu1i
    else echo "❌ no backend available (ollama down, gpu1i unreachable)"; exit 1
    fi
    ;;
  ollama) ollama_up || { echo "❌ ollama not running on :11434"; exit 1; } ;;
  gpu1i)  ensure_gpu1i || { echo "❌ gpu1i tunnel failed"; exit 1; } ;;
  *) echo "unknown backend: $BACKEND"; exit 2 ;;
esac

# --- env per backend ---
export ANDENKEN_PROVIDER=vllm
export ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
unset ANDENKEN_VLLM_API_KEY
export INDEX_CONCURRENCY=4
export ANDENKEN_EMBED_BATCH=200

case "$BACKEND" in
  ollama)
    export ANDENKEN_VLLM_ENDPOINT=http://localhost:11434
    export ANDENKEN_VLLM_MODEL=qwen3-embedding:4b
    # ollama on laptop is slower per request; allow up to 5min per batch
    # so a single large session (hundreds of messages) doesn't time out.
    export ANDENKEN_VLLM_TIMEOUT_MS=300000
    # smaller batch cuts both per-request memory and worst-case wait
    export ANDENKEN_EMBED_BATCH=64
    ;;
  gpu1i)
    export ANDENKEN_VLLM_ENDPOINT=http://localhost:18000
    export ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
    ;;
esac

DIM=$(probe_dim "$ANDENKEN_VLLM_ENDPOINT" "$ANDENKEN_VLLM_MODEL")
if [ "$DIM" != "2560" ]; then
  echo "❌ ABORT: $BACKEND returned dim=$DIM (expected 2560)"
  exit 1
fi

START=$(date --iso-8601=seconds)
echo "== $START sync-sessions backend=$BACKEND =="

# --- index sessions only (manifest-driven incremental) ---
pnpm exec tsx indexer.ts sessions

# --- optional oracle push ---
if [ "$PUSH" = "1" ]; then
  echo "== rsync sessions.lance → oracle =="
  rsync -az --delete \
    data/sessions.lance/ \
    oracle:/home/junghan/repos/gh/andenken/data/sessions.lance/ \
    2>&1 | tail -3
fi

echo "== $(date --iso-8601=seconds) done =="
