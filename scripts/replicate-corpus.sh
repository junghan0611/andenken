#!/usr/bin/env bash
# replicate-corpus.sh — push the session corpus to the devices that cannot pull it.
#
# Why a push at all. Measured 2026-09-02: `ssh oracle` works from thinkpad, but
# `ssh thinkpad` from oracle is refused, and opening it would not help — a laptop
# that is asleep or away from the network cannot be pulled from at any hour the
# server chooses. So the laptop delivers itself while it is awake, and the server
# never blocks on a peer it was never going to reach.
#
# That inversion is what lets the embedding run on the server. The server holds a
# complete corpus at the SAME path (`~/repos/gh/session`), so the command GLG
# types there is character-for-character the command he would type here.
#
# ADDITIVE, like gather. No --delete: a session that left one device's live store
# must not be erased from another device's copy of the corpus. The corpus is the
# only place some of these sessions still exist.
#
# Source form (issue #18). Before anything ships, the corpus must pass
# `corpus-manifest.sh form`: every session file regular, no symlink, no git-annex
# pointer. A pointer or a locked-annex symlink would land on the replica as the
# "transcript", so that is refused (exit 3), not shipped. The corpus ROOT `.git`
# (its Git/annex store) is never shipped; device trees are, unchanged.
#
# Usage:
#   ./scripts/replicate-corpus.sh              # push to every push-transport peer
#   ./scripts/replicate-corpus.sh --dry-run
#   ./scripts/replicate-corpus.sh --to oracle
#   ./scripts/replicate-corpus.sh --strict     # an unreachable target is a failure
#                                              # (publish uses this: an index must
#                                              # not ship ahead of its sources)
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

if [ -z "${ANDENKEN_SESSION_CORPUS:-}" ] && [ -f "$HOME/.env.local" ]; then
  ANDENKEN_SESSION_CORPUS="$(set -a; . "$HOME/.env.local" >/dev/null 2>&1; printf %s "${ANDENKEN_SESSION_CORPUS:-}")"
fi
CORPUS="${ANDENKEN_SESSION_CORPUS:-$HOME/repos/gh/session}"
CORPUS="${CORPUS/#\~/$HOME}"
[ -d "$CORPUS" ] || { echo "corpus not found: $CORPUS" >&2; exit 1; }
ROSTER="$CORPUS/DEVICES.json"

DRY=0
TO=""
STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=1; shift ;;
    --to) TO="${2:?--to needs a device id}"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --help|-h) sed -n "2,$(($(grep -n '^set -euo pipefail' "$0" | head -1 | cut -d: -f1) - 1))p" "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

LOCAL_DEVICE="$(cat "$HOME/.current-device" 2>/dev/null || hostname)"
LOCAL_DEVICE="${LOCAL_DEVICE//[[:space:]]/}"

