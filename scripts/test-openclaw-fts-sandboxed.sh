#!/usr/bin/env bash
# test-openclaw-fts-sandboxed.sh — run openclaw-fts.test.ts inside a kernel
# namespace barrier, never on the host.
#
# Why: on 2026-11-04 a run of that test reached a real host. Its ssh/rsync were
# PATH stubs, and a `bash -c` started with a socket on stdin re-read the system
# profile, which rewrote PATH so the real binaries ran. PATH stubs are an
# emulation layer (they record and answer expected calls); they are not a
# barrier. The barrier is here:
#
#   - user, network, pid, ipc and uts namespaces (bwrap); the network namespace
#     has loopback only, so a real ssh/rsync — if one ever ran — has no route;
#   - a filesystem that exposes only /nix/store, an immutable code view at the
#     repo path (tracked files of the pinned HEAD, sensitive tracked paths
#     filtered, plus this repair's three overlay files), node_modules and a tool
#     directory — all read-only, none holding a socket, FIFO or device — and one
#     read-write directory, root/. No /etc, /run, /sys, host HOME, repo data/
#     or .git;
#   - an environment cleared to an allow-list (HOME, PATH, LANG, NOSYSBASHRC; no
#     package-manager keys), every descriptor above 2 closed by the shell that
#     then execs bwrap (its post-close list is recorded), stdin /dev/null and
#     stdout/stderr regular files outside the sandbox;
#   - no package manager in the tool directory (PATH): every door the test
#     drives launches with `node --import tsx`, so a door that still called pnpm
#     by name would fail inside (not found) instead of installing. This is not a
#     block on absolute paths — /nix/store is bound whole, read-only.
#
# The test proves the barrier from kernel facts before it does anything else
# (G1, openclaw-fts.test.ts) and exits 10/11 when a fact is wrong. This script
# NEVER runs the test outside the barrier: no trusted bwrap, or a bwrap that
# cannot build the namespaces, is exit 3 with nothing run.
#
# Usage:
#   scripts/test-openclaw-fts-sandboxed.sh --barrier-only [--expect-head SHA] [--deps-from DIR]   # G0 + G1
#   scripts/test-openclaw-fts-sandboxed.sh [--expect-head SHA] [--deps-from DIR]                  # G0 + G1 + G2
#
# --deps-from DIR: run a separate source checkout (this script's repo, e.g. an
# independent clone without node_modules) against the dependencies already
# installed in the checkout DIR. DIR/node_modules passes the same guards as a
# repo-local node_modules (a real directory, every link inside it or the store,
# no socket/FIFO/device) and is bound read-only at the same place; DIR's
# pnpm-lock.yaml and package.json must equal the pinned HEAD's. Nothing is
# installed or copied. Nothing else of DIR is bound; outside the sandbox the
# launcher reads only those two files, the node_modules metadata digest and the
# LanceDB native hashes. Without the flag the deps are this repo's own, as before.
#
# The data/ metadata audit (exit 12) reads THIS repo's data/. In a separate
# workplace that is workplace-local — usually absent before and after — and is
# no statement about production data; the protection there is that no
# production data is bound into the sandbox.
#
# Exit: 0 pass · 1 test failures or a budget breach · 2 precondition (dirty tree
# beyond the overlay, HEAD ≠ --expect-head, unsafe view/deps/tools, deps of
# another lock, low disk, scratch over budget before start) · 3 no trusted bwrap
# (G0), or the test entry was not reached — which is NOT proof that the
# barrier is unsupported: bwrap itself, node/tsx/esbuild loading the test, or
# something unspecified can be the cause; the launcher classifies it from
# inner.err and prints the deciding line · 10 barrier static facts wrong or
# launch arguments refused · 11 barrier active check failed · 12 repo data/ or
# dependency metadata changed during the run. Any other exit (a set -e abort,
# 127, a signal) is a stop as well; the run dir is kept.
#
# Run layout under ~/.local/state/andenken/fixture-runs/<KST>-openclaw-fts.XXXXXX/
# (0700), kept whole on failure:
#   outside/  launcher evidence — never bound into the sandbox, so nothing inside
#             can change it: launcher.txt, bwrap-argv.txt, code-manifest.tsv,
#             fd-before-exec.txt, watchdog.tsv, inner.out, inner.err
#   view/     the code view (bound read-only at the repo path)
#   bin/      the tool links (bound read-only)
#   root/     the only read-write bind: HOME, G1 and G2 artifacts, fixtures
# Budget (scratch, cumulative): every run dir under fixture-runs/ — this run and
# every earlier one kept there (G1 and G2 runs both stay) — plus, with
# --deps-from, the workplace (the clone's parent directory: the clone and its
# receipts), measured once at start, must stay ≤ 2 GiB; the state filesystem
# must keep ≥ 5 GiB free. The two trees must be disjoint, so nothing counts
# twice; the borrowed node_modules is not scratch and is not counted. Checked
# before the sandbox starts, then sampled once a second by the watchdog below —
# disk only, an observation, not a hard bound. Not seen: memory (and the
# sandbox's /tmp, which is a tmpfs), and any disk outside those two trees.
# CPUs: the sandbox starts under taskset -c 0-1 (2 cores); that is an inherited
# affinity, not a cgroup limit, so the test pins its own taskset children
# (run.sh run_pinned) to the same set.
set -euo pipefail
umask 077

