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

## Environment

```bash
GEMINI_API_KEY    # preferred
GOOGLE_AI_API_KEY # also accepted
GOOGLE_API_KEY    # also accepted
```

Index locations:
- `~/repos/gh/andenken/data/sessions.lance`
- `~/repos/gh/andenken/data/org.lance`

## Cross-Repo Responsibility

andenken is the **logic and verification provider**. It does not own execution or cost.

| Role | Owner |
|------|-------|
| Logic, analysis, verification | andenken (this repo) |
| Embedding execution, cost bearing | agent-config |
| Final approval for code changes | agent-config (or Hih) |

### Commit discipline

- **Verify before commit.** Run the changed code, confirm output, then commit.
- Analysis and fix proposals are welcome. But code changes require agent-config approval before committing.
- Incident: `de5fbe0` was committed before verification (2026-04-07). The fix was correct, but the process was wrong.

### Scope verification

Even when numbers are precise, the *scope* can be wrong. Always cross-check:
- What does "indexed" mean here — manifest entries or LanceDB rows?
- What does "new" mean — not in manifest, or not in LanceDB?
- Are stale files included in the count?

## Safe Incremental Sync Policy

For day-to-day operation, treat semantic memory indexing as a **throttled incremental sync**, not as an occasional brute-force rebuild.

### Mandatory operator checks

Before cross-host memory work, explicitly verify:

```bash
cat ~/.current-device
TZ='Asia/Seoul' date '+%Y%m%dT%H%M%S'
```

Assume the normal direction is:
- **build on thinkpad**
- **rsync org index to oracle**
- **run oracle sessions incrementally on oracle**

### Local-first / Oracle-second rule

- `org` should be indexed on **thinkpad first** and then copied to oracle with `rsync`
- `oracle` should usually embed **sessions only**
- avoid rebuilding the same `org` corpus on both machines

### Cost-safety rules

- prefer **incremental** indexing; avoid `--force` unless explicitly approved
- always inspect **pre-flight** cost before `org` indexing
- if estimated cost is **>$1**, stop and reconfirm with the user
- keep `INDEX_CONCURRENCY=1`
- rely on the built-in request throttling; do not optimize for peak throughput

### Practical finding from production use

The dangerous failure mode was **not** vector dimensionality alone. The real risks were:
- repeated force rebuilds
- duplicate rebuilds across local + oracle
- project-level spending cap sharing
- large stale sets after interrupted `org` runs

### Important caveat: interrupted org runs

`org` incremental indexing uses manifest + mtime tracking.
If an `org` run is interrupted before manifest save completes, the next run may see a **large stale set** again.
Therefore:
- do not assume a small `new` count means a cheap run
- trust the actual pre-flight chunk/call/cost estimate

**Manifest checkpoint (TODO):** Currently the manifest is saved only at the end of a full run.
If a run is interrupted at 380/542 files, all 542 are retried on next run.
LanceDB pre-delete prevents duplicate chunks, but wasted API cost remains.
A periodic checkpoint (e.g., every 50 files) would reduce re-work after interruption.

**Production observation (2026-04-07):** bash timeout (1200s) caused interruption at
380/542 → manifest not saved → full 542 retry on re-run. Actual cost was $0.702
(pre-flight estimate matched exactly). Checkpoint would have saved ~30% of retry cost.

### Recommended workflow

1. run cost/status inspection first
2. sync local sessions incrementally
3. sync local org incrementally
4. rsync `org.lance` + `org-manifest.json` to oracle
5. sync oracle sessions incrementally
6. report actual cost/time from the `💰 API:` lines

### Tooling

- human/project CLI: `./run.sh`
- agent workflow: `memory-sync` skill
- cost dry-run: `./run.sh estimate all`
