# andenken

> *An-denken* — to think toward what has been. Recollective thinking.
> Heidegger's term for the kind of memory that doesn't merely retrieve,
> but lets the past gain meaning in the present.

Semantic memory for humans and AI agents. Not a corporate RAG pipeline — an interface to the *entirety of one existence* laid out on a time axis.

## What It Does

Records buried in time — session conversations, org-mode notes, journal entries, health data, commit history, bibliography — are embedded into vector space. When a question is thrown, buried records come alive with meaning.

This is exactly what Andenken is.

```
andenken search-sessions "NixOS GPU cluster setup"
andenken search-knowledge "체화인지 embodied cognition"
andenken status
andenken reindex
```

## Architecture

```
                    ┌─ Session Indexer ─── pi sessions (.jsonl)
Query ──→ Embed ──→ │                  └── Claude Code sessions (.jsonl)
  │                 ├─ Org Chunker ────── 3,000+ Denote notes
  │                 └─ (future: health, bib, commits, journal)
  │
  ├─ Vector Search (Gemini Embedding 2, LanceDB)
  ├─ Full-Text Search (BM25)
  ├─ Hybrid Merge (weighted sum / RRF)
  ├─ Temporal Decay (exponential, configurable half-life)
  ├─ MMR Diversity Re-ranking (Jaccard-based)
  └─ dictcli Query Expansion (Korean→English cross-lingual)
```

### Three-Layer Cross-Lingual Search

```
Query: "보편 학문" (Korean: "universal learning")

Layer 1 — Embedding
    "보편" ≈ "universalism" in vector space

Layer 2 — dictcli Expansion
    expand("보편") → [universal, universalism, paideia, liberal arts]

Layer 3 — Full-Text Search
    BM25 keyword match as fallback
```

Each layer catches what the others miss. Together they never miss.

## Current Scale

| Source | Chunks | Notes |
|--------|--------|-------|
| Sessions (pi) | 15,420 | 115 session files |
| Knowledge (org) | 104,812 | 3,000+ Denote notes |

## Stack

- **Embeddings:** Gemini Embedding 2 (768d org, 3072d sessions)
- **Vector Store:** LanceDB (serverless, file-based)
- **Retrieval:** Weighted merge + RRF + temporal decay + MMR
- **Chunking:** Org-aware 2-tier (heading + content)
- **Query Expansion:** dictcli (personal vocabulary graph)
- **Search Strategy:** 2-step refinement (abstract→concrete re-query)
- **Runtime:** TypeScript (tsx)

## Why the Name

`geworfen` — the human is thrown into the world.
`andenken` — the thrown being thinks back toward what has been.

In Heidegger, *Geworfenheit* (thrownness) and *Andenken* (recollective thinking) form a pair. The same worldview, unbroken.

이기상 (Lee Ki-sang), the foremost Korean translator of Heidegger, rendered *Andenken* as 뜻새김 — "engraving meaning through recollection." Three worlds meet in one word: Heidegger's German, Lee's Korean philosophy, and the essence of this project.

→ [Naming document](https://notes.junghanacs.com/botlog/20260319T110800.html) (Korean)

## Changelog

### 0.3.1 — 2-Step Search Strategy (2026-03-21)

Abstract queries ("what did I do last") fail to match concrete text ("graph.edn outdated") in embedding space. The fix is not in code but in **agent behavior**: read top-3 results from the first search, extract proper nouns and technical terms, then re-search with those specific keywords. This pattern is now embedded in `promptGuidelines` for both `session_search` and `knowledge_search` tools.

Reference: [[20260321T103138]] 시맨틱 서치 메타 쿼리 한계와 2단계 검색 전략

## Development

```bash
nix develop          # enter dev shell
npm install          # install dependencies
npm test             # run tests
```

## Related

- [geworfen](https://github.com/junghan0611/geworfen) — existence data WebTUI dashboard
- [agent-config](https://github.com/junghan0611/agent-config) — agent infrastructure (25 skills)
- [dictcli](https://github.com/junghan0611/dictcli) — personal vocabulary graph (Korean↔English)
- [denotecli](https://github.com/junghan0611/denotecli) — Denote knowledge base CLI

## License

MIT
