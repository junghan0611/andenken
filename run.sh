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

# LanceDB `table.optimize()` (compact/cleanup) hands the whole host to its Rust
# rayon/tokio pools — on a 16-core box that pins every core to 100%. rayon/tokio
# size their default pools from available_parallelism() (sched_getaffinity), so
# pinning CPU affinity to a few cores is the robust, provider-agnostic throttle:
# no env-var guessing about which internal pool to cap. Override the core set
# with ANDENKEN_COMPACT_CPUS (taskset -c syntax, e.g. "0-3" or "0,2,4,6").
COMPACT_CPUS="${ANDENKEN_COMPACT_CPUS:-0-3}"

run_pinned() {
  if command -v taskset >/dev/null 2>&1; then
    taskset -c "$COMPACT_CPUS" "$@"
  else
    echo "⚠ taskset not found — running compact without CPU pinning (may saturate all cores)" >&2
    "$@"
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
  compact [sessions|md|org|openclaw]
                              Defragment LanceDB (CPU-pinned to ANDENKEN_COMPACT_CPUS, default 0-3)
                              `all` = sessions+md+org. openclaw by name: it is our
                              own harvest DB (their vectors, our store), fragmented
                              by our own import writes. OpenClaw's sqlite is never
                              touched — the export opens it read-only
  cleanup [sessions|md|org]   Dedup + orphan removal + manifest repair + compact (CPU-pinned)
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
  sync:openclaw [--full]      Harvest OpenClaw's own index (export + import).
                              Zero embedding cost — the vectors come already
                              computed. Append-only; never mirrors their deletes
  sync:md:oracle [flags]      Rsync completed data/md.lance + md-manifest.json to Oracle
                              flags: --dry-run --no-verify --smoke --host <ssh-host>

=== Sessions full rebuild / sync (PR-B) ===
  rebuild:sessions[:dry]      scripts/rebuild-sessions-full.sh [--dry-run]
                              estimate → confirm → preflight → destroy → rebuild
  sync:sessions [--local|--global]
                              scripts/sync-sessions.sh (default --local: this
                              device only, ssh 0; --global: all devices + verify
                              + publish index/manifest/corpus together)
                              wrong-dim → API0 abort
                              to_index=0 → API0 exit (or rsync-only with --push)
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
  search:openclaw <query> [--limit N] [--full]
                              Harvested OpenClaw bot memory. Its own axis, never a
                              fallback — every hit names its agent and whether the
                              bot SAID it (sessions) or KEPT it (memory)
  search:md <query> [--limit N] [--full]
                              Search md (public garden). Default limit 5,
                              document-grouped; --full widens each snippet.
  knowledge <query> [--limit N] [--full]
                              DEPRECATED alias for search:md. `cli.ts
                              search-knowledge` has run the md track since the
                              org axis was disabled; prefer search:md.

=== Test ===
  test                        All tests (unit + integration)
  test:unit                   Unit tests only (no API)
  test:integration            Integration tests (needs API)
  test:search "query"         Live search test
  test:filename               Fixture tests for pi corpus admission by filename (API 0)
  test:corpus                 Fixture tests for corpus-backed device discovery (API 0)
  test:split                  Fixture tests for long-turn embedding split (API 0)
  test:openclaw               Fixture tests for the OpenClaw harvest policy (API 0)
  test:parity                 Credential regex parity: python ↔ typescript (API 0)

=== Session corpus (~/repos/gh/session) ===
  corpus:gather [--dry-run] [--strict]
                              Collect admitted sessions from every device
  corpus:manifest [update|verify|status]
                              Inventory + sha256 integrity (git replacement)
  corpus:replicate [--to X]   Push the corpus to devices that cannot be pulled

=== Acceptance (user-facing quality — layers 1/2/3) ===
  accept [flags]              Acceptance report. DEFAULT IS API 0: index health +
                              stored-signal (recent-mode) probes only.
                              --retrieval   also run probes that need a PAID query
                                            embedding (1 call each, +1 if the
                                            sessions→md fallback fires)
                              --only id[,id]  --cases <file>  --label <name>
                              --json        machine-readable report
                              --save        write report under data/acceptance/
                                            (gitignored; private excerpts redacted)
                              --compare <prev.json>   before/after by probe
                              --strict      nonzero exit on fail/error
                              Probes run with ANDENKEN_DISABLE_RECALL_TRACKING=1 and
                              the run verifies recalls.jsonl did not grow.
                              A green tally is NOT user acceptance — layer 3 is a
                              human verdict. See the andenken-acceptance skill.
  test:accept                 Fixture tests for acceptance.ts (API 0)

=== Benchmark ===
  golden [--db session|md]    Golden queries search quality test
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
  doctor --sessions           Sessions triage (V1): gap + stored-signal distribution
  doctor --sessions --json    Sessions triage JSON output

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
    # Bypasses the corpus gather that sync:sessions performs, so in corpus mode
    # it indexes whatever snapshot happens to be on disk. That is a legitimate
    # thing to want while debugging the indexer, and a silent wrong answer if
    # you reached for it expecting "embed my sessions". Say which one this is.
    shift; load_env; cd "$SCRIPT_DIR"
    if [ -n "${ANDENKEN_SESSION_CORPUS:-}" ]; then
      echo "⚠ index:sessions does NOT gather — the corpus is used as-is."
      echo "  For the normal 'embed my sessions' path use:  ./run.sh sync:sessions"
      echo "  Continuing in 3s (Ctrl-C to stop)…" && sleep 3
    fi
    pnpm exec tsx indexer.ts sessions "$@" ;;
  index:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts md "$@" ;;
  sync:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts md "$@" ;;
  index:org)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts org "$@" ;;
  compact)
    shift; cd "$SCRIPT_DIR" && run_pinned pnpm exec tsx indexer.ts compact "${1:-all}" ;;
  cleanup)
    shift; load_env; cd "$SCRIPT_DIR" && run_pinned pnpm exec tsx indexer.ts cleanup "${1:-org}" "${@:2}" ;;
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
  test:filename)
    cd "$SCRIPT_DIR" && pnpm exec tsx session-filename.test.ts ;;
  test:corpus)
    cd "$SCRIPT_DIR" && pnpm exec tsx session-corpus.test.ts ;;
  test:split)
    cd "$SCRIPT_DIR" && pnpm exec tsx session-split.test.ts ;;
  test:openclaw)
    load_env; cd "$SCRIPT_DIR" && pnpm exec tsx openclaw-import.test.ts ;;
  test:parity)
    cd "$SCRIPT_DIR" && pnpm exec tsx credential-parity.test.ts ;;

  # === Session corpus ===
  corpus:gather)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/gather-corpus.sh "$@" ;;
  corpus:manifest)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/corpus-manifest.sh "${1:-update}" ;;
  corpus:replicate)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/replicate-corpus.sh "$@" ;;

  # === Golden Queries ===
  golden)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx golden-queries.ts "$@" ;;

  # === Acceptance ===
  accept)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx acceptance.ts "$@" ;;
  test:accept)
    cd "$SCRIPT_DIR" && pnpm exec tsx acceptance.test.ts ;;

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
  sync:openclaw)
    shift; load_env; cd "$SCRIPT_DIR" \
      && bash scripts/export-openclaw.sh "$@" \
      && pnpm exec tsx openclaw-importer.ts ;;
  search:openclaw)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx cli.ts search-openclaw "$@" ;;
  rebuild:full)
    cd "$SCRIPT_DIR" && bash scripts/rebuild-full.sh ;;
  rebuild:incremental)
    cd "$SCRIPT_DIR" && bash scripts/rebuild-incremental.sh ;;

  *)
    echo "Unknown: $1"; help; exit 1 ;;
esac
