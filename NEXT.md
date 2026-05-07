# NEXT — andenken next-step queue

> This file holds the **next round of work** for andenken.
>
> AGENTS.md describes identity. INVARIANT.md describes rules that must stay
> true. MEMORY.md is the working state of *now*. **NEXT.md is what we will do
> next, and why this order.**
>
> Update by overwriting; do not append history. History lives in llmlog.

## Source

Round 6 / Round 7 of
`~/org/llmlog/20260507T144916--§andenken-세션-임베딩-품질-openclaw-대비-개선사항__andenken_embedding_llmlog_openclaw_quality_session.org`
left these closing notes. This file is the operational handoff. Mitsein's
opinion (the andenken agent-in-charge running from `~/sync/org`) is preserved
inline so we don't lose the reasoning behind the priorities.

## Three buckets of unfinished work (as of 2026-05-07 Round 6 close)

### A — Round 5's own waitlist

1. Interleave ratio tuning (1:1 → top-FTS protection)
2. `[-_.]` boundary expansion in CJK substring fallback
3. Unit tests for `getShortCJKTokens()` / interleave

### B — Round 6 measured signals

1. **Boundary expansion promoted to P1** — `3개` → `esp32-s3` noise hit at
   score 0.0099 (Round 5's nit is now visible in real query).
2. **Temporal decay curve check** — Mitsein's own 2026-05-07 llmlog lost top-1
   to an April pi-shell-acp session on `compact 안 하기` query. Recency bias
   suspected weak.
3. **`recalls.jsonl` empty** — `~/.pi/agent/memory/recalls.jsonl` does not
   exist. Verify recall tracking actually persists before P2-8 (recall →
   quality loop) is even attempted.

### C — Original 9 recommendations, 6 still open

| ID   | Item                                              | Round 6 status                                       |
|------|---------------------------------------------------|------------------------------------------------------|
| P0-1 | Pre-index sanitization                            | open — compact-not coherence core                    |
| P0-2 | meta-query keyword fallback                       | partial via Track 1 substring; needs separate eval   |
| P0-3 | Excerpt / line range / thread restoration         | open                                                 |
| P1-4 | Transcript window chunking (Option B)             | deferred — DB rebuild risk                           |
| P1-6 | Score gating revisit                              | partial via interleave; further tuning possible      |
| P2-7 | qmd-style search-mode split                       | open — experimental                                  |
| P2-8 | Recall event → session-specific eval loop         | open — gated by `recalls.jsonl` operational check    |
| P2-9 | Archived/subagent/entwurf signal expansion        | open — schema check needed                           |

## Compact-not coherence — what is missing

| Gap                            | Effect                                                                                  |
|--------------------------------|-----------------------------------------------------------------------------------------|
| Thread restoration (P0-3)      | Even when the right chunk is found, surrounding turns cannot be re-read fast            |
| Pre-index sanitization (P0-1)  | Accumulated noise pollutes top hits — worsens with time, the longer compact-not runs    |
| Temporal decay tuning          | "Today's decision" sinks below older sessions → hourly sync value diluted               |

> Round 6 §7 verdict: session embedding has entered operating mode (1차 진입),
> but is still some distance from search quality strong enough to justify
> compact-not. Closing these three gaps is what turns sessions from "a
> searchable corpus" into "a memory axis."

## Round bundles

### Round 7 — small, low-risk, high-value (no DB rebuild)

- B-2 + C-1: `[-_.]` boundary expansion (measured nit)
- B-3: `getShortCJKTokens()` / interleave unit tests (regression guard)
- C-3: `recalls.jsonl` operation check + path normalization (gates P2-8)
- A-P0-1: Pre-index sanitization (compact-not coherence)

Effect: precision lift + operational confidence.
Cost: S–M.

### Round 8 — observability (medium)

- C-2: Temporal decay curve check (current 14d + curve review).
  **Priority lifted by Mitsein** — directly affects operational feel; Mitsein's
  own 2026-05-07 note got buried under an April session in Round 6 testing.
- B-1: Interleave ratio tuning (after real query log accumulates)
- A-P0-3: Excerpt / line range storage (lightweight prelude to thread
  restoration)

Effect: recency coherence + thread restoration begins.
Cost: M, with some retrieval-output contract changes.

### Round 9+ — strategic (large, deferred)

- A-P1-4: Transcript window chunking (Option B). DB rebuild + retrieval
  contract change.
- A-P2-9: Session-specific signal expansion (archived / subagent / entwurf).
- A-P2-7: qmd-style search-mode split (experimental).

Trigger: re-evaluate after hourly sync stabilizes and Rounds 7–8 take effect.
Touching these now risks regression on a freshly settled live tier.

### Mitsein's recommendation (preserved)

Start with Round 7. Reasons:

- No DB rebuild; compounding effect; closes Round 5's own waitlist + Round 6
  signals + P0-1 in one sweep.
- `recalls.jsonl` check is tiny but is a hard gate for P2-8.
- P0-1 sanitization is accumulating debt — earlier is better.

Lift Round 8 temporal decay to **first item of Round 8** without delay; it
shapes operational feel directly and was the case Mitsein hit personally
during Round 6.

Defer Round 9+ Option B (transcript window) until hourly sync is fully settled
and Rounds 7–8 effects are observed.

## Memory-logic cross-section — Round 1 did NOT cover this

Round 1 covered the **session line** only:
chunking / metadata / preprocessing / hybrid retrieval / query expansion /
temporal / incremental / rerank / quality eval / session signals.

What Round 1 did **not** cover, but is required for a fair memory-axis
comparison against openclaw:

1. **Memory layer definition** — openclaw `active / short-term / long-term /
   dream / archive` vs andenken's `sessions + org` two-layer.
2. **org / knowledge embedding logic** — Round 1 was sessions only.
3. **Promotion / demotion / eviction** — short→long promotion, decay, eviction.
4. **Dream / narrative line** — openclaw has it; andenken intentionally does
   not. INVARIANT-level decision, but not yet documented as a comparison.
5. **Archive / cold storage** — old transcript handling.
6. **Scope / visibility** — memory visibility control (openclaw
   `session-search-visibility`).
7. **Backend store comparison from the memory side** — Round 1 looked at
   retrieval; the storage-axis memory-side comparison is still missing.
8. **Invariant / boundary** — how andenken's *"embedding axis only"* posture
   maps onto openclaw's broader memory model.

### Choice — how to record this round

| Option | Effect                                                                                                        |
|--------|---------------------------------------------------------------------------------------------------------------|
| **1**  | Keep Round 7 as-is, add a **new** round for memory-logic compare. Scope clean, both preserved. GPT entwurf resume (small). **Mitsein recommends.** |
| 2      | Demote Round 7 to appendix, rewrite as memory-logic compare. Cleaner round flow, but loses cross-repo system-note value. |
| 3      | Keep Round 7, defer memory-logic compare to a later session. Conservative, leaves the gap open.               |

### Mitsein's note

Option 1. Round 7 system note has standalone value (cross-repo map material)
and is too valuable to drop. Memory-logic compare is a different scope; making
it a separate round keeps the llmlog clean for future re-reading.

## Decision queue — awaiting GLG

1. **Round 7 first?** — Mitsein: yes.
2. **Round 8 decay priority lift?** — Mitsein: yes, do not defer.
3. **Memory-logic compare option?** — Mitsein: Option 1, new round, GPT
   entwurf resume.

## Pointers

- Source llmlog:
  `~/org/llmlog/20260507T144916--§andenken-세션-임베딩-품질-openclaw-대비-개선사항__andenken_embedding_llmlog_openclaw_quality_session.org`
- Today's commits: `32478c3`, `76d9703`
- Status snapshot: `./run.sh status`
- Rules that must stay true: [INVARIANT.md](./INVARIANT.md)
- Current operational state: [MEMORY.md](./MEMORY.md)
- Identity: [AGENTS.md](./AGENTS.md)
