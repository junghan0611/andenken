---
name: andenken-embed
description: "andenken embedding-maintenance workbench — routes GLG's four explicit asks to one command each: 1) 노트북 세션 증분 2) 글로벌 세션 동기화(오라클까지) 3) 가든(md) 임베딩 4) OpenClaw 회수. Also: multi-device session corpus (gather/manifest/replicate), integrity checks, defrag (pinned to 4 cores), full-rebuild human gate. Nothing here runs on a timer — GLG asks each time, so the routing table at the top is the contract. Triggers: '세션 임베딩', '기억 최신화', '글로벌', '오라클까지', '오라클 동기화', '가든 임베딩', 'openclaw 가져와', 'openclaw 회수', 'reindex', 'sync sessions', 'sync md', 'sync openclaw', 'compact', 'verify index', 'gather corpus', 'corpus manifest', '통합 세션 임베딩', '임베딩 다시 하자', 'andenken 인덱스 정리'."
user_invocable: true
---

# andenken-embed — embedding maintenance workbench

Fixes the index-maintenance loop the steward repeats, so the commands aren't
rediscovered each time (saves tokens) and any agent/pi can pick it up in this repo.

**Run everything from the repo root (`~/repos/gh/andenken`) via `./run.sh`.** run.sh
sources `~/.env.local` for provider/keys and enforces the provider/dim guards.

- Search (search-sessions / search-md) is not here — that's `semantic-memory`.
- Nothing here runs on a timer. **GLG asks each time** (ruling 2026-09-03), so the
  only thing standing between an ask and the right command is the table below.

## Route the ask — four tiers, one command each

GLG separated the work into four explicit asks. Match what was said to a row; do
not compose your own sequence.

| GLG says | tier | command | ssh | replica gets |
|---|---|---|---|---|
| "세션 임베딩", "기억 최신화" | 1 | `./run.sh sync:sessions` | 0 | nothing |
| "글로벌", "오라클까지", "양쪽 맞춰줘" | 2 | `./run.sh sync:sessions --global` | yes | index + manifest + corpus |
| "가든 임베딩", "노트도" | 3 | `./run.sh sync:md` → `./run.sh verify md` → `./run.sh sync:md:oracle` | yes | md.lance + md-manifest |
| "openclaw 가져와", "회수" | 4 | `./run.sh sync:openclaw` | yes | — (로컬 전용) |

Reading the rows:

- **1 and 2 are the same script, different mode.** `memory-sync` (agent-config skill)
  is the same two tiers with a thinner surface; either entry point is correct.
  1 does not touch oracle *on purpose* — the bot's memory is as of the last tier 2.
- **"세션·가든 임베딩하고 오라클에 동기화해줘" = 2 + 3**, in that order. That combined
  ask is common enough to have its own block below.
- **Tier 4 is a harvest, not a sync** (GLG ruling): OpenClaw embeds its own sessions
  and owns that quality; we only fetch and make it searchable. Do not offer to tune
  its chunking or model. It costs **zero embedding API calls** — the vectors arrive
  already computed, because OpenClaw independently picked the same
  `qwen/qwen3-embedding-8b` at 4096d. Append-only: it never mirrors their deletes,
  because their index still holds chunks for transcripts they already removed.
- **Tier 4's axis is `search:openclaw`, and it is never a fallback.** Do not reach
  for it because sessions came back empty — that erases which axis answered. Every
  hit states its `agent` and whether it came from what the bot SAID (`sessions`) or
  KEPT (`memory`); those are different kinds of evidence. `openclaw.lance` is
  **local only — there is no push step** — and must never reach the md track,
  which is exported.
  That export line is the only line — do not filter this axis by subject.
