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

### Two tracks inside andenken

| Track | Quality bar | Scope |
|-------|------------|-------|
| **sessions** | Parity with openclaw session memory | Core. pi + Claude Code JSONL. |
| **org** | Optional, high-signal only | 3,000+ Denote notes. Conservative scope — block first, open selectively. |

Sessions is load-bearing for agent continuity. Org is a live experiment in
curating a personal knowledge base for retrieval — still improving, not a
commitment.

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

## Provider split — sessions vs org

| Track | Model / dim | Endpoint | Why |
|-------|-------------|----------|-----|
| **Sessions** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `ANDENKEN_SESSION_*` | Live agent continuity. Incremental sync is small; full rebuild is explicitly gated. |
| **Org** | Qwen3-Embedding-4B / 2560d | `ANDENKEN_ORG_*` / vLLM-compatible path | Conservative knowledge-base indexing; separate from sessions. |

The two LanceDB stores are dimension-separated. Sessions search must use a
4096d sessions provider; knowledge search must use a 2560d org provider.

### Session sources

andenken indexes two session sources:

| Source | Directory | Notes |
|--------|-----------|-------|
| `pi` | `~/.pi/agent/sessions` | pi-native harness sessions |
| `claude` | `~/.claude/projects` | standalone Claude Code sessions |

Do **not** index `~/.pi/agent/claude-config-overlay/projects`. It is the
pi-shell-acp Claude overlay and would duplicate work already represented in pi
sessions / entwurf messages. Valid source filters are `pi`, `claude`, and
`all` (`pi + claude`) only.

## Scope and safety policy

- `journal`: only files with identifier `>= 20250101T000000`
- Exclusion tags (filetag → file skip, heading tag → subtree skip):
  `noexport`, `tts`, `noembed`, `llmlog`, `archive`
- Content chunking uses **direct body only** (no parent/child duplicates)
- Hard guard skips oversize org chunks before they can kill the run
- Policy changes are treated as **full rebuild events**, not incremental syncs

## Rebuild

```bash
cd ~/repos/gh/andenken
scripts/sync-sessions.sh           # sessions-only incremental (~30s, $0, ollama or gpu1i)
scripts/rebuild-incremental.sh     # sessions + org incremental via gpu1i
scripts/rebuild-full.sh            # full rebuild (sessions + org + verify, gpu1i)
./run.sh golden                    # search quality baseline (26/26 PASS target)
```

`sync-sessions.sh` is the operating heartbeat for the sessions track and what
the agent-config `memory-sync` skill calls under the hood. The two `rebuild-*`
scripts are for human-driven larger work.

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

- **2026-05-07** — Sessions promoted to live memory tier. `session-manifest.json`
  with mtime/size stale detection picks up appended-to active conversations.
  CJK substring fallback recovers 1–2 char Hangul queries that LanceDB FTS
  drops, with an ASCII-boundary guard to keep `를`/`사` particle noise out.
  `doctor --org` verdict now carries `reasons[]`. `scripts/sync-sessions.sh`
  auto-selects laptop ollama or gpu1i tunnel for the hourly fast path.
- **2026-04-30** — gpu2i moved to VOS chat-completion. gpu1i is the sole
  GPU-side embedding endpoint until further notice.
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
