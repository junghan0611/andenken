# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Windowed sessions retrieval that survives daily use

**단 하나의 현재 우선순위:** 2026-05-28 doomemacs-config 측 wrapper
(`andenken-search-sessions-today/this-week`)를 사용자가 매일 쓰려고
처음 시도했다. 즉시 결과 미달. 실측으로 surface shape 문제 확정 (어제
KST 윈도우 / limit 30 / mode=recent):

| 축 | 분포 | 해석 |
|---|---|---|
| project | pi-shell-acp 25 / forge-config 5 | project 다양성 붕괴 |
| sessionFile | 한 세션이 17/30 (57%) | 세션 다양성 붕괴 |
| timestamp | 100%가 UTC 10:40~11:00 (KST 19:40~20:00 마지막 1시간) | **시간 다양성 붕괴 — 가장 critical** |

`mode=recent`는 stored-signal scan + timestamp DESC라 윈도우 끝 N분이
결과를 다 점령한다. 사용자가 보고 싶은 "어제 24h 전체 흐름"이 실제로는
**1/24만** 보인다. 인덱싱이 아니라 retriever surface shape 문제.

### Two consumers, one surface

이 단축 retrieval surface는 두 caller가 동시에 쓴다:

- **사용자** (emacs wrapper) — 화면 폭 한정 → default `limit=30`
- **에이전트** (`recall` skill, pi `session_search`) — context window 큼 → default `limit=100~200`. 사용자가 "이번주에 내 세션에서 뭐했는지 보자" 물을 때 에이전트가 시간 윈도우를 ISO로 잡고 같은 surface 호출, 결과를 다축 합성에 넣어 답.

두 caller가 **동일한 balance 행동**(time-bucket 균등 + project 다양성)을
받되 **default limit은 surface별 분리**. balance 로직은 `retriever.ts`
모듈에 두고 `cli.ts`와 `index.ts`(pi extension) 둘 다 호출.

### Sub-plan (순서대로)

| 단계 | 내용 | 상태 |
|---|---|---|
| **2e** | Multi-axis balanced windowed view — `(sessionFile, time-bucket)` group + project balancing tier. retriever module + `cli.ts` + `index.ts` parity. 인덱싱 무변경 | **현재 시작점** |
| **2b** | Corpus noise threshold — simulation 병행 (read-only). 임계값 확정은 2e 안정 후 | 시뮬만 |
| **2a** | parsePiLine compaction schema fix + targeted reindex (Phase 1 stored signals 결손 채움) | 2e 다음 |
| **2c** | Golden quality 측정 — query #3 / #6 / #8. **2e 비차단** (regression check만 머지 직전) | pending |
| **2d** | Derived signals 인덱싱 (entwurf_task_id / commit_sha / slash_command) — 2c 결과 보고 결정 | deferred |

### Current step — 2e Multi-axis balanced view

#### Step 0 — Session-track fileDedup 분기 (1줄 fix 아님)

3차 리뷰(Gemini-3.1-pro)가 GPT-5.5의 "regex 1줄 fix" 추천을 정면 반박:

> fileDedup() regex가 sessionFile id에 안 먹는 것은 사실이지만, regex만
> 고치면 `maxPerFile=3`가 발동되어 **4시간 몰입한 핵심 세션도 3줄로
> 토막**난다. time-bucket balance 들어가기 *전에* base candidates 증발.

Step 0 정의:

1. fileDedup이 sessionFile id에 안 먹는 것 확인 (가설 검증, GPT 관점)
2. **Session track에서 fileDedup 우회 분기 또는 `maxPerFile` 대폭 증가
   (limit×10 이상)** — per-session truncation 방지
3. balance 책임은 전적으로 Step 1 scheduler에 위임

이거 함께 안 하면 17/30 독점이 풀려도 깊은 세션이 토막나서 다른 형태의
붕괴가 생긴다. **수술 1줄 아님**.

