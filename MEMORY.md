# andenken MEMORY

> **Reading order.** Sections marked `## Current` describe the present operational state.
> Sections marked `## Historical` are closed incidents / migration notes kept for archaeological
> reference only — do **not** treat them as current truth. When a Historical section contradicts
> a Current section, Current wins.

## Current Operational State (2026-04-17)

- **Embedding provider:** Qwen3-Embedding-4B (2560d) via vLLM. No Gemini calls in operation.
- **DB dimensions:** sessions = 2560d, org = 2560d. Verified by `./run.sh status`.
- **Rebuild policy:** no compact, no incremental repair. Drop and re-embed.
- **Rebuild script:** `scripts/rebuild-dual-full.sh`.
- **Status verifies DB truth:** `./run.sh status` reads the actual vector dim from each
  LanceDB table and flags any provider↔DB mismatch explicitly (no silent fallback).

Everything below this line is either (a) active action plan, or (b) historical record.
If you are a new agent, stop here and run `./run.sh status` before reading further.

---

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
| 2g | gpu1i 준비 → dual-GPU | ⏳ 가용 |
| 2h | org 재인덱싱 (Qwen3-4B 2560d) | ✅ 106,674 chunks, hybrid 검증 완료 |
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

# OpenRouter (host-agnostic 쿼리용 — thinkpad/Oracle 어디서든 작동)
ANDENKEN_PROVIDER=vllm
ANDENKEN_VLLM_ENDPOINT=https://openrouter.ai/api
ANDENKEN_VLLM_MODEL=qwen/qwen3-embedding-4b
ANDENKEN_VLLM_API_KEY="$OPENROUTER_API_KEY"
ANDENKEN_VLLM_DIMENSIONS=2560
ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
```

### 운영 모드 3가지 (2026-04-17 갱신)

| 모드 | endpoint | 용도 |
|------|----------|------|
| **OpenRouter (쿼리 default)** | `https://openrouter.ai/api` | 일상 쿼리 — thinkpad/Oracle 어디서든. 쿼리당 ~$0 |
| **vLLM single** | localhost:18000 (tunnel) | 인덱싱/실험 |
| **vLLM dual** | localhost:18000,18001 | 대량 인덱싱 — `scripts/rebuild-dual-full.sh` |

로컬 ollama는 2026-04-17부로 **의존 제거** — 2560d Qwen3 호출이 OpenRouter로 통합됨.

**양자화/서빙 차이 주의:**
- vLLM (GPU 서버): SafeTensors fp16 — 인덱싱용 풀 정밀도
- OpenRouter: 호스팅 inference (정확한 스펙 공개 X). 2560d 동일.
- golden-queries 26/26 PASS through both paths (2026-04-17 검증)

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

**[Historical — migration-era behavior, pre-2026-04-17]**
과거 Gemini 768d 인덱스에 vLLM 쿼리를 섞어 쓰던 전환기 동작:
- store.ts가 dimension mismatch 감지 → vector search skip → FTS only fallback
- 에러 없이 결과 반환 (graceful degradation)

**Current (2026-04-17~):**
현재 운영 DB는 sessions/org 모두 2560d. Provider↔DB mismatch가 감지되면
`./run.sh status` 와 `doctor` 가 경고를 띄운다. 정상 상태에서는 발생하지 않는다.

### Key Findings

- Qwen3-Embedding-0.6B cross-lingual ko↔en: **0.8595**
- Qwen3-Embedding-4B cross-lingual ko↔en: **0.8818** (4B가 더 높음)
- Matryoshka 미지원: dimensions 파라미터 보내면 400 에러 → `truncateDimensions` 플래그로 분리
- vLLM 서버 사이드 배치 제한이 진짜 병목 (GPU 처리량 아님)
- max-num-batched-tokens=16384에서 4B 모델 OOM → 8192가 안정
- GeminiProvider stats는 글로벌 싱글턴 — bake-off에서 동시 비교 시 수정 필요

### Bake-off 인덱싱 상태

- `data/bakeoff-qwen4b/org.lance` — **94,931 chunks, 2560d, err:0** (완료)
- cleanup 완료 — 25K duplicate 제거됨
- 운영 org.lance로 승격 완료

### 운영 상태 (2026-04-17 final verified dual rebuild)

