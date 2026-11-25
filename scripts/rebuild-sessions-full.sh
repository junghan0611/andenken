#!/usr/bin/env bash
# rebuild-sessions-full.sh — RETIRED. in-place Qwen 4096d paid rebuild; Qwen is not known to current code
# Kept only so an old caller gets a named refusal instead of "not found".
# History: git log -- scripts/rebuild-sessions-full.sh; CHANGELOG.
set -euo pipefail
echo "❌ refused: scripts/rebuild-sessions-full.sh is retired (in-place Qwen 4096d paid rebuild; Qwen is not known to current code). Nothing was estimated, gathered, written or requested (API 0)." >&2
echo "   A sessions generation is built by ./run.sh candidate:sessions:plan / candidate:sessions:build into a fresh ANDENKEN_DATA." >&2
exit 2
