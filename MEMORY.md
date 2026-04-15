# andenken MEMORY

## Active Action Plan — Local Embedding Transition (2026-04-15)

llmlog: `20260413T213051` — 전략 문서

### Phase 1: Provider Abstraction (진행중)

| Step | What | Status |
|------|------|--------|
| 1a | `embedding-provider.ts` — interface + GeminiProvider + VLLMProvider + factory | ✅ done |
| 1b | `golden-queries.ts` — provider 추상화 소비자 전환 | ✅ done (8/8 passed) |
| 1c | `cli.ts` — provider 전환 | ✅ done |
| 1d | `index.ts` — provider 전환 | ✅ done |
| 1e | `indexer.ts` — provider 전환 | ✅ done |
| 1f | `test-provider.ts` — unit 18/18 + gemini 9/9 + vllm 11/11 | ✅ done |
| 1g | `store.ts` — dimension mismatch graceful fallback | ✅ done |

### Phase 2: gpu2i Embedding Serving

| Step | What | Status |
|------|------|--------|
| 2a | Download Qwen3-Embedding-0.6B to /storage/models/ | ✅ done (1024d) |
| 2b | gpu2i vllm service → embedding model (--task embed) | ✅ done (manual) |
| 2c | Connection test from thinkpad (SSH tunnel :18000) | ✅ done |
| 2d | test-provider.ts vllm integration: 11/11 passed | ✅ done |
| 2e | cli.ts end-to-end: vLLM → FTS fallback 정상 | ✅ done |
| 2f | Download Qwen3-Embedding-8B for bake-off | ⏳ |
| 2g | vllm.nix 수정 (--task embed) + nixos-rebuild | ⏳ |

### Phase 3: Bake-off

| Step | What | Status |
|------|------|--------|
| 3a | golden-queries 확장 (11 query types) | ⏳ |
| 3b | Gemini oracle baseline 저장 | ⏳ |
| 3c | Local candidates bake-off | ⏳ |

### Key Design: EmbeddingProvider Interface

```typescript
interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocument(text: string): Promise<number[]>;
  embedDocumentBatch(texts: string[]): Promise<number[][]>;
  getStats(): EmbeddingStats;
  resetStats(): void;
}
```

### Environment Variables

```bash
# vLLM (new)
ANDENKEN_PROVIDER=vllm
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000  # SSH tunnel to gpu2i:8000
ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
# ANDENKEN_VLLM_DIMENSIONS=  # omit for auto-detect
# ANDENKEN_VLLM_QUERY_INSTRUCTION="..."  # model-dependent

# Gemini (existing, fallback)
GOOGLE_AI_API_KEY=xxx
```

### SSH Tunnel

thinkpad(192.168.10.x) ↔ gpu2i(192.168.2.x) 다른 서브넷 → 직접 접근 불가.

```bash
# SSH 포트포워딩 (세션당 1회)
ssh -f -N -L 18000:localhost:8000 gpu2i
```

### Infrastructure

- gpu2i: RTX 5080 16GB → embedding 전용 전환
- /storage/models/: NFS 10G 공유 (gpu1-3)
- hf_transfer 고속 다운로드 가능
- vllm.nix: ~/repos/work/hej-nixos-cluster/modules/gpu/vllm.nix
- Qwen3-Embedding-0.6B: 1024d, 32K context, ~1.2GB

### Dimension Mismatch Handling

기존 Gemini 768d 인덱스에 vLLM 1024d 쿼리 시:
- store.ts가 dimension mismatch 감지 → vector search skip → FTS only fallback
- 에러 없이 결과 반환 (graceful degradation)
- 실제 bake-off 시 vLLM으로 재인덱싱 필수

### Key Findings

- Qwen3-Embedding-0.6B cross-lingual ko↔en cosine similarity: **0.8595** (매우 높음)
- Matryoshka 미지원: dimensions 파라미터 보내면 400 에러 → auto-detect 모드로 해결
- GeminiProvider stats는 글로벌 싱글턴 — bake-off에서 동시 비교 시 수정 필요

### Bake-off Models

| 모델 | 차원 | 컨텍스트 | VRAM | 역할 |
|------|------|---------|------|------|
| Gemini Embedding 2 | 768d | ? | API | Oracle (기준선) |
| Qwen3-Embedding-4B | 2560d (MRL) | 32K | ~8GB | 주력 후보 |
| BAAI/bge-m3 | 1024d | 8K | ~2.2GB | 기준축 |
| Qwen3-Embedding-0.6B | 1024d | 32K | ~1.2GB | 파이프라인 검증 (완료) |

