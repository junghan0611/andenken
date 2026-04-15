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

### Phase 2: GPU Embedding Serving

| Step | What | Status |
|------|------|--------|
| 2a | Download Qwen3-Embedding-0.6B | ✅ 1024d, 파이프라인 검증 완료 |
| 2b | Download Qwen3-Embedding-4B | ✅ 2560d, cross-lingual 0.8818 |
| 2c | Download BAAI/bge-m3 | ✅ 1024d |
| 2d | gpu2i vllm → embed mode | ✅ Qwen3-4B 서빙 중 |
| 2e | test-provider.ts vllm 11/11 | ✅ |
| 2f | gpu2i max-num-batched-tokens 튜닝 | ✅ 8192 (안정), 16384는 OOM |
| 2g | gpu1i 준비 → dual-GPU | ⏳ 힘 준비 중 |
| 2h | org 재인덱싱 (Qwen3-4B 2560d) | ⏳ dual-GPU 후 실행 |
| 2i | vllm.nix 수정 (--task embed) + nixos-rebuild | ⏳ |

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
# vLLM 단일 GPU
ANDENKEN_PROVIDER=vllm
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000
ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B

# vLLM dual-GPU (round-robin)
ANDENKEN_VLLM_ENDPOINT=http://localhost:18000,http://localhost:18001

# 인덱싱 성능 튜닝
INDEX_CONCURRENCY=4
ANDENKEN_EMBED_BATCH=500

# bake-off용 별도 데이터 경로 (기존 Gemini 인덱스 보호)
ANDENKEN_DATA=./data/bakeoff-qwen4b

# Gemini (existing, fallback)
GOOGLE_AI_API_KEY=xxx

# ollama (thinkpad 로컬 쿼리용 — GPU 서버 없이도 검색 가능)
ANDENKEN_PROVIDER=vllm
ANDENKEN_VLLM_ENDPOINT=http://localhost:11434
ANDENKEN_VLLM_MODEL=qwen3-embedding:4b
ANDENKEN_VLLM_PRESET=ollama/qwen3-embedding:4b
```

### 운영 모드 3가지

| 모드 | endpoint | 용도 |
|------|----------|------|
| **ollama (로컬)** | localhost:11434 | 일상 쿼리 — 터널 불필요, 즉시 응답 |
| **vLLM single** | localhost:18000 (tunnel) | 인덱싱/실험 |
| **vLLM dual** | localhost:18000,18001 | 대량 인덱싱 |

### SSH Tunnel (thinkpad → GPU 서버)

thinkpad(192.168.10.x) ↔ gpu서버(192.168.2.x) 다른 서브넷 → SSH 터널 필수.

```bash
# gpu2i (포트 18000)
ssh -f -N -L 18000:localhost:8000 gpu2i

# gpu1i (포트 18001) — dual-GPU 시
ssh -f -N -L 18001:localhost:8000 gpu1i

# 터널 상태 확인
ss -tlnp | grep -E '18000|18001'

# 터널 재설정 (끊어지면)
pkill -f "ssh -f -N -L 18000"; sleep 1; ssh -f -N -L 18000:localhost:8000 gpu2i
pkill -f "ssh -f -N -L 18001"; sleep 1; ssh -f -N -L 18001:localhost:8000 gpu1i

