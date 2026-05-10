#!/usr/bin/env bash
# DEPRECATED — mixed sessions+org incremental.
#
# Same reason as rebuild-full.sh: sessions (4096d OpenRouter) and org
# (2560d local) are no longer share-an-env-slot compatible. PR-B operating
# posture is per-track scripts.
#
# Replacements:
#   scripts/sync-sessions.sh   — sessions incremental (4096d, hourly cron)
#   (org incremental)          — manual: pnpm exec tsx indexer.ts org
#                                with ANDENKEN_ORG_* (or legacy ANDENKEN_VLLM_*) set
#
# This script intentionally aborts. See ROADMAP.md / AGENTS.md.
set -euo pipefail
echo "❌ scripts/rebuild-incremental.sh is deprecated."
echo
echo "  Sessions and Org now use separate provider namespaces."
echo
echo "  Use:"
echo "    scripts/sync-sessions.sh        # sessions 4096d incremental (hourly cron)"
echo "    # org incremental: pnpm exec tsx indexer.ts org   (with ANDENKEN_ORG_*)"
echo
echo "  See AGENTS.md and ROADMAP.md for context."
exit 1
