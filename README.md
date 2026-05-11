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
                 │ Sessions: Qwen3-Embedding-8B (4096d).
                 │ Org: Qwen3-Embedding-4B (2560d).
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

### Tracks inside andenken

| Track | Quality bar | Scope |
|-------|------------|-------|
| **sessions** | Parity with openclaw session memory | Core. pi + Claude Code JSONL. Closed/stable as of 2026-05-11. |
| **qmd over public garden MD** | Immediately usable knowledge retrieval | Current active track. Uses exported Markdown in `~/repos/gh/notes/content`; see [QMD.md](./QMD.md). |
| **org** | Optional, high-signal only | 3,000+ Denote notes. Conservative source track; doctor/chunker work is next-after-qmd. |

Sessions is load-bearing for agent continuity. The immediate knowledge path is
qmd over the public garden Markdown, because that is the surface GLG can use
now. Org remains the richer source track, but org incremental/chunker work is
not the current next step.

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
  ├─ Vector Search (sessions 8B/4096d, org 4B/2560d; LanceDB)
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

- **Embeddings** Sessions: Qwen3-Embedding-8B via OpenRouter (4096d); Org: Qwen3-Embedding-4B (2560d)
- **Vector store** LanceDB (file-based)
- **Retrieval** Weighted merge + RRF + temporal decay + MMR
- **Chunking** Org-aware 2-tier (heading + direct body)
- **Query expansion** dictcli personal vocabulary graph
- **Runtime** TypeScript (tsx)

## Provider split — sessions, qmd, org

| Track | Model / dim | Endpoint | Why |
|-------|-------------|----------|-----|
| **Sessions** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `ANDENKEN_SESSION_*` | Live agent continuity. Incremental sync is small; full rebuild is explicitly gated. |
| **qmd public garden MD** | qmd local GGUF models; baseline `Qwen3-Embedding-0.6B` + Vulkan | `./run.sh qmd:garden` / `~/.cache/qmd/index.sqlite` | Current practical knowledge path over exported Markdown. See [QMD.md](./QMD.md). |
| **Org** | Qwen3-Embedding-4B / 2560d | `ANDENKEN_ORG_*` / vLLM-compatible path | Conservative source indexing; deferred until qmd baseline is useful. |

The two LanceDB stores are dimension-separated. Sessions search must use a
4096d sessions provider; knowledge search must use a 2560d org provider. qmd is
separate: it indexes Markdown collections into its own SQLite database.

### Session sources

andenken indexes two session sources:

| Source | Directory | Notes |
|--------|-----------|-------|
| `pi` | `~/.pi/agent/sessions` | pi-native harness sessions |
| `claude` | `~/.claude/projects` | standalone Claude Code sessions |

Do **not** index `~/.pi/agent/claude-config-overlay/projects`. It is the
pi-shell-acp Claude overlay and would duplicate work already represented in pi
sessions / entwurf messages. Valid source filters are `pi`, `claude`, and
`all` (`pi + claude`) only. Invalid values are rejected with an explicit error.

`session_search` / `search-sessions` source semantics:

| `source` value      | Candidate pool        | Org cross-track fallback |
|---------------------|-----------------------|--------------------------|
| omitted / `all`     | pi + claude (mixed)   | enabled when results are thin |
| `pi`                | pi only (LanceDB-side filter) | disabled (sessions-only intent) |
| `claude`            | claude only (LanceDB-side filter) | disabled (sessions-only intent) |

The source filter is pushed down into LanceDB at the vector / FTS / substring
query level so the candidate pool is source-specific. Explicit `pi` or `claude`
also suppresses the org knowledge fallback — if the caller named a session
source, they asked for sessions, not org notes.

## qmd public garden MD path

Current qmd work intentionally starts from the exported public garden rather
than raw org:

| Surface | Path | Notes |
|---------|------|-------|
| qmd source | `~/repos/3rd/qmd` | upstream clone, built with Bun |
| qmd binary | `~/.local/bin/qmd` | symlink to `~/repos/3rd/qmd/bin/qmd` |
| qmd DB | `~/.cache/qmd/index.sqlite` | qmd-owned SQLite index |
| public garden Markdown | `~/repos/gh/notes/content` | first qmd corpus; ~2.2K md files / ~27MB |
| org→qmd export | `~/.cache/andenken-qmd` | deferred; depends on org doctor/chunker cleanup |

First baseline collections are expected to be `garden-bib`, `garden-botlog`,
`garden-journal`, `garden-meta`, and `garden-notes`. Images, talks, test, and
tmp stay out of the first baseline unless GLG explicitly asks.

## Scope and safety policy

- `journal`: only files with identifier `>= 20250101T000000`
- Exclusion tags (filetag → file skip, heading tag → subtree skip):
  `noexport`, `tts`, `noembed`, `llmlog`, `archive`
- Content chunking uses **direct body only** (no parent/child duplicates)
- Hard guard skips oversize org chunks before they can kill the run
- Policy changes are treated as **full rebuild events**, not incremental syncs

## Rebuild / sync

```bash
cd ~/repos/gh/andenken
scripts/sync-sessions.sh              # sessions-only incremental (8B/4096d)
scripts/rebuild-sessions-full.sh      # sessions-only full rebuild (estimate + confirm)
./run.sh qmd:bootstrap --cache-dir ~/repos/gh/notes/content --collection-prefix garden
                                      # print qmd collection/context commands for public garden MD
./run.sh doctor --org --no-smoke      # org read-only triage, API 0 (deferred after qmd baseline)
./run.sh golden                       # search quality baseline (API required)
```

`sync-sessions.sh` is the operating heartbeat for the sessions track and what
the agent-config `memory-sync` skill calls under the hood. Mixed
`scripts/rebuild-incremental.sh` / `scripts/rebuild-full.sh` paths are
deprecated for normal operations; sessions and org are dimension-separated
tracks and should be handled deliberately.

## Why the name

`geworfen` — the human is thrown into the world.
`andenken` — the thrown being thinks back toward what has been.

In Heidegger, *Geworfenheit* and *Andenken* form a pair. 이기상 rendered
*Andenken* as 뜻새김 — "engraving meaning through recollection."

→ [Naming document](https://notes.junghanacs.com/botlog/20260319T110800.html) (Korean)

## Further reading

- **[ROADMAP.md](./ROADMAP.md) — core document.** OpenClaw vs andenken comparison table, change history, maintenance signals, role boundaries. Korean.
- **[NEXT.md](./NEXT.md) — the single next thing this agent is doing.** Korean.
- [AGENTS.md](./AGENTS.md) — agent-in-charge doc (axes, boundaries, ownership)
- [INVARIANT.md](./INVARIANT.md) — rules that must stay true across changes
- `./run.sh` — living command catalogue (what this repo can actually do)

## Recent milestones

- **2026-05-11** — Direction switch after sessions closure: qmd over public
  garden Markdown becomes the active knowledge path. qmd is installed from
  `~/repos/3rd/qmd`, linked at `~/.local/bin/qmd`, and will index
  `~/repos/gh/notes/content` before raw org/org→qmd work resumes.
- **2026-05-11** — Sessions track stabilized and closed: OpenRouter
  Qwen3-Embedding-8B / 4096d full rebuild (28,537 chunks, ~$0.065, verify
  pass), C2.1a excerpt readback, and C2.1c `session_search.withExcerpt`
  opt-in.
- **2026-05-07** — Sessions promoted to live memory tier. `session-manifest.json`
  with mtime/size stale detection picks up appended-to active conversations.
  CJK substring fallback recovers 1–2 char Hangul queries that LanceDB FTS
  drops, with an ASCII-boundary guard to keep `를`/`사` particle noise out.
  `doctor --org` verdict now carries `reasons[]`.
- **2026-04-30** — gpu2i moved to VOS chat-completion. It must not be used
  for embedding; org remains on the 4B/2560d embedding path until org/qmd changes.
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
