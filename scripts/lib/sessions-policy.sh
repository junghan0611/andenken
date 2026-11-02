# shellcheck shell=bash
# sessions-policy.sh — the selection-policy pin check for shell wrappers (issue #18).
#
# The pin itself is read by `indexer.ts policy` (session-policy.ts), so the shell
# never parses the pin on its own. This file adds the two things only a wrapper
# can check, and it runs BEFORE the wrapper gathers, probes, destroys or ships:
#
#   1. Same data dir. These wrappers act on the relative `data/` (destroy, push),
#      while the indexer writes `${ANDENKEN_DATA:-$HOME/repos/gh/andenken/data}`.
#      When those differ, a check on one and a destroy of the other is no check.
#   2. The pin of that dir, read by the indexer: exit 2 (malformed / one-sided)
#      refuses every wrapper; `legacy-only` also refuses a pinned dir.
#
#   . scripts/lib/sessions-policy.sh
#   sessions_policy_require any           # sync-sessions: legacy or pinned
#   sessions_policy_require legacy-only   # rebuild-sessions-full: legacy only
#
# On success SESSIONS_POLICY_JSON holds the indexer's one-line answer.
#
#   sessions_authority_require   # INVARIANT 7.1 before any work (rebuild-sessions-full)
#
# sync-sessions.sh keeps its own authority gate AFTER its gather on purpose (a
# replica still gathers its half); a full rebuild has no such half, so it is
# refused before it gathers, estimates or destroys anything.

# The authority device is ~/.current-device and nothing else — the same source
# the Node writers read (session-policy.ts indexAuthorityRefusal). No hostname
# fallback: a wrapper that passed on the hostname would destroy or probe before
# the indexer refused the same machine as "unknown".
sessions_authority_device() {
  local device
  device="$(cat "$HOME/.current-device" 2>/dev/null || true)"
  printf '%s' "${device//[[:space:]]/}"
}

sessions_authority_require() {
  local authority="${ANDENKEN_INDEX_AUTHORITY:-thinkpad}" device
  device="$(sessions_authority_device)"
  if [ "$device" != "$authority" ] && [ "${ANDENKEN_ALLOW_REPLICA_INDEX:-0}" != "1" ]; then
    echo "REFUSED not-index-authority: this is '${device:-unknown}'; only '$authority' writes the sessions index (INVARIANT 7.1)." >&2
    echo "  (no gather, no API call, nothing removed)" >&2
    exit 1
  fi
}

sessions_policy_require() {
  local mode="$1" indexer_data here out pinned
  indexer_data="${ANDENKEN_DATA:-$HOME/repos/gh/andenken/data}"
  here="$(realpath -m data)"
  if [ "$(realpath -m "$indexer_data")" != "$here" ]; then
    echo "REFUSED sessions-policy data-dir-mismatch: this wrapper acts on $here," >&2
    echo "  the indexer would write $(realpath -m "$indexer_data"). Unset ANDENKEN_DATA or run from that repo." >&2
    echo "  (no gather, no API call, nothing removed)" >&2
    exit 2
  fi
  local err rc=0
  err="$(mktemp)"
  out="$(ANDENKEN_DATA="$here" pnpm exec tsx indexer.ts policy 2>"$err")" || rc=$?
  if [ "$rc" != 0 ]; then
    tail -3 "$err" >&2
    rm -f "$err"
    echo "REFUSED sessions-policy unreadable pin in $here (rc $rc) — no gather, no API call, nothing removed" >&2
    exit 2
  fi
  rm -f "$err"
  # The answer is the last JSON line on stdout; anything else there is tooling noise.
  # It must be exactly one of the two shapes `indexer.ts policy` prints, for THIS
  # data dir: a missing / non-boolean `pinned`, a selection that does not match
  # it, or any extra key is no answer, and no answer is never "legacy".
  out="$(printf '%s\n' "$out" | grep '^{' | tail -1 || true)"
  pinned="$(printf '%s' "$out" | ANDENKEN_POLICY_HERE="$here" python3 -I -c '
import json, os, sys
d = json.loads(sys.stdin.read())
legacy = {"dataDir", "selection", "pinned"}
pinned = {"dataDir", "selection", "s0", "pinned"}
ok = isinstance(d, dict) and d.get("dataDir") == os.environ["ANDENKEN_POLICY_HERE"] and (
    (set(d) == legacy and d["selection"] == "legacy" and d["pinned"] is False)
    or (set(d) == pinned and d["selection"] == "control-v1" and d["s0"] == "whole-message-v1" and d["pinned"] is True))
if not ok:
    sys.exit(1)
print("true" if d["pinned"] else "false")
' 2>/dev/null)" || {
    echo "REFUSED sessions-policy unparseable answer from indexer.ts policy — nothing done" >&2
    exit 2
  }
  if [ "$mode" = "legacy-only" ] && [ "$pinned" = "true" ]; then
    echo "REFUSED sessions-policy pinned: $here is pinned to control-v1 ($out)." >&2
    echo "  This wrapper rebuilds with legacy selection. A pinned index is rebuilt as a" >&2
    echo "  candidate (candidate:sessions:plan/build), never in place." >&2
    echo "  (no gather, no API call, nothing removed)" >&2
    exit 2
  fi
  SESSIONS_POLICY_JSON="$out"
  echo "policy: $out"
}
