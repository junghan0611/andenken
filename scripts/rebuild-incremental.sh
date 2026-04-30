#!/usr/bin/env bash
# Single-GPU incremental — sessions + org, manifest-driven (no --force).
# Opens SSH tunnel to gpu1i (with keep-alive) and runs incremental indexing.
# Per ~/AGENTS.md: "GPU 서버 인덱싱 의무" — query-time OpenRouter defaults are
# explicitly overridden so indexing never leaks to a paid endpoint.
#
# NOTE (2026-04-30): gpu2i was repurposed as VOS chat-completion node
# (Qwen2.5-7B-Instruct-AWQ). It MUST NOT be used for embedding — it would
# return 3584d (last hidden state) and corrupt the 2560d LanceDB index.
# This script is now single-GPU (gpu1i only). The dim probe below blocks
# accidental hits to a wrong model.
set -euo pipefail

cd /home/junghan/repos/gh/andenken

# --- 1) Tunnel (idempotent, with keep-alive to survive long org passes) ---
SSH_OPTS=(-fN -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes)

up() { curl -sf -m 3 "http://localhost:$1/health" > /dev/null; }

if ! up 18000; then ssh "${SSH_OPTS[@]}" -L 18000:localhost:8000 gpu1i; fi
up 18000 && echo "tunnel 18000 → gpu1i:8000 OK"

# --- 2) Safety: confirm we're talking to an embedding model, not VOS ---
probe_dim() {
  curl -sf -m 10 "http://localhost:$1/v1/embeddings" \
    -H "Content-Type: application/json" \
    -d '{"model":"/storage/models/vllm/default","input":"safety probe"}' \
    | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"][0]["embedding"]))' 2>/dev/null \
    || echo "0"
}
DIM=$(probe_dim 18000)
if [ "$DIM" != "2560" ]; then
  echo "❌ ABORT: gpu1i returned dim=$DIM (expected 2560 for Qwen3-Embedding-4B)"
  echo "   Check: ssh gpu1i 'systemctl status vllm-api && readlink /storage/models/vllm/default'"
  exit 1
fi
echo "✅ embedding dim=$DIM verified"

# --- 3) Indexing env (override ~/.env.local query defaults) ---
export ANDENKEN_PROVIDER=vllm
export ANDENKEN_VLLM_ENDPOINT=http://localhost:18000
export ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
export ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
unset ANDENKEN_VLLM_API_KEY
export INDEX_CONCURRENCY=4
export ANDENKEN_EMBED_BATCH=500

echo "== $(date --iso-8601=seconds) incremental start =="

echo "== sessions incremental =="
pnpm exec tsx indexer.ts sessions
pnpm exec tsx indexer.ts verify sessions

echo "== org cleanup + incremental =="
pnpm exec tsx indexer.ts cleanup org
pnpm exec tsx indexer.ts org
pnpm exec tsx indexer.ts verify org

echo "== $(date --iso-8601=seconds) incremental done =="
