# shellcheck shell=bash
# corpus-custody.sh — the corpus archive custody lock and the owner's hook, for
# shell wrappers (issue #18 / agent-config #32, contract v1 of 2026-11-02).
#
# Archive mode = the corpus root has a `.git` DIRECTORY (git-annex). Only a
# `.git` that is entirely absent (lstat: ENOENT) is legacy: nothing here does
# anything and every caller behaves as before. A `.git` of any other shape — a
# gitfile, a symlink (even to a directory), or one whose lstat fails for another
# reason — is refused (exit 10, `corpus-archive-marker-invalid`), API 0, the
# same rule corpus-custody.ts applies on the Node side.
#
# In archive mode:
#   - Custody: `<corpus>/.git/corpus-custody.lock`, held with flock on FD 8 by the
#     outermost wrapper (order: sync flock 9 → custody 8 → sessions writer lock).
#     The lock path must be a regular file (lstat; a symlink is refused, 75).
#     The holder exports ANDENKEN_CORPUS_CUSTODY_FD=8; a child wrapper that sees it
#     re-enters on the INHERITED descriptor and never unlocks or reopens it. What
#     that re-entry checks, exactly: FD 8 is the lock file (same dev:inode as the
#     path's lstat) and `flock -n 8` succeeds, i.e. no OTHER open file description
#     holds it. flock also succeeds on a matching descriptor nobody holds yet (it
#     then takes it there), so the check does not prove who took it first; that the
#     outermost wrapper takes it before any child runs is the wrappers' order, shown
#     by the glue fixtures. A separate open that finds it busy: exit 75. A set
#     ANDENKEN_CORPUS_CUSTODY_FD whose FD 8 is missing or another file is a lost
#     descriptor (75, `corpus-custody-fd-lost`), never a reason to open afresh;
#     only an unset variable means "standalone, take it here".
#   - Hook: the owner's helper (agent-config skills/memory-sync/scripts/
#     corpus-archive.py) is called as
#       python3 -I HELPER PHASE --corpus ABS --lock-fd 8 [--annex-bin DIR] [args]
#     stdout = one JSON line (logged), exit code propagated (75 = lock). A missing
#     helper fails closed before anything is gathered, copied or indexed.
#   - --annex-bin: ANDENKEN_CORPUS_ANNEX_BIN, when set, must be an absolute
#     existing directory (else exit 2 before any work); unset → the normal PATH.
#     Nothing here installs anything.
#   - Exit 19 from the helper (a failed phase whose index restore ALSO failed) is
#     surfaced as its own fixed code and propagated as 19, never folded into
#     another failure: the corpus index is left as found and needs an operator.
#   - Writers launched from a wrapper without a gather (run.sh index:sessions /
#     index:durable / corpus:durable-admit, sync and rebuild with SKIP_GATHER=1)
#     first pass corpus_archive_ready: the owner's `preflight` and the read-only
#     source `form`, under the held custody. Either failing → its code, Node never
#     starts. This is a readiness check; it does not require HEAD to include the
#     latest gather (a local, uncommitted corpus stays allowed).
#   - Node writers check the same inherited descriptor (corpus-custody.ts); the
#     wrappers launch them with `node --import tsx`, because `pnpm exec tsx`
#     does not pass FD 8 through (measured by main, D/fd-inherit-probe.txt).
#
#   . scripts/lib/corpus-custody.sh
#   corpus_custody_acquire "$CORPUS" "<label>"       # exit 10 / 75 on refusal
#   corpus_archive_phase "$CORPUS" preflight || exit $?
#   corpus_archive_ready "$CORPUS" "<label>" || exit $?
#   corpus_archive_mode "$CORPUS" && …               # exits 10 on a wrong-shaped .git

CORPUS_CUSTODY_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The owner's helper under a home ($1, default this HOME): the same agent-config
# checkout path the rest of the harness uses (agent-config's own SSOT).
corpus_archive_default_helper() {
  printf '%s/repos/gh/agent-config/skills/memory-sync/scripts/corpus-archive.py' "${1:-$HOME}"
}

corpus_archive_helper() {
  printf '%s' "${ANDENKEN_CORPUS_ARCHIVE_HELPER:-$(corpus_archive_default_helper)}"
}

_corpus_archive_marker_invalid() {
  echo "REFUSED corpus-archive-marker-invalid: $1/.git exists but is $2 — only a real directory (archive) or no .git at all (legacy) is accepted. Nothing was done (API 0)." >&2
  exit 10
}

# 0 = archive (`.git` is a real directory), 1 = legacy (`.git` absent);
# any other shape or an lstat error other than ENOENT exits 10 here.
corpus_archive_mode() {
  [ -n "${1:-}" ] || return 1
  local g="$1/.git" err
  [ -L "$g" ] && _corpus_archive_marker_invalid "$1" "a symlink"
  [ -d "$g" ] && return 0
  [ -e "$g" ] && _corpus_archive_marker_invalid "$1" "not a directory (e.g. a gitfile)"
  err="$(LC_ALL=C stat -c %F -- "$g" 2>&1 >/dev/null)" && _corpus_archive_marker_invalid "$1" "of an unexpected type"
  case "$err" in *"No such file or directory"*) return 1 ;; esac
  _corpus_archive_marker_invalid "$1" "unreadable (${err##*: })"
}

corpus_custody_lock_path() {
  printf '%s/.git/corpus-custody.lock' "$1"
}

# fd 8 of this shell is an open regular file and $1 is that same file: a regular
# file by lstat (a symlink is not followed) with the same device and inode.
_corpus_custody_fd8_is() {
  local a b
  [ -f "/proc/$$/fd/8" ] || return 1
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  a="$(stat -L -c '%d:%i' "/proc/$$/fd/8" 2>/dev/null)" || return 1
  b="$(stat -c '%d:%i' -- "$1" 2>/dev/null)" || return 1
  [ "$a" = "$b" ]
}