#### Step 1 — Selection scheduler (sort 아님)

dedup group key = `(sessionFile, bucketIndex)`. project / role / source는
metadata + tie-break tier, dedup tuple 안 들어감.

time-bucket = `window_length / target_limit`, 단 `minBucketMs` floor:

- 24h + 30 → ~48분 bucket
- 7d + 30 → ~5.6h bucket
- 1h window → 2분 bucket 회피 → `minBucketMs` 적용 + sparse fallback

**Scheduler — pass-N round-robin + evenly-spaced pick:**

```
1. group candidates by (sessionFile, bucketIndex)
2. select 1 representative per group:
   - recent: latest timestamp
   - hybrid: best score; tie-break user_message > assistant_response > tool
3. pass-N round-robin over non-empty buckets (과거 → 현재 chronological):
   for each pass:
     remaining = limit - result.length
     if remaining < activeBuckets.length:
       # Limit truncation 편향 방지 (Gemini 3차 발견)
       currentPass = selectEvenlySpaced(activeBuckets, remaining)
       # 예: 10 buckets 남고 3개만 더 → 0, 4, 9번 stride pick.
       # 단순 순회 시 가장 최근 bucket들이 통째로 잘림 — 역진동.
     else:
       currentPass = activeBuckets
     for bIdx in currentPass:
       pick representative, update projectCounts (least-seen project 우선)
4. sparse fallback: 빈 bucket 다 돌면 active bucket 안에서
   sessionFile/project balanced fill (24h에 1h만 작업한 날 1~2행 끝
   방지)
5. 최종 결과는 timestamp 오름차순 재정렬 — 사용자/에이전트가 시간
   흐름대로 읽도록
```

Hybrid mode 추가:

- **query semanticity 판별**: empty query / "최근 작업 요약" 같은 meta
  query는 vector score 자체가 노이즈 → relevance floor를 **graceful
  degrade** (off 또는 매우 낮게). 칼같이 적용하면 가장 중요한 최근
  작업이 "점수 낮다"고 떨어짐 (Gemini §C1).
- specific query에서만 floor 정상 적용.
- candidate budget: session view에서 `limit*10 max 1000` (현재 `limit*4
  max 200`은 7d에 작음).
- session view에서 MMR off — `(bucket, sessionFile, project)` balance가
  더 직접적 diversity.

#### Step 2 — Entwurf parent/child threading

sessionFile filename pattern: `<parent_id>_entwurf-<childId>.jsonl`.

- recent/empty: `chunks ≥ 3` 자식만 own row. 작은 자식은 같은
  `(project, bucket)` 대표 row에 fold, 그런 row 없으면 own row.
- hybrid/non-empty: 작은 자식이라도 score 높으면 promote. cutoff보다
  query relevance가 우선.
- candidate line에 `[entwurf:<id>]` 또는 `[+N tiny]` badge.
- parent file 확정은 schema 변경 없이는 정확하지 않음 → "같은 bucket
  대표"로 fold가 안전한 근사.

#### Acceptance — 2단계 ship

1. **Raw repro acceptance** (semantic golden 전):
   - 같은 KST 5/27 윈도우 / limit 30 / mode=recent 다시 측정
   - timestamp가 24h에 퍼지는가 (마지막 1h 점령 깨졌나)
   - **동시에 가장 최근 bucket이 통째로 잘리지 않는가 (역진동 방지)**
   - sessionFile 17/30 독점 깨졌나 (단 깊은 세션이 3줄로 토막나지도
     않는가 — Step 0 caveat)
   - project 25/5 독점 완화됐나
2. **Dual-consumer parity check**:
   - emacs wrapper `--view session --limit 30` 호출
   - pi `session_search` `view: session, limit: 100~200` 호출
   - 같은 옵션 동일한 balance 행동
