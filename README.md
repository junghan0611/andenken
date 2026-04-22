# andenken

> *An-denken* — to think toward what has been. Recollective thinking.
> Heidegger's term for the kind of memory that doesn't merely retrieve,
> but lets the past gain meaning in the present.

Semantic memory for humans and AI agents. Not a corporate RAG pipeline — an
interface to the *high-signal slices of one existence* laid out on a time axis.

## How to Read This

andenken is one layer of a larger memory architecture. Before diving in,
understand where it fits.

### Memory axes in the harness

```
 active memory   │ Blocking pre-reply recall. Harness side (pi-extensions /
  (recall)       │ openclaw plugin pattern). Bounded timeout, graceful
                 │ degrade on failure. Consumes andenken as a backend.
                 │ ── Not implemented in this repo. ──

 embedding       │ THIS REPO.
  (semantic)     │ Vector + BM25 hybrid retrieval over curated corpora.
                 │ Qwen3-Embedding-4B (2560d) via vLLM, LanceDB.
                 │ Two tracks: sessions and org (see below).

 dream           │ Overnight consolidation. Compacts recent memory into
  (consolidation)│ distilled units. Separate axis; separate roadmap.
                 │ ── Not implemented in this repo. ──
```

Sidecars (required but not axes):

- **dictcli** — personal vocabulary graph (Korean↔English expand, Kiwi stem)
- **denotecli** — structural graph / dblock navigation over org notes

If you want to know about the whole memory stack of the harness, andenken is
the right place to ask. The implementation here is one axis; the documentation
covers all three.

### Two tracks inside andenken

| Track | Quality bar | Scope |
|-------|------------|-------|
| **sessions** | Parity with openclaw session memory | Core. pi + Claude Code JSONL. |
| **org** | Optional, high-signal only | 3,000+ Denote notes. Conservative scope — block first, open selectively. |

Sessions is load-bearing for agent continuity. Org is a live experiment in
curating a personal knowledge base for retrieval — still improving, not a
commitment.

## What It Does

Records buried in time — session conversations, org-mode notes, recent journal,
health data, commit history, bibliography — are embedded into vector space.
The system prefers conservative scope first: block noisy corpora, then open
selectively when retrieval proves a need.

```
andenken search-sessions "NixOS GPU cluster setup"
andenken search-knowledge "체화인지 embodied cognition"
andenken status
./run.sh doctor --org      # operator triage: retrieval / chunk / structure
```

## Architecture

```
                    ┌─ Session Indexer ─── pi sessions (.jsonl)
Query ──→ Embed ──→ │                  └── Claude Code sessions (.jsonl)
  │                 └─ Org Chunker ────── 3,000+ Denote notes
  │
  ├─ Vector Search (Qwen3-Embedding-4B via vLLM, LanceDB)
  ├─ Full-Text Search (BM25, Korean particle stripping)
  ├─ Hybrid Merge (weighted sum / RRF)
  ├─ Temporal Decay (exponential, configurable half-life)
  ├─ MMR Diversity Re-ranking
  └─ dictcli Query Expansion (Korean→English cross-lingual)
```

### Three-layer search

```
Query: "설계했다"

Layer 1 — andenken              Embedding + BM25. Language-agnostic.
Layer 2 — denotecli dblock      Structural graph / classification.
Layer 3 — dictcli               Personal vocabulary + Korean morphology.
```

Layer 1 keeps retrieval quality high on its own. Layer 2 provides navigation.
Layer 3 reflects the human's vocabulary. Each catches what the others miss.

## Multi-Harness

Same core serves pi (extension), Claude Code (skill), OpenCode (skill). Tools:
`session_search`, `knowledge_search`. Same retriever, same store, same
embeddings. See `index.ts` (pi) and `cli.ts` (CLI harnesses).

## Stack

- **Embeddings** Qwen3-Embedding-4B via vLLM (2560d)
- **Vector store** LanceDB (file-based)
- **Retrieval** Weighted merge + RRF + temporal decay + MMR
- **Chunking** Org-aware 2-tier (heading + direct body)
- **Query expansion** dictcli personal vocabulary graph
- **Runtime** TypeScript (tsx)

## Provider split — query vs indexing

| Path | Endpoint | Why |
|------|----------|-----|
| **Query** | OpenRouter `qwen/qwen3-embedding-4b` | Works from any host. ~$0 per query. |
| **Indexing** | Local vLLM `localhost:18000,18001` (GPU servers) | Bulk work must stay on GPU. |

Both paths produce identical 2560d vectors. The same LanceDB is queryable
anywhere as long as the query provider also emits 2560d.

## Scope and safety policy

- `journal`: only files with identifier `>= 20250101T000000`
- Exclusion tags (filetag → file skip, heading tag → subtree skip):
  `noexport`, `tts`, `noembed`, `llmlog`, `archive`
- Content chunking uses **direct body only** (no parent/child duplicates)
- Hard guard skips oversize org chunks before they can kill the run
- Policy changes are treated as **full rebuild events**, not incremental syncs

## Rebuild

```bash
cd ~/repos/gh/andenken
scripts/rebuild-dual-full.sh   # sessions + org, verify both
./run.sh golden                # search quality baseline (26/26 PASS target)
```

## Why the name

`geworfen` — the human is thrown into the world.
`andenken` — the thrown being thinks back toward what has been.

In Heidegger, *Geworfenheit* and *Andenken* form a pair. 이기상 rendered
*Andenken* as 뜻새김 — "engraving meaning through recollection."

→ [Naming document](https://notes.junghanacs.com/botlog/20260319T110800.html) (Korean)

## Further reading

- [AGENTS.md](./AGENTS.md) — agent-in-charge doc (axes, boundaries, ownership)
- [INVARIANT.md](./INVARIANT.md) — rules that must stay true across changes
- [MEMORY.md](./MEMORY.md) — current operational state (short-term scratchpad)
- `./run.sh` — living command catalogue (what this repo can actually do)

## Recent milestones

- **2026-04-22** — doctor `--org` stage 1: retrieval / chunk / structure triage
- **2026-04-17** — OpenRouter query path + provider split. Indexing stays on
  local GPU; queries run from any host.
- **2026-04-17** — Conservative scope + invariants + reproducible dual rebuild
  (sessions 17,384 / org 44,167 / golden 26/26 PASS).
- **2026-03-30** — Korean particle stripping for BM25 (ported from openclaw).
- **2026-03-30** — Incremental org indexing via mtime manifest.
- **2026-03-21** — 2-step search strategy: abstract → read top-3 → re-search
  with concrete terms. Encoded in `promptGuidelines`.

## Related

- [geworfen](https://github.com/junghan0611/geworfen) — existence data dashboard
- [agent-config](https://github.com/junghan0611/agent-config) — harness infra
- [dictcli](https://github.com/junghan0611/dictcli) — vocabulary graph
- [denotecli](https://github.com/junghan0611/denotecli) — Denote KB CLI

## License

MIT