# An --annex-bin value is an absolute existing directory, or absent. $1 = value, $2 = name.
corpus_annex_bin_valid() {
  [ -z "${1:-}" ] && return 0
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -d "$1" ]
}

corpus_custody_acquire() {
  local corpus="$1" label="${2:-wrapper}" lock helper
  corpus_archive_mode "$corpus" || return 0
  helper="$(corpus_archive_helper)"
  if [ ! -f "$helper" ]; then
    echo "REFUSED corpus-archive-hook-missing: $corpus has a root .git but the archive helper is absent ($helper)." >&2
    echo "  Fail closed: nothing gathered, copied, indexed or published ($label)." >&2
    exit 10
  fi
  if ! corpus_annex_bin_valid "${ANDENKEN_CORPUS_ANNEX_BIN:-}"; then
    echo "REFUSED corpus-annex-bin-invalid: ANDENKEN_CORPUS_ANNEX_BIN must be an absolute existing directory ($label)." >&2
    exit 2
  fi
  case "${ANDENKEN_REPLICA_ANNEX_BIN:-}" in
    ""|/*) ;;
    *) echo "REFUSED corpus-annex-bin-invalid: ANDENKEN_REPLICA_ANNEX_BIN must be absolute ($label)." >&2; exit 2 ;;
  esac
  lock="$(corpus_custody_lock_path "$corpus")"
  if [ -L "$lock" ] || { [ -e "$lock" ] && [ ! -f "$lock" ]; }; then
    echo "REFUSED corpus-custody-lock-not-regular: $lock is not a regular file (a symlink is refused) ($label)" >&2
    exit 75
  fi
  # A set ANDENKEN_CORPUS_CUSTODY_FD is a claim of inherited custody: honoured only
  # as FD 8 on this lock, never replaced by a fresh open. Only an unset variable
  # (a standalone run) takes the lock below.
  if [ -n "${ANDENKEN_CORPUS_CUSTODY_FD+x}" ]; then
    if [ "$ANDENKEN_CORPUS_CUSTODY_FD" = "8" ] && _corpus_custody_fd8_is "$lock"; then
      if flock -n 8; then
        return 0 # inherited custody: re-entry on the same open file description
      fi
      echo "REFUSED corpus-custody-foreign: FD 8 is the custody lock but another holder has it ($label)" >&2
      exit 75
    fi
    echo "REFUSED corpus-custody-fd-lost: ANDENKEN_CORPUS_CUSTODY_FD='$ANDENKEN_CORPUS_CUSTODY_FD' claims inherited custody but FD 8 is not $lock; not reopening it ($label)" >&2
    exit 75
  fi
  if ! exec 8>>"$lock"; then
    echo "REFUSED corpus-custody-open-failed: $lock ($label)" >&2
    exit 75
  fi
  if ! _corpus_custody_fd8_is "$lock"; then
    echo "REFUSED corpus-custody-lock-not-regular: $lock changed under the open ($label)" >&2
    exit 75
  fi
  if ! flock -n 8; then
    echo "REFUSED corpus-custody-busy: $lock is held by another process ($label)" >&2
    exit 75
  fi
  export ANDENKEN_CORPUS_CUSTODY_FD=8
  echo "corpus custody: held on FD 8 ($label)"
}

# corpus_archive_phase CORPUS PHASE [phase args…] — local helper call under the held custody.
corpus_archive_phase() {
  local corpus="$1" phase="$2" out rc=0
  shift 2
  local args=("$phase" --corpus "$corpus" --lock-fd 8)
  [ -n "${ANDENKEN_CORPUS_ANNEX_BIN:-}" ] && args+=(--annex-bin "$ANDENKEN_CORPUS_ANNEX_BIN")
  out="$(python3 -I "$(corpus_archive_helper)" "${args[@]}" "$@")" || rc=$?
  echo "corpus-archive $phase (rc $rc): $out"
  corpus_archive_rc_note "$rc" "$phase" "local"
  return "$rc"
}

# corpus_archive_ready CORPUS LABEL — for a writer that runs without a gather: the
# owner's preflight, then the read-only source form, both under the held custody.
# Returns the first failing code (helper 10..19 / 75, form 3); 0 outside archive mode.
corpus_archive_ready() {
  local corpus="$1" label="${2:-writer}" rc=0
  corpus_archive_mode "$corpus" || return 0
  corpus_archive_phase "$corpus" preflight || rc=$?
  if [ "$rc" != "0" ]; then
    echo "❌ $label refused: corpus archive preflight (rc $rc) — no writer started" >&2
    return "$rc"
  fi
  ANDENKEN_SESSION_CORPUS="$corpus" "$CORPUS_CUSTODY_SCRIPTS/corpus-manifest.sh" form || rc=$?
  if [ "$rc" != "0" ]; then
    echo "❌ $label refused: corpus source form (rc $rc) — no writer started" >&2
    return "$rc"
  fi
}

# A fixed diagnostic for the codes a caller must not fold into another failure.
corpus_archive_rc_note() {
  local rc="$1" phase="$2" where="$3"
  case "$rc" in
    19) echo "REFUSED corpus-archive-restore-failed: $where $phase failed AND its index restore failed (rc 19); the corpus index is left as found — operator intervention required, nothing further runs." >&2 ;;
    75) echo "REFUSED corpus-archive-lock: $where $phase found the custody descriptor lost or held elsewhere (rc 75)." >&2 ;;
  esac
}
