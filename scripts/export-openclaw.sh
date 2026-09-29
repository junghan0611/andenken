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
# WHAT ELSE COMES BACK (2026-09-29, tier-4 stages A+B — still no deletion):
#   - manifest.jsonl.gz — per agent, from the SAME `VACUUM INTO` snapshot the
#     delta was read from: every chunk's id/source/path/updated_at, the row count,
#     the index generation (`memory_index_state.revision`), the chunking identity
#     (`memory_index_meta`) and a sha256 over the sorted ids. A delta export is not
#     evidence of absence; only a full id list from the same snapshot can say
#     "this id is gone upstream", and reading it in a second pass would compare
#     two generations. Ids only, ~0.5 MB — the vectors are never re-exported.
#   - status.json — `openclaw memory status --json`. Plain status: no --deep, no
#     --index, so no provider probe and no reindex. It is the only place that says
#     whether an index identity is valid or waiting for a paid rebuild.
#   - run.json — the run id that binds all of the above to one export, so a
#     manifest left by an earlier run can never be read against this import.
# `./run.sh sync:openclaw` renders them as the freshness board and the reconcile
# dry-run (openclaw-reconcile.ts). Neither writes anything anywhere.
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
LOCKFILE="data/.openclaw-harvest.lock"
FULL=0
# Plain `memory status` only. ANDENKEN_OPENCLAW_STATUS_CMD=off skips it; the
# board then reports every agent's identity as unknown, never as fresh.
STATUS_CMD="${ANDENKEN_OPENCLAW_STATUS_CMD:-docker exec openclaw-gateway openclaw memory status --json}"
[ "$STATUS_CMD" = "off" ] && STATUS_CMD=""
# Where the gateway container sees the host's `$REMOTE_AGENTS/..`, to map the
# workspaceDir that status reports back onto the host for the source scan.
CONTAINER_HOME="${ANDENKEN_OPENCLAW_CONTAINER_HOME:-/home/node/.openclaw}"

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
# It matters more here than for sessions, not less. The completed authority
# store can be published, but a replica must never harvest: it would fork the
# canonical import before that publish. And ANDENKEN_OPENCLAW_HOST defaults to
# `oracle`, which means running this on oracle would quietly succeed by ssh-ing
# to itself.
INDEX_AUTHORITY="${ANDENKEN_INDEX_AUTHORITY:-thinkpad}"
LOCAL_DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"
LOCAL_DEVICE="${LOCAL_DEVICE//[[:space:]]/}"
[ -n "$LOCAL_DEVICE" ] || { echo "cannot determine local device name" >&2; exit 1; }

if [ "$LOCAL_DEVICE" != "$INDEX_AUTHORITY" ] && [ "${ANDENKEN_ALLOW_REPLICA_INDEX:-0}" != "1" ]; then
  echo "❌ refused: this is '$LOCAL_DEVICE'; only the index authority '$INDEX_AUTHORITY' harvests." >&2
  echo "   INVARIANT.md §7.3 — only the authority harvests; publish its completed store" >&2
  echo "   with ./run.sh sync:openclaw:oracle instead of creating a second import here." >&2
  echo "   The authority reaches this host's OpenClaw databases over ssh by itself." >&2
  echo "   To move the authority:  ANDENKEN_INDEX_AUTHORITY=$LOCAL_DEVICE" >&2
  echo "   To override once:       ANDENKEN_ALLOW_REPLICA_INDEX=1  (forks it — know why)" >&2
  echo "   (nothing was fetched; no ssh was made)" >&2
  exit 1
fi

mkdir -p "$STAGE"

# --- Single-harvest lock ---
# Two harvests at once would each clear and refill the same staging directory,
# and the second importer could fold the first one's artifact under the second
# one's run id. `./run.sh sync:openclaw` takes this lock around export + import +
# report and sets ANDENKEN_OPENCLAW_LOCK_HELD, because a second open of the same
# file from this child would conflict with the parent's own lock.
if [ "${ANDENKEN_OPENCLAW_LOCK_HELD:-0}" != "1" ] && command -v flock >/dev/null 2>&1; then
  exec 8>"$LOCKFILE"
  if ! flock -n 8; then
    echo "❌ another openclaw harvest is running (lock: $LOCKFILE) — not starting a second one" >&2
    exit 1
  fi