MODE=full
EXPECT_HEAD=""
DEPS_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --barrier-only) MODE=barrier; shift ;;
    --expect-head) EXPECT_HEAD="${2:?--expect-head needs a commit}"; shift 2 ;;
    --deps-from) DEPS_FROM="${2:?--deps-from needs a checkout directory}"; shift 2 ;;
    *) echo "usage: $0 [--barrier-only] [--expect-head SHA] [--deps-from DIR]" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY=(run.sh scripts/test-openclaw-fts-sandboxed.sh openclaw-fts.test.ts)
# Tolerated dirty file outside the overlay: the coordinator's working queue. It
# is documentation; the view takes HEAD's copy, so its edits never reach a run.
TOLERATED=(NEXT.md)
# Tracked paths that never enter the view (public, but not needed and not ours
# to expose): agent skills, and anything shaped like local or private state.
DENY_RE='^(\.claude|\.agent-reports|\.review|data|dist)(/|$)|(^|/)\.env|\.local\.json$'
BUDGET=$((2 * 1024 ** 3))
FLOOR=$((5 * 1024 ** 3))
STATE="$HOME/.local/state/andenken/fixture-runs"
CPUS="0-1"
TOOLS=(bash sh env cat ls mkdir rm rmdir mv cp ln dirname basename date du df head tail tr sort uniq wc
  stat realpath readlink sleep id touch chmod mktemp cut tee uname grep sed awk find xargs flock taskset
  node sha256sum true false printf test expr seq kill)

die() { echo "❌ $1" >&2; exit "${2:-2}"; }
specials() { find "$@" \( -type s -o -type p -o -type b -o -type c \) -print 2>/dev/null | head -5; }
# A budget measurement is one integer or a failure — never a default. du/df
# output that is not exactly one number (nothing, a partial total from a
# nonzero exit, more lines) is a failed measurement, not 0; no retry.
du_bytes() {
  local out n
  out="$(du -s --block-size=1 -- "$1" 2>/dev/null)" || return 1
  case "$out" in *$'\n'*) return 1 ;; esac
  n="${out%%$'\t'*}"
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$n"
}
df_avail() {
  local out n
  out="$(df -B1 --output=avail -- "$1" 2>/dev/null)" || return 1
  case "$out" in *$'\n'*$'\n'*) return 1 ;; *$'\n'*) ;; *) return 1 ;; esac
  n="${out##*$'\n'}"; n="${n//[[:space:]]/}"
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$n"
}

# ── G0: preconditions, all outside; nothing below runs the test ──────────────
command -v git >/dev/null || die "git not found" 2
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
if [ -n "$EXPECT_HEAD" ] && [ "$HEAD_SHA" != "$(git -C "$REPO" rev-parse --verify "$EXPECT_HEAD^{commit}" 2>/dev/null || echo none)" ]; then
  die "precondition: HEAD is $HEAD_SHA, not the expected $EXPECT_HEAD" 2
fi

dirty="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
while IFS= read -r line; do
  [ -n "$line" ] || continue
  f="${line:3}"
  ok=0
  for o in "${OVERLAY[@]}" "${TOLERATED[@]}"; do [ "$f" = "$o" ] && ok=1; done
  [ "$ok" = 1 ] || die "precondition: $f is changed outside the overlay (${OVERLAY[*]}); commit or set it aside first" 2
done <<< "$dirty"
for o in "${OVERLAY[@]}"; do
  [ -f "$REPO/$o" ] && [ ! -L "$REPO/$o" ] || die "precondition: overlay $o is not a regular file" 2
