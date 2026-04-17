# Agent Guidelines

## Language

- **Conversation:** Korean (ko-KR)
- **Commits, code, docs, comments:** English only
- Terms: 한글용어(English_Term)

## What This Project Is

andenken is not a generic RAG tool. The name comes from Heidegger's *Andenken* — recollective thinking that lets the past gain meaning in the present. It pairs with [geworfen](https://github.com/junghan0611/geworfen) (thrownness) in the same philosophical worldview.

This system does **not** brute-force every artifact. It curates the *high-signal slices of one existence* — sessions, notes, recent journal, health, commits, bibliography — into vector space, so that a present question can meet buried records and bring them back to life.

## Architecture

```
core/
├── store.ts               # LanceDB vector store
├── retriever.ts           # Hybrid retrieval (weighted/RRF + decay + MMR)
├── embedding-provider.ts  # EmbeddingProvider interface + vLLM/Gemini impl
├── model-presets.ts       # Qwen3-Embedding-4B / bge-m3 / Gemini presets
├── session-indexer.ts     # Session JSONL parser (pi + Claude Code)
├── org-chunker.ts         # Org-mode note chunker
├── gemini-embeddings.ts   # Historical: pre-2026-04 Gemini baseline (bake-off only)
cli.ts                     # CLI entry point
index.ts                   # pi-extension entry point
```

## Invariants

Before changing chunking, indexing, or write-path behavior, read [INVARIANT.md](./INVARIANT.md).

## Key Design Decisions

- **Hybrid retrieval:** Vector similarity (0.7) + BM25 full-text (0.3), not vector-only
- **candidateMultiplier:** 4x initial candidate pool (openclaw pattern) for better MMR quality
- **Temporal decay:** Exponential with configurable half-life (14 days sessions, 90 days org)
- **MMR diversity:** Jaccard-based re-ranking to avoid redundant results
- **Incremental indexing:** mtime-based stale detection via JSON manifest for org files
- **Korean BM25:** Particle stripping with dual-emit (original + stem). 25 particles from openclaw.
- **Cross-lingual:** dictcli expands Korean queries to English tags automatically (Layer 3)
- **Multi-runtime:** Same core serves pi (extension), Claude Code (skill), OpenCode (skill)
- **Direct-body chunking:** content chunks embed a heading's direct body only; subtree structure lives in heading chunks and child chunks, avoiding parent/child duplicate emission
- **Conservative scope first:** smaller, high-signal memory is preferred over brute-force corpus size

## Embedding Scope Policy (2026-04-17)

Default stance: **block first, open selectively later**.

### Journal policy

- `journal` is **not** a full-history embedding target
- only journal files with Denote identifier **>= `20250101T000000`** are indexed
- rationale: weekly note era (2025~) has stable structure; older journal files are too inconsistent and are better covered by sessions / notes when needed
- do **not** re-open pre-2025 journal indexing without explicit approval

### Exclusion tags

The following tags exclude content from embedding, case-insensitively:

- `noexport`
- `tts`
- `noembed`
- `llmlog`
- `archive` (heading/subtree only)

Rules:
- **filetags** containing `noexport`, `tts`, `noembed`, or `llmlog` → skip the **entire file**
- **heading tags** containing one of these tags, or `archive` → skip the **entire subtree**
- examples:
  - `#+filetags: :note:noembed:`
  - `* Raw transcript :TTS:`
  - `** Worklog dump :noexport:`
  - `*** Agent trace :LLMLOG:`
  - `* Old branch :ARCHIVE:`

### Operational principle

- embedding size alone is **not** a quality metric
- prefer retrievable, bounded, semantically meaningful chunks
- transcript dumps, append-only logs, giant raw blocks, and agent traces should be excluded first and re-opened only when they prove search value

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

## Embedding Infrastructure — GPU Server Rule (MANDATORY)

**인덱싱(임베딩)은 반드시 GPU 서버(gpu2i/gpu1i)로 한다. 로컬(ollama)에서 인덱싱 절대 금지.**

| 용도 | 환경 | endpoint |
|------|------|----------|
| **인덱싱** (session/org) | GPU 서버 vLLM (RTX 5080) | `localhost:18000` (SSH tunnel) |
| **쿼리** (검색) | 로컬 ollama (iGPU) | `localhost:11434` |

- GPU 서버: ~350 emb/s (5분에 97K chunks 완료)
- 로컬 ollama: ~0.1 files/s (97K chunks → 80분+, 실용 불가)
- 로컬 ollama는 **쿼리 전용** — 터널 없이도 검색 가능하게 하는 것이 목적

### 인덱싱 전 필수 절차

```bash
# 1. SSH 터널 열기
ssh -f -N -L 18000:localhost:8000 gpu2i

# 2. 터널 확인
curl -s http://localhost:18000/v1/models | head -3

# 3. 인덱싱 실행 (GPU 서버 경유)
ANDENKEN_PROVIDER=vllm ANDENKEN_VLLM_ENDPOINT=http://localhost:18000 \
  ANDENKEN_VLLM_MODEL=/storage/models/vllm/default \
  ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B \
  npx tsx indexer.ts sessions --force
```

