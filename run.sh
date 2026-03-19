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
  setup                       npm install

=== Indexing ===
  index:sessions [--force]    Index pi + Claude Code sessions (3072d)
  index:org [--force]         Index org-mode knowledge base (768d)
  compact [sessions|org]      Defragment LanceDB
  status                      Show index statistics

=== Search ===
  search <query> [--limit N]  Search sessions
  knowledge <query> [--limit N]  Search knowledge base

=== Test ===
  test                        All tests (unit + integration)
  test:unit                   Unit tests only (no API)
  test:integration            Integration tests (needs API)
  test:search "query"         Live search test

=== Benchmark ===
  bench                       Full benchmark (needs API)
  bench:dry                   Dry run

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
    echo "andenken: npm install"
    cd "$SCRIPT_DIR" && npm install
    ;;

  # === Index ===
  index:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && npx tsx indexer.ts sessions "$@" ;;
  index:org)
    shift; load_env; cd "$SCRIPT_DIR" && npx tsx indexer.ts org "$@" ;;
  compact)
    shift; cd "$SCRIPT_DIR" && npx tsx indexer.ts compact "${1:-all}" ;;
  status)
    cd "$SCRIPT_DIR" && npx tsx indexer.ts status ;;

  # === Search ===
  search)
    shift; load_env; cd "$SCRIPT_DIR" && npx tsx cli.ts search-sessions "$@" ;;
  knowledge)
    shift; load_env; cd "$SCRIPT_DIR" && npx tsx cli.ts search-knowledge "$@" ;;

  # === Test ===
  test)
    shift; load_env; cd "$SCRIPT_DIR" && npx tsx test.ts "${@:-all}" ;;
  test:unit)
    cd "$SCRIPT_DIR" && npx tsx test.ts unit ;;
  test:integration)
    load_env; cd "$SCRIPT_DIR" && npx tsx test.ts integration ;;
  test:search)
    shift; load_env; cd "$SCRIPT_DIR" && npx tsx test.ts search "$@" ;;

  # === Bench ===
  bench)
    shift; load_env; cd "$SCRIPT_DIR" && npx tsx benchmark.ts "${@:-}" ;;
  bench:dry)
    cd "$SCRIPT_DIR" && npx tsx benchmark.ts dry ;;

  # === Utility ===
  env)
    load_env 2>/dev/null || true
    echo "=== andenken ==="
    echo "  Node:    $(node --version 2>/dev/null || echo 'not found')"
    echo "  GEMINI:  ${GEMINI_API_KEY:+SET (${#GEMINI_API_KEY}ch)}"
    echo "  JINA:    ${JINA_API_KEY:+SET (${#JINA_API_KEY}ch)}"
    echo "  Dir:     $SCRIPT_DIR"
    echo ""
    cd "$SCRIPT_DIR" && npx tsx indexer.ts status 2>/dev/null || echo "  (indexer not available)"
    ;;

  *)
    echo "Unknown: $1"; help; exit 1 ;;
esac
