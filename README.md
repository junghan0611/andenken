# andenken

> *An-denken* — to think toward what has been. Recollective thinking.
> Heidegger's term for the kind of memory that doesn't merely retrieve,
> but lets the past gain meaning in the present.

Semantic memory for humans and AI agents. Not a corporate RAG pipeline — an interface to the *high-signal slices of one existence* laid out on a time axis.

## What It Does

Records buried in time — session conversations, org-mode notes, recent journal entries, health data, commit history, bibliography — are embedded into vector space. The system now prefers **conservative scope first**: block noisy corpora, then open selectively when retrieval proves a need. When a question is thrown, buried records come alive with meaning.

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
  ├─ Vector Search (Qwen3-Embedding-4B via vLLM, LanceDB)
  ├─ Full-Text Search (BM25)
  ├─ Hybrid Merge (weighted sum / RRF)
  ├─ Temporal Decay (exponential, configurable half-life)
  ├─ MMR Diversity Re-ranking (Jaccard-based)
  └─ dictcli Query Expansion (Korean→English cross-lingual)
```

### Three-Layer Search Architecture

```
Query: "설계했다" (한국어 verb conjugation of "설계/design")

Layer 1 — andenken (Embedding + BM25)
    Vector: Gemini Embedding 2 catches semantic similarity
    BM25:   Korean particle stripping ("봇멘트를" → "봇멘트를" + "봇멘트")
    candidateMultiplier: 4x initial pool for better MMR diversity
    Incremental: mtime-based stale detection for modified org files

Layer 2 — denotecli dblock (Meta classification)
    Denote links, tags, hierarchy — structural graph traversal

Layer 3 — dictcli (Personal vocabulary)
    expand("보편") → [universal, universalism, paideia]
    stem("설계했다") → "설계" (planned: Kiwi morphological analysis)
    → kiwi-nlp decomposes Korean, dictcli expands to English