done

# bwrap: a real file in /nix/store with neither setuid nor setgid, or nothing runs.
BWRAP="$(command -v bwrap || true)"
[ -n "$BWRAP" ] || die "barrier unsupported: bwrap not found — nothing was run (no fallback)" 3
BWRAP="$(realpath "$BWRAP")"
case "$BWRAP" in /nix/store/*) ;; *) die "barrier unsupported: bwrap resolves outside /nix/store ($BWRAP) — nothing was run" 3 ;; esac
[ -f "$BWRAP" ] && [ ! -u "$BWRAP" ] && [ ! -g "$BWRAP" ] || die "barrier unsupported: $BWRAP is not a plain store file (setuid/setgid or not a file) — nothing was run" 3
BWRAP_SHA="$(sha256sum "$BWRAP" | cut -c1-64)"
BWRAP_VERSION="$("$BWRAP" --version 2>&1 | head -1)"

mkdir -p "$STATE"
chmod 700 "$STATE"
free=$(df -B1 --output=avail "$STATE" | tail -1 | tr -d ' ')
[ "$free" -ge "$FLOOR" ] || die "precondition: free $free B < reserve $FLOOR B" 2

RUN="$(mktemp -d "$STATE/$(TZ=Asia/Seoul date +%Y%m%dT%H%M%S)-openclaw-fts.XXXXXX")"
chmod 700 "$RUN"
OUT="$RUN/outside"
VIEW="$RUN/view"
BINDIR="$RUN/bin"
ROOT="$RUN/root"
mkdir -p "$OUT" "$VIEW" "$BINDIR" "$ROOT/home"
echo "run dir: $RUN"

# Code view: tracked files of the pinned HEAD, filtered, then the overlay on top.
git -C "$REPO" archive --format=tar "$HEAD_SHA" | tar -x -C "$VIEW"
( cd "$VIEW" && find . -mindepth 1 -printf '%P\n' ) | { grep -E "$DENY_RE" || true; } | sort -r | while IFS= read -r p; do
  rm -rf -- "${VIEW:?}/$p"
done
for o in "${OVERLAY[@]}"; do
  mkdir -p "$VIEW/$(dirname "$o")"
  cp -p -- "$REPO/$o" "$VIEW/$o"
done
left="$( (cd "$VIEW" && find . -mindepth 1 -printf '%P\n') | grep -E "$DENY_RE" || true)"
[ -z "$left" ] || die "precondition: denied paths remain in the view: $left" 2
while IFS= read -r l; do
  [ -n "$l" ] || continue
  t="$(realpath -m "$l")"
  case "$t" in "$VIEW"/*|/nix/store/*) ;; *) die "precondition: view symlink $l escapes to $t" 2 ;; esac
done < <(find "$VIEW" -type l)
mkdir -p "$VIEW/node_modules"

# Dependencies: read-only node_modules whose every link stays inside it or the store.
# DEPS_ROOT is the checkout whose node_modules is bound: this repo, or the
# installed checkout --deps-from names, borrowed as it is. Its lock and
# package.json must equal the pinned HEAD's (necessary, not sufficient: they do
# not prove what an earlier install left in node_modules — the run records the
# tree's metadata digest before and after instead, and refuses a change).
DEPS_ROOT="$REPO"
WORKPLACE=""
WORK_BYTES=0
if [ -n "$DEPS_FROM" ]; then
  case "$DEPS_FROM" in /*) ;; *) die "precondition: --deps-from $DEPS_FROM is not an absolute path" 2 ;; esac
  [ -d "$DEPS_FROM" ] && [ ! -L "$DEPS_FROM" ] || die "precondition: --deps-from $DEPS_FROM is not a directory" 2
  DEPS_ROOT="$(realpath "$DEPS_FROM")"
  for f in pnpm-lock.yaml package.json; do
    [ -f "$DEPS_ROOT/$f" ] && [ ! -L "$DEPS_ROOT/$f" ] || die "precondition: --deps-from $DEPS_ROOT has no regular $f" 2
    [ "$(sha256sum < "$DEPS_ROOT/$f" | cut -c1-64)" = "$(sha256sum < "$VIEW/$f" | cut -c1-64)" ] \
      || die "precondition: $DEPS_ROOT/$f differs from the pinned HEAD's — its node_modules belongs to another lock" 2
  done
  [ ! -e "$REPO/node_modules" ] || die "precondition: --deps-from given but $REPO/node_modules exists — which deps run would be ambiguous" 2
  # This repo is then a clone in a separate workplace — its parent directory,
  # which also holds the clone's receipts. All of it counts against the budget,
  # once, and it must not overlap the run dirs (nothing counted twice).
  WORKPLACE="$(realpath "$(dirname "$REPO")")"
  STATE_REAL="$(realpath -m "$STATE")"
  case "$WORKPLACE" in /|"$(realpath -m "$HOME")") die "precondition: workplace $WORKPLACE (the clone's parent) is / or HOME — put the clone in its own directory" 2 ;; esac
  case "$STATE_REAL/" in "$WORKPLACE"/*) die "precondition: the run dirs ($STATE_REAL) lie inside the workplace $WORKPLACE" 2 ;; esac
  case "$WORKPLACE/" in "$STATE_REAL"/*) die "precondition: the workplace $WORKPLACE lies inside the run dirs ($STATE_REAL)" 2 ;; esac
  WORK_BYTES="$(du_bytes "$WORKPLACE")" || die "precondition: cannot measure the workplace $WORKPLACE (du is not one number) — nothing was run" 2
fi
NM="$DEPS_ROOT/node_modules"
[ -d "$NM" ] && [ ! -L "$NM" ] || die "precondition: $NM is not a directory" 2
while IFS= read -r -d '' l; do
  t="$(realpath -m "$l")"
  case "$t" in "$NM"/*|/nix/store/*) ;; *) die "precondition: dependency link $l escapes to $t" 2 ;; esac
done < <(find "$NM" -type l -print0)

# Tools: resolved outside to their store paths; ssh/rsync are deliberately absent.
for t in "${TOOLS[@]}"; do
  p="$(command -v "$t" || true)"
  case "$p" in /*) ;; *) continue ;; esac
  r="$(realpath "$p")"
  case "$r" in /nix/store/*) ln -s "$r" "$BINDIR/$t" ;; *) die "precondition: tool $t resolves outside /nix/store ($r)" 2 ;; esac
done
for t in bash env node flock taskset; do [ -e "$BINDIR/$t" ] || die "precondition: required tool $t missing" 2; done

# Read-only does not stop connect() on a socket path, nor I/O on a FIFO or
# device: none may exist in anything bound. (/nix/store cannot hold them.)
sp="$(specials "$VIEW" "$NM" "$BINDIR")"
[ -z "$sp" ] || die "precondition: socket/FIFO/device in a bound tree: $sp" 2

HOST_NETNS="$(readlink /proc/self/ns/net)"
HOST_NETNS="${HOST_NETNS#net:[}"; HOST_NETNS="${HOST_NETNS%]}"
case "$HOST_NETNS" in ''|*[!0-9]*) die "cannot read the host network namespace inode" 2 ;; esac

( cd "$VIEW" && find . -type f -printf '%P\n' | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s\t%s\t%s\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -c1-64)"
  done ) > "$OUT/code-manifest.tsv"
lancedb_native="$(find "$NM/.pnpm" -path '*@lancedb*' -name '*.node' -type f 2>/dev/null | LC_ALL=C sort | head -3 | while IFS= read -r f; do printf '%s %s; ' "$(sha256sum "$f" | cut -c1-16)" "${f#"$NM"/}"; done)"
bin_id() { local r; r="$(realpath "$BINDIR/$1")"; printf '%s=%s(%s) ' "$1" "$r" "$(sha256sum "$r" | cut -c1-16)"; }

data_shape() {
  local p
  for p in "$REPO/data/openclaw.lance" "$REPO/data/.openclaw-harvest.lock" "$REPO/data/openclaw-watermark.json" "$REPO/data/openclaw-staging"; do
    if [ -e "$p" ]; then find "$p" -printf '%P\t%s\t%T@\t%i\n' | LC_ALL=C sort; else echo "$p absent"; fi
  done | sha256sum | cut -c1-64
}
# Metadata only (type, path, size, mtime, inode, link target) — no file content.
deps_shape() { find "$NM" -printf '%y\t%P\t%s\t%T@\t%i\t%l\n' | LC_ALL=C sort | sha256sum | cut -c1-64; }
DATA_BEFORE="$(data_shape)"
DEPS_BEFORE="$(deps_shape)"
modules_yaml="$( [ -f "$NM/.modules.yaml" ] && sha256sum < "$NM/.modules.yaml" | cut -c1-64 || echo absent)"

{
  echo "mode: $MODE"
  echo "repo: $REPO"
  echo "head: $HEAD_SHA (expect: ${EXPECT_HEAD:-not given})"
  echo "overlay (view copies): $(for o in "${OVERLAY[@]}"; do printf '%s=%s ' "$o" "$(sha256sum "$VIEW/$o" | cut -c1-64)"; done)"
  echo "dirty-at-start: $(printf '%s' "$dirty" | tr '\n' ';')"
  echo "code-manifest-sha256: $(sha256sum "$OUT/code-manifest.tsv" | cut -c1-64) ($(wc -l < "$OUT/code-manifest.tsv") files)"
  echo "deps: dir=$NM (from: ${DEPS_FROM:-this repo}) pnpm-lock=$(sha256sum "$VIEW/pnpm-lock.yaml" | cut -c1-64) modules-yaml=$modules_yaml lancedb-native-candidates(find; not load evidence)=[$lancedb_native] $(bin_id node)"
  echo "deps-mount: $NM -> $REPO/node_modules (ro; inside paths in g1-report.json lancedb map back by this prefix)"
  echo "deps-metadata-before: $DEPS_BEFORE"
  echo "bwrap: $BWRAP sha256=$BWRAP_SHA ($BWRAP_VERSION)"
  echo "host-netns: $HOST_NETNS"
  echo "tools: $(ls "$BINDIR" | tr '\n' ' ')"
  echo "env-set-by-launcher: HOME PATH LANG NOSYSBASHRC (--clearenv, then --setenv)"
  echo "env-runtime-allowlist: HOME LANG NOSYSBASHRC PATH PWD — PWD only = $REPO (observed at runtime, setter unmeasured); judged inside"
  echo "cpus: $CPUS (taskset affinity, inherited; not a cgroup limit)"
  echo "budget: all run dirs under $STATE (this and earlier kept runs) + workplace ${WORKPLACE:-none} (${WORK_BYTES}B, measured once) <=${BUDGET}B, free>=${FLOOR}B; disjoint trees; borrowed deps not counted (1 s disk samples; observation, not a hard bound; memory and the sandbox tmpfs not watched)"
  if [ -n "$DEPS_FROM" ]; then
    echo "data-audit-scope: $REPO/data — workplace-local, NOT production; absent before and after proves nothing about production data (none is bound into the sandbox)"
  else
    echo "data-audit-scope: $REPO/data"
  fi
  echo "data-metadata-before: $DATA_BEFORE"
} > "$OUT/launcher.txt"

ARGS=(
  --unshare-user --unshare-net --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
  --die-with-parent --new-session --cap-drop ALL --clearenv
  --ro-bind /nix/store /nix/store
  --bind "$ROOT" "$ROOT"
  --ro-bind "$BINDIR" "$BINDIR"
  --ro-bind "$VIEW" "$REPO"
  --ro-bind "$NM" "$REPO/node_modules"
  --proc /proc --dev /dev --tmpfs /tmp
  --dir /bin --dir /usr/bin
  --symlink "$(realpath "$BINDIR/bash")" /bin/sh
  --symlink "$(realpath "$BINDIR/env")" /usr/bin/env
  --setenv HOME "$ROOT/home"
  --setenv PATH "$BINDIR"
  --setenv LANG C.UTF-8
  --setenv NOSYSBASHRC 1
  --chdir "$REPO"
  --
  "$BINDIR/node" --import tsx "$REPO/openclaw-fts.test.ts"
  --root "$ROOT" --evidence "$OUT" --host-netns "$HOST_NETNS" --host-home "$HOME" --repo "$REPO" --bindir "$BINDIR"
)
[ "$MODE" = barrier ] && ARGS+=(--barrier-only)
printf '%s\n' "$BWRAP" "${ARGS[@]}" > "$OUT/bwrap-argv.txt"

# ── run ──────────────────────────────────────────────────────────────────────
# The subshell below is the process that execs bwrap. It closes its own
# descriptors above 2 (the glob expands in this shell, so /proc/self is it),
# records what is left by its own pid, then execs. The listing runs in a child
# whose redirect is the child's alone; nothing is left open for the exec.
# Scratch in use: every run dir under $STATE (this one and earlier kept runs)
# plus the workplace measured once. Already over budget → nothing starts.
scratch_used() { local s; s="$(du_bytes "$STATE")" || return 1; printf '%s\n' "$(( s + WORK_BYTES ))"; }
used0="$(scratch_used)" || die "precondition: cannot measure scratch (du of $STATE is not one number) — nothing was run" 2
echo "scratch-before-start: $used0" >> "$OUT/launcher.txt"
[ "$used0" -le "$BUDGET" ] || die "precondition: scratch already $used0 B > budget $BUDGET B (run dirs under $STATE + workplace) — nothing was run" 2
: > "$OUT/watchdog.tsv"
(
  for p in /proc/self/fd/*; do
    n="${p##*/}"
    [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-" 2>/dev/null || true
  done
  ls -l "/proc/$BASHPID/fd" > "$OUT/fd-before-exec.txt" 2>&1 || true
  exec taskset -c "$CPUS" "$BWRAP" "${ARGS[@]}"
) < /dev/null > "$OUT/inner.out" 2> "$OUT/inner.err" &
BPID=$!
breach=""
while kill -0 "$BPID" 2>/dev/null; do
  # This run dir (for the record) and the cumulative scratch the budget is about.
  # One number each, or the sample failed: a failed sample stops the run with
  # its reason — never read as 0, never retried — and the receipts below follow.
  if ! sa="$(du_bytes "$RUN")"; then breach="sampling failed: du of $RUN is not one number"
  elif ! used="$(scratch_used)"; then breach="sampling failed: du of $STATE is not one number"
  elif ! fr="$(df_avail "$STATE")"; then breach="sampling failed: df of $STATE is not one number"
  else
    printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$sa" "$used" "$fr" >> "$OUT/watchdog.tsv"
    if [ "$used" -gt "$BUDGET" ] || [ "$fr" -lt "$FLOOR" ]; then breach="run=$sa used=$used free=$fr"; fi
  fi
  if [ -n "$breach" ]; then kill "$BPID" 2>/dev/null || true; break; fi
  sleep 1
