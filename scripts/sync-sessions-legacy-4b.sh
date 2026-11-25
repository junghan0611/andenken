#!/usr/bin/env bash
# sync-sessions-legacy-4b.sh — RETIRED. Qwen3-4B 2560d sync; Qwen is not known to current code
# Kept only so an old caller gets a named refusal instead of "not found".
# History: git log -- scripts/sync-sessions-legacy-4b.sh; CHANGELOG.
set -euo pipefail
echo "❌ refused: scripts/sync-sessions-legacy-4b.sh is retired (Qwen3-4B 2560d sync; Qwen is not known to current code). Nothing was estimated, gathered, written or requested (API 0)." >&2
echo "   A sessions generation is built by ./run.sh candidate:sessions:plan / candidate:sessions:build into a fresh ANDENKEN_DATA." >&2
exit 2
