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
#   - an environment cleared to an allow-list, every descriptor above 2 closed
#     by the shell that then execs bwrap (its post-close list is recorded),
#     stdin /dev/null and stdout/stderr regular files outside the sandbox.
#
# The test proves the barrier from kernel facts before it does anything else
# (G1, openclaw-fts.test.ts) and exits 10/11 when a fact is wrong. This script
# NEVER runs the test outside the barrier: no trusted bwrap, or a bwrap that
# cannot build the namespaces, is exit 3 with nothing run.
#
# Usage:
#   scripts/test-openclaw-fts-sandboxed.sh --barrier-only [--expect-head SHA]   # G0 + G1
#   scripts/test-openclaw-fts-sandboxed.sh [--expect-head SHA]                  # G0 + G1 + G2
#
# Exit: 0 pass · 1 test failures · 2 precondition (dirty tree beyond the overlay,
# HEAD ≠ --expect-head, unsafe view/deps/tools, low disk) · 3 barrier
# unsupported (no trusted bwrap / the sandbox did not start the test) · 10
# barrier static facts wrong or launch arguments refused · 11 barrier active
# check failed · 12 production metadata changed during the run.
#
# Run layout under ~/.local/state/andenken/fixture-runs/<KST>-openclaw-fts.XXXXXX/
# (0700), kept whole on failure:
#   outside/  launcher evidence — never bound into the sandbox, so nothing inside
#             can change it: launcher.txt, bwrap-argv.txt, code-manifest.tsv,
#             fd-before-exec.txt, watchdog.tsv, inner.out, inner.err
#   view/     the code view (bound read-only at the repo path)
#   bin/      the tool links (bound read-only)
#   root/     the only read-write bind: HOME, G1 and G2 artifacts, fixtures
# The 2 GiB / 5 GiB budget is sampled once a second by the watchdog below — an
# observation, not a hard bound.
set -euo pipefail
umask 077

MODE=full
EXPECT_HEAD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --barrier-only) MODE=barrier; shift ;;
    --expect-head) EXPECT_HEAD="${2:?--expect-head needs a commit}"; shift 2 ;;
    *) echo "usage: $0 [--barrier-only] [--expect-head SHA]" >&2; exit 2 ;;
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
CPUS="0-3"
TOOLS=(bash sh env cat ls mkdir rm rmdir mv cp ln dirname basename date du df head tail tr sort uniq wc
  stat realpath readlink sleep id touch chmod mktemp cut tee uname grep sed awk find xargs flock taskset
  node pnpm sha256sum true false printf test expr seq kill)

die() { echo "❌ $1" >&2; exit "${2:-2}"; }
specials() { find "$@" \( -type s -o -type p -o -type b -o -type c \) -print 2>/dev/null | head -5; }

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
NM="$REPO/node_modules"
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
for t in bash env node pnpm flock taskset; do [ -e "$BINDIR/$t" ] || die "precondition: required tool $t missing" 2; done

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

prod_shape() {
  local p
  for p in "$REPO/data/openclaw.lance" "$REPO/data/.openclaw-harvest.lock" "$REPO/data/openclaw-watermark.json" "$REPO/data/openclaw-staging"; do
    if [ -e "$p" ]; then find "$p" -printf '%P\t%s\t%T@\t%i\n' | LC_ALL=C sort; else echo "$p absent"; fi
  done | sha256sum | cut -c1-64
}
PROD_BEFORE="$(prod_shape)"

{
  echo "mode: $MODE"
  echo "repo: $REPO"
  echo "head: $HEAD_SHA (expect: ${EXPECT_HEAD:-not given})"
  echo "overlay (view copies): $(for o in "${OVERLAY[@]}"; do printf '%s=%s ' "$o" "$(sha256sum "$VIEW/$o" | cut -c1-64)"; done)"
  echo "dirty-at-start: $(printf '%s' "$dirty" | tr '\n' ';')"
  echo "code-manifest-sha256: $(sha256sum "$OUT/code-manifest.tsv" | cut -c1-64) ($(wc -l < "$OUT/code-manifest.tsv") files)"
  echo "deps: pnpm-lock=$(sha256sum "$VIEW/pnpm-lock.yaml" | cut -c1-64) lancedb-native=[$lancedb_native] $(bin_id node)$(bin_id pnpm)"
  echo "bwrap: $BWRAP sha256=$BWRAP_SHA ($BWRAP_VERSION)"
  echo "host-netns: $HOST_NETNS"
  echo "tools: $(ls "$BINDIR" | tr '\n' ' ')"
  echo "env-set-by-launcher: HOME PATH LANG NOSYSBASHRC pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=warn (--clearenv, then --setenv)"
  echo "env-runtime-allowlist: HOME LANG NOSYSBASHRC PATH PWD pnpm_config_pm_on_fail pnpm_config_verify_deps_before_run — PWD only = $REPO (observed at runtime, setter unmeasured), pm_on_fail only = ignore, verify_deps_before_run only = warn; judged inside"
  echo "cpus: $CPUS"
  echo "budget: root/<=${BUDGET}B free>=${FLOOR}B (1 s samples; observation, not a hard bound)"
  echo "prod-metadata-before: $PROD_BEFORE"
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
  --setenv pnpm_config_pm_on_fail ignore
  --setenv pnpm_config_verify_deps_before_run warn
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
  sa=$(du -s --block-size=1 "$ROOT" 2>/dev/null | cut -f1 || echo 0)
  fr=$(df -B1 --output=avail "$STATE" | tail -1 | tr -d ' ')
  printf '%s\t%s\t%s\n' "$(date +%s)" "$sa" "$fr" >> "$OUT/watchdog.tsv"
  if [ "${sa:-0}" -gt "$BUDGET" ] || [ "$fr" -lt "$FLOOR" ]; then
    breach="root=$sa free=$fr"; kill "$BPID" 2>/dev/null || true; break
  fi
  sleep 1
done
rc=0; wait "$BPID" || rc=$?

PROD_AFTER="$(prod_shape)"
{
  echo "inner-exit: $rc"
  echo "watchdog-breach: ${breach:-none}"
  echo "watchdog-samples: $(wc -l < "$OUT/watchdog.tsv")"
  echo "prod-metadata-after: $PROD_AFTER"
} >> "$OUT/launcher.txt"

if [ "$PROD_AFTER" != "$PROD_BEFORE" ]; then
  echo "❌ production metadata changed during the run — see $OUT/launcher.txt" >&2
  exit 12
fi
if [ -n "$breach" ]; then
  echo "❌ budget watchdog stopped the run ($breach) — $RUN kept" >&2
  exit 1
fi
if grep -q '^BARRIER-REFUSED ' "$OUT/inner.out"; then
  echo "❌ the test refused its launch arguments (rc=$rc) — see $OUT/inner.out" >&2
  exit 10
fi
if ! grep -q '^BARRIER-ENTRY ' "$OUT/inner.out"; then
  echo "❌ barrier unsupported: the sandbox did not start the test (bwrap rc=$rc) — see $OUT/inner.err; nothing ran outside it" >&2
  sed -n '1,5p' "$OUT/inner.err" >&2
  exit 3
fi
tail -n 3 "$OUT/inner.out"
[ "$rc" = 0 ] || echo "❌ inner exit $rc — $RUN kept" >&2
exit "$rc"
