#!/usr/bin/env bash
# andenken — recollective thinking
# Semantic memory CLI for indexing, search, test, and maintenance.
#
# Usage: ./run.sh <command> [args]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HOME/.env.local"

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a; source "$ENV_FILE"; set +a
  else
    echo "⚠ $ENV_FILE not found"
  fi
}

help() {
  cat << 'EOF'
andenken — recollective thinking

Usage: ./run.sh <command> [args]

=== Setup ===
  setup                       pnpm install + build dist/
  build                       rebuild dist/ only (after source edits)

=== Indexing ===
  index:sessions [--force]    Index pi + Claude Code sessions
  index:md [--force]          Index public garden Markdown (issue #8)
  index:org [--force]         Index org-mode KB (disabled in production — upstream R&D)
  sync:md                     md incremental (alias for index:md without --force)
  compact [sessions|md|org]   Defragment LanceDB
  cleanup [sessions|md|org]   Dedup + orphan removal + manifest repair + compact
  cleanup [target] --dry-run  Dry-run (report only)
  verify [sessions|md|org|all] Post-indexing integrity check
  status                      Show index statistics (text)
  status:json                 Show index statistics (machine-readable JSON)
  estimate [sessions|md|org|all] Dry-run cost estimate (Gemini-priced, legacy)
  estimate:sessions [--full]  PR-B: sessions OpenRouter 8B estimate (API 0)
                              default = INCREMENTAL (manifest-driven)
                              --full  = whole corpus
                              price: ANDENKEN_SESSION_PRICE_PER_M_TOKENS
                                  > OPENROUTER_QWEN_8B_PRICE > 0.01
  estimate:md [--full]        Issue #8: md OpenRouter 8B estimate (API 0)
                              CJK-weighted token model, per-folder breakdown
                              price: ANDENKEN_MD_PRICE_PER_M_TOKENS
                                  > OPENROUTER_QWEN_8B_PRICE > 0.01
  sync:md:oracle [flags]      Rsync completed data/md.lance + md-manifest.json to Oracle
                              flags: --dry-run --no-verify --smoke --host <ssh-host>

=== Sessions full rebuild / sync (PR-B) ===
  rebuild:sessions[:dry]      scripts/rebuild-sessions-full.sh [--dry-run]
                              estimate → confirm → preflight → destroy → rebuild
  sync:sessions [--push]      scripts/sync-sessions.sh
                              wrong-dim → API0 abort
                              to_index=0 → API0 exit
                              else → preflight 1 + incremental
  rebuild:full                ❌ DEPRECATED (mixed sessions+org)
  rebuild:incremental         ❌ DEPRECATED (mixed sessions+org)

=== Search ===
  search <query> [--limit N]     Search sessions
                              flags: --source pi|claude|all
                                     --date-from ISO --date-to ISO
                                     --project name[,name] --role user[,assistant,compaction]
                                     --session-file path --session-file-contains substr
                                     --mode semantic|hybrid|recent
                              recent = stored-signal scan + timestamp DESC (no NL time parsing)
  search:md <query> [--limit N]  Search md (public garden) — issue #8
  knowledge <query> [--limit N]  Search knowledge base (org — disabled in production)

=== Test ===
  test                        All tests (unit + integration)
  test:unit                   Unit tests only (no API)
  test:integration            Integration tests (needs API)
  test:search "query"         Live search test

=== Benchmark ===
  golden [--db session|org]   Golden queries search quality test
  bench                       Full benchmark (needs API)
  bench:dry                   Dry run

=== Doctor (operator triage) ===
  doctor                      General: API / DB / oracle / stale / cost
  doctor --org                Org triage: retrieval smoke + chunk + structure
  doctor --org --no-smoke     Skip retrieval probes (no API calls)
  doctor --org --save-baseline  Record current snapshot as baseline
  doctor --org --json         JSON output
  doctor --md                 MD triage (V1): explain manifest↔indexed gap
  doctor --md --json          MD triage JSON output

=== Sanitize / Window prototypes (API 0) ===
  sanitize:dryrun [flags]     Parse-only sanitization dry-run over all sessions
                              Flags: --source pi|claude|all  --limit N  --json
  test:sanitize               Fixture tests for session-sanitize.ts (API 0)
  window:dryrun [flags]       Parse-only transcript-window dry-run over all sessions
                              Flags: --source pi|claude|all  --tokens N  --overlap N  --json
  test:window                 Fixture tests for session-window.ts (API 0)
  excerpt:session <f> <line>  Render read-only excerpt around a JSONL line (C2.1a)
                              Flags: --before N --after N --max N --no-tool --no-session --json
  test:excerpt                Fixture tests for session-excerpt.ts (API 0)

=== Utility ===
  env                         Show environment status
EOF
}

# --- Dispatch ---

case "${1:-help}" in
  help|-h|--help)
    help ;;

  # === Setup ===
  setup)
    echo "andenken: pnpm install + build"
    cd "$SCRIPT_DIR" && pnpm install && pnpm run build
    ;;
  build)
    echo "andenken: build dist/"
    cd "$SCRIPT_DIR" && pnpm run build
    ;;

  # === Index ===
  index:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts sessions "$@" ;;
  index:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts md "$@" ;;
  sync:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts md "$@" ;;
  index:org)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts org "$@" ;;
  compact)
    shift; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts compact "${1:-all}" ;;
  cleanup)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts cleanup "${1:-org}" "${@:2}" ;;
  verify)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts verify "${1:-all}" ;;
  status)
    load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts status ;;
  status:json)
    load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts status --json ;;

  # === Search ===
  search)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx cli.ts search-sessions "$@" ;;
  search:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx cli.ts search-md "$@" ;;
  knowledge)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx cli.ts search-knowledge "$@" ;;

  # === Test ===
  test)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx test.ts "${@:-all}" ;;
  test:unit)
    cd "$SCRIPT_DIR" && pnpm exec tsx test.ts unit ;;
  test:integration)
    load_env; cd "$SCRIPT_DIR" && pnpm exec tsx test.ts integration ;;
  test:search)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx test.ts search "$@" ;;

  # === Golden Queries ===
  golden)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx golden-queries.ts "$@" ;;

  # === Doctor ===
  doctor)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx doctor.ts "$@" ;;

  # === Bench ===
  bench)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx benchmark.ts "${@:-}" ;;
  bench:dry)
    cd "$SCRIPT_DIR" && pnpm exec tsx benchmark.ts dry ;;

  # === Utility ===
  env)
    load_env 2>/dev/null || true
    echo "=== andenken ==="
    echo "  Node:    $(node --version 2>/dev/null || echo 'not found')"
    echo "  GEMINI:  ${GEMINI_API_KEY:+SET (${#GEMINI_API_KEY}ch)}"
    echo "  JINA:    ${JINA_API_KEY:+SET (${#JINA_API_KEY}ch)}"
    echo "  Dir:     $SCRIPT_DIR"
    echo ""
    echo "  --- PR-B sessions track (ANDENKEN_SESSION_*) ---"
    echo "  PROVIDER:    ${ANDENKEN_SESSION_PROVIDER:-(unset — sessions search will fail)}"
    echo "  ENDPOINT:    ${ANDENKEN_SESSION_ENDPOINT:-(unset)}"
    echo "  MODEL:       ${ANDENKEN_SESSION_MODEL:-(unset)}"
    echo "  DIMENSIONS:  ${ANDENKEN_SESSION_DIMENSIONS:-(unset)}"
    echo "  API_KEY:     ${ANDENKEN_SESSION_API_KEY:+SET (${#ANDENKEN_SESSION_API_KEY}ch)}"
    echo "  PAID_REMOTE: ${ANDENKEN_SESSION_PAID_REMOTE:-0}"
    echo "  PRICE/M:     \$${ANDENKEN_SESSION_PRICE_PER_M_TOKENS:-(unset, default 0.01)}"
    echo ""
    echo "  --- md track (ANDENKEN_MD_*) ---"
    echo "  PROVIDER:    ${ANDENKEN_MD_PROVIDER:-(unset — md search will fail)}"
    echo "  ENDPOINT:    ${ANDENKEN_MD_ENDPOINT:-(unset)}"
    echo "  MODEL:       ${ANDENKEN_MD_MODEL:-(unset)}"
    echo "  DIMENSIONS:  ${ANDENKEN_MD_DIMENSIONS:-(unset)}"
    echo "  API_KEY:     ${ANDENKEN_MD_API_KEY:+SET (${#ANDENKEN_MD_API_KEY}ch)}"
    echo "  PAID_REMOTE: ${ANDENKEN_MD_PAID_REMOTE:-0}"
    echo "  PRICE/M:     \$${ANDENKEN_MD_PRICE_PER_M_TOKENS:-(unset, default 0.01)}"
    echo ""
    echo "  --- legacy / org track (ANDENKEN_VLLM_* + ANDENKEN_ORG_*) ---"
    echo "  ANDENKEN_PROVIDER (legacy):     ${ANDENKEN_PROVIDER:-(unset)}"
    echo "  ANDENKEN_VLLM_ENDPOINT (legacy): ${ANDENKEN_VLLM_ENDPOINT:-(unset)}"
    echo "  ANDENKEN_ORG_PROVIDER:          ${ANDENKEN_ORG_PROVIDER:-(unset — falls back to legacy ANDENKEN_VLLM_*)}"
    echo ""
    echo "  ↳ Sessions search (pi extension, cli.ts search-sessions) requires"
    echo "    ANDENKEN_SESSION_* in ~/.env.local. PR-B removed the legacy"
    echo "    ANDENKEN_VLLM_* fallback for sessions track."
    echo "  ↳ Org indexing/search still accepts legacy ANDENKEN_VLLM_* for"
    echo "    backward-compat."
    echo ""
    cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts status 2>/dev/null || echo "  (indexer not available)"
    ;;
  estimate)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx estimate.ts "${1:-all}" ;;
  estimate:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts estimate sessions "$@" ;;
  estimate:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts estimate md "$@" ;;
  sync:md:oracle)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/sync-md-to-oracle.sh "$@" ;;

  # === Sanitize / Window prototypes (API 0) ===
  sanitize:dryrun)
    shift; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/sanitize-dryrun.ts "$@" ;;
  test:sanitize)
    cd "$SCRIPT_DIR" && pnpm exec tsx session-sanitize.test.ts ;;
  window:dryrun)
    shift; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/window-dryrun.ts "$@" ;;
  test:window)
    cd "$SCRIPT_DIR" && pnpm exec tsx session-window.test.ts ;;
  excerpt:session)
    shift; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/session-excerpt.ts "$@" ;;
  test:excerpt)
    cd "$SCRIPT_DIR" && pnpm exec tsx session-excerpt.test.ts ;;

  # === PR-B sessions sync / rebuild ===
  rebuild:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/rebuild-sessions-full.sh "$@" ;;
  rebuild:sessions:dry)
    load_env; cd "$SCRIPT_DIR" && bash scripts/rebuild-sessions-full.sh --dry-run ;;
  sync:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/sync-sessions.sh "$@" ;;
  rebuild:full)
    cd "$SCRIPT_DIR" && bash scripts/rebuild-full.sh ;;
  rebuild:incremental)
    cd "$SCRIPT_DIR" && bash scripts/rebuild-incremental.sh ;;

  *)
    echo "Unknown: $1"; help; exit 1 ;;
esac
