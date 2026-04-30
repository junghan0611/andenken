#!/usr/bin/env bash
# Full single-GPU rebuild — MUST run on or with tunnel to the GPU server.
# Intentionally overrides ANDENKEN_VLLM_* from ~/.env.local so query-time
# OpenRouter defaults don't leak into the indexing path (cost + rate-limit risk).
# Per ~/AGENTS.md: "GPU 서버 인덱싱 의무".
#
# NOTE (2026-04-30): gpu2i was repurposed as VOS chat-completion node.
# Embedding now runs on gpu1i alone. See scripts/rebuild-incremental.sh
# for the dim safety probe; full rebuild assumes operator has verified
# the endpoint manually before destroying the index.
set -euo pipefail

cd /home/junghan/repos/gh/andenken

export ANDENKEN_PROVIDER=vllm
export ANDENKEN_VLLM_ENDPOINT=http://localhost:18000
export ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
export ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
unset ANDENKEN_VLLM_API_KEY
export INDEX_CONCURRENCY=4
export ANDENKEN_EMBED_BATCH=500

# Pre-flight dim check before destroying the existing index.
DIM=$(curl -sf -m 10 "http://localhost:18000/v1/embeddings" \
        -H "Content-Type: application/json" \
        -d '{"model":"/storage/models/vllm/default","input":"safety probe"}' \
      | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"][0]["embedding"]))' 2>/dev/null \
      || echo "0")
if [ "$DIM" != "2560" ]; then
  echo "❌ ABORT: endpoint returned dim=$DIM (expected 2560)"
  echo "   Refusing to destroy LanceDB index against an unknown model."
  exit 1
fi
echo "✅ embedding dim=$DIM — safe to rebuild"

echo "== $(date --iso-8601=seconds) full rebuild start =="

echo "== sessions reset =="
rm -rf data/sessions.lance
pnpm exec tsx indexer.ts sessions --force
pnpm exec tsx indexer.ts verify sessions

echo "== org reset =="
rm -rf data/org.lance data/org-manifest.json
pnpm exec tsx indexer.ts org --force
pnpm exec tsx indexer.ts verify org

echo "== $(date --iso-8601=seconds) full rebuild done =="