fi

# Every artifact of the previous run leaves BEFORE this one starts, so a failed
# run leaves nothing a later importer or reconcile could mistake for its own. The
# unimported chunks of an earlier failed run lose nothing: the watermark did not
# advance, so this export asks for them again.
rm -f "$STAGE/openclaw-chunks.jsonl.gz" "$STAGE/host" "$STAGE/run.json" \
  "$STAGE/manifest.jsonl.gz" "$STAGE/status.json" "$STAGE/status.err" \
  "$STAGE/status-post.json" "$STAGE/status-post.err"

# One id per run, carried to the remote side and back inside the manifest. The
# remote work directory is named by it, so two runs can never overwrite each
# other's artifact the way the old fixed /tmp/openclaw-chunks.jsonl.gz could.
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"

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

echo "== export openclaw index: $HOST (mode: $([ "$FULL" = 1 ] && echo full || echo delta), run $RUN_ID) =="

# The remote script is piped over ssh rather than installed there: harvesting must
# not depend on the openclaw host having an andenken checkout, the same reason
# gather-corpus.sh pipes corpus-admit.py instead of calling a remote copy.
REMOTE_OUT="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
  "AGENTS_DIR=$REMOTE_AGENTS SINCE_JSON='$SINCE_JSON' RUN_ID=$RUN_ID STATUS_CMD=$(printf '%q' "$STATUS_CMD") CONTAINER_HOME=$(printf '%q' "$CONTAINER_HOME") bash -s" <<'REMOTE'
set -euo pipefail
agents_dir="$(eval echo "$AGENTS_DIR")"
run_dir="/tmp/andenken-openclaw.$RUN_ID"
mkdir -m 700 "$run_dir"   # fails if it exists: one directory, one run
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/openclaw-chunks.jsonl"
man="$tmp/openclaw-manifest.jsonl"
: > "$out"
: > "$man"

# Status BRACKETS the snapshots: once before the agent loop, once after. A single
# pre-loop call is not the same generation as a snapshot taken seconds later —
# a rebuild can land in between (sol re-review 2026-09-29). The reconcile holds
# any agent whose identity, dirty flag or chunk count moved between the two
# calls, or whose snapshot row count disagrees with them. Best-effort: a failure
# is kept as a receipt (exit code + last stderr lines) for the board to name and
# does not stop the harvest. An agent directory OpenClaw does not configure is
# simply absent (measured 2026-09-29: `claude` → `Unknown agent id "claude"`).
run_status() {  # $1 = file stem (status | status-post); prints the exit code
  local rc=skipped
  if [ -n "$STATUS_CMD" ]; then
    if eval "$STATUS_CMD" > "$run_dir/$1.json" 2> "$tmp/$1.err"; then rc=0; else rc=$?; fi
    tail -n 5 "$tmp/$1.err" > "$run_dir/$1.err" || true
  fi
  echo "$rc"
}
STATUS_RC="$(run_status status)"

# Source-side freshness for the `memory` source: the newest MEMORY.md /
# memory/**/*.md mtime in each configured agent's workspace, read on the host
# (the container's home is mounted from the agents dir's parent). Compared on
# the board against the newest source mtime the snapshot says was indexed.
# Sessions are not scanned here: their eligible/indexed file counts come from
# status, and a session's wall-clock is not a file mtime we can trust.
if [ "$STATUS_RC" = "0" ]; then
  python3 - "$run_dir/status.json" "$(dirname "$agents_dir")" "$CONTAINER_HOME" "$RUN_ID" >> "$man" <<'SOURCES' || true
import json, os, sys
status_path, host_root, container_home, run_id = sys.argv[1:5]
try:
    entries = json.load(open(status_path))
except Exception:
    sys.exit(0)
