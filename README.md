# andenken

> *An-denken* — to think toward what has been. Recollective thinking.
> Heidegger's term for the kind of memory that doesn't merely retrieve,
> but lets the past gain meaning in the present.

Semantic memory for humans and AI agents. Not a corporate RAG pipeline — an
embedding lens that lets the meaning around one existence's canonical time axis
return to the present.

> **Agent-in-charge doc** — [§andenken: 존재의 뜻새김, 시맨틱 메모리를 넘어서](https://notes.junghanacs.com/botlog/20260319T110800.html)
> (Denote `20260319T110800`, Korean). The public standing report of the agent
> who owns this repo: what andenken is for, the two turns it must make, where
> its boundaries are, and why it is named after Heidegger's *Andenken*.

## Who owns the memory

The agent-memory field mostly answers *how do we store memory intelligently*.
beads, Letta, Hermes are one family: the DB is the authority and the system is
the subject that curates. andenken sits on the opposite vertex — files are the
authority, and a human sets the coordinates. That is not a claim of superiority;
it answers a different question.

Three operating consequences follow, and each one is visible in this repo:

- **No automatic dreaming.** Memory refresh is split into four surfaces and
  none of them run on a timer by default. `--local` is cheap enough to schedule,
  but *the moment two machines come to hold the same memory* stays an explicit
  human call (`--global`). The owner is not whoever holds every beat; it is
  whoever decides the moment of coherence.
- **Memory follows the person, not the machine.** The session corpus is a
  device-merged, append-only lifetime folder with its own roster
  (`~/repos/gh/session`). If the files that own memory live on exactly one
  machine, then that machine is the real owner.
- **The doc is the only thing standing between a request and a command.** With
  no automation, a stale skill doc silently stops the memory axis. Owning the
  surface means owning its verification.

→ [에이전트 기억층 — 누가 기억의 주인인가](https://notes.junghanacs.com/botlog/20260408T120252.html)
is the shared reference where andenken, agent-config, dictcli, nixos-config and
aionsclubs each answer that question from their own repo (Korean).

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

The canonical time axis itself is not implemented here. The harness-side
[`timeline`](https://github.com/junghan0611/agent-config/tree/main/skills/timeline) collector owns KST
coordinates, event identity, source status, and provenance across timelog,
journal, agenda, notes, and git. andenken supplies the semantic turn around
that factual spine:

- **time → meaning:** retrieve session decisions and durable garden context
  around a timeline slice;
- **meaning → time:** find candidate evidence semantically, then let the
  timeline confirm when it happened and what surrounded it.

Sidecars (required but not axes):

- **dictcli** — personal vocabulary graph (Korean↔English expand, Kiwi stem)
- **denotecli** — structural graph / dblock navigation over org notes

If you want to know about the whole memory stack of the harness, andenken is
the right place to ask. The implementation here is one axis; the documentation
covers all three.

### Tracks inside andenken

| Track | Quality bar | Scope |
|-------|------------|-------|
| **sessions** | Recover decisions and continuity inside canonical time windows | Core. pi + Claude Code JSONL, indexed from the device-merged corpus (`~/repos/gh/session`) with stored timestamp/project/role/source/file signals. OpenClaw parity is a technical baseline. |
| **md (public garden)** | Recover durable interpretation attached to dated notes and events | Current production knowledge axis. Direct Markdown embedding over exported `~/repos/gh/notes/content` (~2,200 md / ~27MB). OpenClaw builtin md memory logic + LanceDB backend. |
| **openclaw (harvest)** | Recover what the bots said and kept, as its own nameable axis | Landed 2026-09-03. OpenClaw already embeds its agents' sessions and memory with `qwen/qwen3-embedding-8b` at 4096d — the same model we use, chosen independently — so the rows arrive carrying both text and vector and the import costs **zero embedding API calls**. Append-only, local only, and never a search fallback. |
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

andenken is not a harness that keeps sessions alive, and it is not a search
benchmark that finds a few concept words in a garden. It is the embedding memory
axis that brings the judgements and inventions made inside a session — long after
that session has flowed away — back around the events on the canonical time axis,
so they become the next move in the present.

> The bridge calls, the session flows away, the time axis keeps the facts, and
> andenken helps those facts gain meaning again.

**The time axis is the skeleton; the embedding is the lens.** `timeline` owns
*when* and *what*; andenken recovers *why*, *which judgement*, and *where it
continues* out of sessions and md. That runs in both directions:

1. **time → meaning** — given a date or window, read the timeline's events and
   refs, then find the session judgements and the durable garden interpretation
   around them.
2. **meaning → time** — start from today's question, find candidate sessions and
   notes, then send the timestamps, files and identifiers they yield back to the
   timeline to confirm the real coordinate and the depth around it.

An explicit date is read first, structurally. **An embedding result never becomes
the truth about time.**

```
andenken search-sessions "why did we stop the paid full rebuild"
andenken search-sessions "last week's decision" --date-from ... --date-to ...
andenken search-sessions "corpus 결정" --mode recent --project andenken
andenken search-md "2026-07-11 장염 복통"
andenken status
./run.sh corpus:manifest verify   # is the corpus itself intact?
./run.sh doctor --md              # production md triage / gap explainability
./run.sh accept                   # user-facing acceptance (API 0 by default)
```

The north-star question is not whether a generic concept term returns
something. Two days out of the real time axis define it better than any
vocabulary probe:

- **2026-02-07** — commits, stamps, notes and journal are all silent, yet the day
  holds 611.6 min of family, 358.6 min of reading, 484.6 min of sleep. Reading
  only the artifacts and answering "an empty day" is a failure.
- **2026-07-11** — sleep, reading and family time plus the journal's `장염 복통`
  and `인간 환멸`, with zero depth-2/3 artifacts. The answer is not "did
  nothing"; it is to distinguish the *depth* of the record.

So the question the system must answer is: **what did I live, what did I make,
why did I do it, and where do I continue now?**

### What andenken does not own

The boundaries are as load-bearing as the features. Each line names another
agent-in-charge who does own it.

| Not ours | Whose | Why the line matters |
|---|---|---|
| KST coordinates, event identity, source status, provenance, natural-language dates | `timeline` (agent-config) | A similarity score must never become the truth about time. andenken does not merge `empty / partial / stale / unreadable` on its own. |
| Calling, waking, resuming a session; transport between garden citizens | `entwurf` / `meta-bridge` | andenken searches what a session left behind; it does not keep sessions alive. |
| Exposing recall to each harness, composing time facts with embedding evidence | `agent-config` | One capability, but its reach differs per surface — a doc that claims three axes from the CLI misleads a sibling inside pi. |
| Korean morphology, ko↔en vocabulary pairs | `dictcli` | Layer 1 does not absorb Layer 3. Particle stripping lives here only because it is BM25 preprocessing. |
| Note structure, backlinks, dblocks | `denotecli` | Layer 2 is navigation, not retrieval. |
| Bot memory quality, chunking, model, retention — and their `openclaw-agent.sqlite` itself | OpenClaw (nixos-config) | The tier-4 track is a **harvest**, not a sync. We import; we do not tune their axis. Their databases are opened `sqlite3 -readonly` and snapshotted; we never write to them and never compact them. |
| `data/openclaw.lance` — the store those vectors land in | **andenken** | The mirror image of the row above, and the names make it easy to miss. Their vectors, our LanceDB: our schema, our ids, our FTS index, fragmented by our own import writes. So compacting it is ours to do, by name (`compact openclaw`), and nothing else will — the file exists on the authority alone. |
| The garden content itself | GLG | andenken reads the notes; it never curates the source. |

And one rule that reads like a feature but is a boundary: an overlay or a bridge
mailbox is **never** embedded as a third session source. That work is already
represented in the pi sessions; indexing it would manufacture duplicate memory.

## Architecture

```
                    ┌─ Session Indexer ─── device-merged session corpus
Query ──→ Embed ──→ │                       (pi + Claude Code .jsonl, all devices)
  │                 ├─ MD Chunker ──────── public garden (~2,200 .md, exported)
  │                 └─ (Org Chunker) ───── disabled — upstream R&D
  │
  ├─ Vector Search (sessions + md 8B/4096d; org 4B/2560d when re-enabled; LanceDB)
  ├─ Full-Text Search (BM25, Korean particle stripping)
  ├─ Hybrid Merge (weighted sum / RRF)
  ├─ Temporal Decay — OFF in production (see below); `mode=recent` carries recency
  ├─ MMR Diversity Re-ranking
  └─ dictcli Query Expansion (Korean→English cross-lingual)
```

`applyRecencyDecay` still exists in `retriever.ts`, but both live tracks pass
`recencyHalfLifeDays: 0` (`index.ts`, `cli.ts` session path, `md-search.ts`).
The 14-day half-life removed on 2026-09-03 multiplied scores by
`exp(-ln2 x age/14)` and then applied `minScore 0.001`, so an ordinary hit fell
below the floor at roughly 49 days and a strong one at roughly 85. On a memory
axis built to reach back years, that was a hard delete wearing the costume of a
ranking signal. Recency intent belongs to `--mode recent`, which is a primary
sort over stored timestamps, not a multiplier on relevance.

### Three-layer search

```
Question: "When did the embedding cost incident happen, why, and what changed?"

Timeline — canonical KST coordinates, event identity, source status
Layer 1 — andenken              Session + md semantic evidence
Layer 2 — denotecli             Structural graph / exact note navigation
Layer 3 — dictcli               Personal vocabulary bridge
```

The timeline is not Layer 0 of the embedding stack; it is the factual spine the
stack must not overwrite. The harness composes these capabilities.

Layer 1 keeps retrieval quality high on its own. Layer 2 provides navigation.
Layer 3 reflects the human's vocabulary. Each catches what the others miss.

## Multi-Harness

Same core serves pi (extension), Claude Code (skill), OpenCode (skill). Tools:
`session_search`, `knowledge_search`. In the current production surface,
`knowledge_search` points at the md track; CLI `search-knowledge` is kept as a
compatibility alias to `search-md`. See `index.ts` (pi) and `cli.ts` (CLI
harnesses).

The md path is deliberately **one shared core**: since 2026-08-11 the pi
extension's `knowledge_search`, the CLI's `search-md`, and the `golden` gate all
call `searchMdCore()` in `md-search.ts`, so the gate and the agent-facing tool no
longer measure different pipelines. A copy of a production path is not a
shortcut — `golden` once kept its own inline decay constant and silently held the
old value after production changed it.

**A capability is not equally reachable from every surface.** The CLI may carry
an axis the pi tool surface does not yet expose. Where they differ, this repo
says so rather than letting a sibling hunt for something that is not there.

### Is it any good? — three layers, and only one of them is automatic

`./run.sh accept` is the user-facing acceptance surface, deliberately separate
from `golden`:

1. **index / operator health** — API 0.
2. **retrieval behaviour** — canonical evidence rank, document-level diversity,
   and an honest `stale-index` / `corpus-miss` / `ranking-miss` classification.
   `--retrieval` opts into paid query embeddings.
3. **a human verdict** — `usable` / `partial` / `not-improved`. **No automated
   run may set this.** A green tally is not user acceptance.

Cases live in `acceptance-cases.json`, so adding one never touches code.

## Stack

- **Embeddings** Sessions + md: Qwen3-Embedding-8B via OpenRouter (4096d). Org (disabled): Qwen3-Embedding-4B (2560d).
- **Vector store** LanceDB (file-based, one file per track)
- **Retrieval** Weighted merge + RRF + MMR. Temporal decay is implemented but off in both live tracks; recency is `--mode recent`.
- **Chunking** Track-specific. Sessions: message-aware. MD: Markdown-aware. Org (disabled): org 2-tier (heading + direct body).
- **Query expansion** dictcli personal vocabulary graph
- **Runtime** TypeScript (tsx)

## Provider split — sessions, md, org

| Track | Model / dim | Endpoint | Status |
|-------|-------------|----------|--------|
| **Sessions** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `ANDENKEN_SESSION_*` → `data/sessions.lance` | Live. Indexed from the device-merged corpus since `v2026.9.3`. 76,044 chunks / 1,627 files (2026-09-03). |
| **MD** | OpenRouter `qwen/qwen3-embedding-8b` / 4096d | `ANDENKEN_MD_*` → `data/md.lance` | Live production knowledge axis. 10,704 chunks / 2,230 indexed files (2026-09-03); `doctor --md` accounts for the manifest↔indexed gap. |
| **Org** | Qwen3-Embedding-4B / 2560d | `ANDENKEN_ORG_*` → `data/org.lance` | **Disabled.** Upstream R&D only. Do not run `index:org` in production. |

LanceDB stores are dimension- and track-separated. Each track's search must use
its own provider env. The 4096d sessions/md providers and the 2560d org provider
are not cross-compatible.

### Session sources — the device-merged corpus

Since `v2026.9.3` the sessions track does **not** index a single machine's live
store. Its input is a device-merged lifetime corpus:

```
~/repos/gh/session/<device>/<the harness's own storage path>
```

The layout is the live path with one device segment prepended, and that is the
contract: `detectSource` still decides by `/.claude/`, `extractProjectName`
still reads the `projects` / `sessions` segment, so both pass unmodified and
**the lance schema did not change**.

| Source | Live path under each device | Notes |
|--------|-----------------------------|-------|
| `pi` | `~/.pi/agent/sessions` | pi-native harness sessions |
| `claude` | `~/.claude/projects` | standalone Claude Code sessions |

Two rules govern the corpus: **append-only** (never `rsync --delete`) and **real
copies** (no hardlinks — a shared inode cannot move to another machine).

Why it was needed, measured on 2026-09-02: after filtering, thinkpad held 1,137
files and oracle 1,008, overlapping on 553 — **455 files (0.69GB) existed only on
oracle**, including 64 openclaw workspace sessions with no counterpart on the
laptop. An oracle agent searching its own memory could not find its own work.

Integrity is a checksum manifest, not git. One trial commit of the corpus cost a
**806MB pack and 47m47s of gitleaks**, and append-only data has no readable diff
and no history worth rewriting. `MANIFEST.json` is the SSOT and
`MANIFEST.sha256` is `sha256sum -c` compatible — **verifiable without andenken**.
`DEVICES.json` is a separate roster (`state: active|retired`,
`transport: local|ssh|push`) because using the corpus directory listing as the
roster means trying to reach a retired machine forever.

Surfaces: `corpus:gather` / `corpus:manifest` / `corpus:replicate`. `gather`
runs as Step 0 of `sync:sessions` and `rebuild:sessions` and **refuses to index
when it fails** — an index is never built on a corpus of unknown freshness.

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

Current state (2026-09-03):

- `10,704` chunks / `2,230` indexed files / `2,245` manifest entries
- the manifest↔indexed gap is accounted for by `doctor --md` through
  `analyzeMdFile` skip reasons (`noembed_tag`, `min_body`, `all_chunks_short`,
  `deleted`, `unclassified`); the first production cut on 2026-05-12 closed with
  `18 = 3 noembed_tag + 15 min_body`, `unclassified=0`
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
./run.sh sync:sessions --local        # this device only, zero ssh, no replica touch
./run.sh sync:sessions --global       # gather every device → embed → verify → publish
./run.sh rebuild:sessions             # sessions full rebuild (estimate + confirm)
./run.sh corpus:gather [--strict]     # collect admitted sessions from every device
./run.sh corpus:manifest verify       # sha256 integrity over the corpus
./run.sh index:md                     # md incremental / full (with gate when needed)
./run.sh search:md "<query>"          # md search
./run.sh sync:openclaw [--full]       # harvest OpenClaw's own index (API 0)
./run.sh search:openclaw "<query>"    # the harvest axis — by name, never a fallback
./run.sh compact openclaw             # defrag our harvest DB (not part of `all`)
./run.sh doctor --md                  # md production triage / gap explainability
./run.sh accept                       # user-facing acceptance (API 0 by default)
./run.sh golden                       # transitional component baseline; see NEXT.md
```

`scripts/sync-sessions.sh` is the operating heartbeat for the sessions track and
what the agent-config `memory-sync` skill calls. Since 2026-09-03 it has two
modes. `--local` (the default) indexes only this device's live sessions, uses no
ssh, and does not touch the replica — cheap enough to put on a timer.
`--global` gathers every device with `--strict`, embeds, verifies, and publishes
the index, the manifest **and** the corpus in one act; that is the moment a human
is meant to hold. `--push` remains as a deprecated alias. Nothing here is
automated by default.

**Only the index authority writes.** `ANDENKEN_INDEX_AUTHORITY` (default
`thinkpad`) gates the indexer itself, not just the push — see
[INVARIANT.md](./INVARIANT.md) §7.1. The gate sits *after* Step 0, so a refused
call still completes its gather: a replica's sessions travel to the authority as
source files and come back inside the index that is pushed to it.
`ANDENKEN_ALLOW_REPLICA_INDEX=1` is a fork, not a way to catch up.

The current golden fixtures still contain vocabulary-heavy probes; they are
retained only as transitional component checks while the gate is rebuilt around
canonical timeline evidence. The md track follows the same shape (manifest-driven
incremental). The legacy mixed-track `scripts/rebuild-incremental.sh` /
`scripts/rebuild-full.sh` paths are deprecated; each track is run on its own. Org
indexing is currently disabled in production — do not invoke `index:org` outside
upstream R&D.

## Why the name

`geworfen` — the human is thrown into the world.
`andenken` — the thrown being thinks back toward what has been.

In Heidegger, *Geworfenheit* and *Andenken* form a pair. 이기상 rendered
*Andenken* as 뜻새김 — "engraving meaning through recollection."

→ The naming record lives in the ARCHIVE of the agent-in-charge doc:
[§andenken: 존재의 뜻새김](https://notes.junghanacs.com/botlog/20260319T110800.html)
(Denote `20260319T110800`, Korean) — including the rejected candidates and how
the Greek *mnemo* turned into the German *Andenken*.

## Further reading

- **[ROADMAP.md](./ROADMAP.md) — core document.** OpenClaw vs andenken comparison summary, change history, maintenance signals, role boundaries. Korean.
- **[COMPARISON.md](./COMPARISON.md) — detailed sessions + md matrix vs OpenClaw.** English.
- **[NEXT.md](./NEXT.md) — the single next thing this agent is doing.** Korean.
- **[§andenken 담당자 문서](https://notes.junghanacs.com/botlog/20260319T110800.html)
  — the public standing report of this repo's agent-in-charge.** Denote
  `20260319T110800`. Korean.
- [AGENTS.md](./AGENTS.md) — agent-in-charge doc (axes, boundaries, ownership)
- [INVARIANT.md](./INVARIANT.md) — rules that must stay true across changes
- [CHANGELOG.md](./CHANGELOG.md) — CalVer snapshots of what actually closed
- `./run.sh` — living command catalogue (what this repo can actually do)

## Recent milestones

- **2026-09-03** — sessions sync split into `--local` / `--global`, and the
  device corpus, index and manifest now publish as one act. Sessions reached
  76,044 chunks / 1,627 files; md 10,704 / 2,230.
- **2026-09-02** — `v2026.9.3`: the sessions input became a **device-merged
  lifetime corpus** (`~/repos/gh/session`) governed by a checksum manifest and a
  device roster, not git. Two long-standing quality defects closed with it — the
  2K embedding truncation (30.3% of user turns were over 2,000 chars; 51.1% of
  all user characters sat outside the index) and the 14-day recency decay that
  was deleting anything older than a season. `ANDENKEN_INDEX_AUTHORITY` now
  gates indexing itself, per INVARIANT §7.1.
- **2026-08-10** — `v2026.8.10`: pi corpus admission moved to the current native
  id suffix `_<UUIDv7>.jsonl`. pi had emitted UUIDv7 since 2026-04-15 and only
  UUIDv7 from 2026-08-07, so the old garden-id filter had been admitting zero new
  pi sessions — no error, just the pi half of the corpus going quiet.
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
