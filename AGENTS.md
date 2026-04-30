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

## GPU server rule (mandatory)

**인덱싱(임베딩)은 반드시 GPU 서버(gpu1i)로 한다. 로컬 대량 인덱싱 금지.**

| Purpose | Environment | Endpoint |
|---------|-------------|----------|
| Indexing (session / org) | GPU server vLLM (RTX 5080) | `localhost:18000` via SSH tunnel to gpu1i |
| Query (search) | OpenRouter | `https://openrouter.ai/api`, model `qwen/qwen3-embedding-4b` |

Both emit 2560d. Same LanceDB is queryable anywhere that also emits 2560d.

> **2026-04-30 — gpu2i removed from embedding role.**
> gpu2i was repurposed as VOS chat-completion node (Qwen2.5-7B-Instruct-AWQ).
> It now serves `/v1/chat/completions` and **must not be used for embedding** —
> calling `/v1/embeddings` against it returns 3584d (last hidden state) and
> would corrupt the 2560d index. gpu1i is the sole embedding endpoint until
> further notice; this is a single point of failure to monitor.

Indexing scripts (`scripts/rebuild-full.sh`, `scripts/rebuild-incremental.sh`)
explicitly unset `ANDENKEN_VLLM_API_KEY`, pin localhost vLLM, and run a
dimension probe before touching the index so a misrouted endpoint can never
silently destroy the LanceDB.

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

- `scripts/rebuild-full.sh` — reproducible full rebuild (sessions + org + verify, with dim safety probe)
- `scripts/rebuild-incremental.sh` — incremental sessions + org (manifest-driven, with dim safety probe)
- `./run.sh verify all` — integrity check after indexing
- `./run.sh doctor --org` — operator triage (read-only, local-only)
- `./run.sh golden` — search quality baseline (regression gate)

If you want to add a new operation, add it to `run.sh` first. If it does not
appear in `./run.sh` help, it does not exist for operators.

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
