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
                 │ MD (public garden export): Qwen3-Embedding-8B (4096d).
                 │ Org: 4B/2560d — currently disabled (upstream R&D).
                 │ Two live tracks: sessions and md.

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
| **md (public garden)** | Immediately usable knowledge retrieval for agents | Current production knowledge axis. Direct Markdown embedding over exported `~/repos/gh/notes/content` (~2,200 md / ~27MB). OpenClaw builtin md memory logic + LanceDB backend (same pattern that built the org track). First production cut closed on 2026-05-12. |
| **org** | Currently disabled | 3,000+ Denote notes. Source track. Doctor/chunker/incremental work is upstream R&D, **not** what agents consume right now. |

**Split of effort.** The agent-in-charge separates *what we ship to agents now*
from *upstream development*:

- **Now:** sessions + md tracks. These are what agents consume as memory axes.
  Garden export is controlled, easier to tune, and immediately useful.
- **Upstream:** org track. Org notes are richer but messier; few people actually
  retrieve them well today. Doctor WARN cleanup, chunker improvements, and
  incremental sync all live here. Disabled in production until it earns its keep.

The previous qmd-over-garden-MD plan was retired on 2026-05-12 (issue #8).
qmd's local-GGUF rerank/expand stack was too heavy for interactive retrieval
(~53s/query on 90-file smoke). The current md track keeps the same garden
source but uses the same simple **embed → LanceDB → hybrid retrieve** contract
as the sessions track.

## What It Does

Records buried in time — session conversations and the exported public garden —
are embedded into vector space. The current production surface is deliberately
narrow: session continuity + md knowledge axis first, with org left in
upstream R&D until it earns a return path.

```
andenken search-sessions "NixOS GPU cluster setup"
andenken search-md "체화인지 embodied cognition"
andenken search-knowledge "체화인지 embodied cognition"   # compatibility alias
andenken status
./run.sh doctor --md       # production md triage / gap explainability
```

## Architecture

```
                    ┌─ Session Indexer ─── pi sessions (.jsonl)
Query ──→ Embed ──→ │                  └── Claude Code sessions (.jsonl)
  │                 ├─ MD Chunker ──────── public garden (~2,200 .md, exported)
  │                 └─ (Org Chunker) ───── disabled — upstream R&D
  │
  ├─ Vector Search (sessions + md 8B/4096d; org 4B/2560d when re-enabled; LanceDB)
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
`session_search`, `knowledge_search`. In the current production surface,
`knowledge_search` points at the md track; CLI `search-knowledge` is kept as a
compatibility alias to `search-md`. See `index.ts` (pi) and `cli.ts` (CLI
harnesses).

## Stack

- **Embeddings** Sessions + md: Qwen3-Embedding-8B via OpenRouter (4096d). Org (disabled): Qwen3-Embedding-4B (2560d).
- **Vector store** LanceDB (file-based, one file per track)
- **Retrieval** Weighted merge + RRF + temporal decay + MMR
- **Chunking** Track-specific. Sessions: message-aware. MD: Markdown-aware. Org (disabled): org 2-tier (heading + direct body).
- **Query expansion** dictcli personal vocabulary graph
- **Runtime** TypeScript (tsx)

## Provider split — sessions, md, org

| Track | Model / dim | Endpoint | Status |
|-------|-------------|----------|--------|
| **Sessions** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `ANDENKEN_SESSION_*` → `data/sessions.lance` | Live. Closed and stable. |
| **MD** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `ANDENKEN_MD_*` → `data/md.lance` | Live production knowledge axis. First production cut: 10,119 chunks / 2,192 indexed files, with `doctor --md` explaining the remaining 18 zero-chunk files. |
| **Org** | Qwen3-Embedding-4B / 2560d | `ANDENKEN_ORG_*` → `data/org.lance` | **Disabled.** Upstream R&D only. Do not run `index:org` in production. |

LanceDB stores are dimension- and track-separated. Each track's search must use
its own provider env. The 4096d sessions/md providers and the 2560d org provider
are not cross-compatible.

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

| `source` value      | Candidate pool        | MD cross-track fallback |
|---------------------|-----------------------|-------------------------|
| omitted / `all`     | pi + claude (mixed)   | enabled when results are thin |
| `pi`                | pi only (LanceDB-side filter) | disabled (sessions-only intent) |
| `claude`            | claude only (LanceDB-side filter) | disabled (sessions-only intent) |

The source filter is pushed down into LanceDB at the vector / FTS / substring
query level so the candidate pool is source-specific. Explicit `pi` or `claude`
also suppresses the md knowledge fallback — if the caller named a session
source, they asked for sessions, not garden notes.

## md track — public garden direct embedding

The md track starts from the exported public garden, not raw org. Garden export
is a controlled surface (already shaped by Hugo + Denote conventions) and
therefore much easier to tune than the raw Denote tree.

| Surface | Path | Notes |
|---------|------|-------|
| md source | `~/repos/gh/notes/content` | exported Markdown; ~2,200 md / ~27MB |
| md store | `data/md.lance` | LanceDB, dimension 4096d |
| md manifest | `data/md-manifest.json` | mtime/size based incremental |
| provider env | `ANDENKEN_MD_*` | OpenRouter qwen/qwen3-embedding-8b |
| md doctor | `./run.sh doctor --md` | provider / DB / manifest / gap explainability |

Current first-cut baseline:

- `10,119` chunks / `2,192` indexed files / `2,210` manifest entries
- gap `18` is fully explained by `doctor --md`
  - `3` files skipped by `noembed_tag`
  - `15` files skipped by `min_body`
  - `0` unclassified drift
- chunk count is intentionally much lower than org (`44,916`) because the md
  chunker emits larger, denser OpenClaw-style CJK-weighted chunks rather than
  org's heading/body two-tier fragments.

The implementation ports OpenClaw's builtin md memory logic
(`~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/`) onto the same
LanceDB backend used by the sessions track. This is the exact pattern the org
track was built with originally — OpenClaw core + LanceDB substitute for
sqlite. See [COMPARISON.md](./COMPARISON.md) for the track-by-track matrix.

## Scope and safety policy

- `journal`: only files with identifier `>= 20250101T000000`
- Exclusion tags / skip reasons are surfaced through `analyzeMdFile` and
  `doctor --md` (`noembed_tag`, `min_body`, `all_chunks_short`, `deleted`,
  `unclassified`)
- Content chunking uses **direct body only** (no parent/child duplicates)
- Policy changes are treated as **full rebuild events**, not incremental syncs

## Rebuild / sync

```bash
cd ~/repos/gh/andenken
scripts/sync-sessions.sh              # sessions incremental (8B/4096d)
scripts/rebuild-sessions-full.sh      # sessions full rebuild (estimate + confirm)
./run.sh index:md                     # md incremental / full (with gate when needed)
./run.sh search:md "<query>"          # md search
./run.sh doctor --md                  # md production triage / gap explainability
./run.sh golden                       # current quality baseline surface (B2 expands md coverage)
```

`sync-sessions.sh` is the operating heartbeat for the sessions track and what
the agent-config `memory-sync` skill calls. The md track follows the same
shape (manifest-driven incremental). The legacy mixed-track
`scripts/rebuild-incremental.sh` / `scripts/rebuild-full.sh` paths are
deprecated; each track is run on its own. Org indexing is currently disabled
in production — do not invoke `index:org` outside upstream R&D.

## Why the name

`geworfen` — the human is thrown into the world.
`andenken` — the thrown being thinks back toward what has been.

In Heidegger, *Geworfenheit* and *Andenken* form a pair. 이기상 rendered
*Andenken* as 뜻새김 — "engraving meaning through recollection."

→ [Naming document](https://notes.junghanacs.com/botlog/20260319T110800.html) (Korean)

## Further reading

- **[ROADMAP.md](./ROADMAP.md) — core document.** OpenClaw vs andenken comparison summary, change history, maintenance signals, role boundaries. Korean.
- **[COMPARISON.md](./COMPARISON.md) — detailed sessions + md matrix vs OpenClaw.** English.
- **[NEXT.md](./NEXT.md) — the single next thing this agent is doing.** Korean.
- [AGENTS.md](./AGENTS.md) — agent-in-charge doc (axes, boundaries, ownership)
- [INVARIANT.md](./INVARIANT.md) — rules that must stay true across changes
- `./run.sh` — living command catalogue (what this repo can actually do)

## Recent milestones

- **2026-05-12** — md first production cut closed. Live knowledge surface
  pivoted from org to md; `knowledge_search` now points at the public garden
  track, Oracle sync handoff is in place, and `doctor --md` explains the
  manifest↔indexed gap (`18 = 3 noembed_tag + 15 min_body`, `unclassified=0`).
- **2026-05-12** — qmd path retired (issue #8). md track redefined as direct
  Markdown embedding over the public garden export, ported from OpenClaw
  builtin md memory logic onto the sessions LanceDB backend. Org track marked
  disabled in production — agents consume sessions + md only.
- **2026-05-11** — Sessions track stabilized and closed: OpenRouter
  Qwen3-Embedding-8B / 4096d full rebuild (28,537 chunks, ~$0.065, verify
  pass), C2.1a excerpt readback, and C2.1c `session_search.withExcerpt`
  opt-in.
- **2026-04-17** — OpenRouter query path + provider split. Indexing stays on
  local GPU; queries run from any host.
- **2026-03-30** — Korean particle stripping for BM25 (ported from openclaw).
- **2026-03-21** — 2-step search strategy: abstract → read top-3 → re-search
  with concrete terms. Encoded in `promptGuidelines`.

## Related

- [geworfen](https://github.com/junghan0611/geworfen) — existence data dashboard
- [agent-config](https://github.com/junghan0611/agent-config) — harness infra
- [dictcli](https://github.com/junghan0611/dictcli) — vocabulary graph
- [denotecli](https://github.com/junghan0611/denotecli) — Denote KB CLI

## License

MIT
