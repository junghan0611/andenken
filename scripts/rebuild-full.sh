#!/usr/bin/env bash
# DEPRECATED — mixed sessions+org rebuild.
#
# Sessions and Org now use separate provider namespaces (ANDENKEN_SESSION_*
# vs ANDENKEN_ORG_*) and may run on different dims (sessions 4096d via
# OpenRouter, org 2560d via local gpu1i). A single mixed-rebuild script
# can no longer apply one set of env vars to both tracks safely, and would
# either leak paid endpoints into org or stale endpoints into sessions.
#
# Replacements:
#   scripts/rebuild-sessions-full.sh   — sessions full rebuild (4096d)
#   (org full rebuild)                 — manual:
#                                        export ANDENKEN_ORG_PROVIDER=vllm
#                                        export ANDENKEN_ORG_ENDPOINT=...
#                                        pnpm exec tsx indexer.ts org --force
#                                        (or set legacy ANDENKEN_VLLM_* and run the same)
#
# This script intentionally aborts. See ROADMAP.md "변화 기록" / AGENTS.md
# for cutover context.
set -euo pipefail
echo "❌ scripts/rebuild-full.sh is deprecated."
echo
echo "  Sessions and Org now use separate provider namespaces; a single"
echo "  mixed-rebuild script is no longer safe."
echo
echo "  Use:"
echo "    scripts/rebuild-sessions-full.sh   # sessions 4096d (OpenRouter 8B)"
echo "    # org full rebuild: export ANDENKEN_ORG_* + pnpm exec tsx indexer.ts org --force"
echo
echo "  See AGENTS.md and ROADMAP.md for context."
exit 1
