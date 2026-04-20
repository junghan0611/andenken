#!/usr/bin/env bash
# Dual GPU incremental — sessions + org, manifest-driven (no --force).
# Opens SSH tunnels to gpu1i/gpu2i (with keep-alive) and runs incremental indexing.
# Per ~/AGENTS.md: "GPU 서버 인덱싱 의무" — query-time OpenRouter defaults are
# explicitly overridden so indexing never leaks to a paid endpoint.
set -euo pipefail

cd /home/junghan/repos/gh/andenken

# --- 1) Tunnels (idempotent, with keep-alive to survive long org passes) ---
SSH_OPTS=(-fN -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes)

up() { curl -sf -m 3 "http://localhost:$1/health" > /dev/null; }

if ! up 18000; then ssh "${SSH_OPTS[@]}" -L 18000:localhost:8000 gpu1i; fi
if ! up 18001; then ssh "${SSH_OPTS[@]}" -L 18001:localhost:8000 gpu2i; fi
up 18000 && echo "tunnel 18000 → gpu1i:8000 OK"
up 18001 && echo "tunnel 18001 → gpu2i:8000 OK"

# --- 2) Indexing env (override ~/.env.local query defaults) ---
export ANDENKEN_PROVIDER=vllm
export ANDENKEN_VLLM_ENDPOINT=http://localhost:18000,http://localhost:18001
export ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
export ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
unset ANDENKEN_VLLM_API_KEY
export INDEX_CONCURRENCY=4
export ANDENKEN_EMBED_BATCH=500

echo "== $(date --iso-8601=seconds) dual incremental start =="

echo "== sessions incremental =="
npx tsx indexer.ts sessions
npx tsx indexer.ts verify sessions

echo "== org cleanup + incremental =="
npx tsx indexer.ts cleanup org
npx tsx indexer.ts org
npx tsx indexer.ts verify org

echo "== $(date --iso-8601=seconds) dual incremental done =="