```

Layer 1 maximizes embedding/BM25 quality independently.
Layer 2 provides structural navigation.
Layer 3 reflects the human's thought patterns and Korean language habits.
Each layer catches what the others miss. Together they reconstruct a *bunshin*'s memory.

## Current Scale (2026-04-17 verified rebuild)

| Source | Chunks | Notes |
|--------|--------|-------|
| Sessions | 17,384 | full dual-GPU rebuild, verify PASS |
| Knowledge (org) | 44,167 | 2,010 indexed files, 179 policy-excluded 0-chunk files |

Validation after rebuild:
- no duplicate IDs
- no orphan files
- no ghost zone
- manifest clean
- golden queries: **8/8 PASS**

## Stack

- **Embeddings:** Qwen3-Embedding-4B via vLLM (2560d)
- **Vector Store:** LanceDB (serverless, file-based)
- **Retrieval:** Weighted merge + RRF + temporal decay + MMR
- **Chunking:** Org-aware 2-tier (heading + content)
- **Query Expansion:** dictcli (personal vocabulary graph)
- **Search Strategy:** 2-step refinement (abstract→concrete re-query)
- **Runtime:** TypeScript (tsx)

## Multi-Harness Architecture

Same core serves three agent harnesses:

| | pi (extension) | Claude Code (CLI) | OpenCode (CLI) |
|---|---|---|---|
| **Interface** | `index.ts` registerTool | `cli.ts` search/knowledge | `cli.ts` search/knowledge |
| **session_search** | ✅ tool | ✅ `search <query>` | ✅ `search <query>` |
| **knowledge_search** | ✅ tool | ✅ `knowledge <query>` | ✅ `knowledge <query>` |
| **dictcli expand** | ✅ auto | ✅ auto | ✅ auto |
| **BM25 조사 제거** | ✅ | ✅ | ✅ |
| **candidateMultiplier 4x** | ✅ | ✅ | ✅ |
| **source filter (pi\|claude)** | ✅ | ✅ `--source` | ✅ `--source` |
| **session→knowledge fallback** | ✅ auto | ✅ auto | ✅ auto |
| **Kiwi stems (indexing)** | ✅ indexer | ✅ indexer | ✅ indexer |
| **/new auto-indexing** | ✅ pi-only | — | — |
| **status/reindex** | ✅ `/memory` | ✅ `status`/`reindex` | ✅ `status`/`reindex` |
| **promptGuidelines** | ✅ Kiwi aware | — (no prompt) | — (no prompt) |

Search pipeline is identical across all harnesses — same retriever, store, and embeddings.
pi-only features (`/new` indexing, `session_start` init, promptGuidelines) are extension
lifecycle hooks that CLI doesn't need.

## Why the Name

`geworfen` — the human is thrown into the world.
`andenken` — the thrown being thinks back toward what has been.

In Heidegger, *Geworfenheit* (thrownness) and *Andenken* (recollective thinking) form a pair. The same worldview, unbroken.

이기상 (Lee Ki-sang), the foremost Korean translator of Heidegger, rendered *Andenken* as 뜻새김 — "engraving meaning through recollection." Three worlds meet in one word: Heidegger's German, Lee's Korean philosophy, and the essence of this project.

→ [Naming document](https://notes.junghanacs.com/botlog/20260319T110800.html) (Korean)

## Scope and Safety Policy

- `journal` is intentionally partial: only files with identifier `>= 20250101T000000`
- exclusion tags block embedding conservatively:
  - filetag: `noexport`, `tts`, `noembed`, `llmlog`
  - heading/subtree: same tags plus `archive`
- content chunking uses **direct body only** to avoid parent/child duplicate emission
- hard guard skips oversize org chunks before they can kill the run
- indexing policy changes are treated as **full rebuild events**, not incremental syncs

See also:
- [AGENTS.md](./AGENTS.md)
- [INVARIANT.md](./INVARIANT.md)
- [MEMORY.md](./MEMORY.md)

## Rebuild and Verification

Reproducible full rebuild script:

```bash
cd ~/repos/gh/andenken
scripts/rebuild-dual-full.sh
```

This performs:
1. full sessions rebuild
2. full org rebuild
3. verify sessions
4. verify org

Search quality baseline:

```bash
export ANDENKEN_PROVIDER=vllm
export ANDENKEN_VLLM_ENDPOINT=http://localhost:18000
export ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
export ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
npx tsx golden-queries.ts --db org
```

## Changelog

### 0.3.4 — Conservative Scope + Invariants + Reproducible Dual Rebuild (2026-04-17)

- journal indexing narrowed to 2025+ weekly-note era
- exclusion tags enforced (`noexport`, `tts`, `noembed`, `llmlog`, subtree `archive`)
- direct-body chunking replaces subtree-wide content emission
- hard guard skips oversize org chunks instead of killing the run
- manifest now updates after successful file processing
- zero-chunk files clear stale DB rows
- added `INVARIANT.md`
- added `scripts/rebuild-dual-full.sh`
- verified full dual-GPU rebuild: sessions + org both PASS
- golden queries: **8/8 PASS**

### 0.3.3 — Korean Particle Stripping for BM25 (2026-03-30)

Port openclaw's `KO_TRAILING_PARTICLES` logic. 25 particles stripped with dual-emit
strategy (original + stem both in BM25 query). +27% BM25 score for particle-laden queries.
Applied to BM25 only — vector queries unchanged (Gemini handles Korean natively).

Future: Kiwi morphological analysis via dictcli `stem` for verb conjugation decomposition
("설계했다" → "설계"), compound nouns ("검색증강생성" → "검색"+"증강"+"생성").
Kiwi stays in dictcli (Layer 3) to keep andenken language-agnostic.

### 0.3.2 — Incremental Org Indexing + candidateMultiplier (2026-03-30)

mtime-based stale detection via JSON manifest. Modified botlog/notes are re-indexed
automatically. candidateMultiplier 4x (openclaw pattern) for better MMR diversity.
Openclaw deep analysis informed both changes (2 delegate reports, ~1,350 lines).

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
