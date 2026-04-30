# andenken MEMORY — short-term scratchpad

> This file is the *working state of now*.
> Not history. Not a runbook. Not an incident archive.
> Target size: **under 200 lines**. When it grows past that, trim.
>
> For stable knowledge: [AGENTS.md](./AGENTS.md).
> For rules that must stay true: [INVARIANT.md](./INVARIANT.md).
> For public framing: [README.md](./README.md).

## Current State (2026-04-30)

- **Embedding provider**: Qwen3-Embedding-4B (2560d) via vLLM
- **Query path**: OpenRouter `qwen/qwen3-embedding-4b` (host-agnostic)
- **Indexing path**: gpu1i only — `localhost:18000` SSH tunnel → gpu1i:8000
- **gpu2i status**: VOS chat-completion (Qwen2.5-7B-Instruct-AWQ). NOT for embedding.
- **DB dimensions**: sessions = 2560d, org = 2560d — verify with `./run.sh status`
- **Rebuild policy**: drop + re-embed. No compact. No incremental repair.
- **Last full dual rebuild (2026-04-17)**: sessions **17,384 chunks** / org **44,167 chunks**
  / 2,010 org files / 179 policy-excluded zero-chunk / hard-guard skip 6 / verify clean
- **Search baseline**: golden **26/26 PASS** through both OpenRouter and local vLLM paths

## Open Items

- [ ] Retrieval ranking R3 — AI-transcript decay: not yet implemented (golden 26/26 is R1/R2)
- [ ] Retrieval ranking R4 — session first-result precision: not addressed
- [ ] Org chunker refinement — oversize guard shipped, but root chunker + garden heading
      cleanup still pending
- [ ] Active-memory contract — when harness starts wiring active memory into andenken,
      formalize `{ status: "timeout" | "unavailable", results: [] }` return shape on the
      query API. Until then, document as TODO, do not pre-implement.
- [ ] **gpu1i SPOF** — single embedding endpoint since gpu2i went VOS. Add health probe
      to operational dashboard or doctor; investigate whether to bring up a second
      embedding instance (different host, or carve VRAM if VOS load allows).
- [ ] **Incremental on gpu1i** — review whether `rebuild-incremental.sh` throughput is
      acceptable on a single GPU before next sync; benchmark against last dual run.

## Last Words from Previous Pass

> Keep this short. Overwrite, do not append.

- **2026-04-30**: gpu2i pulled out of embedding pool. Symlink + systemd runtime override
  flipped to Qwen2.5-7B-Instruct-AWQ + chat completion (n8n VOS workflow). Scripts renamed
  `rebuild-dual-*` → `rebuild-*`, single-tunnel, with dim probe (2560 hard gate) before
  touching the index. AGENTS / README updated. Embedding now flows through gpu1i alone.
  Llmlog: `~/org/llmlog/20260430T162537--vos-vllm-모델-준비-검토-...org` (full follow-up).

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

Indexing overrides (set by `scripts/rebuild-full.sh` / `rebuild-incremental.sh`):

```bash
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000   # gpu1i tunnel only
ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
# and unsets ANDENKEN_VLLM_API_KEY
```

## Related Notes

- `20260430T162537` — VOS vLLM 모델 준비 검토 + gpu2i 역할 전환 후속 (this transition)
- `20260325T151425` — andenken worklog (rolling)
- `20260416T115700` — QMD + GBrain pattern absorption status
- `20260408T120252` — Memory consolidation 3-stage roadmap (dream axis)
- `20260330T212639` — Embedding cost bomb analysis (why local GPU became mandatory)
- `20260321T103138` — 2-step search strategy (abstract → concrete re-query)
