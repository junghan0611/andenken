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

## Memory axes — what I cover, what I don't

| Axis | Where it lives | My role |
|------|----------------|---------|
| **active memory** (pre-reply recall) | harness — pi-extensions, openclaw-style plugin | Consumer of my search API. I must expose graceful-degrade contracts; I do **not** implement recall orchestration. |
| **embedding** (semantic search) | **this repo** | Owner. Full implementation. |
| **dream** (overnight consolidation) | separate axis, harness side | I know it exists; I do not implement it. |

### Sidecars (required, not axes)

- **dictcli** — personal vocabulary (ko↔en expand, Kiwi stem). Layer 3. Not mine.
- **denotecli** — structural dblock / graph over org. Layer 2. Not mine.

## Tracks inside andenken

| Track | Quality bar | Notes |
|-------|------------|-------|
| **sessions** | Parity with openclaw session memory | Load-bearing for agent continuity. Regression here is a real incident. Closed/stable as of 2026-05-11. |
| **md (public garden)** | Immediately usable knowledge retrieval for agents | Current production knowledge axis. Direct Markdown embedding over `~/repos/gh/notes/content`. Ports OpenClaw builtin md memory logic (`~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/`) onto the same LanceDB backend used by sessions. First production cut closed on 2026-05-12; current work is B2 retrieval quality / golden baseline. |
| **org** | Currently disabled | Source track over 3,000+ Denote notes. Doctor / chunker / incremental work is upstream R&D. Not consumed by agents in production. Do not run `index:org` unless explicitly working on the org track. |

**Split of effort.** The agent-in-charge separates *what we ship to agents now*
(sessions + md) from *upstream development* (org). Org is rich but messy;
garden export is a controlled surface and far easier to tune. md is what GLG
hands agents as their knowledge axis today; org gets time to mature on its own.