- **Two databases, two owners, and the names invite confusing them.** OpenClaw's
  `openclaw-agent.sqlite` (on the openclaw host, one per bot) is theirs: their
  chunking, model, retention. The export opens it with `sqlite3 -readonly` and
  snapshots it; we never write to it and never compact it. `data/openclaw.lance`
  is **ours** — our schema, our ids, our FTS index — holding vectors they
  computed. So `./run.sh compact openclaw` IS our maintenance, and it is not in
  `compact all`: ask for it by name. Measured 2026-09-04: one 481-row import took
  it 1 → 4 fragments, and a compact returned 7 → 1 (96M → 82M). Nothing else
  maintains that file — it lives on the authority only, with no push step.
- **Tier 3's oracle half is not automatic.** md's source is the garden checkout, so
  after `sync:md:oracle` the replica may still need `git -C ~/repos/gh/notes pull`
  **on oracle**. Sessions carries its corpus itself inside `--global`; md does not.

## The usual ask — "세션·가든 임베딩하고 오라클에 동기화해줘"

That request is this, in order, from `~/repos/gh/andenken`. Run it and report;
you do not need the rest of this file to do it.

```bash
cd ~/repos/gh/andenken
./run.sh sync:sessions --global   # all devices → embed → verify → publish index+manifest+corpus
./run.sh sync:md                  # garden markdown
./run.sh verify md
./run.sh sync:md:oracle           # → oracle: md.lance + md-manifest.json
```

That used to be six lines. The sessions half collapsed into one on 2026-09-03
because the three steps that used to be separate — verify, push the index, ship
the corpus — are the ones an operator kept doing only two of. `--global` performs
them as a single act or not at all.

**`sync:sessions` has two modes and the default is the cheap one.**

| | what it does | ssh | replica |
|---|---|---|---|
| `sync:sessions` (= `--local`) | gather THIS device only, then embed | 0 | untouched |
| `sync:sessions --global` | gather every rostered device (strict), embed, verify, publish | yes | index + manifest + corpus |

`--local` is the frequent/automatic tier; it is what the `memory-sync` skill calls
with no argument. `--global` is the one you call when the answer has to be "both
machines agree." `--push` still works as a deprecated alias for `--global`.

Things that are easy to get wrong here:

- **`--local` does not update the replica, on purpose.** So the bot on oracle sees
  memory as of the last `--global`. That is the trade the two tiers buy; if oracle's
  recall feels a day behind, the fix is `--global`, not a rebuild.
- **Ship the sources too — the md track still needs this by hand.** sessions now
  carries its corpus automatically inside `--global`. md does not: its source is
  the garden checkout, caught up on oracle with `git -C ~/repos/gh/notes pull`.
  Measured twice on 2026-09-03, skipping either left exactly one orphan on the
  replica.
- **The request IS the confirmation.** Being asked to sync oracle authorizes the
  push; do not stop to ask again. (Destructive *rebuilds* are different — those
  keep their own human gate, below.)
- **`--global` re-runs the gather and publishes even when `to_index=0`.** That is
  the catch-up path, not a wasted run: the replica may be behind from earlier
  `--local` runs.
- **`--global` fails if a rostered active device is unreachable.** Deliberate:
  gather itself is lenient (a laptop off the network must keep indexing itself),
  but "global" is a claim that both sides agree, and a claim you could not check
  is not one you get to make. Use `--local` when a peer is down.
- **Long runs go in the background** and you wait for the completion signal.
  Never poll by re-running a sync — that is a single-writer race.

**If a sessions command refuses**, read the message: this machine is probably not
the index authority. That is the `thinkpad` rule below, working. Do not reach for
`ANDENKEN_ALLOW_REPLICA_INDEX=1`.

**If `verify` on oracle reports orphans but the same check is clean locally**,
that is not a false positive and not a bad push. `verify` calls
`fs.existsSync()` on every path in the DB, so an orphan means *the replica is
missing a source file the index legitimately covers* — its copy of the source is
behind, not the index. Same shape on both tracks, different source to catch up:

