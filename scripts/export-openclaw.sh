#!/usr/bin/env bash
# export-openclaw.sh — pull OpenClaw's OWN embedding index rows to this machine.
#
# This is a HARVEST, not a sync. OpenClaw embeds its agents' memory and sessions
# itself, with `qwen/qwen3-embedding-8b` at 4096d — the same model and
# the same dimension andenken uses. So the rows already carry both the text and
# the vector, and importing them costs zero embedding API calls. We do not decide
# its chunking, its model, or its scope; that is OpenClaw's configuration (GLG
# ruling 2026-09-03). We fetch, and we make it findable.
#
# HOW MANY AGENTS: do not hardcode a count. Measured 2026-09-03 there are SEVEN
# agent directories, each with a database — bbot, claude, gemini, glg, gpt, main,
# mini — and `claude` holds zero index rows. Six is what the DATA showed that day;
# seven is what the HOST has. The loop walks the directory, so a bot added later
# is picked up without a code change, and one that never grows an index simply
# contributes nothing. If a number appears in a document here, it is a snapshot.
#
# WHY NOT rsync THE SQLITE: the six agent databases total ~1.6 GB, almost all of
# it session transcripts and caches we do not want. The rows we need are ~80 MB
# as float32 and ~16 MB for a day's delta. Pulling the whole file to read 5% of
# it would also make every run depend on the file being quiet, which it is not —
# the bots write continuously.
#
# CONSISTENCY: each database is snapshotted with `VACUUM INTO` before reading.
# A live SQLite in WAL mode is not safe to read row-by-row over a long export,
# and a torn read here would land as vectors that disagree with their text.
#
# READ-ONLY, ENFORCED. `-readonly` is not decoration: the default sqlite3
# connection is read-write, and an ordinary open of a live WAL database is
# permitted to checkpoint or recover it. Those databases belong to OpenClaw
# (nixos-config), and the boundary of this track is that we read them and own
# nothing in them, so the kernel should hold that line rather than a comment.
# The snapshot is written to OUR temp dir; the source is never a write target.
# Measured 2026-09-04 on oracle: `-readonly` VACUUM INTO produces the same 49M
# snapshot of mini's database, so nothing is bought by the wider permission.
#
# APPEND-ONLY: we never delete a row this export did not return. OpenClaw's index
# still holds chunks for sessions whose transcripts it already deleted
# (`*.jsonl.deleted.*`), and we do not know its retention rule. If we mirrored
# deletions, its cleanup would become our loss.
#
# Usage:
#   ./scripts/export-openclaw.sh                 # delta since the local watermark
#   ./scripts/export-openclaw.sh --full          # every row, ignore the watermark
#   ./scripts/export-openclaw.sh --host NAME     # override the openclaw host
#
# RUNS ON THE INDEX AUTHORITY ONLY (see the gate below).
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${ANDENKEN_OPENCLAW_HOST:-oracle}"
REMOTE_AGENTS="${ANDENKEN_OPENCLAW_AGENTS_DIR:-\$HOME/openclaw/config/agents}"
STAGE="data/openclaw-staging"
WATERMARK="data/openclaw-watermark.json"
FULL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --host) HOST="${2:?--host needs a name}"; shift 2 ;;
    --help|-h) sed -n "2,$(($(grep -n '^set -euo pipefail' "$0" | head -1 | cut -d: -f1) - 1))p" "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --- Authority gate ---
#
# The harvest runs on the index authority and nowhere else. This gate is FIRST,
# unlike the sessions one: sync-sessions.sh puts its gate after Step 0 because a
# refused replica has still done its half (gathering its own sessions). Here
# there is no half to do — every row comes from the OpenClaw host over ssh — so a
# refused run should cost nothing at all, not even a connection.
#
# It matters more here than for sessions, not less. `openclaw.lance` has NO
# publish step (INVARIANT §7.3), so a replica that harvests on its own does not
# just fork the corpus — it forks it with no rsync that could ever reconcile the
# two. And ANDENKEN_OPENCLAW_HOST defaults to `oracle`, which means running this
# on oracle would quietly succeed by ssh-ing to itself.
INDEX_AUTHORITY="${ANDENKEN_INDEX_AUTHORITY:-thinkpad}"
LOCAL_DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"
LOCAL_DEVICE="${LOCAL_DEVICE//[[:space:]]/}"
[ -n "$LOCAL_DEVICE" ] || { echo "cannot determine local device name" >&2; exit 1; }