3. **Regression spot check** (2c 본 단계 전):
   - #3 entwurf 결과 / #6 multi-repo 의미연결 / #8 entwurf 흐름 한 번
   - 머지 직전 통과 확인 — quality tuning은 별 단계

#### Code location

- `retriever.ts` — `balanceSessionWindow(candidates, opts)` 새 함수,
  scheduler 본체. `selectEvenlySpaced(buckets, k)` helper. 기존
  `fileDedup()`은 Step 0에서 Session track 분기 (우회 또는
  `maxPerFile` 인자 외부 노출).
- `cli.ts` — `--view session` flag, opts 전달. default `limit=30`.
- `index.ts` (pi extension) — `session_search`가 같은 옵션 (`view:
  "session"`) 받기. default `limit=100~200`. 두 entry 모두에서 동일한
  `balanceSessionWindow` 호출.
- 인덱싱 무변경. `temporal decay`는 windowed mode에서 off.

#### Diagnostic (응답 JSON top-level)

- `bucketMs`
- `nonEmptyBuckets`
- `candidateGroups` / `selectedGroups`
- `truncated: bool`
- `timestampMissingRows`
- (필요 시) `hint: "increase --limit for denser weekly view"`

### Boundary principle — caller owns the time window, andenken owns the diversity

시간 윈도우는 caller가 잡는다 (emacs wrapper나 `recall` / `session_search`).
andenken은 그 안에서 **세션 중복 없는 / project 다양성 있는 / 시간 분포
균형 잡힌** 결과를 노출. 윈도우 자연어 파싱과 git/journal/bib 통합은
day-query / recall 영역.

### Non-goal

- md retrieval ranking 자체를 이번 항목에서 다시 튜닝하지 않는다
- org track은 건드리지 않는다 (production disable 유지)
- 인덱싱 schema 변경(2d)은 2c 측정 보고 결정 — 우선 retriever 후처리로
  끝나는 것부터
- per-source weight (pi vs claude) 적용 안 함 — 실제 작업 위치 왜곡 위험
- 자동 limit 증가 안 함 — caller가 화면 폭 / 비용 결정
- Reranker API 후처리 안 함 — 시간 균형 못 봄, UX 지연 (Gemini §B 기각)
- Pre-computed session summary indexing 안 함 — 실시간성 깨뜨림
  (Gemini §B 기각, 2d-deferred로 유지)

### Review trail

- 2026-05-28 1차: doomemacs-config Claude (Q1~Q7 입장 잠금)
- 2026-05-28 2차: GPT-5.5 (`.review/2026-05-28.md`, $0.58, 5 turns) —
  scheduler frame, `fileDedup()` regex 결함 가설, module parity,
  candidate budget, edge-case fallback, sparse window diagnostic
- 2026-05-28 3차: Gemini-3.1-pro (사용자 직접 호출, 실측 동반) —
  **fileDedup fix 역설** (regex 1줄 fix → 깊은 세션 토막, Session
  track 우회 필요), chronological traversal limit truncation 편향
  (`selectEvenlySpaced` 대응), empty/meta query × hybrid floor 충돌
  (graceful degrade), agent vs emacs limit default 분리

### 권장 자문 — Gemini-3.1-pro

이 작업 영역(windowed sessions retrieval, scheduler 설계, dual-consumer
surface)은 2026-05-28 첫 자문에서 Gemini-3.1-pro가 결정적 발견을 줬다
— 특히 fileDedup 역설은 직전 자문(GPT-5.5)의 답을 정면 반박하며 문제를
한 단계 더 깊이에서 막았다. 다음 라운드에서도 같은 지점에서 막히면 우선
Gemini로:

```
provider="pi-shell-acp"
model="gemini-3.1-pro-preview"
cwd 옵션으로 AGENTS.md inject
cost: subscription-backed (낮음)
```

다른 영역(예: corpus noise threshold 2b, derived signals 2d)에서는
이번 신호가 자동 적용되지 않는다 — 그 영역은 다시 처음부터 자문.