- org-aware break point scoring + 마이크로헤딩 병합 구현은 유지
- **content chunk는 subtree 전체가 아니라 direct body만 임베딩** — 구조는 heading tier / child chunk가 담당
- **저널은 2025년 이후만 임베딩** (`identifier >= 20250101T000000`)
- **제외 태그 정책 활성화**: `noexport`, `tts`, `noembed`, `llmlog` (filetag면 전체 파일, heading tag면 subtree 제외, case-insensitive, `:ARCHIVE:` subtree 제외 유지)
- 기본 원칙은 **block first, open selectively later** — 임베딩 크기보다 신호 밀도가 우선
- **hard guard 활성화**: `ANDENKEN_ORG_EMBED_MAX_CHARS` 기본값 `12000` 초과 org chunk는 임베딩에서 skip + warning
- **manifest는 성공 후 갱신**, zero-chunk 파일도 기존 DB row를 지우도록 write-path 보강
- 재현 가능한 전체 리빌드 스크립트:
  - `scripts/rebuild-dual-full.sh`
- 2026-04-17 검증 완료 수치:
  - Sessions: **17,384 chunks | 0 errors | 204s**
  - Org: **44,167 chunks | 0 errors | 439s**
  - Org indexed files: **2,010**
  - 0-chunk policy-excluded files: **179**
  - hard-guard skip: **6 chunks**
  - org DB size: **579M**
- verify 결과:
  - no duplicate IDs
  - no orphan files
  - row count consistent
  - manifest clean
  - no ghost zone
- search baseline:
  - `npx tsx golden-queries.ts --db org` → **8/8 PASS**
- 해석: conservative scope + direct-body chunking + single-writer + zero-chunk cleanup + hard guard 조합이 실제 dual-GPU full rebuild에서도 안정적으로 동작함을 검증했다.
- **중요**: 2026-04-16에 shared `WriteBuffer` 동시성 버그 확인. dual-GPU / 병렬 임베딩 중 `sessions.lance`, `org.lance` 모두 duplicate rows가 생길 수 있었음.
- **현재 운영 판단**: write-buffer fix 이전에 생성된 DB는 신뢰하지 않는다. 해당 DB는 삭제 후 재인덱싱이 원칙.
- **[Historical — Closed 2026-04-17]** 2026-04-16 시점에 일시적으로 session DB 768d(Gemini) / org 2560d(Qwen3-4B) 불일치가 있었음. **현재는 둘 다 2560d로 통일.** 이 문장은 archaeological reference로만 남긴다.
- llmlog 설계문서: `20260416T135457` (org 청킹 설계)
- llmlog 통합문서: `20260416T115700` (QMD+GBrain 패턴 흡수 현황)
- **다음 작업**: hybrid retrieval spot check / doctor audit 확장

### DB 운영 원칙 (2026-04-16 명문화)

- `sessions.lance` 와 `org.lance` 는 **서로 다른 DB 파일**이다. 하나의 인덱스로 취급하지 않는다.
- 무결성 이슈(duplicate IDs, orphan rows, manifest mismatch)가 보이면 **영향받은 DB만 삭제 후 재인덱싱**한다.
- **`compact`는 운영 절차에서 사용하지 않는다.** 복구 수단도 아니고 일상 maintenance도 아니다.
- 이번 incident 이후 기본 원칙은 `cleanup/compact`보다 **drop + rebuild** 이다.
- dual-GPU / 병렬 임베딩은 유지 가능하지만, 로컬 DB writer는 반드시 single-writer 보장을 해야 한다.
- 재인덱싱 후 필수 확인:
  - `./run.sh verify sessions`
  - `./run.sh verify org`
  - golden/search quality spot check

### Dual-GPU 인덱싱 퀵스타트 (2026-04-16)

**모델**
- GPU 인덱싱: `/storage/models/vllm/default` → `Qwen/Qwen3-Embedding-4B` (2560d)
- 쿼리: OpenRouter `qwen/qwen3-embedding-4b` (same family, 2560d)

**터널 열기 (인덱싱 시에만 필요)**
```bash
ssh -f -N -L 18000:localhost:8000 gpu2i
ssh -f -N -L 18001:localhost:8000 gpu1i
```

**터널/모델 확인**
```bash
ss -tlnp | grep -E ':18000|:18001'
curl -s http://localhost:18000/v1/models | python3 -m json.tool | head -20
curl -s http://localhost:18001/v1/models | python3 -m json.tool | head -20
curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -X POST https://openrouter.ai/api/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen/qwen3-embedding-4b","input":"ping"}' | head -c 200
```