if [ "$LOCAL_DEVICE" != "$INDEX_AUTHORITY" ] && [ "${ANDENKEN_ALLOW_REPLICA_INDEX:-0}" != "1" ]; then
  echo "❌ refused: this is '$LOCAL_DEVICE'; only the index authority '$INDEX_AUTHORITY' harvests." >&2
  echo "   INVARIANT.md §7.3 — openclaw.lance is authority-only and has no publish step," >&2
  echo "   so a second copy built here could never be reconciled with the canonical one." >&2
  echo "   The authority reaches this host's OpenClaw databases over ssh by itself." >&2
  echo "   To move the authority:  ANDENKEN_INDEX_AUTHORITY=$LOCAL_DEVICE" >&2
  echo "   To override once:       ANDENKEN_ALLOW_REPLICA_INDEX=1  (forks it — know why)" >&2
  echo "   (nothing was fetched; no ssh was made)" >&2
  exit 1
fi

mkdir -p "$STAGE"

# The watermark keys AGENTS, and records the host it was built against as `_host`
# (see HOST SCOPING below). Missing file or --full means "from zero".
#
# WHY updated_at AND NOT hash. `memory_index_chunks` carries a `hash` column and it
# is tempting to key the delta on content instead of time, since a full rebake
# re-stamps every row's updated_at and resends the whole corpus. Do not make that
# change. Read from OpenClaw's own source (2026-09-03, cross-review):
#
#   - `hash` is sha256 of the CHUNK TEXT (memory-host-sdk `chunkMarkdown` flush).
#   - the row `id` is sha256(source:path:startLine:endLine:chunkHash:model), so the
#     model is already inside the identity — a re-embed under a different model
#     mints a new id and an id-diff would catch it.
#   - what neither hash nor id can see: SAME model string, different provider or
#     embedding version. That updates the vector in place under the same id
#     (ON CONFLICT DO UPDATE). Only the time cursor notices.
#
# Accuracy is therefore ordered `updated_at` ⊃ id-diff ⊃ bare-hash, and every step
# away from the cursor buys silence about provider changes.
#
# The premise that made hash attractive was also wrong. Routine sync skips a file
# whose hash is unchanged (`manager-sync-ops.ts`: `if (!needsFullReindex &&
# existingHash === entry.hash) return`); full rebakes happen on EVENTS — a model
# switch, a deploy, a recovery — not on a schedule. The 09-01→09-03 clustering in
# this corpus is one such event, not periodicity. So the resend cost is once per
# event, and the next delta is a real delta again.
#
# HOST SCOPING. Agent names are directory names inside ONE openclaw host, so a
# cursor keyed by agent alone is only meaningful next to the host it was built
# against. `_host` records that host in the same file (it cannot collide with an
# agent, for the same reason). A cursor from a different host is refused here,
# before the ssh round trip, rather than being reused into silent row loss on the
# new host. `--full` is the way through: it ignores the watermark entirely.
SINCE_JSON="{}"
if [ "$FULL" = "0" ] && [ -f "$WATERMARK" ]; then
  RECORDED_HOST="$(python3 -c '
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("_host") or "")
except Exception:
    print("")' "$WATERMARK")"
  if [ -n "$RECORDED_HOST" ] && [ "$RECORDED_HOST" != "$HOST" ]; then
    echo "❌ openclaw watermark belongs to host '$RECORDED_HOST', but --host/ANDENKEN_OPENCLAW_HOST says '$HOST'." >&2
    echo "   Agent names are scoped to one host, so reusing this cursor would skip rows on '$HOST'." >&2
    echo "   Re-run with --full to start '$HOST' from zero, or point back at '$RECORDED_HOST'." >&2
    exit 2
  fi
  SINCE_JSON="$(cat "$WATERMARK")"
fi

echo "== export openclaw index: $HOST (mode: $([ "$FULL" = 1 ] && echo full || echo delta)) =="

# The remote script is piped over ssh rather than installed there: harvesting must
# not depend on the openclaw host having an andenken checkout, the same reason
# gather-corpus.sh pipes corpus-admit.py instead of calling a remote copy.
REMOTE_OUT="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
  "AGENTS_DIR=$REMOTE_AGENTS SINCE_JSON='$SINCE_JSON' bash -s" <<'REMOTE'
set -euo pipefail
agents_dir="$(eval echo "$AGENTS_DIR")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/openclaw-chunks.jsonl"
: > "$out"

AGENTS_OK=0
AGENTS_SKIPPED=""

