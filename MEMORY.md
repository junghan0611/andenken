# andenken MEMORY — short-term scratchpad

> This file is the *working state of now*.
> Not history. Not a runbook. Not an incident archive.
> Target size: **under 200 lines**. When it grows past that, trim.
>
> For stable knowledge: [AGENTS.md](./AGENTS.md).
> For rules that must stay true: [INVARIANT.md](./INVARIANT.md).
> For public framing: [README.md](./README.md).

## Current State (2026-05-07)

- **Embedding provider**: Qwen3-Embedding-4B (2560d) via vLLM-compatible endpoint
- **Query path**: OpenRouter `qwen/qwen3-embedding-4b` (host-agnostic)
- **Indexing path (sessions, fast)**: laptop ollama `localhost:11434` (preferred)
  → falls back to gpu1i tunnel if ollama not running
- **Indexing path (org / full rebuild)**: gpu1i tunnel `localhost:18000` (mandatory)
- **gpu2i status**: VOS chat-completion (Qwen2.5-7B-Instruct-AWQ). NOT for embedding.
- **DB dimensions**: sessions = 2560d, org = 2560d — verify with `./run.sh status`
- **Manifests**: `org-manifest.json` + **`session-manifest.json`** (new this round)
- **Last full dual rebuild (2026-04-17)**: sessions 17,384 / org 44,167 / golden 26/26 PASS
- **Current incremental state (2026-05-07)**: sessions **27,227 chunks / 1,521 files**,
  org 44,916 chunks / 2,025 files. Hourly session sync via memory-sync skill.

## Operating Mode (new)

- **sessions = live tier**, indexed every 30–60 min via `scripts/sync-sessions.sh`
  / agent-config `memory-sync` skill. Compact-not strategy: instead of summarizing
  the past, keep the raw transcript searchable so any earlier turn can be re-found.
- **org = stable tier**, refreshed only on explicit human-driven runs from this repo.
- **Cost discipline**: sessions sync runs through laptop ollama (free) by default.
  Anything that could spend money (full rebuild, oracle full sync) is human-only —
  the skill refuses to do it.

## Open Items

- [ ] Retrieval ranking R3 — AI-transcript decay: not yet implemented (golden 26/26 is R1/R2)
- [ ] Retrieval ranking R4 — session first-result precision: not addressed
- [ ] Org chunker refinement — oversize guard shipped, but root chunker + garden heading
      cleanup still pending
- [ ] Active-memory contract — when harness starts wiring active memory into andenken,
      formalize `{ status: "timeout" | "unavailable", results: [] }` return shape on the
      query API. Until then, document as TODO, do not pre-implement.
- [ ] **gpu1i SPOF for org/full rebuild** — single embedding endpoint for the bulk path
      since gpu2i went VOS. Sessions-fast path now has ollama as a second engine, but
      org rebuild still has no second source.
- [ ] **Interleave ratio tuning** — current 1:1 round-robin merges short-CJK substring
      hits with FTS hits; asymmetric queries may over-boost substring. Decide ratio
      with real query logs, not synthetic golden.
- [ ] **session-manifest health → doctor** — manifest stats (new/stale/deleted/to-index)
      are visible in `./run.sh status` but not in `./run.sh doctor` general yet.

## Last Words from Previous Pass

> Keep this short. Overwrite, do not append.

- **2026-05-07**: Sessions promoted to live memory tier with hourly incremental sync.
  Track 0 (session-manifest mtime/size detection) closes the long-running JSONL gap
  — append-only conversations are now picked up. Track 1 (CJK substring fallback +
  ASCII boundary guard) recovers 1–2 char Hangul queries that LanceDB FTS drops.
  Track 3 (doctor `reasons[]`) makes WARN/FAIL self-explaining. New
  `scripts/sync-sessions.sh` auto-selects ollama (laptop) or gpu1i tunnel; same
  Qwen3-Embedding-4B 2560d → identical LanceDB. 4 fix rounds + gpt-5.5 review
  passes; commits `32478c3` + `76d9703`. Llmlog:
  `~/org/llmlog/20260507T144916--§andenken-세션-임베딩-품질-openclaw-대비-개선사항...org`.

- **2026-04-30**: gpu2i pulled out of embedding pool. Now Qwen2.5-7B-Instruct-AWQ +
  chat completion. Embedding flows through gpu1i alone (until 2026-05-07's ollama
  addition for sessions-fast path).

## Environment Quick Reference

Query-time (`~/.env.local`):

```bash
ANDENKEN_PROVIDER=vllm
ANDENKEN_VLLM_ENDPOINT=https://openrouter.ai/api
ANDENKEN_VLLM_MODEL=qwen/qwen3-embedding-4b
ANDENKEN_VLLM_API_KEY="$OPENROUTER_API_KEY"
ANDENKEN_VLLM_DIMENSIONS=2560
ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
```

Sessions-fast indexing (`scripts/sync-sessions.sh` sets these per backend):

```bash
# ollama path (preferred when laptop ollama is running)
ANDENKEN_VLLM_ENDPOINT=http://localhost:11434
ANDENKEN_VLLM_MODEL=qwen3-embedding:4b
ANDENKEN_VLLM_TIMEOUT_MS=300000
ANDENKEN_EMBED_BATCH=64

# gpu1i fallback (when ollama is down)
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000
ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
```

Full rebuild / org indexing (`scripts/rebuild-*.sh` set these):

```bash
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000   # gpu1i tunnel only
ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
# and unsets ANDENKEN_VLLM_API_KEY (no accidental external billing)
```

## Related Notes

- `20260507T144916` — andenken session embedding quality vs openclaw (this round)
- `20260430T162537` — VOS vLLM 모델 준비 검토 + gpu2i 역할 전환
- `20260325T151425` — andenken worklog (rolling)
- `20260416T115700` — QMD + GBrain pattern absorption status
- `20260408T120252` — Memory consolidation 3-stage roadmap (dream axis)
- `20260330T212639` — Embedding cost bomb analysis (why local GPU became mandatory)
- `20260321T103138` — 2-step search strategy (abstract → concrete re-query)