**임베딩 endpoint smoke test**
```bash
python3 - <<'PY'
import json, urllib.request
body=json.dumps({"model":"/storage/models/vllm/default","input":["GPU 서버 임베딩 인프라"]}).encode()
for port in (18000, 18001):
    req=urllib.request.Request(f'http://localhost:{port}/v1/embeddings', data=body, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        data=json.load(r)
        print(port, len(data['data'][0]['embedding']))
PY
```

**주의: status 명령**
```bash
npx tsx indexer.ts status
```
- `npx tsx indexer.ts org --status` 는 status가 아니라 **실제 org 인덱싱을 시작**한다. 쓰지 말 것.

**듀얼 GPU 재인덱싱**
```bash
scripts/rebuild-dual-full.sh
```

Equivalent manual steps:
```bash
export ANDENKEN_PROVIDER=vllm
export ANDENKEN_VLLM_ENDPOINT=http://localhost:18000,http://localhost:18001
export ANDENKEN_VLLM_MODEL=/storage/models/vllm/default
export ANDENKEN_VLLM_PRESET=Qwen/Qwen3-Embedding-4B
export INDEX_CONCURRENCY=4
export ANDENKEN_EMBED_BATCH=500

rm -rf data/sessions.lance
npx tsx indexer.ts sessions --force
./run.sh verify sessions

rm -rf data/org.lance data/org-manifest.json
npx tsx indexer.ts org --force
./run.sh verify org
```

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
```

**운영 기준 컨텍스트 한도는 모델 이론치가 아니라 `--max-model-len 8192` 이다.**
모든 audit / oversize 판정 / hard guard는 이 8K 서빙 한도를 기준으로 한다.

```bash
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

## QMD + GBrain 패턴 흡수 현황 (2026-04-16 갱신)

llmlog: `20260416T115700` — 통합 비교 문서 (QMD 6건 + GBrain 5건)

### QMD 패턴

| # | 패턴 | 상태 |
|---|------|------|
| 1 | RRF top-rank bonus | ✅ rrfFusion() |
| 2 | Strong Signal Bypass | ❌ 보류 (로컬 무료) |
| 3 | 쿼리 캐싱 | ✅ CachingProvider + dictcli expand cache |
| 4 | Break point scoring | ✅ 완료 (org-aware scoring + 절대 블록 보호 + 마이크로헤딩 병합) |
| 5 | MCP 서버 | ❌ 장기 |
| 6 | FTS5 고급 쿼리 | ❌ 장기 |

### GBrain 패턴

| # | 패턴 | 상태 |
|---|------|------|
| 1 | Compiled Truth | ⏳ 중기 |
| 2 | 5가지 운영 규율 | 부분 |
| 3 | 4단계 dedup | ✅ file dedup (pre+post) + MMR |
| 4 | Brain-Agent Loop | 부분 |
| 5 | doctor/maintain | ⏳ 다음 |

### 이번 세션 추가 적용

- Score normalization + cross-signal bonus (×1.1)
- FTS에 dictcli expand 반영
- File dedup pre-merge(3/file) + post-merge cap(3/file)
- Heading noise 감소 (min 20→40)
- Recall tracking (recalls.jsonl)

### Excluded (confirmed)

- LLM 리랭킹: Jina MRR 하락 검증. 범용 리랭커는 개인 개념에 약함
- LLM 쿼리 확장: dictcli expand가 비용 0으로 해냄
- pre-2025 journal 인덱싱: 범위 대비 신호가 낮고 형식 불안정. sessions / notes로 커버
- `noexport` / `tts` / `noembed` / `llmlog` 태그가 붙은 org content: 기본적으로 임베딩 제외
- llmlog/agenda 인덱싱: 세션으로 커버. botlog 승격분만 인덱싱

## Architecture Quick Reference

- sessions: rrf merge, halfLife=14d, mmr=off, minScore=0.001
- org: weighted merge + score norm, halfLife=90d, mmr=on(λ=0.7), minScore=0.05
- file dedup: pre-merge 3/file + post-merge 3/file
- candidateMultiplier: 4x both
- Pipeline: dictcli expand → embedQuery → vector+FTS(expanded) → file dedup → merge(norm+cross) → decay → filter → MMR → file cap

## Related Notes

- `20260416T115700` — QMD+GBrain 패턴 흡수 현황 (통합)
- `20260408T120252` — Memory consolidation 3-stage roadmap
- `20260325T151425` — andenken worklog (Jina failure record)
- `20260330T212639` — Embedding cost bomb analysis
