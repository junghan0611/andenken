# Agent Guidelines

## Language

- **Conversation:** Korean (ko-KR)
- **Commits, code, docs, comments:** English only
- Terms: 한글용어(English_Term)

## What This Project Is

andenken is not a generic RAG tool. The name comes from Heidegger's *Andenken* — recollective thinking that lets the past gain meaning in the present. It pairs with [geworfen](https://github.com/junghan0611/geworfen) (thrownness) in the same philosophical worldview.

This system embeds the *entirety of one existence* — sessions, notes, journal, health, commits, bibliography — into vector space, so that a present question can meet buried records and bring them back to life.

## Architecture

```
core/
├── store.ts              # LanceDB vector store
├── retriever.ts          # Hybrid retrieval (weighted/RRF + decay + MMR)
├── gemini-embeddings.ts  # Gemini Embedding 2 API
├── session-indexer.ts    # Session JSONL parser (pi + Claude Code)
├── org-chunker.ts        # Org-mode note chunker
cli.ts                    # CLI entry point
index.ts                  # pi-extension entry point
```

## Key Design Decisions

- **Hybrid retrieval:** Vector similarity (0.7) + BM25 full-text (0.3), not vector-only
- **candidateMultiplier:** 4x initial candidate pool (openclaw pattern) for better MMR quality
- **Temporal decay:** Exponential with configurable half-life (14 days sessions, 90 days org)
- **MMR diversity:** Jaccard-based re-ranking to avoid redundant results
- **Incremental indexing:** mtime-based stale detection via JSON manifest for org files
- **Korean BM25:** Particle stripping with dual-emit (original + stem). 25 particles from openclaw.
- **Cross-lingual:** dictcli expands Korean queries to English tags automatically (Layer 3)
- **Multi-runtime:** Same core serves pi (extension), Claude Code (skill), OpenCode (skill)

## Three-Layer Principle

andenken is Layer 1 of a 3-layer search architecture:

```
Layer 1 (andenken): Embedding + BM25 — maximize retrieval quality independently
Layer 2 (denotecli dblock): Meta classification — structural graph traversal
Layer 3 (dictcli): Personal vocabulary + morphological analysis
```

**Layer 1 does NOT mix Layer 2/3 concerns.**
- Korean particle stripping (25 patterns) = Layer 1 (BM25 preprocessing)
- Kiwi morphological analysis = Layer 3 (dictcli `stem` — planned)
- dictcli `expand` = Layer 3 (personal word map)
- andenken stays language-agnostic; Korean-specific heavy lifting goes to dictcli

Future: dictcli `stem` (Kiwi-based) will decompose Korean verb conjugations
("설계했다" → "설계") and compound nouns ("검색증강생성" → "검색"+"증강"+"생성").
andenken Layer 1 consumes dictcli stem output without owning the Kiwi dependency.

## Issue Tracking

This project uses **br** (beads_rust) for issue tracking.

```bash
br ready              # Find available work
br show <id>          # View issue details
br update <id> --status in_progress  # Claim work
br close <id>         # Complete work
br sync --flush-only  # Export JSONL (git commit separately)
```

## Environment

```bash
GOOGLE_AI_API_KEY    # or GEMINI_API_KEY — required for embeddings
```

Index locations:
- `~/repos/gh/andenken/data/sessions.lance`
- `~/repos/gh/andenken/data/org.lance`
