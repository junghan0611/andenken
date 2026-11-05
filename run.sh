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

# A Node writer that reads or writes the session corpus. When the corpus root has
# a .git (archive mode), the custody lock is taken on FD 8 first and Node is
# launched with `node --import tsx`, which keeps that descriptor (`pnpm exec tsx`
# drops it, and the writer then refuses with exit 75). Without a .git this is a
# plain `node --import tsx` run. Run from $SCRIPT_DIR.
run_corpus_writer() {
  local label="$1"
  shift
  # shellcheck source=scripts/lib/corpus-custody.sh
  . scripts/lib/corpus-custody.sh
  if [ -n "${ANDENKEN_SESSION_CORPUS:-}" ]; then
    corpus_custody_acquire "$ANDENKEN_SESSION_CORPUS" "$label"
    # No gather ran here: the owner's preflight and the read-only source form
    # must pass before the writer starts (archive mode only).
    corpus_archive_ready "$ANDENKEN_SESSION_CORPUS" "$label" || return $?
  fi
  node --import tsx "$@"
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
  index:sessions [--force]    Index pi + Claude Code sessions. Every sessions.lance
                              writer (index:sessions/durable, cleanup/compact sessions,
                              sync/rebuild:sessions, corpus:durable-admit; pi /memory
                              only from a rebuilt dist in a reloaded pi) takes ONE
                              non-blocking lock, data/.sessions-write.lock;
                              held → exit 75 sessions-writer-busy|-stale-lock, never
                              waited on or reclaimed. Dry-runs take no lock.
                              --force also drops data/durable-manifest.json.
                              Pinned data dir (policy:sessions): control-v1 + S0,
                              held ids → data/s0-held.json; --force refused. Any
                              policy: index authority only (INVARIANT 7.1), and an
                              index holding none of the discovered sessions + paid
                              endpoint is refused without
                              ANDENKEN_ALLOW_PAID_FULL_REBUILD=1
  index:md [--force]          Index public garden Markdown (issue #8)
  index:org [--force]         Index org-mode KB (disabled in production — upstream R&D)
  sync:md                     md incremental (alias for index:md without --force)
  compact [sessions|md|org|openclaw]
                              Defragment LanceDB (CPU-pinned to ANDENKEN_COMPACT_CPUS, default 0-3)
                              `all` = sessions+md+org. openclaw by name: it is our
                              own harvest DB (their vectors, our store), fragmented
                              by our own import writes. OpenClaw's sqlite is never
                              touched — the export opens it read-only. openclaw takes
                              the harvest lock and runs on the index authority only
  cleanup [sessions|md|org]   Dedup + orphan removal + manifest repair + compact (CPU-pinned)
  cleanup [target] --dry-run  Dry-run (report only)
  verify [sessions|md|org|openclaw|all]
                              Post-indexing integrity check (all = sessions+md+org)
  verify openclaw --require-fts
                              The same check, plus FAIL unless openclaw's BM25 index
                              exists and a native full-text query runs ok (index stats
                              are reported, not required). Without the flag the FTS
                              state is reported and never fails
  status                      Show index statistics (text)
  status:json                 Show index statistics (machine-readable JSON)
  estimate [sessions|md|org|all] Dry-run cost estimate (Gemini-priced, legacy)
  estimate:sessions [--full]  PR-B: sessions OpenRouter 8B estimate (API 0)
                              Pinned data dir: control-v1 send set, S0-held reported
                              separately; --full refused
  policy:sessions             Read-only: the selection pin of the sessions data dir
                              (session-policy.json + session-manifest.json copy) as
                              JSON; exit 2 when malformed or one-sided (issue #18)
  policy:sessions:pin --data <abs dir>
                              Pin <abs dir> to control-v1 (manifest field, then
                              session-policy.json), under its writer lock. API 0.
                              Refuses an already pinned dir. Cutover step only.
                              default = INCREMENTAL (manifest-driven)
                              --full  = whole corpus
                              price: ANDENKEN_SESSION_PRICE_PER_M_TOKENS
                                  > OPENROUTER_QWEN_8B_PRICE > 0.01
  estimate:md [--full]        Issue #8: md OpenRouter 8B estimate (API 0)
                              CJK-weighted token model, per-folder breakdown
                              price: ANDENKEN_MD_PRICE_PER_M_TOKENS
                                  > OPENROUTER_QWEN_8B_PRICE > 0.01
  sync:openclaw [--full]      Harvest OpenClaw's own index: export → freshness
                              board → import → reconcile DRY-RUN. Zero embedding
                              cost — the vectors come already computed. Append-only;
                              never mirrors their deletes. The board and the dry-run
                              only report (paid rebuilds / prune candidates are
                              prescriptions, never run). One harvest at a time (flock)
  prune:openclaw [flags]      Stage C: delete ONLY dreaming + superseded-confirmed rows
                              from openclaw.lance. Dry-run unless --apply. Every agent
                              must clear all reconcile holds; live upstream is re-read
                              (revision + id digest) right before deleting; rows are
                              backed up whole with a receipt under data/openclaw-prune/.
                              flags: --apply --allow-mass-decrease --offline (dry-run only)
                                     --publish (after apply: verify + sync:openclaw:oracle,
                                     same lock) --restore <prune dir>
  report:openclaw [--samples N]
                              Re-print freshness board + reconcile dry-run from the
                              staged run (no ssh, no write, API 0)
  sync:openclaw:oracle [flags] Publish completed data/openclaw.lance to Oracle.
                              Authority-only; flags: --dry-run --no-verify --smoke --host <ssh-host>
                              --require-fts: refuse before transfer unless the local
                                store passes verify --require-fts and the replica answers
                                fts:openclaw --protocol; after transfer, require the
                                replica's own verify --require-fts healthy line. Without
                                it the publish is unchanged (FTS not required)
  fts:openclaw [--check|--protocol]
                              BM25 (full-text) index of openclaw.lance, built from the
                              stored text — API 0, no re-embedding, rows untouched.
                              No flag: create it on an existing table that lacks it
                              (authority + harvest lock); ready = no write. --check:
                              read-only, exit 0 only when ready. --protocol: print the
                              required-mode protocol line, open nothing
  sync:md:oracle [flags]      Rsync completed data/md.lance + md-manifest.json to Oracle
                              flags: --dry-run --no-verify --smoke --host <ssh-host>

=== Sessions full rebuild / sync (PR-B) ===
  rebuild:sessions[:dry]      scripts/rebuild-sessions-full.sh [--dry-run]
                              estimate → confirm → preflight → destroy → rebuild
  sync:sessions [--local|--global]
                              scripts/sync-sessions.sh (default --local: this
                              device only, ssh 0; --global: all devices + verify
                              + publish index, session + durable manifests and
                              corpus together)
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
  test:openclaw               Fixture tests for the OpenClaw harvest, reconcile, prune,
                              FTS index and harvest lock (API 0, no ~/.env.local). The
                              FTS test runs only inside a bwrap user/net/pid namespace
                              barrier; no bwrap → exit 3, nothing runs on the host
  test:openclaw-fts:barrier [--expect-head SHA] [--deps-from DIR]
                              Prove that barrier only (G0 + G1: namespaces, mounts,
                              descriptors, env, no route out); the FTS fixtures (G2)
                              are not run. Run dirs: ~/.local/state/andenken/fixture-runs/
                              --deps-from: run this checkout against the node_modules
                              of the installed checkout DIR (same lock); only DIR's
                              node_modules is bound, read-only; nothing else of DIR
  test:absent                 Fixture tests for the absent-axis invariant — a read never creates (API 0)
  test:parity                 Credential regex parity: python ↔ typescript (API 0)
  test:diagnostics            Type fence (tsconfig.diagnostics.json) + tests for the
                              full-text leg diagnostics (store, md core, CLI/pi report
                              fields) and the table-shape report vocabulary (API 0,
                              synthetic temp LanceDB, no optimize is run)
  test:retry                  Type fence (tsconfig.retry.json) + synthetic suite for the
                              sessions 429 rescheduler, provider error diagnostics and
                              the index-run finalization seam (API 0: fetch stubbed,
                              fake clock, temp HOME/ANDENKEN_DATA, no ~/.env.local)

=== Session corpus (~/repos/gh/session) ===
  corpus:gather [--dry-run] [--strict] [--checkpoint]
                              Collect admitted sessions from every device
                              (refuses a corpus failing the source form, exit 3).
                              Archive mode (corpus root has a .git): custody on
                              FD 8 + owner preflight; --checkpoint (sync --global
                              only) commits on the authority after a full gather
  corpus:manifest [update|verify|status|form]
                              Inventory + sha256 integrity (git replacement).
                              Skips only the corpus root .git. form (read-only) and
                              update/verify exit 3, writing nothing, on a symlinked
                              or git-annex pointer session file
  corpus:replicate [--to X] [--strict] [--dry-run]
                              Push the corpus to devices that cannot be pulled.
                              Source form checked first; root .git never shipped;
                              --strict: an unreachable target fails (publish uses it).
                              Archive mode: per replica preflight → rsync (replica
                              lock held) → bundle (sha256) → job dir on the replica
                              → receive → location log back (merge-log --from
                              <roster id>) → cleanup; any failure exits with its
                              code (19 = restore failed, operator needed)

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

=== pi-durable reader (issue #15, API 0) ===
  durable:census <session.sqlite> [--json]
                              Counts only: conversations, kinds, origins, submissions
  durable:read <session.sqlite> --around E [--before N --after N]
  durable:read <session.sqlite> [--conversation C] [--from E] [--to E] [--limit N]
                              Raw entries with origin + basis; --max-chars N cuts
                              each entry and says so; --json for siblings.
                              --around counts physical entries of E's own conversation
                              CLOSED SNAPSHOTS ONLY — a live session DB (live root,
                              hard link, WAL header, -wal/-shm beside it) is refused
                              by name before it is opened
  corpus:durable-admit <closed snapshot> --device <roster id> [--bucket B --session S] [--json]
                              Copy ONE already-made closed snapshot into the session
                              corpus (durable grammar, real copy 0600, atomic rename).
                              Never snapshots or opens a live DB. Replacing a corpus
                              copy needs same lineage + unchanged last entry.
                              Holds the sessions writer lock (exit 75 if held)
  index:durable --dry-run [--json]
                              API 0: what the next durable indexing run would embed
                              Reports row and character counts, estimated token count,
                              and identifiers of held or ambiguous entries.
  index:durable [--json]      PAID: embed corpus pi-durable snapshots (policy B.1)
                              into sessions.lance; checkpoint in data/durable-manifest.json.
                              Authority-only; run it only when the operator says when.
                              Holds the sessions writer lock (exit 75 if held)
  durable:plan <session.sqlite> [--json]
                              Embedding PLAN only (API 0): per entry, what candidate
                              policies B (human run) / C (root assistant) would do,
                              with basis, hold watermark and token estimate. Writes,
                              embeds and indexes nothing; prints no entry text
  test:durable                Type fence (tsconfig.durable.json) + fixture tests for
                              durable reader, plan, admit, index, excerpt, the
                              sessions writer lock and sync-sessions publish failure
                              propagation (API 0, temp corpus + temp LanceDB, stub
                              provider at 127.0.0.1:9, stub rsync/ssh)

=== Selection candidate (issue #18, control-v1; plan only, no build) ===
  candidate:sessions:plan --target <abs dir> --out <abs file>
                              API 0, read-only. Reads every corpus JSONL once
                              (inside the corpus, regular, no symlink on the path;
                              others refused unread) and counts legacy vs control-v1
                              chunks of the same bytes, the S0 high-signal hold (per
                              whole message) and the to-send set; pins admitted
                              pi-durable snapshots (size + sha256) and plans them as
                              a dry run (B.1 as-is). Target must sit directly under
                              ~/.local/state/andenken/candidates/ and must not
                              exist — the plan creates nothing there. Output (wx,
                              0600) holds counts, coordinates and fixed codes, never
                              text. Requires ANDENKEN_SESSION_CORPUS. Exit 3 unless
                              status=complete (refused / changed / error / empty;
                              no retry).
  test:selection              Type fence (tsconfig.selection.json) + synthetic
                              fixtures for session-selection.ts, the detailed
                              extractor and the plan (API 0, temp files only)
  candidate:sessions:build --plan <abs> --plan-sha <hex> --target <abs> [--resume]
                              PAID. Builds the planned candidate into a FRESH
                              target only (never production data/manifests/corpus/
                              backups). Holds data/.sync-sessions.lock (flock -n,
                              exit 75 when busy) and the candidate writer lock;
                              pinned by taskset to the first <= 8 allowed CPUs.
                              API-0 refusals first (plan sha + six source hashes,
                              authority, target, CPU, Qwen3-8B/4096 config, space,
                              file set/pins), then ANDENKEN_ALLOW_PAID_FULL_REBUILD=1
                              and an interactive TTY "yes" (no --yes). Per file:
                              read once, sha/counts == plan, whole-message S0, then
                              embed. Timeout/429/5xx/network: per-request retry with
                              backoff+jitter behind one shared pause (<= 12 tries,
                              <= 30 min); other failures stop new requests, files
                              complete at that point are checkpointed, the partial
                              target is kept. One progress line per minute.
                              --resume continues THAT partial target: API-0
                              reconciliation (manifest == DB ids + text hashes ==
                              extraction; adopt complete orphans, delete incomplete
                              ones in the candidate only), the same "yes", then
                              only the remaining files. Each attempt is archived
                              under <target>/attempts/. Set ANDENKEN_SESSION_TIMEOUT_MS
                              for the per-request timeout. Exit 0 built / 4 partial /
                              2 refused / 75 busy.
  candidate:sessions:measure --target <abs> [--out <abs>]
                              Read-only: target disk (allocated/apparent, table
                              parts), candidate DB rows/dim/FTS/unique ids/S0,
                              manifest↔DB pairs; production sessions.lance by
                              directory metadata only (never opened). API 0.
  test:policy                 Type fence (tsconfig.policy.json) + selection-pin suite
                              (every sessions writer under legacy / pinned / malformed
                              pins, fresh paid guard, wrapper refusals, corpus source
                              form) + publish-order suite + corpus archive glue suite
                              (fake owner helper, custody FD 8). API 0, CPUs 0-7
  test:archive-real           The same glue against the REAL owner helper (pinned
                              SHA-256, private copy), synthetic temp corpus + replica:
                              readiness, global checkpoint → receive → merge-log,
                              lost FD (75), restore failure (19). API 0. Needs
                              git-annex (else SKIPPED, exit 77)
  test:candidate-build        Type fence (tsconfig.candidate.json) + synthetic suite
                              under taskset -c 0-7 (mock provider, temp LanceDB,
                              temp locks, virtual retry clock; API 0)

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
    run_corpus_writer "index:sessions" indexer.ts sessions "$@" ;;
  index:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts md "$@" ;;
  sync:md)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts md "$@" ;;
  index:org)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts org "$@" ;;
  compact)
    shift; cd "$SCRIPT_DIR" || exit 1
    if [ "${1:-all}" = "openclaw" ]; then
      # Our harvest store: compacted under the same harvest lock as import, prune,
      # FTS bootstrap and publish; `node --import tsx` keeps FD 8 for the check.
      . scripts/lib/openclaw-lock.sh
      openclaw_lock_acquire "compact openclaw"
      run_pinned node --import tsx indexer.ts compact openclaw
    else
      run_pinned pnpm exec tsx indexer.ts compact "${1:-all}"
    fi ;;
  cleanup)
    shift; load_env; cd "$SCRIPT_DIR" && run_pinned pnpm exec tsx indexer.ts cleanup "${1:-org}" "${@:2}" ;;
  verify)
    # verify openclaw, and any verify with the exact token --require-fts anywhere
    # in its arguments (the target slot included), launch with `node --import tsx`
    # like the openclaw writers; no package manager runs on that path. The
    # arguments reach indexer.ts unchanged and in order, so its validators
    # (unknown argument, unknown target, --require-fts on another track) remain
    # the only judge of validity and of the exit code. Every other verify keeps
    # its pnpm exec tsx launch.
    shift; load_env; cd "$SCRIPT_DIR" || exit 1
    VERIFY_RUNNER=(pnpm exec tsx)
    if [ "${1:-all}" = "openclaw" ]; then VERIFY_RUNNER=(node --import tsx); fi
    for a in "$@"; do
      if [ "$a" = "--require-fts" ]; then VERIFY_RUNNER=(node --import tsx); fi
    done
    "${VERIFY_RUNNER[@]}" indexer.ts verify "${1:-all}" "${@:2}" ;;
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
    # API 0: no load_env, so no ~/.env.local reaches any of these tests. The FTS
    # test runs only inside the namespace barrier (scripts/test-openclaw-fts-sandboxed.sh).
    cd "$SCRIPT_DIR" && pnpm exec tsx openclaw-import.test.ts \
      && pnpm exec tsx openclaw-reconcile.test.ts \
      && pnpm exec tsx openclaw-prune.test.ts \
      && bash scripts/test-openclaw-fts-sandboxed.sh ;;
  test:openclaw-fts:barrier)
    shift; cd "$SCRIPT_DIR" && bash scripts/test-openclaw-fts-sandboxed.sh --barrier-only "$@" ;;
  test:absent)
    cd "$SCRIPT_DIR" && pnpm exec tsx axis-absent.test.ts ;;
  test:parity)
    cd "$SCRIPT_DIR" && pnpm exec tsx credential-parity.test.ts ;;
  test:diagnostics)
    cd "$SCRIPT_DIR" && pnpm exec tsc -p tsconfig.diagnostics.json \
      && pnpm exec tsx store-fts-diagnostics.test.ts && pnpm exec tsx table-shape.test.ts ;;
  test:retry)
    # API 0: no load_env; the suite stubs fetch, swaps HOME for a temp dir and
    # removes credential-shaped env names from its own process before any test.
    cd "$SCRIPT_DIR" && node node_modules/typescript/bin/tsc -p tsconfig.retry.json \
      && node --import tsx embed-retry.test.ts ;;

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
  policy:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts policy ;;
  policy:sessions:pin)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx indexer.ts policy --pin "$@" ;;
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
  durable:census)
    # The snapshot path is resolved against the caller's directory, not the repo.
    shift; export DURABLE_CALLER_CWD="$PWD"; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/durable-read.ts census "$@" ;;
  durable:read)
    shift; export DURABLE_CALLER_CWD="$PWD"; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/durable-read.ts read "$@" ;;
  durable:plan)
    shift; export DURABLE_CALLER_CWD="$PWD"; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/durable-plan.ts "$@" ;;
  corpus:durable-admit)
    shift; load_env; export DURABLE_CALLER_CWD="$PWD"; cd "$SCRIPT_DIR" && run_corpus_writer "corpus:durable-admit" scripts/durable-admit.ts "$@" ;;
  index:durable)
    shift; load_env; cd "$SCRIPT_DIR"
    case " $* " in
      *" --dry-run "*) pnpm exec tsx indexer.ts durable "$@" ;;   # read-only: no custody
      *) run_corpus_writer "index:durable" indexer.ts durable "$@" ;;
    esac ;;
  test:durable)
    # Type fence first (reader + CLI + test), then the fixtures.
    cd "$SCRIPT_DIR" && pnpm exec tsc -p tsconfig.durable.json \
      && pnpm exec tsx durable-reader.test.ts && pnpm exec tsx durable-plan.test.ts \
      && pnpm exec tsx durable-source.test.ts && pnpm exec tsx sessions-lock.test.ts \
      && pnpm exec tsx sync-publish.test.ts ;;

  # === Selection candidate (issue #18) — plan only ===
  candidate:sessions:plan)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/candidate-plan.ts "$@" ;;
  test:selection)
    cd "$SCRIPT_DIR" && pnpm exec tsc -p tsconfig.selection.json && pnpm exec tsx session-selection.test.ts ;;
  candidate:sessions:build)
    # The production sync lock is held by `flock -n <file> <cmd>` so that
    # /proc/locks attributes it to an ANCESTOR of the build (the build verifies
    # that); `exec 9>…; flock -n 9` would attribute it to an exited helper.
    shift; load_env; cd "$SCRIPT_DIR" || exit 1
    command -v flock >/dev/null 2>&1 || { echo "❌ flock is required" >&2; exit 2; }
    command -v taskset >/dev/null 2>&1 || { echo "❌ taskset is required" >&2; exit 2; }
    [ -f data/.sync-sessions.lock ] || { echo "❌ data/.sync-sessions.lock is missing — not creating production files" >&2; exit 2; }
    . scripts/lib/candidate-cpus.sh
    CANDIDATE_CPUS="$(candidate_cpu_list 8)" || { echo "❌ cannot read this process's CPU affinity" >&2; exit 2; }
    echo "candidate build: taskset -c $CANDIDATE_CPUS (inherited by every child); API concurrency ${INDEX_CONCURRENCY:-2} (max 4)"
    flock -n -E 75 data/.sync-sessions.lock \
      taskset -c "$CANDIDATE_CPUS" env RAYON_NUM_THREADS=8 pnpm exec tsx scripts/candidate-build.ts "$@"
    rc=$?
    [ "$rc" -eq 75 ] && echo "⚠ data/.sync-sessions.lock or the candidate writer lock is busy — refused" >&2
    exit "$rc" ;;
  candidate:sessions:measure)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx scripts/candidate-measure.ts "$@" ;;
  test:candidate-build)
    cd "$SCRIPT_DIR" && pnpm exec tsc -p tsconfig.candidate.json \
      && taskset -c 0-7 pnpm exec tsx candidate-build.test.ts ;;
  test:archive-real)
    # The archive glue against the REAL owner helper, pinned by SHA-256 (the suite
    # refuses a different helper before running it and runs a private copy).
    # Synthetic only: temp HOME / corpus / replica, stubbed provider and indexer,
    # no real corpus, DB, replica or network. Needs git, git-annex, flock, rsync;
    # otherwise SKIPPED (exit 77). API 0.
    cd "$SCRIPT_DIR" && pnpm exec tsc -p tsconfig.policy.json \
      && taskset -c 0-7 pnpm exec tsx corpus-archive-real.test.ts ;;
  test:policy)
    # Type fence, then the selection-pin suite (temp HOME/data/corpus, 127.0.0.1
    # mock provider, PATH-stubbed wrappers), the publish-order suite and the
    # corpus archive glue suite (fake owner helper, custody FD, replica commands
    # run locally against a temp replica HOME). API 0.
    cd "$SCRIPT_DIR" && pnpm exec tsc -p tsconfig.policy.json \
      && taskset -c 0-7 pnpm exec tsx session-policy.test.ts \
      && pnpm exec tsx sync-publish.test.ts \
      && taskset -c 0-7 pnpm exec tsx corpus-archive-glue.test.ts ;;

  # === PR-B sessions sync / rebuild ===
  rebuild:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/rebuild-sessions-full.sh "$@" ;;
  rebuild:sessions:dry)
    load_env; cd "$SCRIPT_DIR" && bash scripts/rebuild-sessions-full.sh --dry-run ;;
  sync:sessions)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/sync-sessions.sh "$@" ;;
  sync:openclaw)
    # One lock around the whole pipeline: export clears and refills the staging
    # directory, and the import and reconcile that follow must read what THIS
    # export staged. The child export inherits FD 8 and re-enters the same lock
    # (scripts/lib/openclaw-lock.sh proves it by inode + fdinfo, not by a flag).
    shift; load_env; cd "$SCRIPT_DIR" || exit 1
    . scripts/lib/openclaw-lock.sh
    openclaw_lock_acquire "sync:openclaw"
    bash scripts/export-openclaw.sh "$@" \
      && pnpm exec tsx openclaw-reconcile.ts freshness \
      && node --import tsx openclaw-importer.ts \
      && pnpm exec tsx openclaw-reconcile.ts reconcile --samples 0 ;;
  prune:openclaw)
    # One lock from plan to publish: no harvest may restage, and no other prune or
    # publish may run, between the plan, the delete and the replica push.
    shift; load_env; cd "$SCRIPT_DIR" || exit 1
    . scripts/lib/openclaw-lock.sh
    openclaw_lock_acquire "prune:openclaw"
    PRUNE_ARGS=(); PUBLISH=0
    for a in "$@"; do
      if [ "$a" = "--publish" ]; then PUBLISH=1; else PRUNE_ARGS+=("$a"); fi
    done
    node --import tsx openclaw-prune.ts "${PRUNE_ARGS[@]}" || exit $?
    if [ "$PUBLISH" = "1" ]; then
      case " ${PRUNE_ARGS[*]} " in
        *" --apply "*) ./run.sh verify openclaw && bash scripts/sync-openclaw-to-oracle.sh ;;
        *) echo "--publish ignored: nothing is published after a dry run" ;;
      esac
    fi ;;
  report:openclaw)
    # Same lock as the harvest: a report read while an export is refilling the
    # staging directory would mix two runs (the binding check would refuse, but
    # there is no reason to race it).
    shift; load_env; cd "$SCRIPT_DIR" || exit 1
    . scripts/lib/openclaw-lock.sh
    openclaw_lock_acquire "report:openclaw"
    pnpm exec tsx openclaw-reconcile.ts freshness \
      && pnpm exec tsx openclaw-reconcile.ts reconcile "$@" ;;
  sync:openclaw:oracle)
    shift; load_env; cd "$SCRIPT_DIR" && bash scripts/sync-openclaw-to-oracle.sh "$@" ;;
  fts:openclaw)
    # Build the BM25 index of an existing openclaw.lance that lacks it. --check and
    # --protocol only read (no lock, no write); the build takes the harvest lock.
    # All three launch with `node --import tsx`; no package manager runs here.
    shift; load_env; cd "$SCRIPT_DIR" || exit 1
    case " $* " in
      *" --check "*|*" --protocol "*) node --import tsx openclaw-fts.ts "$@" ;;
      *) . scripts/lib/openclaw-lock.sh
         openclaw_lock_acquire "fts:openclaw"
         node --import tsx openclaw-fts.ts "$@" ;;
    esac ;;
  search:openclaw)
    shift; load_env; cd "$SCRIPT_DIR" && pnpm exec tsx cli.ts search-openclaw "$@" ;;
  rebuild:full)
    cd "$SCRIPT_DIR" && bash scripts/rebuild-full.sh ;;
  rebuild:incremental)
    cd "$SCRIPT_DIR" && bash scripts/rebuild-incremental.sh ;;

  *)
    echo "Unknown: $1"; help; exit 1 ;;
esac
