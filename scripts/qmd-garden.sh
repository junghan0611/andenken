#!/usr/bin/env bash
# qmd-garden — GLG public garden qmd runner
#
# This wrapper is the operator contract for qmd over ~/repos/gh/notes/content.
# It pins the CJK-friendly embedding model and the NixOS thinkpad Vulkan runtime
# shim needed by node-llama-cpp's prebuilt GGUF backend.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QMD_REPO="${QMD_REPO:-$HOME/repos/3rd/qmd}"
GARDEN_DIR="${QMD_GARDEN_DIR:-$HOME/repos/gh/notes/content}"
COLLECTION_PREFIX="${QMD_COLLECTION_PREFIX:-garden}"
QMD_BIN="${QMD_BIN:-qmd}"
LOCAL_BUILDS_DIR="$QMD_REPO/node_modules/node-llama-cpp/llama/localBuilds"

# GLG garden is Korean/CJK + English proper nouns + citation metadata.
# qmd's default embeddinggemma-300M is English-oriented, so first baseline must
# not embed with the default model.
DEFAULT_QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
export QMD_EMBED_MODEL="${QMD_EMBED_MODEL:-$DEFAULT_QMD_EMBED_MODEL}"
export QMD_LLAMA_GPU="${QMD_LLAMA_GPU:-vulkan}"

# NixOS/nix-ld contract: node-llama-cpp is dlopen'ed by the Nix node process.
# The dynamic loader path must be visible via LD_LIBRARY_PATH, not only NIX_LD_*.
if [[ -n "${NIX_LD_LIBRARY_PATH:-}" ]]; then
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$NIX_LD_LIBRARY_PATH:"*) ;;
    *) export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  esac
fi

usage() {
  cat <<'EOF'
qmd-garden — run qmd for GLG public garden Markdown

Usage:
  scripts/qmd-garden.sh <command> [args]

Commands:
  env                 Print pinned qmd environment
  clean-local-builds  Remove node-llama-cpp CPU-only fallback build cache
  status              qmd status with GPU probe
  preflight           clean-local-builds + verify Vulkan backend + qmd status
  bootstrap [flags]   Register garden collections/contexts via qmd-context.ts
                      defaults: --cache-dir ~/repos/gh/notes/content --collection-prefix garden
                      supports --only meta (or comma list) for small smoke
                      pass --execute to actually register
  embed [args]        clean-local-builds + qmd embed (passes args through)
                      example: embed -f --max-docs-per-batch 200 --max-batch-mb 64
  query <query> ...   qmd query with pinned env
  search <query> ...  qmd search with pinned env
  vsearch <query> ... qmd vsearch with pinned env
  mcp-http [args]     qmd mcp --http (passes args through; add --daemon if wanted)
  raw <args...>       qmd <args...> with pinned env

Pinned defaults:
  QMD_EMBED_MODEL=hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
  QMD_LLAMA_GPU=vulkan
  LD_LIBRARY_PATH includes $NIX_LD_LIBRARY_PATH when present

Why clean-local-builds?
  If qmd/node-llama-cpp runs once without LD_LIBRARY_PATH on NixOS, it may cache
  a CPU-only source fallback under node_modules/node-llama-cpp/llama/localBuilds.
  That cache can take precedence over the Vulkan prebuilt addon. Remove it before
  baseline embed.
EOF
}

print_env() {
  cat <<EOF
QMD_BIN=$QMD_BIN
QMD_REPO=$QMD_REPO
QMD_GARDEN_DIR=$GARDEN_DIR
QMD_COLLECTION_PREFIX=$COLLECTION_PREFIX
QMD_EMBED_MODEL=$QMD_EMBED_MODEL
QMD_LLAMA_GPU=$QMD_LLAMA_GPU
NIX_LD_LIBRARY_PATH=${NIX_LD_LIBRARY_PATH:-}
LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-}
LOCAL_BUILDS_DIR=$LOCAL_BUILDS_DIR
EOF
}

clean_local_builds() {
  if [[ -d "$LOCAL_BUILDS_DIR" ]]; then
    echo "Removing stale node-llama-cpp localBuilds: $LOCAL_BUILDS_DIR" >&2
    rm -rf "$LOCAL_BUILDS_DIR"
  else
    echo "No localBuilds cache: $LOCAL_BUILDS_DIR" >&2
  fi
}

verify_vulkan() {
  echo "Verifying node-llama-cpp Vulkan backend..." >&2
  (cd "$QMD_REPO" && bun -e 'import("node-llama-cpp").then(m=>m.getLlama({gpu:"vulkan"})).then(async l=>console.log(l.gpu, await l.getGpuDeviceNames()))')
}

qmd_status() {
  QMD_STATUS_DEVICE_PROBE=1 "$QMD_BIN" status
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  help|-h|--help)
    usage ;;
  env)
    print_env ;;
  clean-local-builds)
    clean_local_builds ;;
  status)
    qmd_status "$@" ;;
  preflight)
    print_env
    clean_local_builds
    verify_vulkan
    qmd_status ;;
  bootstrap)
    cd "$REPO_DIR"
    pnpm exec tsx qmd-context.ts \
      --cache-dir "$GARDEN_DIR" \
      --collection-prefix "$COLLECTION_PREFIX" \
      --qmd-bin "$QMD_BIN" \
      "$@" ;;
  embed)
    if [[ "${QMD_KEEP_LOCAL_BUILDS:-0}" != "1" ]]; then
      clean_local_builds
    fi
    "$QMD_BIN" embed "$@" ;;
  query|search|vsearch)
    "$QMD_BIN" "$cmd" "$@" ;;
  mcp-http)
    "$QMD_BIN" mcp --http "$@" ;;
  raw)
    "$QMD_BIN" "$@" ;;
  *)
    echo "unknown command: $cmd" >&2
    usage >&2
    exit 1 ;;
esac