| track | source on the replica | catch it up with |
|---|---|---|
| sessions | the session corpus | `./run.sh corpus:replicate` (from the authority) |
| md | the garden checkout `~/repos/gh/notes` | `git -C ~/repos/gh/notes pull` **on oracle** |

Measured 2026-09-03: pushing md left one orphan on oracle,
`content/journal/20260831T000000.md` — oracle's garden checkout was at
`214cf972c` while thinkpad had `fd690e367`. **Shipping an index also means
shipping what it points at.**

Cost: an incremental over a few dozen sessions / a few hundred md files is about
$0.01. Everything below is the why, and the rarer operations.

## Where sessions come from — the device corpus

**Read this before any sessions command.** When `$ANDENKEN_SESSION_CORPUS` is set
(`~/repos/gh/session`, in `~/.env.local`), the sessions track indexes that corpus
— a lifetime folder holding **every device's** admitted transcripts — instead of
this machine's live store.

**That is a conditional, not a law.** `sync-sessions.sh` runs its Step 0 gather
only `if [ -n "${ANDENKEN_SESSION_CORPUS:-}" ]`; unset means it silently indexes
the live store alone, and nothing warns you.

Two things keep the normal path safe: `run.sh` sources `~/.env.local`, and
`sync-sessions.sh` independently falls back to reading that one variable out of
the same file when the env lacks it. Neither helps a caller that reaches the
indexer another way. A login captures env once, so a cron job, a daemon, or a
shell that started **before** the corpus line was added to `~/.env.local` never
sees it. If a sessions run surprises you, check that variable first.

**An empty value is not an opt-out here.** The script's fallback tests `-z`, so
`export ANDENKEN_SESSION_CORPUS=` reads as *unset*, falls back to the file, and
gathers anyway. The read side (`session-recap`) tests presence in the
environment instead, so the same empty string IS its live-only escape there.
Same variable, two readings, each right for its side — just never assume one
command's escape works on the other.

Why: GLG works on thinkpad *and* on oracle. Indexing only the local live store
meant oracle's agent searched its own memory and did not find its own work —
measured 2026-09-02 as **455 oracle-only sessions**, including 64 openclaw
workspace sessions that existed on no other machine.

Layout is `<corpus>/<device>/<the harness's own live path shape>` — the live path
with one device segment in front. **That shape is a contract**, not cosmetics:
`detectSource` keys off `/.claude/` in the path and `extractProjectName` off the
`projects`/`sessions` segment, so both pass unmodified and no lance schema
changed. Two rules hold it together:

- **Append-only.** The gather never passes `--delete`. A session deleted from a
  live store stays in the corpus — that is the point of a lifetime folder.
- **Real copies, never hardlinks.** A shared inode is not an independent
  artifact and cannot travel to another machine.

### Corpus commands

```bash
./run.sh corpus:gather [--dry-run]     # collect admitted sessions from every device
./run.sh corpus:manifest [update|verify|status]
./run.sh corpus:replicate [--to X]     # push the corpus to devices that can't be pulled
```

**You rarely call `corpus:gather` yourself.** Both `sync:sessions` and
`rebuild:sessions` run it as their own Step 0, and both **refuse to index** if it
fails — an index must never be built on a corpus of unknown freshness. A remote
device that is unreachable is a warning, not a failure, so a laptop off the
network still indexes its own sessions. Call it directly only to inspect
(`--dry-run`), or to gather without embedding. `SKIP_GATHER=1` opts out.

**`DEVICES.json` is the roster; `MANIFEST.json` is the inventory.** Keep them
apart — using the corpus's directory listing as the roster makes the gather try
to reach a retired machine forever. Roster fields: `state: active|retired`,
`transport: local|ssh|push`. A `push` device is announced as *"delivered by push
— not pulled from here"* rather than silently skipped, so silence never reads as
a forgotten device.

**`MANIFEST.sha256` verifies without andenken.** It is `sha256sum -c` compatible
on purpose: the corpus must be checkable on a machine that has no repo checkout.
Full hash of ~2,160 files is ~3.5s; steady-state update 0.07s.