When a change affects multiple live tracks, sessions gets the stricter review.
The qmd path attempted between 2026-05-09 and 2026-05-11 was retired on
2026-05-12 (issue #8) — local-GGUF rerank/expand stack was too heavy
(~53s/query on 90-file smoke). Embedding axis stays a simple
*embed → LanceDB → hybrid retrieve* engine; no brain-platform features.

## What I own

```
embedding-provider.ts   EmbeddingProvider interface + vLLM impl + factory
model-presets.ts        Qwen3-Embedding-4B/8B / bge-m3 / Gemini presets
store.ts                LanceDB vector store (sessions.lance + md.lance + org.lance)
retriever.ts            Hybrid retrieval (weighted/RRF + decay + MMR)
session-indexer.ts      pi + Claude Code JSONL parser
md-chunker.ts           Markdown-aware chunker + analyzeMdFile SSOT classifier
org-chunker.ts          Org-aware 2-tier chunker (disabled track — upstream R&D)
indexer.ts              Indexing driver (manifest + hard guard + zero-chunk clear)
write-buffer.ts         Single-writer serialization
doctor.ts               Operator triage dispatch
doctor-md.ts            MD production triage — provider / DB / manifest / gap
doctor-org.ts           Org triage (upstream R&D only)
index.ts                pi extension entry
cli.ts                  Claude Code / OpenCode CLI entry
```

Three separate LanceDB files — `sessions.lance`, `md.lance`, `org.lance`. Each
is keyed to its own provider/dim. No DB is a fallback for another.

The md track is no longer "under construction" in the old sense: first
production cut is closed. Current md work is quality measurement (golden
queries) and explainability (`doctor --md`), not corpus bring-up.

## What I do not own

- Active memory orchestration, timeout policy, prompt style — harness concern
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
| **Sessions** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `https://openrouter.ai/api` via `ANDENKEN_SESSION_*` → `data/sessions.lance` | hourly incremental driven by `scripts/sync-sessions.sh` / agent-config `memory-sync` skill; full rebuild via `scripts/rebuild-sessions-full.sh` |
| **MD** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `https://openrouter.ai/api` via `ANDENKEN_MD_*` → `data/md.lance` | incremental driven by `./run.sh sync:md`; full index via `./run.sh index:md`; corpus `~/repos/gh/notes/content`; Oracle replication via `./run.sh sync:md:oracle` |
| **Org** | Qwen3-Embedding-4B / 2560d | `ANDENKEN_ORG_*` / legacy vLLM path → `data/org.lance` | **disabled in production.** Upstream R&D only. Do not run from operator workflow. |

### Session corpus sources

Sessions index exactly two harness sources:

| Source | Directory | Format |
|--------|-----------|--------|
| `pi` | `~/.pi/agent/sessions` | pi JSONL (`type="message"`, `message.role`) |
| `claude` | `~/.claude/projects` | Claude Code JSONL (`type="user" | "assistant"`) |

Entwurf sessions are **not a third source**. A spawned/resumed entwurf that writes
`*_entwurf-<taskId>.jsonl` under `~/.pi/agent/sessions/<project>/` is indexed by
the normal `pi` source path, with project inferred from the cwd-shaped session
directory. Saved task metadata / control sockets are not separately embedded;
only the transcript JSONL that lands under the pi sessions tree participates in
`sessions.lance`.

Do **not** index `~/.pi/agent/claude-config-overlay/projects`. That directory
is pi-shell-acp's Claude overlay, not a third memory source. Its work is already
represented through pi harness sessions / entwurf messages; indexing it would
create duplicate memory. If source optionalization is added, valid choices are
only `pi`, `claude`, and `all` (`pi + claude`). No `overlay` source.

### Why the split

- **Sessions** are load-bearing for live agent continuity and use 8B/4096d.
  Incremental sync is paid-remote but low cost; wrong-dim and paid full-rebuild
  guards are mandatory.
- **MD** is the current knowledge axis for agents. It indexes the exported
  public garden directly — a controlled corpus where chunking and retrieval
  are tunable on a sane schedule. Same 8B/4096d provider as sessions; separate
  LanceDB file so the two pools never cross-contaminate. Its chunk count is
  intentionally much lower than org (`10,119` vs `44,916` in the 2026-05-12
  baseline): OpenClaw-style Markdown chunking emits larger, denser
  CJK-weighted chunks instead of org's heading/body two-tier fragments. Treat
  this as density improvement, not missing corpus.
- **Org** stays 4B/2560d but is **disabled in production**. Doctor WARN
  cleanup, chunker improvements, and source policy refinement are upstream R&D
  and live behind explicit operator invocation. Agents do not consume org
  today.
- Query providers are track-specific. Never use a sessions vector against the
  md or org DB, or vice versa.

### Cost discipline (mandatory)

- Sessions full rebuild against a paid remote is gated by
  `ANDENKEN_ALLOW_PAID_FULL_REBUILD=1` and should go through
  `scripts/rebuild-sessions-full.sh` after estimate + explicit confirmation.
- MD indexing follows the same gate (`ANDENKEN_ALLOW_PAID_FULL_REBUILD=1` for
  full rebuilds) and the same wrong-dim preflight. Incremental is the default
  cadence.
- Indexing/search paths must check DB/provider dimension compatibility before
  any paid embedding call. Sessions and md expect 4096d; org expects 2560d.
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
  OpenRouter 8B/4096d into `data/md.lance`.
- `./run.sh sync:md:oracle` — md Oracle replication surface. It rsyncs the
  completed local `data/md.lance/` and `data/md-manifest.json` to
  `oracle:/home/junghan/repos/gh/andenken/data/`, then runs remote
  `./run.sh status` + `./run.sh verify md` by default (API 0). `--smoke` adds
  one remote `search:md` query. This script is part of the md production
  contract; do not leave ad-hoc rsync snippets outside `run.sh` / AGENTS.md.
- `scripts/sync-sessions.sh` — sessions-only incremental path through
  OpenRouter Qwen3-Embedding-8B 4096d. Wrong-dim aborts before API; no-work
  exits with API 0; optional `--push` to oracle. Used by the agent-config
  `memory-sync` skill.
- `scripts/rebuild-sessions-full.sh` — sessions-only full rebuild. Estimate →
  explicit confirmation → 4096d preflight → destroy sessions index → rebuild
  → verify. Human-driven and paid-remote gated.
- `scripts/rebuild-incremental.sh` / `scripts/rebuild-full.sh` — deprecated
  mixed sessions+org paths. Do not use for normal operations.
- `./run.sh verify all` — integrity check after indexing (skips disabled org).
- `./run.sh doctor --md` — production md triage. Explains provider / DB /
  manifest state and accounts for manifest↔indexed gaps via `analyzeMdFile`
  skip reasons (`noembed_tag`, `min_body`, etc.).
- `./run.sh doctor --org` — org triage (read-only, local-only). Upstream R&D
  only since the org track is disabled in production.
- `./run.sh golden` — search quality baseline (regression gate); current NEXT
  item is md-specific golden coverage.

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
- Hourly (or 30 min) sessions sync is the expected operating cadence. The
  `memory-sync` skill in agent-config exists for that and only that — full
  rebuild and oracle full-sync stay human-only.
- Verify still runs through `./run.sh verify sessions` after any sync that
  shows non-trivial chunk delta. Skill output alone is not verification.

## Pointers

| For... | Read... |
|--------|---------|
| **Core document — comparison, history, maintenance, boundaries (Korean)** | **[ROADMAP.md](./ROADMAP.md)** |
| **Detailed sessions + md matrix vs OpenClaw** | **[COMPARISON.md](./COMPARISON.md)** |
| **Next single thing this agent is doing** | **[NEXT.md](./NEXT.md)** |
| Rules that must stay true | [INVARIANT.md](./INVARIANT.md) |
| Public framing / naming | [README.md](./README.md) |
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
- **`NEXT.md` holds exactly one thing.** The next item this agent-in-charge
  is about to do, with the *why*. When done, the change is stamped into
  ROADMAP History and `NEXT.md` is overwritten with the next item. Never
  appended, never queued multiple items.
- **Doctor signals are maintenance, not roadmap items.** `./run.sh doctor`
  output triggers fixes; it does not shape the comparison table.
- **GLG decisions** that affect andenken arrive as direct prompts. They do not
  need a Decision queue file because GLG is the one running the multi-axis
  flow — the queue is on GLG's side.