for dir in "$agents_dir"/*/; do
  agent="$(basename "$dir")"
  db="$dir/agent/openclaw-agent.sqlite"
  [ -f "$db" ] || continue

  since="$(SINCE_JSON="$SINCE_JSON" AGENT="$agent" python3 -c '
import json, os
try:
    print(int(json.loads(os.environ["SINCE_JSON"]).get(os.environ["AGENT"], 0)))
except Exception:
    print(0)')"

  snap="$tmp/$agent.sqlite"
  # VACUUM INTO gives a consistent point-in-time copy of a live WAL database.
  # A failure here is REPORTED, not swallowed: a run where every agent failed to
  # open produces the same zero rows as a run where nothing changed, and the two
  # must not print the same sentence.
  if ! sqlite3 -readonly "$db" "VACUUM INTO '$snap'" 2>/dev/null; then
    AGENTS_SKIPPED="$AGENTS_SKIPPED $agent"
    continue
  fi

  # An agent with no new rows prints nothing (not `[]`), and one whose database
  # predates the memory index has no such table at all. Neither is an error here:
  # the harvest is per-agent best-effort, and a missing agent simply contributes
  # nothing this run.
  # `>=`, not `>`. The watermark is the max updated_at we ACCEPTED, and OpenClaw
  # bulk-reindexes: two transactions can commit in the same millisecond with our
  # snapshot between them, which would leave the second one's rows permanently
  # below a strict `>`. The import is idempotent by id, so the boundary replaces
  # itself.
  #
  # THE BOUNDARY IS NOT ONE ROW — it is that whole millisecond, and a bulk
  # reindex commits thousands of rows into very few of them. Measured 2026-09-04
  # on the staged dump: all 312 rows it carried sat exactly at their agent's
  # watermark ms and not one row sat above it — gpt 228, main 78, glg 3, bbot 1,
  # gemini 1, mini 1. So a run that fetches nothing new still moves ~6.5 MB and
  # rewrites 312 rows, every run, and that is a standing cost rather than a
  # one-off. It scales with the largest bucket, and glg's largest is 851.
  #
  # This also settles a reading left open on 2026-09-03: the delta of 312 was
  # never evidence that gpt and main had re-indexed. It was the boundary, whole.
  if sqlite3 -readonly -json "$snap" \
    "select '$agent' as agent, id, path, source, updated_at, text, embedding
       from memory_index_chunks where updated_at >= $since" 2>/dev/null \
  | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
for r in (json.loads(raw) if raw else []):
    print(json.dumps(r, ensure_ascii=False))' >> "$out"; then
    AGENTS_OK=$((AGENTS_OK + 1))
  else
    AGENTS_SKIPPED="$AGENTS_SKIPPED $agent"
  fi
  rm -f "$snap"
done

gzip -c "$out" > "$tmp/openclaw-chunks.jsonl.gz"
echo "REMOTE_ROWS=$(wc -l < "$out")"
echo "REMOTE_AGENTS_OK=$AGENTS_OK"
echo "REMOTE_AGENTS_SKIPPED=$AGENTS_SKIPPED"
# Keep the artifact alive past the trap by moving it somewhere stable.
mv "$tmp/openclaw-chunks.jsonl.gz" /tmp/openclaw-chunks.jsonl.gz
REMOTE
)"

ROWS="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_ROWS=//p')"
AGENTS_OK="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_AGENTS_OK=//p')"
SKIPPED="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_AGENTS_SKIPPED=//p' | xargs || true)"

echo "   agents read: ${AGENTS_OK:-0}${SKIPPED:+, skipped: $SKIPPED}"

# Zero rows means two very different things and the operator has to be able to
# tell them apart. Nothing changed since the watermark is a healthy no-op; not
# being able to open a single database is a failure that happens to produce the
# same row count.
if [ "${AGENTS_OK:-0}" = "0" ]; then
  echo "❌ openclaw: no agent database could be read on $HOST"
  echo "   This is NOT 'nothing new' — the harvest did not happen. Check that"
  echo "   $REMOTE_AGENTS exists there and that sqlite3 can open it."
  exit 1
fi

if [ -n "$SKIPPED" ]; then
  echo "⚠ some agents were not read this run: $SKIPPED"
  echo "   Their watermarks did not advance, so the next run retries them."
fi

if [ "${ROWS:-0}" = "0" ]; then
  # Remove the previous run's artifact. Leaving it would let the importer that
  # runs after this one in `sync:openclaw` re-import a snapshot the watermark has
  # already consumed — reporting thousands of rows on a run that fetched none.
  rm -f "$STAGE/openclaw-chunks.jsonl.gz" "$STAGE/host"
  echo "✅ openclaw: nothing new since the watermark — no transfer"
  exit 0
fi

rsync -az "$HOST:/tmp/openclaw-chunks.jsonl.gz" "$STAGE/openclaw-chunks.jsonl.gz"
ssh -o BatchMode=yes "$HOST" 'rm -f /tmp/openclaw-chunks.jsonl.gz' || true

# Which host these rows came from, for the importer that runs next. It is written
# beside the artifact and not passed as an env var, because `--host` can
# contradict ANDENKEN_OPENCLAW_HOST and the artifact is the thing that is true.
printf '%s\n' "$HOST" > "$STAGE/host"

echo "== staged: $STAGE/openclaw-chunks.jsonl.gz ($ROWS rows, $(du -h "$STAGE/openclaw-chunks.jsonl.gz" | cut -f1)) =="
echo "   next: ./run.sh sync:openclaw imports it and advances the watermark"