> Replaced git deliberately. One commit of the corpus cost an 806MB pack and a
> 47m47s gitleaks scan, and append-only data has no diff worth reading. The only
> question that needs answering is "what do I have and is it still intact".

### Direction of travel — who builds, who receives

`INVARIANT.md` §7.1: **the canonical host builds the index; oracle is a query
replica and must not run the indexer.** Oracle-native sessions become searchable
by reaching the canonical host **as source files** (that is exactly what
`corpus:gather` does), never as replica-side embeddings. Oracle drifted once this
way (2026-06-19→07-06, 27,966 chunks against the canonical 24,882).

```
thinkpad:  corpus:gather (own + pull oracle)  →  embed  →  push index
oracle  :  receives index by rsync            →  query only
```

ssh runs `thinkpad → oracle` only, and pull symmetry is pointless anyway — a
closed laptop cannot be pulled from. So the corpus travels by push
(`corpus:replicate`) and the index travels by push — both inside `sync:sessions --global`.

`sync:sessions` refuses **entirely** — not just the publish half — unless
`$ANDENKEN_INDEX_AUTHORITY` (default `thinkpad`) matches `~/.current-device`.
Two different disasters, one gate:

- **push from a replica** rsyncs `--delete` into the canonical index path and
  overwrites it with an older copy.
- **indexing on a replica** forks the corpus: the replica gets canonical rows
  *plus* rows it invented, which no later push can reconcile (§7.1's
  2026-06-19→07-06 drift, 27,966 chunks against the canonical 24,882).

Guarding only push leaves the second one open, and the friendly entry points —
the `memory-sync` skill, "기억 최신화" — are exactly what a sibling on the replica
reaches for.

**The gate sits after Step 0, so a refused call has already gathered.** That is
the half a replica should do: its sessions are in the corpus and reach the index
as **source files** on the authority's next run, coming back inside the pushed
index. Refused does not mean nothing happened, and it does not mean this machine
falls behind — which is also why `ANDENKEN_ALLOW_REPLICA_INDEX=1` is not the way
to "catch up". It forks the corpus; catching up is the authority's next run.

```
ANDENKEN_INDEX_AUTHORITY=<device>   # move the authority deliberately
ANDENKEN_ALLOW_REPLICA_INDEX=1      # override once — this forks the corpus
```

### While a rebuild is baking

- **Do not run `corpus:replicate` or `sync:sessions` from another shell.** There
  is no corpus lock yet; rsync is atomic per file, never across 2,160 of them, so
  the input snapshot is held by operating discipline alone.
- **Treat search on the replica as maintenance.** A full rebuild destroys the
  active `data/sessions.lance` and refills the same path, so the intermediate
  state looks like a healthy DB while being half of one.
- **Never run the whole script "just to check" a guard.** `status:json` performs
  full corpus discovery and takes 10+ minutes. Read the guard, or test it in
  isolation.

## Two tracks, one discipline

| Track | provider | dim | index | incremental command |
|-------|----------|-----|-------|---------------------|
| **sessions** | OpenRouter `qwen/qwen3-embedding-8b` | 4096d | `data/sessions.lance` | `./run.sh sync:sessions [--local|--global]` |
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
#    (`status:json` does full corpus discovery — 10+ min. Don't reach for it casually.)
./run.sh status

# 2. (optional) API-0 cost & size estimate. No calls made
./run.sh estimate:sessions      # sessions to embed
./run.sh estimate:md            # md to embed (payload-hash probe included)

# 3. Sessions incremental — dim 4096 preflight (1 call) → to_index=0 exits API-0
#    THIS DEVICE ONLY (tier 1). If the ask includes oracle, skip this line and run
#    step 7's --global instead — it does the gather, the embed AND the verify.
#    Running both just embeds twice.
./run.sh sync:sessions

# 4. Garden (md) incremental
./run.sh sync:md

