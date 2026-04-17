#!/usr/bin/env bash
set -euo pipefail

cd /home/junghan/repos/gh/andenken

export ANDENKEN_PROVIDER=vllm
export ANDENKEN_VLLM_ENDPOINT=http://localhost:18000,http://localhost:18001
export ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
export ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
export INDEX_CONCURRENCY=4
export ANDENKEN_EMBED_BATCH=500

echo "== $(date --iso-8601=seconds) dual full rebuild start =="

echo "== sessions reset =="
rm -rf data/sessions.lance
npx tsx indexer.ts sessions --force
npx tsx indexer.ts verify sessions

echo "== org reset =="
rm -rf data/org.lance data/org-manifest.json
npx tsx indexer.ts org --force
npx tsx indexer.ts verify org

echo "== $(date --iso-8601=seconds) dual full rebuild done =="