for e in entries if isinstance(entries, list) else []:
    agent = e.get("agentId")
    ws = (e.get("status") or {}).get("workspaceDir") or ""
    if not agent or not ws.startswith(container_home):
        continue
    host_ws = host_root + ws[len(container_home):]
    newest, newest_path, n = None, None, 0
    candidates = [os.path.join(host_ws, "MEMORY.md")]
    for root, dirs, files in os.walk(os.path.join(host_ws, "memory")):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        candidates += [os.path.join(root, f) for f in files if f.endswith(".md")]
    for p in candidates:
        try:
            m = int(os.stat(p).st_mtime * 1000)
        except OSError:
            continue
        n += 1
        if newest is None or m > newest:
            newest, newest_path = m, os.path.relpath(p, host_ws)
    print(json.dumps({"kind": "source", "agent": agent, "run_id": run_id, "source": "memory",
                      "files": n, "newest_mtime": newest, "newest_path": newest_path}))
SOURCES
fi

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
    printf '{"kind":"agent","agent":"%s","state":"vacuum-failed","run_id":"%s"}\n' "$agent" "$RUN_ID" >> "$man"
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
  #
  # THE VECTOR COLUMN CHANGED TYPE. Through OpenClaw 2026.9.5 `embedding` was
  # TEXT holding a JSON array. From v2026.9.6 (upstream c65911334f8, #153683,
  # `memory-schema-storage-migration.ts`) it is `BLOB NOT NULL` in a STRICT table:
  # IEEE-754 binary64, little-endian, 8 bytes per coordinate — 32768 B for 4096d
  # (`embedding-vector.ts encodeMemoryEmbedding`). `sqlite3 -json` writes a blob
  # as raw bytes, so the old select produced invalid UTF-8 and every agent with
  # rows failed to parse — the 2026-09-29 "agents read: 1" run. It is not zstd.
  # The blob is shipped as hex and decoded back to the same JSON array the
  # importer has always read, so the lance side and the watermark are untouched.
  # The migration copies id and updated_at verbatim, so it re-sent nothing.
  # A TEXT row (pre-migration database) passes through as before. An empty blob
  # is OpenClaw's own "needs regeneration" marker and decodes to [], which the
  # importer drops as a wrong-dim vector.
  #
  # ISOLATED PER AGENT. The delta lands in its own file and joins the shared
  # artifact only when the whole pipe succeeded. Appending straight to "$out"
  # let a pipe that failed half-way leave its first rows behind: the agent was
  # marked skipped, yet the importer read those rows and advanced that agent's
  # watermark past the rows that never arrived (sol re-review 2026-09-29).
  delta="$tmp/$agent.delta.jsonl"
  if sqlite3 -readonly -json "$snap" \
    "select '$agent' as agent, id, path, source, updated_at, text,
            typeof(embedding) as embedding_type,
            case when typeof(embedding) = 'blob' then hex(embedding) else embedding end as embedding
       from memory_index_chunks where updated_at >= $since" 2>/dev/null \
  | python3 -c '