# 5. Integrity — dim / duplicate IDs / orphans / row consistency
./run.sh verify sessions
./run.sh verify md

# 6. (optional) Defrag — only when fragments grew a lot. Pinned to 4 cores (below)
./run.sh compact sessions
./run.sh compact md

# 7. Oracle replication. Being asked to sync oracle is the confirmation.
#    sessions: --global gathers, embeds, VERIFIES, then ships index + manifest +
#    corpus as one act — so steps 3/5 above are already inside it for that track.
./run.sh sync:sessions --global # index + manifest + corpus → oracle
./run.sh sync:md:oracle         # md.lance + md-manifest.json → oracle
```

Run long jobs (tens of sessions / hundreds of md) in the background and wait for
the completion signal. **No short polling sleeps** — re-calling the same sync is
a single-writer race.

### Whole flow at once (background recommended)

Local only (tier 1 + 3, no oracle):

```bash
./run.sh sync:sessions && ./run.sh sync:md \
  && ./run.sh verify sessions && ./run.sh verify md
```

Including oracle (tier 2 + 3) — this is "세션·가든 임베딩하고 오라클에 동기화해줘":

```bash
./run.sh sync:sessions --global \
  && ./run.sh sync:md && ./run.sh verify md && ./run.sh sync:md:oracle
```

`--global` already gathered, embedded, verified and shipped the sessions side, so
there is no separate `verify sessions` or `corpus:replicate` line. **If oracle's md
verify then reports an orphan, it is the garden checkout, not the index** —
`git -C ~/repos/gh/notes pull` on oracle.

## Safety guards (already enforced by the scripts)

- **dim 4096 preflight**: each incremental confirms the provider dim with 1 call
  before embedding. On mismatch with the DB dim → **API-0 abort** — never embed at
  the wrong dim. That case needs a full rebuild (`scripts/rebuild-sessions-full.sh`) first.
- **to_index=0 → API-0 exit**: nothing to embed → no probe. With `--global` it
  still publishes — DB, manifest and corpus — at zero API cost. That is the
  catch-up path: the replica can be behind from earlier `--local` runs even when
  there is nothing new to embed (also true after a compact).
- **org isolation**: the sessions script never reads or writes `ANDENKEN_ORG_*`,
  `ANDENKEN_VLLM_*`, or `org.lance`.

## compact — always core-limited

`compact`/`cleanup` call LanceDB `table.optimize()`, whose Rust rayon/tokio pools
**pin all 16 cores to 100%**. run.sh binds CPU affinity with `taskset -c` — rayon/tokio
size their pools from `available_parallelism()` (sched_getaffinity), so capping the
core set to 4 caps the threads to 4.

```bash
./run.sh compact md                              # default: cores 0-3 (4)
./run.sh compact openclaw                        # our harvest DB; not in `all`
ANDENKEN_COMPACT_CPUS=0-7 ./run.sh compact md    # override to 8 cores
```

- Default `0-3`. Override with `ANDENKEN_COMPACT_CPUS` in taskset `-c` syntax (`0-3`, `0,2,4,6`).
- compact **only when fragments grew a lot** — not every increment. md was once
  compacted 162 → 1 fragment. `verify` reports the fragment count; for openclaw,
  `./run.sh status` does (it has no manifest).
- `compact all` is sessions+md+org. **openclaw is asked for by name** — the
  harvest runs on explicit call, so its defrag does too.

## Oracle replication — DB and manifest travel together

thinkpad is the **canonical host**, oracle is a **query replica** (see the
corpus section above for why, and for the authority guard, which refuses the
whole sessions command — not just its publish half). Rules:

- **§6.6 (INVARIANT.md)**: don't ship only the `.lance` DB. Sessions must rsync
  `session-manifest.json`, md must rsync `md-manifest.json` **alongside** — otherwise
  the replica is inconsistent. Both sync commands already carry the manifest.
- **§7.1**: oracle is not an indexing node. **Running the indexer on oracle diverges
  it from the source.** Replicate only.
- push is outward-facing, so it needs an operator asking for it — but the ask
  itself is the confirmation; do not re-confirm a request you were just given.
  Embed + verify must pass first.
- See `INVARIANT.md` §6.4–§6.6, §7–§7.1.

## Full rebuild — human gate (no agent automation)

Only when a whole rebuild (not incremental) is required:

```bash
./run.sh rebuild:sessions:dry   # estimate → confirm → preflight → (destroy) → rebuild
./run.sh rebuild:sessions       # actual destructive rebuild
```

Step order is `gather → estimate → confirm → preflight → destroy → rebuild`, and
that order is load-bearing:

- **Step 0 gather runs before the estimate.** A rebuild is the one moment the
  whole corpus is read, so it must read the *whole* corpus — and a gather failure
  then lands *before* the destroy instead of after it. `--dry-run` skips the
  gather: a dry run must not mutate the corpus.
- **Step 3 is an interactive `yes` with no `--yes` flag, by design.** ₩100K-incident
  residual safety: **agents do not automate full-sync / cost gates / destructive
  rebuilds.** A human reads the estimate and decides.
- A writer lock is taken **before** the destroy, so a run that loses the race
  never gets far enough to remove anything.
- md full rebuild only after reviewing `ANDENKEN_ALLOW_PAID_FULL_REBUILD=1`.

Record before every bake, in one line: **MANIFEST digest · code HEAD ·
provider/model/dim**. Without it a finished index cannot be tied to the input it
was made from. A rule with no command is a rule that gets skipped, so:

```bash
set -a; . ~/.env.local; set +a          # a bare shell may not have the corpus var
echo "$(TZ=Asia/Seoul date +%Y%m%dT%H%M%S) | HEAD $(git rev-parse --short HEAD)" \
     "| $(cat ~/.current-device)" \
     "| manifest $(sha256sum "$ANDENKEN_SESSION_CORPUS/MANIFEST.sha256" | cut -c1-16)" \
     "| $(./run.sh env | grep -m1 'MODEL:' | tr -s ' ')"