# 연결 확인
curl -s http://localhost:18000/v1/models | python3 -m json.tool | head -5
curl -s http://localhost:18001/v1/models | python3 -m json.tool | head -5
```

### Infrastructure

| 서버 | GPU | 역할 | 터널 포트 | 상태 |
|------|-----|------|-----------|------|
| gpu2i | RTX 5080 16GB | embedding 주력 | 18000 | ✅ Qwen3-4B 서빙 |
| gpu1i | RTX 5080 16GB | embedding 보조 | 18001 | ⏳ 준비 중 |

- /storage/models/: NFS 10G 공유 (gpu1-3) — 모델 1회 다운로드로 전체 공유
- hf_transfer 고속 다운로드
- vllm.nix: ~/repos/work/hej-nixos-cluster/modules/gpu/vllm.nix
- multi-GPU: VLLMProvider가 comma-separated endpoint로 round-robin

### Dimension Mismatch Handling

기존 Gemini 768d 인덱스에 vLLM 1024d 쿼리 시:
- store.ts가 dimension mismatch 감지 → vector search skip → FTS only fallback
- 에러 없이 결과 반환 (graceful degradation)
- 실제 bake-off 시 vLLM으로 재인덱싱 필수

### Key Findings

- Qwen3-Embedding-0.6B cross-lingual ko↔en: **0.8595**
- Qwen3-Embedding-4B cross-lingual ko↔en: **0.8818** (4B가 더 높음)
- Matryoshka 미지원: dimensions 파라미터 보내면 400 에러 → `truncateDimensions` 플래그로 분리
- vLLM 서버 사이드 배치 제한이 진짜 병목 (GPU 처리량 아님)
- max-num-batched-tokens=16384에서 4B 모델 OOM → 8192가 안정
- GeminiProvider stats는 글로벌 싱글턴 — bake-off에서 동시 비교 시 수정 필요

### Bake-off 재인덱싱 상태

- `data/bakeoff-qwen4b/` — manifest checkpoint 보존
- dual-GPU 준비 후 재시작 예정
- 인덱싱 완료 후 golden-queries bake-off 실행

### Bake-off Models

| 모델 | 차원 | 컨텍스트 | VRAM | 역할 |
|------|------|---------|------|------|
| Gemini Embedding 2 | 768d | ? | API | Oracle (기준선) |
| Qwen3-Embedding-4B | 2560d (MRL) | 32K | ~8GB | 주력 후보 |
| BAAI/bge-m3 | 1024d | 8K | ~2.2GB | 기준축 |
| Qwen3-Embedding-0.6B | 1024d | 32K | ~1.2GB | 파이프라인 검증 (완료) |

### Performance (RTX 5080 + vLLM tuning)

#### vLLM 서버 튜닝 (핵심)

`--max-num-batched-tokens 16384` (default 2048에서 8배)

| 배치 | Before (2048) | After (16384) | 배수 |
|------|-------------|-------------|------|
| 1 | 0.5 emb/s | 9.2 emb/s | 18x |
| 10 | 2.6 emb/s | 122.8 emb/s | 47x |
| 50 | 10.3 emb/s | 331.4 emb/s | 32x |
| 100 | - | 357.1 emb/s | - |

병목은 GPU 처리량이 아니라 서버 사이드 배치 제한이었음.

#### 인덱싱 시간 예측

| 시나리오 | 예상 시간 |
|---------|----------|
| 전체 재인덱싱 (~97K chunks) | ~5분 (stemming) + ~5분 (embedding) = **~10분** |
| 증분 인덱싱 (수십 chunks) | <1초 |
| 단건 쿼리 | ~100ms |

"자주 돌릴 수 있는 구조" 목표 달성. gpu 추가 없이 단일 RTX 5080으로 충분.

#### vLLM 서빙 설정

```bash
# 공통 (모든 GPU 서버)
--model /storage/models/vllm/default    # NFS symlink
--task embed
--max-model-len 8192

# RTX 5080 16GB VRAM 기준
--max-num-batched-tokens 8192    # 안정 (16384는 4B에서 OOM)

# symlink 관리 (gpu 서버에서)
ln -sfn /storage/models/vllm/Qwen3-Embedding-4B /storage/models/vllm/default
sudo systemctl restart vllm-api
```

#### dictcli stem 프로토콜 수정 (2026-04-15)

- 멀티라인 청크가 줄 단위 프로토콜에서 분해되는 문제 해결
- `texts.join("\n")` → `texts.map(t => t.replace(/\n/g, " ")).join("\n")`
- timeout 5분 → 15분, stem 출력 줄 수 불일치 경고 추가
- dictcli core.clj 괄호 불균형 버그도 동시 수정

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
