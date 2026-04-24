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
  index:org [--force]         Index org-mode knowledge base
  compact [sessions|org]      Defragment LanceDB
  cleanup [sessions|org]      Dedup + orphan removal + manifest repair + compact
  cleanup [target] --dry-run  Dry-run (report only)
  verify [sessions|org|all]   Post-indexing integrity check
  status                      Show index statistics
  estimate [sessions|org|all] Dry-run cost estimate before indexing

=== Search ===
  search <query> [--limit N]  Search sessions
  knowledge <query> [--limit N]  Search knowledge base

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

  # === Search ===
  search)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx cli.ts search-sessions "$@" ;;
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
    cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts status 2>/dev/null || echo "  (indexer not available)"
    ;;
  estimate)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx estimate.ts "${1:-all}" ;;

  *)
    echo "Unknown: $1"; help; exit 1 ;;
esac