# → 20260903T010745 | HEAD ee441ac | thinkpad | manifest 6c30e28aa250bb8e | MODEL: qwen/qwen3-embedding-8b
```

The dim is not in that line because it is not yours to assert — Step 4 probes it
and prints `✅ preflight dim=4096`. Copy what the probe said.

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
| Current state | `./run.sh status` — `status:json` is machine-readable but does **full corpus discovery (10+ min)**; do not reach for it casually |
| Sessions incremental | `./run.sh sync:sessions` |
| Garden incremental | `./run.sh sync:md` |
| Verify | `./run.sh verify sessions\|md\|all` |
| Defrag (4 cores) | `./run.sh compact sessions\|md\|openclaw` |
| dedup+orphan+manifest repair | `./run.sh cleanup sessions\|md` (includes compact, pinned) |
| Operator triage | `./run.sh doctor --sessions\|--md [--json]` |
| Sessions, this device only | `./run.sh sync:sessions` (= `--local`, ssh 0, replica untouched) |
| Sessions, all devices + publish | `./run.sh sync:sessions --global` (gather strict → embed → verify → index+manifest+corpus) |
| Oracle replicate (md) | `./run.sh sync:md:oracle` |
| Cost estimate (API-0) | `./run.sh estimate:sessions\|md [--full]` |
| Gather all devices' sessions | `./run.sh corpus:gather [--dry-run] [--strict]` |
| Corpus inventory / integrity | `./run.sh corpus:manifest update\|verify\|status` |
| Push corpus to a push-only device | `./run.sh corpus:replicate [--to X]` |

SSOT is `run.sh` + `scripts/` + `INVARIANT.md`. This skill is a signpost for that
flow — if behavior and docs disagree, run.sh/INVARIANT.md win.