done
rc=0; wait "$BPID" || rc=$?

DATA_AFTER="$(data_shape)"
DEPS_AFTER="$(deps_shape)"
{
  echo "inner-exit: $rc"
  echo "watchdog-breach: ${breach:-none}"
  echo "watchdog-samples: $(wc -l < "$OUT/watchdog.tsv")"
  echo "data-metadata-after: $DATA_AFTER"
  echo "deps-metadata-after: $DEPS_AFTER"
} >> "$OUT/launcher.txt"

if [ "$DATA_AFTER" != "$DATA_BEFORE" ]; then
  echo "❌ $REPO/data metadata changed during the run — see $OUT/launcher.txt" >&2
  exit 12
fi
if [ "$DEPS_AFTER" != "$DEPS_BEFORE" ]; then
  echo "❌ dependency metadata ($NM) changed during the run — see $OUT/launcher.txt" >&2
  exit 12
fi
if [ -n "$breach" ]; then
  echo "❌ watchdog stopped the run ($breach) — $RUN kept" >&2
  exit 1
fi
if grep -q '^BARRIER-REFUSED ' "$OUT/inner.out"; then
  echo "❌ the test refused its launch arguments (rc=$rc) — see $OUT/inner.out" >&2
  exit 10
fi
if ! grep -q '^BARRIER-ENTRY ' "$OUT/inner.out"; then
  # Entry not reached. Name the layer from inner.err's own deciding line — bwrap
  # prefixes its errors "bwrap:"; a load failure of the test shows node/tsx/
  # esbuild/module errors — and do not call it "unsupported" either way.
  first="$(grep -m1 -v '^[[:space:]]*$' "$OUT/inner.err" || true)"
  if printf '%s' "$first" | grep -q '^bwrap: '; then layer="bwrap itself"
  elif grep -q -E 'ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError|TransformError|esbuild|tsx|Cannot find (module|package)|node:internal' "$OUT/inner.err"; then layer="node/tsx loading the test"
  else layer="unspecified"; fi
  {
    echo "entry-not-reached: layer=$layer bwrap-rc=$rc"
    echo "entry-not-reached-deciding-line: ${first:-<inner.err empty>}"
  } >> "$OUT/launcher.txt"
  echo "❌ entry not started: the test entry was not reached (layer: $layer; bwrap rc=$rc) — not proof that the barrier is unsupported; see $OUT/inner.err; nothing ran outside it" >&2
  echo "   deciding line: ${first:-<inner.err empty>}" >&2
  sed -n '1,5p' "$OUT/inner.err" >&2
  exit 3
fi
tail -n 3 "$OUT/inner.out"
[ "$rc" = 0 ] || echo "❌ inner exit $rc — $RUN kept" >&2
exit "$rc"
