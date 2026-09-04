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

- andenken **never calls LLMs for recall**. Retrieval is vector + BM25 + merge + MMR.
  (Recency decay is implemented but switched off in both live tracks since
  2026-09-03 — see 7.2.) If an LLM-in-the-loop is ever needed, it is a harness
  concern (active memory), not andenken.
- The harness-side `timeline` skill is the canonical source for KST coordinates,
  event identity, source status, and provenance. andenken must not infer a date
  from similarity, turn a day-only event into midnight, or collapse
  `empty`/`partial`/`stale`/`unreadable` into one state.
- Natural-language time parsing and cross-depth timeline composition belong to
  the caller. andenken accepts exact stored-signal windows and returns semantic
  evidence inside or around them.
- A timeline event embedding track is **not** a default scope expansion. If one
  is ever justified by measured meaning→time failures, it is a derived search
  projection keyed to canonical event identity, never a second timeline.
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
- a new corpus is not justified merely because the timeline can collect it;
  first prove that existing exact refs plus sessions/md cannot satisfy a real
  time-grounded recovery case

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
- stamp the change in `ROADMAP.md` History

## 6. DB + manifest invariants

### 6.1 Policy change means rebuild

If indexing policy changes, incremental sync is insufficient.

Examples:
- journal scope narrowed or widened
- exclusion tag semantics changed
- direct-body vs subtree chunking changed

Required action:
```bash
scripts/rebuild-full.sh
```