### Performance Estimates (RTX 5080)

| 시나리오 | 0.6B | 4B | 비고 |
|---------|------|-----|------|
| 단건 쿼리 | ~5ms | ~20ms | 체감 없음 |
| 증분 인덱싱 (수십 chunks) | <1초 | 1-3초 | 체감 없음 |
| 전체 재인덱싱 (~5만 chunks) | ~1-2분 | ~5-10분 | Gemini API보다 빠르고 비용 제로 |

핵심: 일상 사용(검색/증분)은 0.6B↔4B 체감 차이 없음.
전체 재인덱싱 10분 이내 = "자주 돌릴 수 있는 구조" 목표에 충분.

### Qwen3-Embedding-4B vs bge-m3

| 항목 | Qwen3-Embedding-4B | BAAI/bge-m3 |
|------|-------------------|------------|
| MTEB 다국어 | ~68 | 63.0 |
| 차원 | 2560 (MRL 지원) | 1024 |
| 컨텍스트 | 32K | 8K |
| Instruction-aware | ✅ | ❌ |
| MRL (차원 축소) | ✅ | ❌ |
| 한국어 실무 검증 | Reddit: 4B≈8B 효율적 | RAG 광범위 사용 |

4B 유리: 최고 품질, 장문 8K+, instruction 커스터마이징
bge-m3 유리: 메모리/속도, 검증된 기준축

---

## Action Plan — QMD 패턴 4건 (2026-04-13 approved)

llmlog: `20260413T174833` — 전체 계획 + 코드 분석 상세

### 실행 순서

| Step | Pattern | Lines | Status |
|------|---------|-------|--------|
| A | RRF top-rank bonus (retriever.ts rrfFusion) | ~10 | ⏳ next |
| B | Query caching (gemini-embeddings.ts, in-memory Map+TTL) | ~20 | ⏳ |
| C | Strong Signal Bypass (cli.ts + index.ts, 4 places) | ~30 | ⏳ FTS score distribution survey first |
| D | Recall Tracking (index.ts → recalls.jsonl) | ~15 | ⏳ |

### Key Constraints

- **No embedding rebuild** — all 4 patterns work with existing index
- **One at a time** — golden-queries before/after comparison per pattern
- **RRF bonus = sessions only** (rrf merge). org uses weighted merge — separate logic if needed, decide after A validates
- **Strong Signal Bypass blocker**: LanceDB FTS `_score` scale differs from SQLite FTS5. Must survey score distribution before setting thresholds (0.85/0.15 are QMD values, not ours)
- **Recall Tracking** → memory consolidation stage 2 entry point. Data feeds future MEMORY.md auto-promotion (stage 3)

### Excluded (verified reasons)

- LLM reranking: Jina v3 MRR drop 0.754→0.642 on Korean+English
- GGUF local embedding: Gemini Free tier sufficient
- MCP server, FTS5 migration, break-point scoring: too large scope

### Verification Protocol

```
1. Run golden-queries → save baseline
2. Apply one pattern (~10-30 lines)
3. Add unit test
4. Re-run golden-queries → compare
5. No quality drop → commit
6. Quality drop → rollback + analyze
```

### Review Notes (2026-04-13, from GLG)

- Pattern A(RRF bonus) sessions-only analysis correct. Validate on sessions first, then decide org
- Strong Signal Bypass trap correctly identified — FTS score scale investigation is prerequisite
- Recall → consolidation 2→3 stage roadmap acknowledged

## Architecture Quick Reference

- sessions: rrf merge, halfLife=14d, mmr=off, minScore=0.001
- org: weighted merge, halfLife=90d, mmr=on(λ=0.7), minScore=0.05
- candidateMultiplier: 4x both
- Pipeline: dictcli expand → embedQuery → vector+FTS → merge → decay → filter → MMR

## Related Notes

- `20260410T214031` — QMD vs andenken comparison (6 patterns analyzed)
- `20260408T120252` — Memory consolidation 3-stage roadmap
- `20260325T151425` — andenken worklog (Jina failure record)
- `20260330T212639` — Embedding cost bomb analysis