# Targets: active roster devices, other than this one, that we can ssh to. A
# `push` device is skipped — it is a source that delivers itself, not a replica
# we can reach — which is exactly why we are pushing in the first place.
mapfile -t TARGETS < <(ROSTER="$ROSTER" LOCAL="$LOCAL_DEVICE" python3 -c '
import json, os
for d in json.load(open(os.environ["ROSTER"])).get("devices", []):
    if d.get("state") != "active" or d.get("id") == os.environ["LOCAL"]:
        continue
    if d.get("transport") != "ssh":
        continue
    print(d["id"], d.get("target", d["id"]))
')

[ ${#TARGETS[@]} -gt 0 ] || { echo "no ssh-reachable replica in $ROSTER"; exit 0; }

# `/.git/` is anchored to the transfer root: only the corpus root's own store.
RSYNC_FLAGS=(-a --info=stats2 --exclude=/.git/)
[ "$DRY" = "1" ] && RSYNC_FLAGS+=(--dry-run)

# Archive mode (corpus root has a .git; scripts/lib/corpus-custody.sh): local
# custody on FD 8 (inherited from sync, or taken here) for the whole run. Per
# target, in this order, any failure stopping the run before the next step:
#   1. replica preflight, under the replica's own custody (one ssh) — before any
#      byte moves; it is a safety/form check, not an incoming-budget proof
#   2. rsync of the corpus, the replica's custody lock held for the transfer
#      (`--rsync-path "flock -n <lock> rsync"`), root .git excluded
#   3. the run's ONE local bundle (main + git-annex): a job-owned 0700 temp dir,
#      `canonical.bundle` 0600, its sha256 recorded
#   4. a job-owned 0700 dir on the replica (mktemp under ~/.cache/andenken);
#      the bundle is copied there, made 0600 and its sha256 checked against (3)
#   5. replica `receive --bundle`, under the replica's custody (one ssh)
#   6. location log back: the replica bundles its refs into the same job dir,
#      the bundle comes back (sha256 checked) and the canonical side runs
#      `merge-log --from <device>` under local custody, so both hosts' git-annex
#      branches know both copies. Bundles carry Git refs only — never annexed
#      source content — and nothing is pushed anywhere else.
#   7. the job dirs are removed, payload files only. A failed step keeps the
#      replica's job dir and names it, for inspection.
# Exit codes are the failing step's own (the helper's 10..19, 75; ssh 255);
# 19 is surfaced as `corpus-archive-restore-failed`. There is no atomicity
# across the ssh calls: `receive` re-verifies what it is given and fails closed.
# Only after this script succeeds does sync-sessions ship the index. --dry-run
# copies nothing and skips the archive steps.
#
# Step 6 argv (coordinator, 2026-11-03 00:31 KST): replica `bundle --out ABS`;
# canonical `merge-log --corpus ABS --bundle ABS --from <roster id> --lock-fd N
# [--annex-bin DIR]`.
# shellcheck source=lib/corpus-custody.sh
. scripts/lib/corpus-custody.sh
ARCHIVE=0
# The marker is classified first, also on --dry-run: a wrong-shaped .git exits 10.
if corpus_archive_mode "$CORPUS" && [ "$DRY" = "0" ]; then
  ARCHIVE=1
  corpus_custody_acquire "$CORPUS" "replicate"
fi
BUNDLE=""
BUNDLE_DIR=""
BUNDLE_SHA=""
trap '[ -n "$BUNDLE_DIR" ] && rm -rf "$BUNDLE_DIR"' EXIT

# One owner-helper phase on the replica, under the replica's custody lock.
remote_phase() {
  local target="$1" rcorpus="$2" phase="$3"
  shift 3
  local rlock="$rcorpus/.git/corpus-custody.lock"
  # Default: the agent-config checkout under the REPLICA's home.
  local rhelper="${ANDENKEN_REPLICA_ARCHIVE_HELPER:-${ANDENKEN_CORPUS_ARCHIVE_HELPER:-$(corpus_archive_default_helper "$REMOTE_HOME")}}"
  local cmd q rbin="${ANDENKEN_REPLICA_ANNEX_BIN:-}"
  cmd="exec 8>>$(printf %q "$rlock") && flock -n 8 || exit 75;"
  # A replica --annex-bin must exist THERE; unset → the replica's normal PATH.
  [ -n "$rbin" ] && cmd+=" [ -d $(printf %q "$rbin") ] || { echo 'REFUSED corpus-annex-bin-invalid on the replica' >&2; exit 2; };"
  cmd+=" python3 -I $(printf %q "$rhelper") $(printf %q "$phase") --corpus $(printf %q "$rcorpus") --lock-fd 8"
  [ -n "$rbin" ] && cmd+=" --annex-bin $(printf %q "$rbin")"
  for q in "$@"; do cmd+=" $(printf %q "$q")"; done
  local out rc=0
  out="$(ssh -o BatchMode=yes "$target" "$cmd")" || rc=$?
  echo "   replica corpus-archive $phase (rc $rc): $out"
  corpus_archive_rc_note "$rc" "$phase" "replica"
  return "$rc"
}

# sha256 of a file on the replica (one ssh); empty on failure.
remote_sha256() {
  ssh -o BatchMode=yes "$1" "sha256sum $(printf %q "$2")" 2>/dev/null | awk '{print $1}'
}

# Stop this run with rc $1, keeping the replica job dir $2 (if any) for inspection.
archive_fail() {
  local rc="$1" rdir="${2:-}" msg="$3"
  echo "❌ $msg (rc $rc)" >&2
  [ -n "$rdir" ] && echo "   replica job dir kept for inspection: $rdir" >&2
  exit "$rc"
}

# Source form first, also on --dry-run: it is read-only, and a dry run that
# reports a clean transfer of pointer files would be the wrong answer.
./scripts/corpus-manifest.sh form || { rc=$?; echo "❌ replicate refused: corpus source form (rc $rc) — nothing shipped" >&2; exit "$rc"; }

# Refresh the inventory before shipping so the manifest that lands on the replica
# describes what actually travelled with it. Captured, not piped into `head`: a
# failed update must stop the replication, and a reader that exits early must
# not turn a good update into a SIGPIPE failure.
#
# Archive mode: NOT here. There the ledger is refreshed by gather and committed by
# its checkpoint, and the worktree MANIFEST that ships must be the committed one —
# `update` always rewrites it (its `generated` stamp moves even when no file
# changed), so refreshing it here made every receive refuse (13, "worktree
# MANIFEST.json is not the canonical one"; measured with the real helper). A
# standalone replicate after an uncommitted local gather is likewise refused by
# the replica's receive, fail closed: run `sync:sessions --global`.
if [ "$DRY" = "0" ] && [ "$ARCHIVE" = "0" ]; then
  MANIFEST_RC=0
  MANIFEST_OUT="$(./scripts/corpus-manifest.sh update)" || MANIFEST_RC=$?
  if [ "$MANIFEST_RC" != "0" ]; then
    echo "❌ replicate refused: corpus manifest update failed (rc $MANIFEST_RC) — nothing shipped" >&2
    exit "$MANIFEST_RC"
  fi
  printf '%s\n' "$MANIFEST_OUT" | head -2
fi

UNREACHABLE=()

for row in "${TARGETS[@]}"; do
  read -r device target <<<"$row"
  [ -z "$TO" ] || [ "$TO" = "$device" ] || continue
  echo "== replicate corpus → $device ($target) =="
  if ! REMOTE_HOME="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" 'printf %s "$HOME"' 2>/dev/null)"; then
    echo "   ⚠ $device unreachable — skipped"
    UNREACHABLE+=("$device")
    continue
  fi
  DEST="$target:$REMOTE_HOME/${CORPUS#$HOME/}/"
  # Same path on both machines is the point; refuse rather than silently land
  # the corpus somewhere else.
  case "$CORPUS" in
    "$HOME"/*) ;;
    *) echo "❌ corpus is outside \$HOME ($CORPUS) — cannot mirror the path remotely" >&2; exit 1 ;;
  esac
  if [ "$ARCHIVE" = "0" ]; then
    rsync "${RSYNC_FLAGS[@]}" "$CORPUS/" "$DEST" | tail -8
    continue
  fi
  RCORPUS="$REMOTE_HOME/${CORPUS#$HOME/}"
  # The --from name of step 6 is the roster id; refuse a name the helper would not take.
  [[ "$device" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || archive_fail 2 "" "roster id '$device' is not a valid location-log name"
  # 1. preflight
  remote_phase "$target" "$RCORPUS" preflight || archive_fail $? "" "replica archive preflight failed on $device — nothing shipped there"
  # 2. corpus, replica lock held for the transfer
  rsync "${RSYNC_FLAGS[@]}" --rsync-path="flock -n $(printf %q "$RCORPUS/.git/corpus-custody.lock") rsync" "$CORPUS/" "$DEST" | tail -8 \
    || archive_fail $? "" "corpus rsync to $device failed (a busy replica custody lock fails here)"
  # 3. the run's one bundle
  if [ -z "$BUNDLE" ]; then
    BUNDLE_DIR="$(mktemp -d)"
    chmod 700 "$BUNDLE_DIR"
    BUNDLE="$BUNDLE_DIR/canonical.bundle"
    corpus_archive_phase "$CORPUS" bundle --out "$BUNDLE" || archive_fail $? "" "corpus archive bundle failed"
    chmod 600 "$BUNDLE"
    BUNDLE_SHA="$(sha256sum "$BUNDLE" | awk '{print $1}')"
    echo "   canonical.bundle sha256=$BUNDLE_SHA"
  fi
  # 4. job dir on the replica, bundle in, sha checked
  RJOB="$(ssh -o BatchMode=yes "$target" "umask 077 && mkdir -p $(printf %q "$REMOTE_HOME/.cache/andenken") && mktemp -d $(printf %q "$REMOTE_HOME/.cache/andenken/archive.XXXXXXXX")")" \
    || archive_fail $? "" "could not create a job dir on $device"
  case "$RJOB" in
    "$REMOTE_HOME/.cache/andenken/archive."?*) ;;
    *) archive_fail 1 "" "replica job dir is not where it was asked for ($RJOB)" ;;
  esac
  RBUNDLE="$RJOB/canonical.bundle"
  rsync -a "$BUNDLE" "$target:$RBUNDLE" || archive_fail $? "$RJOB" "bundle transfer to $device failed"
  ssh -o BatchMode=yes "$target" "chmod 600 $(printf %q "$RBUNDLE")" || archive_fail $? "$RJOB" "could not restrict the bundle on $device"
  [ "$(remote_sha256 "$target" "$RBUNDLE")" = "$BUNDLE_SHA" ] || archive_fail 18 "$RJOB" "bundle on $device does not match canonical.bundle sha256"
  # 5. receive
  remote_phase "$target" "$RCORPUS" receive --bundle "$RBUNDLE" || archive_fail $? "$RJOB" "replica archive receive failed on $device — the index must not ship"
  # 6. location log back
  RBACK="$RJOB/$device.bundle"
  remote_phase "$target" "$RCORPUS" bundle --out "$RBACK" || archive_fail $? "$RJOB" "replica bundle for the location log failed on $device"
  RBACK_SHA="$(remote_sha256 "$target" "$RBACK")"
  [ -n "$RBACK_SHA" ] || archive_fail 1 "$RJOB" "replica bundle missing on $device"
  LBACK="$BUNDLE_DIR/$device.bundle"
  rsync -a "$target:$RBACK" "$LBACK" || archive_fail $? "$RJOB" "location-log bundle transfer from $device failed"
  chmod 600 "$LBACK"
  [ "$(sha256sum "$LBACK" | awk '{print $1}')" = "$RBACK_SHA" ] || archive_fail 18 "$RJOB" "location-log bundle from $device does not match its sha256"
  echo "   $device.bundle sha256=$RBACK_SHA"
  corpus_archive_phase "$CORPUS" merge-log --bundle "$LBACK" --from "$device" || archive_fail $? "$RJOB" "canonical merge-log from $device failed"
  # 7. this run's payload only
  ssh -o BatchMode=yes "$target" "rm -f $(printf %q "$RBUNDLE") $(printf %q "$RBACK") && rmdir $(printf %q "$RJOB")" \
    || echo "   ⚠ could not remove the replica job dir $RJOB (payload only; nothing else touched)"
done

echo "== done =="
[ "$DRY" = "1" ] && echo "(dry run — nothing was written)"
if [ "$STRICT" = "1" ] && [ ${#UNREACHABLE[@]} -gt 0 ]; then
  echo "❌ --strict: corpus not replicated to: ${UNREACHABLE[*]}" >&2
  exit 1
fi
exit 0