import json, struct, sys
raw = sys.stdin.read().strip()
for r in (json.loads(raw) if raw else []):
    if r.pop("embedding_type", None) == "blob":
        b = bytes.fromhex(r["embedding"] or "")
        r["embedding"] = json.dumps(list(struct.unpack("<%dd" % (len(b) // 8), b)) if len(b) % 8 == 0 else [])
    print(json.dumps(r, ensure_ascii=False))' > "$delta"; then
    cat "$delta" >> "$out"
    AGENTS_OK=$((AGENTS_OK + 1))
    delta_ok=1
  else
    AGENTS_SKIPPED="$AGENTS_SKIPPED $agent"
    delta_ok=0
  fi
  rm -f "$delta"

  # The manifest, from the snapshot the delta was just read from. Ids, not
  # vectors. The agent line is printed only after every query succeeded, so a
  # half-read manifest cannot pass for a complete one: any failure turns the
  # whole agent into `manifest-failed`, and a missing table into `no-index` —
  # which is not the same claim as "an index with zero rows".
  python3 - "$agent" "$snap" "$delta_ok" "$RUN_ID" >> "$man" <<'MANIFEST' \
    || printf '{"kind":"agent","agent":"%s","state":"manifest-failed","run_id":"%s"}\n' "$agent" "$RUN_ID" >> "$man"
import hashlib, json, sqlite3, sys, time
agent, snap, delta_ok, run_id = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
rec = {"kind": "agent", "agent": agent, "run_id": run_id, "snapshot_at": int(time.time() * 1000)}
try:
    con = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    if "memory_index_chunks" not in tables:
        rec.update(state="no-index", rows=0)
        print(json.dumps(rec))
        sys.exit(0)
    rows = sorted(con.execute("select id, source, path, updated_at from memory_index_chunks").fetchall())
    meta = {}
    if "memory_index_meta" in tables:
        for k, v in con.execute("select key, value from memory_index_meta"):
            try:
                v = json.loads(v)
            except Exception:
                pass
            if k == "memory_index_meta_v1" and isinstance(v, dict):
                v = {x: v.get(x) for x in ("model", "provider", "sources", "chunkingVersion", "vectorDims")}
            meta[k] = v
    indexed_mtime = {}
    if "memory_index_sources" in tables:
        for src, m in con.execute("select source, max(mtime) from memory_index_sources group by source"):
            indexed_mtime[src] = int(m) if m is not None else None
    revision = None
    if "memory_index_state" in tables:
        r = con.execute("select revision from memory_index_state where id = 1").fetchone()
        revision = r[0] if r else None
    rec.update(
        state="ok" if delta_ok else "delta-failed",
        rows=len(rows),
        max_updated_at=max((r[3] for r in rows), default=None),
        revision=revision,
        meta=meta,
        indexed_mtime=indexed_mtime,
        digest=hashlib.sha256("\n".join(r[0] for r in rows).encode()).hexdigest(),
        # The id digest proves membership; this one also covers the fields the
        # classifier reads (source, path) and the stamp, so a garbled path cannot
        # pass for a re-chunked one. Rows are already sorted.
        row_digest=hashlib.sha256("\n".join(f"{i}\t{s}\t{p}\t{u}" for i, s, p, u in rows).encode()).hexdigest(),
    )
    lines = [json.dumps(rec, ensure_ascii=False)]
    lines += [
        json.dumps({"kind": "chunk", "agent": agent, "id": i, "source": s, "path": p, "updated_at": u}, ensure_ascii=False)
        for i, s, p, u in rows
    ]
except Exception as e:
    rec.update(state="manifest-failed", error=str(e)[:200])
    lines = [json.dumps(rec)]
print("\n".join(lines))
MANIFEST
  rm -f "$snap"
done

# The closing half of the status bracket.
STATUS_POST_RC="$(run_status status-post)"

gzip -c "$man" > "$run_dir/manifest.jsonl.gz"
ROWS_OUT="$(wc -l < "$out")"
[ "$ROWS_OUT" = "0" ] || gzip -c "$out" > "$run_dir/openclaw-chunks.jsonl.gz"
echo "REMOTE_ROWS=$ROWS_OUT"
echo "REMOTE_AGENTS_OK=$AGENTS_OK"
echo "REMOTE_AGENTS_SKIPPED=$AGENTS_SKIPPED"
echo "REMOTE_STATUS_RC=$STATUS_RC"
echo "REMOTE_STATUS_POST_RC=$STATUS_POST_RC"
echo "REMOTE_RUN_DIR=$run_dir"
REMOTE
)"

ROWS="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_ROWS=//p')"
AGENTS_OK="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_AGENTS_OK=//p')"
SKIPPED="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_AGENTS_SKIPPED=//p' | xargs || true)"
STATUS_RC="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_STATUS_RC=//p')"
STATUS_POST_RC="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_STATUS_POST_RC=//p')"
REMOTE_RUN_DIR="$(echo "$REMOTE_OUT" | sed -n 's/^REMOTE_RUN_DIR=//p')"

echo "   agents read: ${AGENTS_OK:-0}${SKIPPED:+, skipped: $SKIPPED}"

# Zero rows means two very different things and the operator has to be able to
# tell them apart. Nothing changed since the watermark is a healthy no-op; not
# being able to open a single database is a failure that happens to produce the
# same row count.
if [ "${AGENTS_OK:-0}" = "0" ]; then
  [ -z "$REMOTE_RUN_DIR" ] || ssh -o BatchMode=yes "$HOST" "rm -rf '$REMOTE_RUN_DIR'" || true
  echo "❌ openclaw: no agent database could be read on $HOST"
  echo "   This is NOT 'nothing new' — the harvest did not happen. Check that"
  echo "   $REMOTE_AGENTS exists there and that sqlite3 can open it."
  exit 1
fi

if [ -n "$SKIPPED" ]; then
  echo "⚠ some agents were not read this run: $SKIPPED"
  echo "   Their watermarks did not advance, so the next run retries them."
fi

for rc in "${STATUS_RC:-}" "${STATUS_POST_RC:-}"; do
  if [ "$rc" != "0" ] && [ "$rc" != "skipped" ]; then
    echo "⚠ openclaw memory status failed on $HOST (pre exit ${STATUS_RC:-?}, post exit ${STATUS_POST_RC:-?}) — index identity is unknown this run"
    break
  fi
done

# Fetch the whole run directory — manifest and status always, the chunks when
# there are any — then remove it on the host. The manifest comes back even on a
# run with no new rows: "nothing new" is exactly when the reconcile still has
# something to say.
INCOMING="$STAGE/incoming.$RUN_ID"
rm -rf "$INCOMING"
rsync -az "$HOST:$REMOTE_RUN_DIR/" "$INCOMING/"
ssh -o BatchMode=yes "$HOST" "rm -rf '$REMOTE_RUN_DIR'" || true
for f in manifest.jsonl.gz status.json status.err status-post.json status-post.err openclaw-chunks.jsonl.gz; do
  if [ -f "$INCOMING/$f" ]; then mv "$INCOMING/$f" "$STAGE/$f"; fi
done
rm -rf "$INCOMING"

# Which host these rows came from, for the importer that runs next. It is written
# beside the artifact and not passed as an env var, because `--host` can
# contradict ANDENKEN_OPENCLAW_HOST and the artifact is the thing that is true.
printf '%s\n' "$HOST" > "$STAGE/host"

# The run receipt. The importer copies runId into its own receipt, and the
# reconcile refuses to compare anything whose run ids disagree.
python3 - "$STAGE/run.json" "$RUN_ID" "$HOST" "$([ "$FULL" = 1 ] && echo full || echo delta)" \
  "${ROWS:-0}" "${AGENTS_OK:-0}" "$SKIPPED" "${STATUS_RC:-}" "${STATUS_POST_RC:-}" <<'RUNJSON'
import json, sys, time
p, run_id, host, mode, rows, ok, skipped, status_rc, status_post_rc = sys.argv[1:10]
with open(p, "w") as f:
    json.dump({
        "runId": run_id, "host": host, "mode": mode, "exportedAt": int(time.time() * 1000),
        "rows": int(rows), "agentsOk": int(ok), "agentsSkipped": skipped.split(),
        "statusRc": status_rc, "statusPostRc": status_post_rc,
    }, f, indent=2)
    f.write("\n")
RUNJSON

if [ "${ROWS:-0}" = "0" ]; then
  # No chunks artifact exists (the previous one was cleared at start), so the
  # importer that runs next in `sync:openclaw` cannot re-import a snapshot the
  # watermark already consumed. Manifest and status did come back.
  echo "✅ openclaw: nothing new since the watermark — manifest and status only"
  exit 0
fi

echo "== staged: $STAGE/openclaw-chunks.jsonl.gz ($ROWS rows, $(du -h "$STAGE/openclaw-chunks.jsonl.gz" | cut -f1)) =="
echo "   next: ./run.sh sync:openclaw imports it and advances the watermark"
