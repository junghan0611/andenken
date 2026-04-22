# andenken Invariants

Read this before changing:
- `org-chunker.ts`
- `indexer.ts`
- `write-buffer.ts`
- `doctor.ts`
- `estimate.ts`

This file documents the rules that must stay true even as implementation changes.

## 0. Cross-axis boundary invariants

andenken implements the **embedding axis only**. Boundaries with the other two
memory axes (active memory, dream) and the sidecars (dictcli, denotecli) must
not drift.

- andenken **never calls LLMs for recall**. Retrieval is vector + BM25 + merge + decay + MMR.
  If an LLM-in-the-loop is ever needed, it is a harness concern (active memory), not andenken.
- The **query path never writes** to LanceDB. Only indexing writes. This is what lets
  query run on any host including Oracle without touching the DB.
- **Hard guard is a safety rail, not a quality bar**. Oversize chunks being skipped is
  never the end state; it is a signal that chunking or garden content needs work.
- Korean morphology belongs in **dictcli**, not here. andenken stays language-agnostic.
  Particle stripping is the one exception because it is BM25 preprocessing at the
  tokenizer boundary.
- Structural graph traversal (backlinks, dblock classification) belongs in **denotecli**.
  andenken does not own Denote identifiers as first-class; it treats them as opaque file IDs.
- When the harness wires **active memory** to andenken, the query API must expose a
  graceful-degrade contract (`{ status: "timeout" | "unavailable", results: [] }`) instead
  of throwing. Until that work lands, document the intent; do not pre-implement.

## 1. Scope invariants

### 1.1 Journal is intentionally partial

`journal` is **not** a full-history embedding target.

Invariant:
- only journal files with Denote identifier `>= 20250101T000000` are indexable
- pre-2025 journal content is excluded on purpose

Rationale:
- post-weekly-note journal structure is stable enough for chunking
- older journal files are noisy and are covered better by sessions / notes

Do not widen this scope casually.
If policy changes, treat it as a **DB rebuild event**, not an incremental sync.

### 1.2 Conservative scope beats brute-force size

Invariant:
- more embedded text is **not** automatically better memory
- low-signal corpora should stay excluded until proven useful in retrieval

Examples of default exclusion candidates:
- transcript dumps
- append-only logs
- giant raw blocks
- agent traces

## 2. Exclusion-tag invariants

The following tags exclude content from embedding, case-insensitively:
- `noexport`
- `tts`
- `noembed`
- `llmlog`
- `archive`

Rules:
- filetags containing one of these tags → skip the **entire file**
- heading tags containing one of these tags → skip the **entire subtree**

Examples:
- `#+filetags: :note:noembed:`
- `* Transcript :TTS:`
- `** Dump :noexport:`
- `*** Agent trace :LLMLOG:`
- `* Old branch :ARCHIVE:`

Important:
- `:ARCHIVE:` subtree skipping is required behavior
- exclusion must apply to **both** heading tier and content tier
- excluded subtree text must not leak upward into parent content chunks

## 3. Chunking invariants

### 3.1 Direct-body chunking

Invariant:
- heading chunks carry structure
- content chunks carry the heading's **direct body only**
- parent headings must not re-emit child subtree bodies

This prevents parent/child duplicate emission.

If you change `buildHeadingSegments()`, preserve this rule.

### 3.2 Excluded subtree isolation

Invariant:
- if a child subtree is excluded, its text must not appear in parent content chunks
- excluded headings must not appear in heading chunks either

### 3.3 Protected blocks are structural, not absolute truth

Protected blocks (`#+begin_src`, quote, example, export, verse, table) are important,
but embedding success has priority over blindly preserving giant blocks.

Invariant:
- do not assume block integrity alone makes a chunk safe for embedding
- any future splitting/guard logic must still respect the serving limit below

## 4. Serving-limit invariants

The operational limit is **not** the theoretical model context.

Invariant:
- all org embedding safety decisions are based on vLLM serving limit
- current serving limit: `--max-model-len 8192`

Implications:
- audit thresholds
- oversize warnings
- hard guards
- retry decisions

must all treat **8K** as the real boundary.

## 5. Hard-guard invariants

Invariant:
- oversize org chunks must not be allowed to kill the whole indexing run
- current behavior: chunks over `ANDENKEN_ORG_EMBED_MAX_CHARS` (default `12000`) are skipped with warning

This is a safety rail, not a final quality solution.

If you change the threshold or strategy:
- document why
- re-run scan / tests
- update `MEMORY.md`

## 6. DB + manifest invariants

### 6.1 Policy change means rebuild

If indexing policy changes, incremental sync is insufficient.

Examples:
- journal scope narrowed or widened
- exclusion tag semantics changed
- direct-body vs subtree chunking changed

Required action:
```bash
scripts/rebuild-dual-full.sh
```

Equivalent minimal org-only reset:
```bash
rm -rf data/org.lance data/org-manifest.json
npx tsx indexer.ts org --force
```

### 6.2 Manifest updates happen after successful file processing

Invariant:
- a file should enter `org-manifest.json` only after its current indexing decision has completed successfully
- collection-time metadata capture is fine, but manifest commit must be success-based

### 6.3 Zero-chunk files must still clear stale DB rows

Invariant:
- if a previously indexed file now produces zero chunks
  (for example due to `:noembed:` or `:noexport:`), old DB rows must be deleted

Zero-chunk does **not** mean "do nothing".

## 7. Single-writer invariant

Invariant:
- embedding can be concurrent
- DB mutation must remain single-writer serialized

`WriteBuffer` exists to preserve this.

Do not re-introduce parallel DB writes.

If you change write buffering, preserve:
- delete-by-file once per file
- no duplicate inserts from interleaved flushes
- zero-chunk file deletion path

## 8. Test invariants

At minimum, unit tests must prove:

1. pre-2025 journal is excluded
2. 2025+ journal is included
3. filetag exclusion skips entire file
4. heading-tag exclusion skips subtree
5. excluded subtree text does not leak into parent chunk
6. `:TTS:` subtree is really excluded by matching real excluded text
7. `:ARCHIVE:` subtree is excluded
8. `:LLMLOG:` subtree is excluded
9. heading tier also excludes those headings
10. `WriteBuffer.markFile()` deletes stale rows for zero-chunk files
11. `WriteBuffer` still avoids duplicate writes under concurrency

If a policy is added and no test changes, assume coverage is incomplete.

## 9. Review checklist for future agents

Before merging chunking/indexing changes, verify:

- [ ] Does this preserve direct-body chunking?
- [ ] Can excluded subtree text leak upward?
- [ ] Does `:ARCHIVE:` still skip subtree?
- [ ] Does a zero-chunk stale file clear old DB rows?
- [ ] Does manifest update only after success?
- [ ] Does the change respect the 8K serving limit?
- [ ] If scope policy changed, did we require full org rebuild?
- [ ] Did `npm test -- unit` pass?
- [ ] Did `npm run build` pass?

## 10. Required verification commands

```bash
npm test -- unit
npm run build
```

For policy / chunking changes, also run a local scan or doctor-style check before force rebuild.
