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

## Two tracks inside andenken

| Track | Quality bar | Notes |
|-------|------------|-------|
| **sessions** | Parity with openclaw session memory | Load-bearing for agent continuity. Regression here is a real incident. |
| **org** | Optional, high-signal only | Conservative scope. Live experiment in curating a personal KB. Not a commitment. |

When a change affects both tracks, sessions gets the stricter review.

## What I own

```
embedding-provider.ts   EmbeddingProvider interface + vLLM impl + factory
model-presets.ts        Qwen3-Embedding-4B / bge-m3 / Gemini presets
store.ts                LanceDB vector store (sessions.lance + org.lance)
retriever.ts            Hybrid retrieval (weighted/RRF + decay + MMR)
session-indexer.ts      pi + Claude Code JSONL parser
org-chunker.ts          Org-aware 2-tier chunker (direct-body rule)
indexer.ts              Indexing driver (manifest + hard guard + zero-chunk clear)
write-buffer.ts         Single-writer serialization
doctor.ts               Operator triage — retrieval / chunk / structure health
index.ts                pi extension entry
cli.ts                  Claude Code / OpenCode CLI entry
```

Two separate LanceDB files — `sessions.lance` and `org.lance`. One DB is not a
fallback for the other.

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

Two paths, same Qwen3-Embedding-4B 2560d output. Same LanceDB is queryable
anywhere that also emits 2560d.

| Purpose | Endpoint | When |
|---------|----------|------|
| **Sessions fast path** | laptop ollama `localhost:11434` (preferred) → falls back to gpu1i tunnel | hourly incremental driven by `scripts/sync-sessions.sh` / agent-config `memory-sync` skill |
| **Org / full rebuild** | gpu1i tunnel `localhost:18000` only | human-initiated, runs through `scripts/rebuild-full.sh` / `scripts/rebuild-incremental.sh` |
| **Query (search)** | OpenRouter `https://openrouter.ai/api` model `qwen/qwen3-embedding-4b` | every retrieval call from any host |

### Why the split

- **Sessions** churn constantly (every active conversation appends). They need
  a path that costs nothing per call and is reachable from a laptop on the road.
  Ollama on the laptop fits; gpu1i is the fallback when ollama isn't running.
- **Org / full rebuild** processes thousands of files at once. That work belongs
  on a real GPU. Letting it run anywhere else is how the ₩100K bill happened.
- **Query** is small per call (one vector per search) and OpenRouter gives us a
  stable host-agnostic URL.

### Cost discipline (mandatory)

- All indexing scripts unset `ANDENKEN_VLLM_API_KEY` before running so a
  misconfigured endpoint cannot silently bill OpenRouter.
- All indexing scripts run a dimension probe (must return 2560) before touching
  the index. A wrong endpoint returning 3584d (e.g. gpu2i) can never corrupt
  the LanceDB silently.
- `memory-sync` skill (agent-config side) covers the sessions fast path only.
  Org/full/oracle full-sync require human invocation from this repo.

> **2026-04-30 — gpu2i removed from embedding role.**
> gpu2i was repurposed as VOS chat-completion node (Qwen2.5-7B-Instruct-AWQ).
> It now serves `/v1/chat/completions` and **must not be used for embedding** —
> calling `/v1/embeddings` against it returns 3584d (last hidden state) and
> would corrupt the 2560d index. gpu1i is the sole GPU embedding endpoint
> until further notice; this remains a single point of failure for the org/full
> path. The sessions fast path now has ollama as a second engine, but org
> rebuild does not.

## Cross-repo responsibility

andenken is the **logic and verification provider**. It does not own execution
or cost.

| Role | Owner |
|------|-------|
| Logic, analysis, verification | andenken (this repo) |
| Embedding execution, cost bearing | agent-config |
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

- `scripts/sync-sessions.sh` — sessions-only fast path (auto-selects ollama/gpu1i,
  dim probe, optional `--push` to oracle). Hourly cadence target. Used by the
  agent-config `memory-sync` skill.
- `scripts/rebuild-incremental.sh` — incremental sessions + org through gpu1i
  (manifest-driven, with dim safety probe). Human-driven.
- `scripts/rebuild-full.sh` — reproducible full rebuild (sessions + org + verify,
  with dim safety probe). Human-driven, full-cost.
- `./run.sh verify all` — integrity check after indexing
- `./run.sh doctor --org` — operator triage (read-only, local-only). Verdict
  comes with `reasons[]` so the operator sees *why* it WARNed.
- `./run.sh golden` — search quality baseline (regression gate)

If you want to add a new operation, add it to `run.sh` first. If it does not
appear in `./run.sh` help, it does not exist for operators.

### Sessions track operating cadence

The sessions track is now load-bearing in a different sense than at the start
of the project: it is the **live tier** of agent memory in a compact-not
workflow. Implications:

- `session-manifest.json` is treated as a first-class artifact alongside
  `org-manifest.json`. Stale detection (mtime/size) is the entry point.
- Hourly (or 30 min) sessions sync is the expected operating cadence. The
  `memory-sync` skill in agent-config exists for that and only that — full
  rebuild and oracle full-sync stay human-only.
- Verify still runs through `./run.sh verify sessions` after any sync that
  shows non-trivial chunk delta. Skill output alone is not verification.

## Pointers

| For... | Read... |
|--------|---------|
| Rules that must stay true | [INVARIANT.md](./INVARIANT.md) |
| Current operational state | [MEMORY.md](./MEMORY.md) |
| Public framing / naming | [README.md](./README.md) |
| "What can I run?" | `./run.sh` |

When code and docs disagree, trust the code and update the doc. When MEMORY.md
and AGENTS.md disagree, AGENTS.md is the stable surface — update MEMORY.md to
match reality.
