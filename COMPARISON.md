# COMPARISON — andenken vs OpenClaw

This document compares the **embedding surfaces** only.

It does **not** try to restate OpenClaw's whole memory stack. Active memory,
short/long/dream orchestration, and harness-side recall remain out of scope
except where they change corpus boundaries or operator expectations.

## Snapshot — 2026-05-12

- **andenken live tracks:** `sessions` + `md`
- **andenken disabled track:** `org` (upstream R&D only)
- **andenken sessions:** OpenRouter `qwen/qwen3-embedding-8b` / `4096d`
- **andenken md:** OpenRouter `qwen/qwen3-embedding-8b` / `4096d`
- **andenken md baseline:** `10,119` chunks / `2,192` indexed files
- **OpenClaw reference for md logic:**
  `~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/`

---

## 1. Session embedding — OpenClaw vs andenken

| Aspect | OpenClaw session memory | andenken `sessions` |
|---|---|---|
| Primary goal | Per-agent / per-bot continuity inside the OpenClaw runtime | Personal cross-harness continuity for GLG's agent work |
| Corpus boundary | OpenClaw transcript/session files, scoped by agent/runtime | pi sessions + Claude Code sessions combined into one memory axis |
| Identity model | Bot/agent-local corpus | Human/operator-local corpus across harnesses |
| Storage backend | `sqlite-vec` + SQLite tables / FTS5 | LanceDB + side manifest |
| Full-text backend | SQLite FTS5, typically trigram-aware for CJK | BM25 + substring fallback; Korean particle stripping ported from OpenClaw |
| Embedding provider | Runtime-configured in OpenClaw | OpenRouter `qwen/qwen3-embedding-8b` |
| Embedding dimension | Depends on configured provider/model | `4096d` |
| Chunking style | Flattened transcript → message-aware chunking | JSONL transcript parsing → message-aware chunking |
| Retrieval shape | Hybrid retrieval | Hybrid retrieval |
| Shared tuning baseline | 2026-05-08 parity work aligned chunking / hybrid / MMR assumptions | Same baseline; then moved to 8B/4096d on 2026-05-10 |
| Time signal | Runtime memory stack can promote/demote across layers | Exponential temporal decay inside the retriever |
| Live operator surface | OpenClaw runtime / plugin / gateway side | `session_search`, `search-sessions`, `scripts/sync-sessions.sh` |
| Current state | Reference implementation for bot transcript memory | **Closed/stable** as of 2026-05-11 |

### Reading note

The important difference is **corpus ownership**, not just retrieval code.
OpenClaw remembers a bot's world. andenken remembers **GLG's work across
harnesses**.

---

## 2. Markdown embedding — OpenClaw builtin md memory vs andenken `md`

| Aspect | OpenClaw builtin md memory | andenken `md` |
|---|---|---|
| Primary goal | Let an OpenClaw agent search markdown roots inside its runtime/workspace | Provide a production knowledge axis for agents from the exported public garden |
| Corpus boundary | Runtime-configured markdown paths / collections | `~/repos/gh/notes/content` only |
| Source style | Generic markdown roots | Curated public garden export |
| Storage backend | `sqlite-vec` + SQLite FTS5 | LanceDB + `data/md-manifest.json` |
| Embedding provider | Runtime-configured | OpenRouter `qwen/qwen3-embedding-8b` |
| Embedding dimension | Depends on configured provider/model | `4096d` |
| Chunker | OpenClaw `chunkMarkdown` | **Port of OpenClaw `chunkMarkdown`** |
| CJK handling | Weighted sizing + surrogate-pair-safe splitting in builtin chunker | Same ported behavior |
| Retrieval shape | Hybrid search over markdown chunks | Hybrid search over markdown chunks |
| Scope discipline | General-purpose runtime memory surface | Single production knowledge axis for agent use |
| Incremental artifact | OpenClaw runtime-managed DB/files | `data/md-manifest.json` + `data/md.lance` |
| Explainability | Runtime/tooling dependent | `./run.sh doctor --md` explains manifest ↔ indexed gaps |
| Live operator surface | OpenClaw memory runtime | `knowledge_search`, `search-md`, `sync:md`, `doctor --md` |
| Current state | Upstream logic source | **First production cut closed** on 2026-05-12 |

### Port boundary

andenken's md track is **not inspired by** OpenClaw md memory in a vague sense.
It directly ports the builtin markdown chunking logic from:

- `~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/internal.ts`

and runs that logic on top of the same retrieval philosophy, but with a
different storage and operator contract:

- OpenClaw: `sqlite-vec` + SQLite FTS5 inside the runtime
- andenken: LanceDB + manifest/doctor surfaces for external operator workflows

---

## 3. Retrieval baseline snapshot

This table captures the **comparison baseline we actually care about**. Some
OpenClaw runtime knobs are configurable, so read these as the working baseline
for parity discussions rather than a claim that every OpenClaw deployment is
identical.

| Knob | OpenClaw baseline | andenken |
|---|---|---|
| Session chunk budget | `400` tokens / `80` overlap | Same parity target for sessions |
| Hybrid merge | vector `0.7` / text `0.3` | vector `0.7` / BM25 `0.3` |
| MMR | enabled, `λ=0.7` baseline | enabled, `λ=0.7` |
| Temporal decay | enabled; 5/8 baseline noted `30d` half-life | enabled; default `14d` half-life |
| CJK full-text path | SQLite FTS5 trigram | BM25 + substring fallback |
| Markdown chunker lineage | builtin `chunkMarkdown` | direct port of `chunkMarkdown` |

For sessions, this means the comparison is mostly about **corpus and operator
surface**, not radically different retrieval philosophy. For md, the chunking
logic is intentionally shared while the storage/ops layer diverges.

## 4. What is intentionally different

| Topic | OpenClaw | andenken |
|---|---|---|
| Memory layers | active / short / long / dream | embedding axis only |
| Active recall ownership | Runtime/harness concern | Out of scope; consumed by other harness surfaces |
| Corpus granularity | Per-agent / per-bot / per-runtime | Per-human / cross-harness |
| Markdown mission | Generic runtime memory roots | Public-garden knowledge axis |
| Storage choice | SQLite family | LanceDB family |
| Quality harness | Runtime-side memory QA and plugin contracts | `doctor`, `verify`, and the upcoming md golden baseline |

These differences are not regressions. They are the result of different jobs.
OpenClaw is a full runtime. andenken is the **embedding hub** for GLG's harness.

---

## 5. What OpenClaw has that andenken does not own

| Surface | Owner |
|---|---|
| Active memory before reply | OpenClaw / harness side |
| Multi-layer memory promotion | OpenClaw |
| Dreaming / overnight consolidation | OpenClaw / separate harness axis |
| Per-bot isolated memory worlds | OpenClaw |

andenken can be a backend for these experiences, but it does not implement them
in this repo.

---

## 6. What andenken has that OpenClaw does not target in the same way

| Surface | andenken value |
|---|---|
| Cross-harness session corpus | pi + Claude Code together |
| Public-garden-first knowledge axis | Exported `notes/content` as a production corpus |
| Sidecar graph ecosystem | `dictcli`, `denotecli`, `bibcli` |
| Operator-first integrity tools | `doctor --md`, `verify`, manifest accounting |

---

## 7. Code map

| Concern | OpenClaw reference | andenken implementation |
|---|---|---|
| Markdown chunking | `packages/memory-host-sdk/src/host/internal.ts` | `md-chunker.ts` |
| SQLite schema / FTS | `packages/memory-host-sdk/src/host/memory-schema.ts` | `store.ts` + `retriever.ts` |
| Session transcript classification | `packages/memory-host-sdk/src/host/session-files.ts` | `session-indexer.ts` |
| Query expansion / CJK token handling | `packages/memory-host-sdk/src/host/query-expansion.ts` | `retriever.ts` + sidecar `dictcli` boundary |
| Runtime memory orchestration | `packages/memory-host-sdk/src/host/openclaw-runtime-memory.ts` | Not owned here |

---

## 8. Current judgment

### Sessions

For session embedding, the meaningful comparison is no longer "who has the
better trick." The more important question is whether the two systems are
**horizontally aligned enough** that regressions are obvious.

That alignment largely exists now. The remaining differences are corpus and
operator model, not first-order retrieval philosophy.

### Markdown

For markdown, andenken's md track should be read as:

1. **OpenClaw builtin md memory logic**,
2. transplanted onto a **LanceDB operator surface**,
3. narrowed to a **single curated public-garden corpus**.

That is why the right comparison is not "OpenClaw vs andenken" in the abstract,
but:

- **OpenClaw runtime markdown memory**
- vs **andenken production knowledge axis (`md`)**

### Next quality step

The next real gap is no longer bring-up. It is **retrieval quality accounting**:
`md` golden queries, day-specific retrieval checks, and a baseline that can fail
when relevance drifts.
