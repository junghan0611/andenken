---
name: andenken-embed
description: "andenken embedding-maintenance workbench — the fixed flow the repo steward runs every time: status → sync(sessions+md) → verify → compact → oracle push. Re-embed/incremental for session + garden(md) indexes, integrity checks, defrag (pinned to 4 cores), oracle replication. Triggers: 'reindex', 'sync sessions', 'sync md', 'compact', 'oracle push', 'verify index', '임베딩 다시 하자', '세션/가든 임베딩', 'andenken 인덱스 정리'."
user_invocable: true
---

# andenken-embed — embedding maintenance workbench

Fixes the index-maintenance loop the steward repeats, so the commands aren't
rediscovered each time (saves tokens) and any agent/pi can pick it up in this repo.

**Run everything from the repo root (`~/repos/gh/andenken`) via `./run.sh`.** run.sh
sources `~/.env.local` for provider/keys and enforces the provider/dim guards.

- Just need a **light, live session-only bump**? → use the `memory-sync` skill instead.
  This skill is the **full workbench**: sessions + md maintenance + compact + oracle replication.
- Search (search-sessions / search-md) is not here — that's `semantic-memory`.

## Two tracks, one discipline

| Track | provider | dim | index | incremental command |
|-------|----------|-----|-------|---------------------|
| **sessions** | OpenRouter `qwen/qwen3-embedding-8b` | 4096d | `data/sessions.lance` | `./run.sh sync:sessions [--push]` |
| **md (garden)** | same 8B | 4096d | `data/md.lance` | `./run.sh sync:md` + `./run.sh sync:md:oracle` |
| org | (768d mismatch) | — | `data/org.lance` | **production-disabled — do not touch** |

org is service-disabled by a dim mismatch (provider 768 vs DB 2560/config). Its
indexing/search paths are refused; it is not a maintenance target.

Cost: paid remote (OpenRouter, `$0.01/M tokens`). Small but **not zero**. An
incremental run over tens of sessions / hundreds of md files is ~$0.01. Full
rebuild is a separate gate (below).

## Normal flow (incremental re-embed)

```bash
cd ~/repos/gh/andenken

# 1. Current state — to-index size / last indexed / fragment count
./run.sh status

# 2. (optional) API-0 cost & size estimate. No calls made
./run.sh estimate:sessions      # sessions to embed
./run.sh estimate:md            # md to embed (payload-hash probe included)

# 3. Sessions incremental — dim 4096 preflight (1 call) → to_index=0 exits API-0
./run.sh sync:sessions

# 4. Garden (md) incremental
./run.sh sync:md

# 5. Integrity — dim / duplicate IDs / orphans / row consistency
./run.sh verify sessions
./run.sh verify md

# 6. (optional) Defrag — only when fragments grew a lot. Pinned to 4 cores (below)
./run.sh compact sessions
./run.sh compact md

# 7. (optional) Oracle replication — after GLG confirms. DB + manifest together (below)
./run.sh sync:sessions --push   # sessions.lance + session-manifest.json → oracle
./run.sh sync:md:oracle         # md.lance + md-manifest.json → oracle
```

Run long jobs (tens of sessions / hundreds of md) in the background and wait for
the completion signal. **No short polling sleeps** — re-calling the same sync is
a single-writer race.

### Whole flow at once (background recommended)

```bash
./run.sh sync:sessions && ./run.sh sync:md \
  && ./run.sh verify sessions && ./run.sh verify md
```

## Safety guards (already enforced by the scripts)

- **dim 4096 preflight**: each incremental confirms the provider dim with 1 call
  before embedding. On mismatch with the DB dim → **API-0 abort** — never embed at
  the wrong dim. That case needs a full rebuild (`scripts/rebuild-sessions-full.sh`) first.
- **to_index=0 → API-0 exit**: nothing to embed → no probe. With `--push`, it
  still rsyncs the local DB and manifest (for example after compact), also at
  zero API cost.
- **org isolation**: the sessions script never reads or writes `ANDENKEN_ORG_*`,
  `ANDENKEN_VLLM_*`, or `org.lance`.

## compact — always core-limited

`compact`/`cleanup` call LanceDB `table.optimize()`, whose Rust rayon/tokio pools
**pin all 16 cores to 100%**. run.sh binds CPU affinity with `taskset -c` — rayon/tokio
size their pools from `available_parallelism()` (sched_getaffinity), so capping the
core set to 4 caps the threads to 4.

```bash
./run.sh compact md                              # default: cores 0-3 (4)
ANDENKEN_COMPACT_CPUS=0-7 ./run.sh compact md    # override to 8 cores
```

- Default `0-3`. Override with `ANDENKEN_COMPACT_CPUS` in taskset `-c` syntax (`0-3`, `0,2,4,6`).
- compact **only when fragments grew a lot** — not every increment. md was once
  compacted 162 → 1 fragment. `verify` reports the fragment count.

## Oracle replication — DB and manifest travel together

thinkpad is the **source of truth**, oracle is a **query replica**. Rules:

- **§6.6 (INVARIANT.md)**: don't ship only the `.lance` DB. Sessions must rsync
  `session-manifest.json`, md must rsync `md-manifest.json` **alongside** — otherwise
  the replica is inconsistent. Both sync commands already carry the manifest.
- **§7.1**: oracle is not an indexing node. **Running the indexer on oracle diverges
  it from the source.** Replicate only.
- push is outward-facing — run **after GLG confirms**. Embed + verify must pass first.
- See `INVARIANT.md` §6.4–§6.6, §7–§7.1.

## Full rebuild — human gate (no agent automation)

Only when a whole rebuild (not incremental) is required:

```bash
./run.sh rebuild:sessions:dry   # estimate → confirm → preflight → (destroy) → rebuild
./run.sh rebuild:sessions       # actual destructive rebuild
```

- ₩100K-incident residual safety: **agents do not automate full-sync / cost gates /
  destructive rebuilds.** A human decides after reading the estimate.
- md full rebuild only after reviewing `ANDENKEN_ALLOW_PAID_FULL_REBUILD=1`.

## single-writer

- **One writer per track at a time.** `sync:sessions` takes a non-blocking flock
  (`data/.sync-sessions.lock`), so a second sessions sync — cron or manual — backs
  off cleanly ("already running") instead of racing. compact/cleanup and md are
  not yet lock-guarded, so still avoid running two of those on the same track at once.
- Check by hand with a self-match-safe pattern: `pgrep -af '[s]ync-sessions'`
  (a plain `pgrep -af sync-sessions` also matches its own command line).
- Don't re-launch a background sync out of impatience. Wait for the completion signal.

## Quick reference

| Want to | Command |
|---------|---------|
| Current state | `./run.sh status` (`status:json` for machines) |
| Sessions incremental | `./run.sh sync:sessions` |
| Garden incremental | `./run.sh sync:md` |
| Verify | `./run.sh verify sessions\|md\|all` |
| Defrag (4 cores) | `./run.sh compact sessions\|md` |
| dedup+orphan+manifest repair | `./run.sh cleanup sessions\|md` (includes compact, pinned) |
| Operator triage | `./run.sh doctor --sessions\|--md [--json]` |
| Oracle replicate | `./run.sh sync:sessions --push` / `./run.sh sync:md:oracle` |
| Cost estimate (API-0) | `./run.sh estimate:sessions\|md [--full]` |

SSOT is `run.sh` + `scripts/` + `INVARIANT.md`. This skill is a signpost for that
flow — if behavior and docs disagree, run.sh/INVARIANT.md win.