### 운영 모델

- **Qwen3-Embedding-4B** (2560d) — org + session 공통
- Gemini 호출 없음. 모든 임베딩은 로컬 인프라.

## Environment

```bash
# Embedding provider (vLLM mandatory for indexing)
ANDENKEN_PROVIDER=vllm
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000   # GPU server via SSH tunnel
ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B

# Query-time local (ollama)
# ANDENKEN_VLLM_ENDPOINT=http://localhost:11434
# ANDENKEN_VLLM_MODEL=qwen3-embedding:4b
# ANDENKEN_VLLM_PRESET=ollama/qwen3-embedding:4b
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
4. **run `./run.sh verify all`** — confirm zero duplicates, orphans, ghost zone
5. rsync `org.lance` + `org-manifest.json` to oracle
6. sync oracle sessions incrementally
7. report actual cost/time from the `💰 API:` lines

### Reproducible full rebuild

When policy changes or a clean rebuild is needed, use:

```bash
scripts/rebuild-dual-full.sh
```

This is the canonical full reset path for:
- `data/sessions.lance`
- `data/org.lance`
- `data/org-manifest.json`
- verify sessions
- verify org

### Post-indexing Verification

"Indexing done" is not done. Verification must confirm:

1. **No duplicates** — same chunk ID appearing multiple times
2. **No orphans** — DB rows pointing to deleted/renamed files
3. **No ghost zone** — files indexed in LanceDB but missing from manifest
4. **Manifest clean** — no entries for files that don't exist on disk
5. **Fragment health** — fragment count and total size reported

```bash
# Run after every indexing operation
./run.sh verify all

# Cleanup when verify reports issues
./run.sh cleanup org --dry-run   # inspect first
./run.sh cleanup org             # dedup + orphan + manifest repair + compact
./run.sh verify all              # confirm clean
```

### Search Quality Verification (Mandatory)

Structural integrity (`verify`) is necessary but not sufficient.
Embeddings exist to be *found*. After every indexing or cleanup operation,
andenken **must** run search quality checks to confirm retrieval works.

This is not optional code quality — it is the core obligation of a semantic memory system.

#### 5-Point Search Quality Spec

Delegate to a **different agent** (e.g., Sonnet via `delegate`) to avoid self-confirmation bias.
The delegate runs these tests and reports pass/fail per item.

**T1: Stale file re-indexing reflected**

Sample 5 recently re-indexed files (stale in last run). Search by a unique snippet from each.
Expect: file appears in top-10 results.

```bash
./run.sh knowledge "<unique phrase from file>" --limit 10
# Check: expected file basename in results
```

**T2: Deleted/orphan files NOT in results**

Pick 3 files removed by cleanup (orphans). Search by their distinctive keywords.
Expect: the *exact file path* does NOT appear in results. (Renamed successors may appear — that's OK.)

**T3: Dedup quality (MMR diversity)**

Search for a file that previously had heavy duplicates.
Expect: same file appears ≤2 times in top-10. If ≥3, MMR diversity is broken.

**T4: Golden queries baseline**

```bash
npx tsx golden-queries.ts --db org
```

Expect: all queries PASS. Any regression from previous run = fail.

**T5: Cross-lingual retrieval**

Test the 3-layer pipeline (andenken → denotecli → dictcli):
- Korean query → English-tagged note found (e.g., `보편 학문` → universalism/paideia)
- Conjugated verb → stem match (e.g., `설계했다` → `설계`)
- Compound concept → decomposed match (e.g., `존재사건` → Ereignis)

#### Execution Protocol

1. Collect test data: recent stale files, orphan paths, golden query list
2. Write concrete queries + expected results table
3. `delegate` to Sonnet with CWD=andenken, `source ~/.env.local`
4. Sonnet reports per-test pass/fail table
5. andenken interprets results: pass/fail judgment + root cause for failures
6. Report to agent-config (or Hih)

#### Relationship to structural verify

| Layer | Tool | What it checks |
|-------|------|----------------|
| Structural | `./run.sh verify all` | Duplicates, orphans, manifest, fragments |
| Search quality | This spec (5 tests) | Retrieval actually works after changes |
| Golden baseline | `npx tsx golden-queries.ts` | Regression detection across runs |

All three layers are required. Structural verify alone is not enough.

**Who runs what**:
- `verify`: andenken (after any indexing) or agent-config (post-sync check)
- `cleanup`: agent-config only (modifies DB)
- Search quality spec: andenken (delegated to Sonnet, mandatory after cleanup/major indexing)
- Golden queries: andenken (search quality baseline)

### Tooling

- human/project CLI: `./run.sh`
- agent workflow: `memory-sync` skill
- cost dry-run: `./run.sh estimate all`
- integrity check: `./run.sh verify all`
- cleanup: `./run.sh cleanup org [--dry-run]`