Equivalent minimal org-only reset:
```bash
rm -rf data/org.lance data/org-manifest.json
pnpm exec tsx indexer.ts org --force
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

### 6.4 Session manifest baselines only files already in the DB

`session-manifest.json` exists so long-running JSONL sessions (active
conversations that keep growing in place) get re-indexed when their
mtime/size advances. The first-run baseline must populate manifest entries
**only for files in the indexed set**.

Invariant:
- a session file that is **not** in the indexed set must **not** acquire a
  manifest entry until it has been successfully embedded and persisted
- pre-populating such a file with current mtime/size silently strands embed
  failures: on the next run `getStaleFiles()` sees the file as
  "not-indexed but manifest entry matches stat" → classified as neither new
  nor stale → silently skipped forever

Same rule applies to org-manifest. The pattern is shared.

### 6.5 Manifest checkpoint must follow buffer flush

`WriteBuffer` may hold buffered records up to `DB_WRITE_BATCH` before a
LanceDB write. The session/org manifest must never be persisted while the
WriteBuffer still holds rows for files the manifest claims are indexed.

Invariant:
- every `saveSessionManifest()` / `saveManifest()` checkpoint **must** be
  preceded by `await wb.flush()` (or equivalent flush) so the DB and the
  manifest agree at every persisted boundary
- crash between checkpoint save and final flush would otherwise leave the
  manifest claiming "indexed at mtime T" while LanceDB has nothing for that
  file, and `getStaleFiles()` would never re-queue it

The final flush at end-of-run still flushes before `saveSessionManifest()`
for the same reason. Helper `checkpointIfNeeded()` in `indexSessions()`
encodes this discipline explicitly.

### 6.6 Replication ships the DB and its manifest together

Oracle replication (`scripts/sync-md-to-oracle.sh`, the publish step of
`scripts/sync-sessions.sh --global`) must rsync **both** the `.lance` directory
and its manifest. Pushing the DB alone leaves the remote manifest claiming files
the pushed DB no longer contains, so any indexing run on the replica skips them
forever — the same silent-strand failure as 6.4, arriving over the wire.

Observed 2026-07-14: `--push` shipped `sessions.lance` without
`session-manifest.json`, and oracle kept a manifest from a local run five days
older than the DB it now held.

**Extended 2026-09-03 to the corpus.** For the sessions track the same rule now
reaches one artifact further: index, manifest **and** the device corpus publish
together. Shipping an index whose corpus is behind the gather leaves rows on the
replica whose source file is not there — seven such orphans were measured that
day. This is why `--global` is a single act rather than three commands an
operator is trusted to run in order.

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

### 7.1 Oracle is a query replica, not an indexing node

The single writer is the **index authority** — `ANDENKEN_INDEX_AUTHORITY`,
default `thinkpad`. Oracle serves queries from a pushed DB and must not run the
indexer against its own session transcripts.

Invariant:
- indexing writes happen on the authority; oracle receives them by rsync
- the DB is replaced, never merged — `rsync --delete` on the canonical push is
  correct, and rows the replica indexed on its own are expected to disappear

**Since 2026-09-03 this is enforced in code, and it blocks indexing entry — not
just the push.** Guarding only the push keeps the canonical safe while leaving
the replica free to fork *itself*, which is precisely the failure named below.
The gate sits **after** Step 0, so a refused call still completes its gather:
the replica's own sessions travel to the authority as source files and return
inside the index pushed back to it. That is the supported path, and it is why
`ANDENKEN_ALLOW_REPLICA_INDEX=1` is a fork rather than a way to catch up.
Moving the authority is a deliberate act — set `ANDENKEN_INDEX_AUTHORITY` on
purpose; do not reach for the override.

Oracle owns session JSONLs of its own (it runs agents too), so a local indexing
run there silently forks the corpus: the replica ends up with canonical rows
*plus* oracle-native rows that no push can reconcile. That happened between
2026-06-19 and 2026-07-06 (oracle drifted to 27,966 chunks / 667 files against
the canonical 24,882 / 624) and was resolved by re-establishing the canonical
push. If oracle-native sessions ever need to be searchable, they must reach the
canonical host as source files — not as replica-side embeddings. Since
`v2026.9.3` the device corpus (`~/repos/gh/session`) *is* that path: `gather`
collects each device's admitted sessions, and a replica's work reaches search
without a replica-side embedding run.

### 7.2 Recency is a sort, never a multiplier

`applyRecencyDecay` exists in `retriever.ts`, but both live tracks pass
`recencyHalfLifeDays: 0` (`index.ts`, the `cli.ts` session path,
`md-search.ts`). A new track must not silently reintroduce a nonzero half-life.

The 14-day decay removed on 2026-09-03 multiplied scores by `exp(-ln2 x age/14)`
and *then* applied `minScore 0.001`, so an ordinary hit fell under the floor at
roughly 49 days and a strong one at roughly 85. On a memory axis built to reach
back years, a decay that erases a season is a **hard delete wearing a ranking
signal's costume** — the result disappears rather than ranking lower, and no
caller can tell the difference from a corpus miss.

Recency intent belongs to `mode=recent`, which is a primary sort over stored
timestamps. A copy of the pipeline that keeps its own decay constant is a
defect: `golden-queries.ts` held exactly that inline duplicate and had to be
corrected separately (`f048a0a`) after production changed.

### 7.3 The OpenClaw harvest travels the other way, and never reaches the garden

Every other track is built here and pushed to the replica. This one is not built
here at all: the vectors already exist on the OpenClaw host, so the flow is **pull
to the authority and import**. There it stops — **there is no publish step today**,
and `openclaw.lance` exists on this machine only.

That is a current fact, not a rule. If the replica ever needs this axis, the push
must be added deliberately and in the same direction as every other track
(authority → replica); the fetch being inverted does not invert the publish. Until
then, do not describe this track as replicated.

Three rules hold this track:

1. **Append-only.** The importer never deletes a row the export did not return.
   OpenClaw's index still holds chunks for sessions whose transcripts it already
   deleted, and its retention rule is unmeasured. Mirroring its deletions would
   turn their cleanup into our loss. A row with the same id replaces itself;
   nothing else moves.
2. **`openclaw.lance` is local only** (and, if a publish is ever added, replica). It must never reach the md
   track by any path. The line here is **local versus public**, and it is the only
   line: md is the axis that gets exported to the public garden, and this track
   holds conversations that were never written for that. Family, health and money
   sit next to engineering in these chunks — measured 2026-09-03 in the
   `source=sessions` sample — and that is the point of the axis, not a hazard in
   it. GLG's ruling the same day: *"괜찮아. 가족은 하나야. 그러려고 합친 거야."*
   **Do not build a personal/coding split inside the local side.** One wall,
   drawn at export.
3. **Never a fallback.** `search-openclaw` / `openclaw_search` answer only when
   asked for by name. "Sessions found nothing, try the bot memory" erases which
   axis an answer came from, and an answer that cannot name its source is the
   system's recollection rather than the person's. `session_search` and
   `knowledge_search` must not mix openclaw rows into their results — the pi tool
   surface matters more here than the CLI, because agents call it on their own
   judgment.

The credential policy is drop-the-chunk, not redact. These vectors were computed
by someone else from the text we would be editing, so a redacted chunk would
retrieve as the unredacted one and display as something else. Measured
2026-09-03: 0 of 4,683 chunks trip the detector, so the policy costs nothing today
and exists for the day it does not.

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

Coverage gaps to close (not blocking, but tracked):

- timeline-grounded retrieval cases with canonical dates, session files, note
  paths/Denote IDs, and honest corpus-miss vs ranking-miss classification
- `getShortCJKTokens()` boundary cases (punctuation, ASCII-adjacent, length cut)
- session-search interleave order (substring + FTS round-robin)
- session-manifest stale detection (mtime change, size change, deleted file)

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
