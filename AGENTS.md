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
- **Temporal decay:** Exponential with configurable half-life (14 days sessions, 90 days org)
- **MMR diversity:** Jaccard-based re-ranking to avoid redundant results
- **Cross-lingual:** dictcli expands Korean queries to English tags automatically
- **Multi-runtime:** Same core serves pi (extension), Claude Code (skill), OpenCode (skill)

## Environment

```bash
GOOGLE_AI_API_KEY    # or GEMINI_API_KEY — required for embeddings
```

Index locations:
- `~/.pi/agent/memory/sessions.lance`
- `~/.pi/agent/memory/org.lance`
