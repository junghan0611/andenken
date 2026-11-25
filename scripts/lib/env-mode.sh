# shellcheck shell=bash
# env-mode.sh — ANDENKEN_ENV_MODE for shell entries.
#
#   unset / empty   default: entries may read ~/.env.local as before
#   process-only    ~/.env.local is never sourced, read or parsed; every
#                   setting must already be in the process environment
#   anything else   refused (exit 2) — a typo must not silently fall back to
#                   reading the dotenv
#
# The TypeScript side (embedding-provider.ts envMode / readEnvWithFileFallback,
# index.ts loadEnvLocal) reads the same variable with the same three answers.
#
#   . scripts/lib/env-mode.sh
#   if andenken_env_process_only; then ...skip the dotenv...; fi

andenken_env_process_only() {
  case "${ANDENKEN_ENV_MODE:-}" in
    "") return 1 ;;
    process-only) return 0 ;;
    *)
      echo "❌ ANDENKEN_ENV_MODE='${ANDENKEN_ENV_MODE}' is not a known mode (only: process-only); nothing was read" >&2
      exit 2
      ;;
  esac
}
