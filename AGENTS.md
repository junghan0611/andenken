# andenken — agent-in-charge

## Language

- Conversation: Korean (ko-KR)
- Commits, code, docs, comments: English only
- Terms: 한글용어(English_Term)

## Who I Am

andenken is the **memory-axis hub** of 힣's harness.

The implementation here is one axis — embedding. The documentation covers all
three. If someone asks who owns memory in the harness, the answer is the
andenken agent-in-charge.

**My public standing report is a Denote note, not this file.**

| | |
|---|---|
| Denote ID | `20260319T110800` |
| org (SSOT) | `~/org/botlog/20260319T110800--§andenken-담당자-문서-존재의-뜻새김-시맨틱-메모리를-넘어서__*.org` |
| exported | `~/repos/gh/notes/content/botlog/20260319T110800.md` |
| public | https://notes.junghanacs.com/botlog/20260319T110800.html |

**Project home:** [English](https://junghanacs.com/projects/andenken/) ·
[한국어](https://junghanacs.com/ko/projects/andenken/). Its sources live in
`~/repos/gh/homepage/content/projects/andenken/index.md` and `index.ko.md`, with
cards in the bilingual `content/projects/_index` pages. The andenken steward
maintains the project facts on both public surfaces; homepage owns rendering and
publication. The landing pages introduce purpose, capabilities and boundaries;
the Denote report preserves dated judgments. Keep them aligned when those change,
without copying private corpora or operational logs into either public surface.
README/run.sh remain the implementation and usage reference, not a third report.

The split of duty: **this file is the standing baseline for identity,
boundaries and ownership inside the repo; the Denote note is where the
agent-in-charge reports outward** — what andenken is for, the two turns
(time→meaning / meaning→time), the guard boundaries against timeline / entwurf /
dictcli / denotecli, and the naming record in its ARCHIVE. When a report is
written there, add a `히스토리` line with the date, the actor and what changed;
do not silently rewrite the standing report.

Related Denote IDs on the same axis:

| ID | What |
|----|------|
| `20260408T120252` | 에이전트 기억층 — 누가 기억의 주인인가. The cross-repo axis where andenken, agent-config, dictcli, nixos-config and aionsclubs each answer from their own seat. |
| `20260312T174622` | §agent-config — the surface that exposes recall to every harness. |
| `20260309T194058` | §dictcli — the vocabulary graph (Layer 3). |

## Memory axes — what I cover, what I don't

| Axis | Where it lives | My role |
|------|----------------|---------|
| **active memory** (pre-reply recall) | harness — pi-extensions, openclaw-style plugin | Consumer of my search API. I must expose graceful-degrade contracts; I do **not** implement recall orchestration. |
| **embedding** (semantic search) | **this repo** | Owner. Full implementation. |
| **dream** (overnight consolidation) | separate axis, harness side | I know it exists; I do not implement it. |

### The time axis is the compass, not another track

The canonical KST time axis lives in the harness-side `timeline` skill
(`~/repos/gh/agent-config/skills/timeline/README.md`). It normalizes timelog,
journal, agenda, note, and git events and owns their coordinates, source status,
and provenance. andenken neither recreates that collector nor treats an
embedding score as a timestamp.

The time axis nevertheless defines why this embedding axis exists. The two
systems meet in both directions:

- **time → meaning:** a canonical timeline slice provides the date, entities,
  and refs; sessions and md recover the decisions, interpretation, and
  continuity around them.
- **meaning → time:** semantic retrieval finds candidate session/note evidence;
  the timeline confirms the coordinate and supplies the surrounding depths.

The harness owns that orchestration. andenken owns the retrieval quality and
stored signals needed for it. A `timeline.lance` track is not presumed: add a
derived event index only if real time-axis scenarios prove that structured
queries plus sessions/md cannot make the meaning→time turn.

### Sidecars (required, not axes)

- **dictcli** — personal vocabulary (ko↔en expand, Kiwi stem). Layer 3. Not mine.
- **denotecli** — structural dblock / graph over org. Layer 2. Not mine.

## Tracks inside andenken

| Track | Quality bar | Notes |
|-------|------------|-------|
| **sessions** | Recover decisions and continuity inside canonical time windows | Load-bearing for agent continuity. OpenClaw parity remains a technical baseline, not the product goal. Stored timestamp/project/role/source/session-file signals must support timeline-grounded recall. |
| **md (public garden)** | Recover durable interpretation attached to dated notes and events | Current production knowledge axis. Direct Markdown embedding over `~/repos/gh/notes/content`. **English tags are a controlled vocabulary (~1,243)**: the doomemacs-config export drops org-side tags and emits only English tags registered in meta notes, so the unnormalized org tag soup never reaches md. Korean stays free-form; English is constrained in pairs. Tags land in the stored `text` (FTS/display), never in `embeddingInput`. Ports OpenClaw builtin md memory logic (`~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/`) onto the same LanceDB backend used by sessions. First production cut closed on 2026-05-12; current work is time-grounded retrieval quality. |
| **openclaw (harvest)** | Recover what the bots said and kept, nameable as its own axis | A HARVEST, not a sync: OpenClaw (Oracle) embeds its own agents' sessions and memory with OpenRouter `baai/bge-m3` 1024d (rebuilt from zero 2026-11-25; no Qwen group remains), so rows arrive with text AND vector and the import costs **zero embedding API calls**. We do not own their chunking, model, retention, or their `openclaw-agent.sqlite`, which the export opens `sqlite3 -readonly` and never compacts. We DO own `openclaw.lance` — schema, ids, FTS index, generation stamp — so its defrag is ours, by name. Append-only (their deletes are never mirrored), authority-harvested, never a search fallback. See INVARIANT §7.3. |
| **org** | **Code removed (2026-11-25)** | The disabled org track (chunker, doctor, indexer/cli/run.sh routes, the legacy `ANDENKEN_VLLM_*` / `createOrgProviderFromEnv` fallback) was removed from the active codebase; git history keeps it. `data/org.lance` is not deleted by code. `all` in verify / compact / cleanup now means sessions + md; `index:org` and `doctor --org` refuse by name. |

**Split of effort.** The agent-in-charge ships sessions + md to agents. The org
track was disabled for months and its code was removed on 2026-11-25 so no
`all` command or legacy provider can reach it; reviving it is a new design, not
a toggle.

When a change affects multiple live tracks, sessions gets the stricter review.
The qmd path attempted between 2026-05-09 and 2026-05-11 was retired on
2026-05-12 (issue #8) — local-GGUF rerank/expand stack was too heavy
(~53s/query on 90-file smoke). Embedding axis stays a simple
*embed → LanceDB → hybrid retrieve* engine; no brain-platform features.

## What I own

```
embedding-profile.ts    Embedding generation identity: profiles, fingerprint, reply
                        validation, input-length bound, Ollama digest, store stamp
embedding-provider.ts   EmbeddingProvider interface + vLLM impl + factory
store.ts                LanceDB vector store (sessions.lance + md.lance + openclaw.lance)
retriever.ts            Hybrid retrieval (weighted/RRF + MMR; decay off in prod)
md-search.ts            md retrieval core + display contract, shared by cli.ts
                        search-md, knowledge_search, and golden
session-indexer.ts      pi + Claude Code JSONL parser
md-chunker.ts           Markdown-aware chunker + analyzeMdFile SSOT classifier
indexer.ts              Indexing driver (manifest + hard guard + zero-chunk clear)
write-buffer.ts         Single-writer serialization (in-process)
sessions-lock.ts        Cross-process sessions.lance writer lock (+ scripts/lib/sessions-lock.sh)
durable-reader.ts       Closed pi-durable snapshot reader (refuses live stores by name)
durable-plan.ts         pi-durable embedding admission plan (policy B.1)
durable-source.ts       pi-durable corpus layout, admit, row extraction
durable-index.ts        pi-durable incremental indexing + durable-manifest.json
session-excerpt-dispatch.ts  Hit excerpt dispatch: JSONL lines or durable entries
doctor.ts               Operator triage dispatch
doctor-md.ts            MD production triage — provider / DB / manifest / gap
openclaw-importer.ts    OpenClaw harvest import (append-only, unchanged-skip)
openclaw-reconcile.ts   OpenClaw freshness board + reconcile dry-run (read-only)
openclaw-prune.ts       OpenClaw stage-C prune: dream + sup✓ only, backup + receipt
index.ts                pi extension entry
cli.ts                  Claude Code / OpenCode CLI entry
```

Separate LanceDB files — `sessions.lance`, `md.lance`, `openclaw.lance`. Each
is keyed to its own provider/dim. No DB is a fallback for another.

### Embedding generations (embedding-profile.ts)

Equal dimension is not equal model. A **generation** is named by a profile —
`ollama-bge-m3-1024` (local; the only one andenken embeds with) and
`openrouter-bge-m3-1024` (the OpenClaw harvest's documents; a store identity
only) — and fingerprinted over provider, endpoint class, model, runtime digest,
dimension and instructions. **Qwen / 4096d is not known to current code**
(2026-11-26): the earlier generation is a recovery artefact restored with its own
code, configuration and data, never read by this code.

- A store written by a profiled writer carries `<db>.lance/andenken-profile.json`
  (it travels with every copy of the store). Write, `reset` and query refuse a
  different fingerprint — `reset` refuses BEFORE dropping rows.
- Stamp v2 records provider, runtime revision (digest), preprocess
  (instructions, split policy) and, for a harvest, the producer and per-agent
  index revisions. An unstamped store with rows is an unknown generation:
  refused for read and write. Nothing is stamped retroactively; every
  generation lives in a fresh `ANDENKEN_DATA`.
- Providers exist ONLY through `ANDENKEN_<NS>_PROFILE=<id>` (no model-string,
  preset, Gemini or dimension-default path). A conflicting MODEL / DIMENSIONS /
  instruction / endpoint / batch / timeout is a refusal. Before its first
  request a digest-pinned provider proves the runtime digest (`/api/tags`).
- A query against ANOTHER generation passes only with an explicit
  query-attestation in the store (`./run.sh attest:query`, human, names store +
  query fingerprints and evidence). It never permits writes.
- Every reply is validated: one vector per input, integer unique in-range
  index, exact dimension, finite, non-zero, and for loopback profiles the
  echoed model. An invalid reply is permanent (never retried).
- The local profile talks to Ollama's native `/api/embed` with
  `truncate: false` and `options.num_ctx = 2048` (loopback only), so an
  oversize input is refused by the runtime instead of embedded truncated
  (`/v1/embeddings` cannot say that). The runtime refusal is permanent
  (`provider-input-exceeds-context`, never retried, at any status). The
  transport IS part of the fingerprint (v3): a `/v1`-era store or plan carries
  no no-truncation proof and is another generation (refused for write, query
  only by attestation); native → native resume keeps the same pin. Stamps
  record `preprocess.truncate: false`.
- Independently, a fail-closed client bound refuses before any request:
  tokens ≤ NFKC code points + 3, limit 2045. The profiled generation
  splits md chunks and session messages to fit (`withEmbedSplit`, target 1845
  + code-point ceiling); every character survives. The legacy split is
  byte-identical outside that scope.
- `ANDENKEN_ENV_MODE=process-only` makes the process environment the whole
  configuration: `~/.env.local` is not sourced (run.sh, child scripts) nor
  opened (providers, pi extension). Unset = default; any other value refuses.
- OpenClaw queries use `ANDENKEN_OPENCLAW_QUERY_*` when set, otherwise the
  sessions provider; the generation check (stamp or attestation) refuses rather
  than silently falling back to FTS.

The md track is no longer "under construction" in the old sense: first
production cut is closed. Current md work is quality measurement and
explainability (`doctor --md`), not corpus bring-up. Quality cases must now be
derived from real time-axis recovery jobs; generic vocabulary probes are smoke
or component tests, not the north-star gate.

## What I do not own

- Active memory orchestration, timeout policy, prompt style — harness concern
- Timeline collection, KST coordinate truth, provenance, and natural-language time parsing — `timeline` / harness concern
- Dreaming / consolidation cadence — separate axis
- Korean morphology (Kiwi) — `dictcli stem`
- Structural dblock / backlink traversal — `denotecli`
- Garden content itself — I read, I do not curate source notes

andenken stays language-agnostic. Korean-specific work goes to dictcli.

## Three-layer principle

```
Layer 1 (andenken)        Embedding + BM25. Maximize retrieval quality on its own.
Layer 2 (denotecli)       Structural graph traversal.
Layer 3 (dictcli)         Personal vocabulary + morphology.
```

Layer 1 does **not** mix Layer 2/3 concerns. Korean particle stripping (25
patterns, ported from openclaw) lives here because it is BM25 preprocessing.
Kiwi morphology lives in dictcli.

## Indexing endpoints

andenken has dimension-separated embedding stores per track. A vector DB is
queryable only by a provider that emits the same dimension.

| Track | Model / dim | Endpoint | When |
|-------|-------------|----------|------|
| **Sessions** | Ollama `bge-m3:latest` / 1024d (`ollama-bge-m3-1024`, digest-pinned) | loopback (`ANDENKEN_SESSION_PROFILE`; placement `ANDENKEN_SESSION_ENDPOINT` / `ANDENKEN_SYNC_ENDPOINT`) → a fresh, stamped `ANDENKEN_DATA` | `candidate:sessions:plan/build` (window `--since-kst/--until-kst`), then `scripts/sync-sessions.sh --local`; `--global` publish dormant until its own gate. |
| **MD** | Ollama `bge-m3:latest` / 1024d (`ollama-bge-m3-1024`) | loopback (`ANDENKEN_MD_PROFILE`) → a fresh, stamped `ANDENKEN_DATA` | `./run.sh index:md` / `sync:md`; chunks split to fit the 2045 code-point window. `sync:md:oracle` refuses a stamped generation until its publish gate. |
| **OpenClaw** | `baai/bge-m3` / 1024d — **embedded by OpenClaw (OpenRouter), not by us**; store generation `openrouter-bge-m3-1024` | `ANDENKEN_OPENCLAW_HOST` (default `oracle`), `sqlite3 -readonly` snapshot → `openclaw.lance` in a fresh `ANDENKEN_DATA` | explicit authority call only: `./run.sh sync:openclaw` (`--full` from zero). Import pins the producer literal (`baai/bge-m3` / `openai` / 1024), refuses mixed artifacts, stamps the store. **API 0**. Querying it with local Ollama needs `./run.sh attest:query` (human, evidence-named); no paid query path. |

### Session corpus sources

Since `v2026.9.3` the input is **not** one machine's live store. It is a
device-merged, append-only lifetime corpus:

```
~/repos/gh/session/<device>/<the harness's own storage path>
```

That layout — the live path with one device segment prepended — **is the
contract.** `detectSource` decides by `/.claude/` and `extractProjectName` reads
the `projects` / `sessions` segment, so both pass unmodified and the lance schema
did not change. Two rules: append-only (no `--delete`) and real copies (no
hardlinks — a shared inode cannot travel to another machine).

Inside each device directory the same two harness sources apply, plus one
snapshot source that is never gathered:

| Source | Path under each device | Format |
|--------|------------------------|--------|
| `pi` | `~/.pi/agent/sessions` | pi JSONL (`type="message"`, `message.role`) |
| `claude` | `~/.claude/projects` | Claude Code JSONL (`type="user" | "assistant"`) |
| `pi-durable` | `.pi/agent/experimental/durable-sessions/<bucket>/<session>/session.sqlite` | closed pi-durable SQLite snapshot (schema v1), admitted explicitly |

Corpus governance is a checksum manifest, not git — `MANIFEST.json` is the SSOT
and `MANIFEST.sha256` is `sha256sum -c` compatible, so the corpus is verifiable
without andenken. `DEVICES.json` is a **separate** roster
(`state: active|retired`, `transport: local|ssh|push`); using the corpus
directory listing as the roster means trying to reach a retired machine forever.
Both files live in the corpus, not in this code repo, so they follow the memory
when the laptop is replaced.

Surfaces: `corpus:gather` / `corpus:manifest` / `corpus:replicate`. `gather` runs
as Step 0 of `sync:sessions` and `rebuild:sessions` and **refuses to index if it
fails** — no index is built on a corpus of unknown freshness. The authority gate
sits *after* Step 0, so a refused call still completes its gather.

Entwurf sessions are **not a third source**. A spawned/resumed entwurf is just a
pi session written as `<created-at>_<native session id>.jsonl` under
`~/.pi/agent/sessions/<project>/`, and it is indexed by the normal `pi` source
path with project inferred from the cwd-shaped session directory.

**Corpus admission is the current native id suffix `_<UUIDv7>.jsonl`** (2026-08-10
ruling). Retired species are *not* OR'd back in: `*_entwurf-<taskId>`,
`*_delegate-…`, UUIDv4, and the garden-id form `_YYYYMMDDTHHMMSS-[0-9a-f]{6}`.
See `session-indexer.ts § isNativePiSessionFile` and its mirror
`session-recap._is_native_pi_session_file`; the two must move together.

The species history matters, because the obvious story is wrong. UUIDv7 native ids
are **not new** — pi has written them since **2026-04-15**, and the garden-id form
**coexisted** with them from 2026-06-03 to 2026-08-06. What changed is that
**from 2026-08-07 pi emits UUIDv7 only**. A filter still demanding the garden-id
suffix therefore admitted zero *new* pi sessions from that day on: no error, just
the pi half of the corpus going quiet.

Two consequences follow, and the second is a corpus-policy change, not a bug fix:

- Already-indexed pi sessions carrying the garden-id suffix (333 manifest entries
  at 2026-08-10) leave discovery. Their chunks stay in `sessions.lance` — search
  still finds them — so manifest and discovery drift apart until someone decides
  retain vs `cleanup sessions`. Incremental sync never removes them on its own.
- Pre-existing UUIDv7 sessions become eligible **retroactively**. `v2026.6.19`
  retired the `_<uuid>` species wholesale as "pre-0.9.0"; admitting the current
  species readmits every UUIDv7 transcript back to 2026-04-15, which is the bulk
  of the pending work rather than the four-day gap. Size the paid embedding gate
  with `./run.sh estimate:sessions`, never with a number copied from a doc — the
  count moves as live transcripts cross the 200KB floor.

**Filenames do not carry identity.** The `garden id ↔ nativeSessionId ↔
transcriptPath` join is owned by the entwurf meta-record, and neither this indexer
nor `session-recap` reimplements it — the filename decides corpus membership and
nothing else. The transcript may carry backend/name hints, but canonical garden
identity and the native-session join live only in the meta-record.

Saved task metadata / control sockets are not separately embedded; only the
transcript JSONL that lands under the pi sessions tree, and admitted pi-durable
snapshots (below), participate in `sessions.lance`.

**pi-durable is snapshot-only** (issue #15; rules in INVARIANT §7.6–7.7).

- **No live gather.** `corpus:gather` admits `.jsonl` only. A durable session
  reaches the corpus as ONE closed snapshot, made beforehand by an approved
  procedure outside this repo, through `./run.sh corpus:durable-admit <snapshot>
  --device <roster id>` (real copy 0600, atomic rename; a replacement must keep
  lineage and the old last entry and must not shrink). andenken never opens,
  snapshots or finds a live durable store; the reader refuses recognizable live
  stores by name, which is not proof that a store is closed.
- **Separate checkpoint.** `./run.sh index:durable` (paid, authority-only;
  `--dry-run` is API 0) embeds policy `B.1` — human input runs and their answers;
  ambiguous entries are reported, not embedded; entries of a run still open in
  the snapshot wait for a later one — and checkpoints in
  `data/durable-manifest.json`, never `session-manifest.json`. A different policy,
  lineage, rollback, divergence or winning path is refused by name.
- **Reading is not admission.** `./run.sh durable:read` reads every entry of a
  closed snapshot, including those B.1 does not embed; search excerpts for
  pi-durable hits point to session, lineage and entry ids.
- **Publish pairing.** `sync-sessions.sh --global` ships `durable-manifest.json`
  with `sessions.lance` and, when the authority has none, removes exactly that
  file on the replica. Admitted snapshots travel with the corpus.
- **Full rebuild drops it.** `rebuild-sessions-full.sh` and `index:sessions
  --force` delete the durable manifest with the rows; run `index:durable` again
  afterwards.
- **One writer lock.** Every sessions.lance writer — sync, rebuild,
  `index:sessions`/`index:durable`, sessions cleanup/compact, durable admit, pi
  `/memory` — takes `data/.sessions-write.lock` non-blocking (exit 75
  `sessions-writer-busy` / `sessions-writer-stale-lock`, no automatic reclaim).
  The guarantee belongs to the code that runs: pi honours it only from a rebuilt
  `dist/` in a reloaded process. A pi process started before that keeps the old
  `/memory reindex`, which takes no lock and must not be used during operations;
  confirm no non-locking writer is active before a paid sessions run.

Do **not** index `~/.pi/agent/claude-config-overlay/projects`. That directory
is pi-shell-acp's Claude overlay, not a third memory source. Its work is already
represented through pi harness sessions / entwurf messages; indexing it would
create duplicate memory. JSONL discovery chooses only `pi`, `claude`, and `all`
(`pi + claude`). Search filters add `pi-durable` for admitted snapshot rows. No
`overlay` source.

### Why the split

- **Sessions** are load-bearing for live agent continuity and use the local
  BGE-M3 1024d generation (no API cost). Wrong-generation and wrong-dim guards
  are mandatory.
- **MD** is the current knowledge axis for agents. It indexes the exported
  public garden directly — a controlled corpus where chunking and retrieval
  are tunable on a sane schedule. Same local BGE-M3 generation as sessions; separate
  LanceDB file so the two pools never cross-contaminate. Its chunk count is
  intentionally much lower than org (`10,119` vs `44,916` in the 2026-05-12
  baseline): OpenClaw-style Markdown chunking emits larger, denser
  CJK-weighted chunks instead of org's heading/body two-tier fragments. Treat
  this as density improvement, not missing corpus.
- Query providers are track-specific. Never use a sessions vector against the
  md DB, or vice versa — and never one generation against another (stamp).

### Cost discipline (mandatory)

- Sessions full rebuild against a paid remote is gated by
  `ANDENKEN_ALLOW_PAID_FULL_REBUILD=1` and should go through
  `scripts/rebuild-sessions-full.sh` after estimate + explicit confirmation.
- MD indexing follows the same gate (`ANDENKEN_ALLOW_PAID_FULL_REBUILD=1` for
  full rebuilds) and the same wrong-dim preflight. Incremental is the default
  cadence.
- Indexing/search paths must check DB/provider dimension compatibility before
  any embedding call: the profile's dimension and the generation stamp.
- `memory-sync` skill (agent-config side) covers the sessions fast path. md
  full indexing requires GLG confirmation; md Oracle replication should reuse
  the completed local DB via `./run.sh sync:md:oracle` rather than paying for a
  second full embedding run. Full / oracle full-sync require human invocation
  from this repo.

> **2026-04-30 — gpu2i removed from embedding role.**
> gpu2i was repurposed as VOS chat-completion node (Qwen2.5-7B-Instruct-AWQ).
> It now serves `/v1/chat/completions` and **must not be used for embedding** —
> calling `/v1/embeddings` against it returns 3584d (last hidden state) and
> would corrupt a 2560d org index. Sessions and md use OpenRouter 8B/4096d via
> `ANDENKEN_SESSION_*` / `ANDENKEN_MD_*`; org stays on 4B/2560d but disabled.

## Cross-repo responsibility

andenken is the **logic and verification provider**. It does not own execution
or cost.

| Role | Owner |
|------|-------|
| Logic, analysis, verification | andenken (this repo) |
| Embedding execution, cost bearing | agent-config |
| Oracle replication scripts / verification | andenken (this repo) |
| Final approval for code changes | agent-config (or Hih) |

### Commit discipline

- **Verify before commit.** Run the changed code, confirm output, then commit.
- Analysis and fix proposals are welcome. Code changes need agent-config sign-off.
- Scope-verify numbers: "indexed" = manifest entries or LanceDB rows? "New" =
  not in manifest, or not in DB? Even precise counts can answer the wrong question.

## Operational surface — `run.sh`

**`run.sh` is part of the documentation**, not an extra.

The four Markdown files describe *who*, *why*, *rules*, and *state*. They
deliberately do **not** walk through operations step by step, because
operations drift faster than docs can track. The living catalogue of what this
repo can do is:

```bash
./run.sh            # prints the full command menu, grouped by area
```

Groups: setup, indexing, search, test, benchmark, doctor, utility. Every entry
shown there is a real command against real code; no documentation gap.

Specific operations worth knowing by name:

- `./run.sh index:md` / `./run.sh sync:md` / `./run.sh search:md` — md track
  operating surface. Direct embedding of `~/repos/gh/notes/content` via
  the local BGE-M3 generation into `md.lance` (fresh `ANDENKEN_DATA`).
- `./run.sh sync:openclaw:oracle` — OpenClaw private-axis replication surface. It verifies the authority `data/openclaw.lance/`, rsyncs it to Oracle, then verifies the replica (API 0). It never harvests on Oracle and never reaches the public md track.
- `./run.sh sync:md:oracle` — md Oracle replication surface. It rsyncs the
  completed local `data/md.lance/` and `data/md-manifest.json` to
  `oracle:/home/junghan/repos/gh/andenken/data/`, then runs remote
  `./run.sh status` + `./run.sh verify md` by default (API 0). `--smoke` adds
  one remote `search:md` query. This script is part of the md production
  contract; do not leave ad-hoc rsync snippets outside `run.sh` / AGENTS.md.
- `scripts/sync-sessions.sh` — sessions-only incremental for the local Ollama
  BGE-M3 1024d generation (`ANDENKEN_SYNC_PROFILE`, default and only value
  `ollama-bge-m3-1024`; placement via `ANDENKEN_SYNC_ENDPOINT`). The generation
  is resolved before Step 0 gather: a Qwen profile, `--global`, or an existing
  UNSTAMPED `sessions.lance` (the preserved legacy store) refuse with API 0 and
  nothing gathered. Preflight is `scripts/profile-preflight.ts` (digest + one
  validated probe). `--global` publish is dormant until its own gate (the
  INVARIANT 6.6 pairing still applies when it reopens).
- `scripts/rebuild-sessions-full.sh` — RETIRED 2026-11-25 (in-place Qwen 4096d
  paid rebuild); refuses at once. A new generation is built into a fresh target
  by `candidate:sessions:plan/build`.
- `scripts/rebuild-incremental.sh` / `scripts/rebuild-full.sh` — retired; they
  refuse.
- `./run.sh verify all` — integrity check after indexing (sessions + md). Strict
  for sessions/md: a configured/stored dimension delta, a foreign or unreadable
  generation stamp, or a bad vector sample FAILS.
- `./run.sh doctor --md` — production md triage. Explains provider / DB /
  manifest state and accounts for manifest↔indexed gaps via `analyzeMdFile`
  skip reasons (`noembed_tag`, `min_body`, etc.).
- `./run.sh golden` — the current component-level search baseline. It covers
  the two live tracks independently: `--db session` and `--db md`; the org
  track is retired from the gate. The md track calls `searchMdCore()` from
  `md-search.ts` — since 2026-08-11 that is also the function the pi
  extension's `knowledge_search` runs, so the gate and the agent-facing tool
  no longer measure different pipelines. Its 2026-07-27
  vocabulary-heavy fixture set is transitional, not the final quality bar.
  The next gate must use canonical dates / event refs / session files / Denote
  IDs from real timeline recovery scenarios and grade expected evidence rank,
  source coverage, and honest gaps rather than loose keyword presence.

- `./run.sh accept` — the **user-facing acceptance surface**, distinct from
  `golden`. Three separated layers: index/operator health (API 0), andenken
  retrieval behaviour (canonical evidence rank, document-level diversity, and an
  honest `stale-index` / `corpus-miss` / `ranking-miss` classification), and a
  **human** `usable` / `partial` / `not-improved` verdict that no automated run
  may set. Default is API 0; `--retrieval` opts into paid query embeddings.
  Cases live in `acceptance-cases.json` (public-safe) plus a gitignored
  `acceptance-cases.local.json` for volatile bindings, so adding a case never
  touches code. `--compare` reports before/after and refuses a direction when the
  two runs did not measure the same thing. Probes run with
  `ANDENKEN_DISABLE_RECALL_TRACKING=1` and the run verifies `recalls.jsonl` did
  not grow. See the `andenken-acceptance` skill for the manual layer-3 step —
  CLI diagnostics measure `cli:*` only and never prove the pi tool surface.

Retired:

- `./run.sh qmd:*` — the qmd-over-garden-MD path was removed on 2026-05-12
  (issue #8). Replaced by the direct md track above. qmd binary at
  `~/.local/bin/qmd` is no longer driven from this repo.

If you want to add a new operation, add it to `run.sh` first. If it does not
appear in `./run.sh` help, it does not exist for operators.

### Sessions track operating cadence

The sessions track is now load-bearing in a different sense than at the start
of the project: it is the **live tier** of agent memory in a compact-not
workflow. Implications:

- `session-manifest.json` is treated as a first-class artifact alongside
  `md-manifest.json` (the current production knowledge-axis manifest). Stale
  detection (mtime/size) is the entry point.
- Frequent `--local` incremental sync is the expected cadence, and the
  `memory-sync` skill in agent-config exists for that. **`--global` is a human
  call** — it is the moment both machines come to hold the same memory — and so
  are full rebuild and oracle full-sync. GLG's 2026-09-03 decision was a scope
  decision, not a refusal of automation: the machine may keep the beat, the
  human decides the moment of coherence. It was also dated (`당분간`), not a
  permanent design principle.
- Verify still runs through `./run.sh verify sessions` after any sync that
  shows non-trivial chunk delta. Skill output alone is not verification.
- **Only the index authority writes. Oracle is a query replica** — it holds
  session JSONLs of its own, but running the indexer there forks the corpus and
  the next canonical publish (`rsync --delete`) discards the fork.
  `ANDENKEN_INDEX_AUTHORITY` (default `thinkpad`) now enforces this in code and
  blocks **indexing entry**, not merely the push: blocking only the push keeps
  the canonical safe while leaving the replica free to fork itself, which is the
  failure INVARIANT 7.1 actually names (2026-06-19 → 07-06, 27,966 vs 24,882).
  A replica's own sessions reach search by travelling to the authority as source
  files and returning inside the pushed index. `ANDENKEN_ALLOW_REPLICA_INDEX=1`
  is a fork, not a way to catch up. See INVARIANT 7.1.
- **One writer at a time, across processes.** A writer that finds
  `data/.sessions-write.lock` held exits 75 and is not retried. The agent-config
  warm path (`warm-local.sh`) stamps its request before detaching the sync and
  logs its output, so a refusal there costs one warm request until the cooldown
  passes. A stale lock is removed by an operator after checking no writer runs.
  See INVARIANT 7.6.

## Pointers

| For... | Read... |
|--------|---------|
| **Core document — comparison, history, maintenance, boundaries (Korean)** | **[ROADMAP.md](./ROADMAP.md)** |
| **Detailed sessions + md matrix vs OpenClaw** | **[COMPARISON.md](./COMPARISON.md)** |
| **Next / parked items this agent should return to** | **[NEXT.md](./NEXT.md)** |
| Rules that must stay true | [INVARIANT.md](./INVARIANT.md) |
| Project introduction (EN / KO) | [Project home](https://junghanacs.com/projects/andenken/) / [한국어](https://junghanacs.com/ko/projects/andenken/) — sources in `homepage/content/projects/andenken/` |
| Public framing / naming | [README.md](./README.md) |
| What actually closed, by CalVer snapshot | [CHANGELOG.md](./CHANGELOG.md) |
| **My public standing report (Korean)** | [botlog `20260319T110800`](https://notes.junghanacs.com/botlog/20260319T110800.html) |
| **Who owns the memory — the cross-repo axis (Korean)** | [botlog `20260408T120252`](https://notes.junghanacs.com/botlog/20260408T120252.html) |
| "What can I run?" | `./run.sh` |

When code and docs disagree, trust the code and update the doc. ROADMAP.md is
the SSOT for role / history / boundary decisions. COMPARISON.md is the detailed
sessions + md matrix against OpenClaw. AGENTS.md is the stable surface for
identity / boundaries / ownership.

### Document policy — single-axis discipline

andenken is the **embedding axis only**. It does not maintain self-memory
(working state, scratchpad, "now" notes). Multi-axis context hydration is
GLG's recap concern, not this agent-in-charge's.

Concretely:

- **No `MEMORY.md`.** Working state lives in code + `./run.sh status` + the
  multi-axis recap on the harness side.
- **No round queue.** ROADMAP.md is a comparison table + history + maintenance
  + role boundaries. Round / micro-fix / chase-list framing is rejected at
  this level — micro-fixes belong in commits, not in a top-level queue.
- **`NEXT.md` is the working queue.** It can hold the immediate next item
  and also parked follow-ups that are not being done right now. Put things
  there so the next session can resume without guesswork. When an item is
  done, remove it and stamp durable outcomes into ROADMAP History / commits.
- **Doctor signals are maintenance, not roadmap items.** `./run.sh doctor`
  output triggers fixes; it does not shape the comparison table.
- **GLG decisions** that affect andenken arrive as direct prompts. They do not
  need a Decision queue file because GLG is the one running the multi-axis
  flow — the queue is on GLG's side.
