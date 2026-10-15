# shellcheck shell=bash
# sessions-lock.sh — the sessions.lance writer lock for shell wrappers.
#
# Same lock as sessions-lock.ts: <data dir>/.sessions-write.lock/owner with
# pid= token= command= startedAt= host=. Non-blocking; a held lock exits 75
# with `sessions-writer-busy` (owner alive) or `sessions-writer-stale-lock`
# (owner gone) and is never reclaimed automatically. The holder exports
# ANDENKEN_SESSIONS_LOCK_TOKEN for ITS OWN children, which re-enter only while
# this wrapper (the owner pid) is alive. Release removes the lock only when it
# still carries this wrapper's token.
#
#   . scripts/lib/sessions-lock.sh
#   sessions_lock_acquire "sync-sessions --local"   # exits 75 when held
#   ... writers ...                                  # released on EXIT

sessions_lock_dir() {
  printf '%s/.sessions-write.lock' "${ANDENKEN_DATA:-$HOME/repos/gh/andenken/data}"
}

_sessions_lock_field() {
  sed -n "s/^$2=//p" "$1/owner" 2>/dev/null | head -1
}

_sessions_lock_refuse() {
  local dir="$1" pid cmd since
  pid="$(_sessions_lock_field "$dir" pid)"
  cmd="$(_sessions_lock_field "$dir" command)"
  since="$(_sessions_lock_field "$dir" startedAt)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "REFUSED sessions-writer-busy: ${cmd:-?} (pid $pid, since ${since:-?}) holds $dir" >&2
  elif [ -n "$pid" ]; then
    echo "REFUSED sessions-writer-stale-lock: $dir names pid $pid (${cmd:-?}), which is gone — remove it after checking no writer runs" >&2
  else
    echo "REFUSED sessions-writer-stale-lock: $dir has no readable owner — remove it after checking no writer runs" >&2
  fi
  exit 75
}

sessions_lock_release() {
  local dir gone
  [ "${SESSIONS_LOCK_OWNED:-0}" = "1" ] || return 0
  dir="$(sessions_lock_dir)"
  [ "$(_sessions_lock_field "$dir" token)" = "${SESSIONS_LOCK_OWN_TOKEN:-}" ] || return 0
  gone="$dir.rm.$$.$SESSIONS_LOCK_OWN_TOKEN"
  mv -T "$dir" "$gone" 2>/dev/null && rm -rf "$gone"
  SESSIONS_LOCK_OWNED=0
}

sessions_lock_acquire() {
  local cmd="$1" dir tmp token pid
  dir="$(sessions_lock_dir)"
  if [ -n "${ANDENKEN_SESSIONS_LOCK_TOKEN:-}" ] && [ -d "$dir" ]; then
    token="$(_sessions_lock_field "$dir" token)"
    pid="$(_sessions_lock_field "$dir" pid)"
    if [ "$token" = "$ANDENKEN_SESSIONS_LOCK_TOKEN" ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      SESSIONS_LOCK_OWNED=0   # re-entered: the parent wrapper releases
      return 0
    fi
  fi
  [ -e "$dir" ] && _sessions_lock_refuse "$dir"
  mkdir -p "$(dirname "$dir")"
  tmp="$(mktemp -d "$dir.tmp.XXXXXX")"
  token="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'pid=%s\ntoken=%s\ncommand=%s\nstartedAt=%s\nhost=%s\n' \
    "$$" "$token" "$cmd" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" > "$tmp/owner"
  if ! mv -T "$tmp" "$dir" 2>/dev/null || [ "$(_sessions_lock_field "$dir" token)" != "$token" ]; then
    rm -rf "$tmp"
    _sessions_lock_refuse "$dir"
  fi
  SESSIONS_LOCK_OWNED=1
  SESSIONS_LOCK_OWN_TOKEN="$token"
  export ANDENKEN_SESSIONS_LOCK_TOKEN="$token"
  trap sessions_lock_release EXIT
}
