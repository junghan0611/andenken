# andenken MEMORY — short-term scratchpad

> This file is the *working state of now*.
> Not history. Not a runbook. Not an incident archive.
> Target size: **under 200 lines**. When it grows past that, trim.
>
> For stable knowledge: [AGENTS.md](./AGENTS.md).
> For rules that must stay true: [INVARIANT.md](./INVARIANT.md).
> For public framing: [README.md](./README.md).

## Current State (2026-04-22)

- **Embedding provider**: Qwen3-Embedding-4B (2560d) via vLLM
- **Query path**: OpenRouter `qwen/qwen3-embedding-4b` (host-agnostic)
- **Indexing path**: local GPU vLLM `localhost:18000,18001`
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
- [ ] gpu1i standby → dual-GPU ready (tunnel port 18001)

## Last Words from Previous Pass

> Keep this short. Overwrite, do not append.

- **2026-04-22**: doctor `--org` stage 1 shipped (`656d902`). Hard-guard skip persistence
  added — `indexer.ts` writes per-file `skippedOversize` into manifest, `doctor-org.ts`
  reads it into chunk-health aggregate. Scope was metadata-only; re-embedding **not**
  required (`chunkOrgFile`, hard-guard condition, `embedDocumentBatch` input, LanceDB
  schema all unchanged). Documented in worklog note `20260325T151425`.

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

Indexing overrides (set by `scripts/rebuild-dual-full.sh`):

```bash
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000,http://localhost:18001
ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
# and unsets ANDENKEN_VLLM_API_KEY
```

## Related Notes

- `20260325T151425` — andenken worklog (rolling)
- `20260416T115700` — QMD + GBrain pattern absorption status
- `20260408T120252` — Memory consolidation 3-stage roadmap (dream axis)
- `20260330T212639` — Embedding cost bomb analysis (why local GPU became mandatory)
- `20260321T103138` — 2-step search strategy (abstract → concrete re-query)
