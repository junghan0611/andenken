# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken에서 다음에 할 것들 / 잠시 주차한 것들**을 적는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Watching — OKF (Open Knowledge Format, Google knowledge-catalog)

따라갈 대상 아님. 중심은 andenken. 다만 **알아두면 고도화 유연성**이 된다 —
독불장군식으로 뻗지 않고 외부 표준과 손잡을 수 있는 export target 후보.

- **현 판단**: OKF v0.1은 schema-less·중앙권위 없음 → 포맷이 더 움직일 가능성.
  지금 denote↔OKF 컨버터 착수 금지. andenken md 축이 이미 가든 markdown
  (`~/repos/gh/notes/content`)을 임베딩 → OKF bundle에 ~90% 근접. ingestion이
  아니라 interchange/proof 표면.
- **우리 우위**: OKF concept ID는 경로 기반(파일 이동 시 깨짐). durable Denote
  ID가 그 약점을 이미 해결. 우리가 OKF에 맞추는 게 아니라 OKF가 우리 쪽으로.
- **트리거 (이때 재검토)**: OKF가 v0.1을 벗어나 schema/durable-ID 도입 시 →
  (1) denote↔OKF 매핑 정밀화, (2) andenken md export를 OKF bundle 표면으로
  노출 검토. "path-based ID라 깨진다" claim은 그때 SPEC 직접 확인.
- 맥락 노트: [[botlog]] `20260406T140411` §andenken — llm-wiki·OKF·EKG 수렴.
  EKG/semext(ahyatt) 동행 좌표도 거기.

## Watching — pi-shell-acp 1.0.0 (session-identity 2차 정렬 예상)

0.9.0 garden-native identity 정렬은 끝났다 (`b77713d`). 그런데 0.9.0
changelog가 직접 예고하듯 **resident · entwurf · 1.0.0 meta-bridge가
하나의 garden session ontology로 수렴**한다 — 즉 1.0.0에서 세션 정체성/이름/
헤더 표면이 **또 바뀔 수 있다.** GLG가 지금 pi-shell-acp 1.0.0 작업 중이고,
끝나면 결과를 가지고 andenken과 논의 예정.

andenken 측 함의 (지금 착수 금지, 1.0.0 결과 본 뒤):

- **2d entwurf parent/child threading은 1.0.0 결과를 기다린다.** 헤더 `id` +
  `entwurf`/`control` 태그를 인덱싱하는 schema 결정인데, 1.0.0이 meta-bridge로
  그 표면을 또 바꾸면 지금 설계한 게 두 번 깨진다. 0.9.0에서 한 번 깨진 걸로
  충분 — threading은 1.0.0 session 표면이 굳은 뒤 한 번에 설계.
- 1.0.0이 landing하면: (1) 세션 파일명/헤더/이름 grammar diff 확인,
  (2) session-indexer.ts 파일명·헤더 가정 재점검, (3) AGENTS.md
  "Session corpus sources" 절 재정렬.

> 세션 코퍼스 정밀화(tmp/300KB/구형 파일명 가드 + delegate golden 제거)는
> `v2026.6.19`로 닫혔다 → [CHANGELOG.md](./CHANGELOG.md). 아래는 그 위에서
> 이어지는 retrieval 품질 작업.

## Now — Post-rebuild 품질 개선안 (2026-06-19, GPT 검수 반영) ⟵ 다음 에이전트 시작점

full rebuild 후 1차 검수(golden 세션 8/10, doctor 분포) + GPT 분신
(`20260619T095519-55dcb9` gpt-5.5) 검수 결론: **rebuild는 성공("핵심만"
정책 정상 작동). 지금 손댈 건 threshold 완화가 아니라 (1) golden 계약 정리
(2) 2e retrieval balancing (3) read-only 민감도 계측.** 300KB는 유지.

검수 사실:
- 세션 15,581청크/376파일, md 10,404/2217, verify 로컬 clean (oracle orphan은
  raw 소스 미보유 host-locality 아티팩트).
- **compaction=0**: GPT가 로컬 raw 확인 — pi compaction 107개 전부
  garden-native=false라 정책상 정상 제외. 94개 신형 파일엔 `type=compaction`
  자체가 없음 → **parser 고쳐도 즉시 복구 안 됨.** legacy 재유입 금지.
- 분포 skew: source claude 89.5%/pi 10.5%, project pi-shell-acp 37.1%.

### 우선순위 1 — Golden contract cleanup (작고 즉시)
- `delegate session directory` 제거 ✅ (v2026.6.19에서 완료).
- `봇멘트 remark42`: session golden에서 제거 또는 md/skill-doc golden으로 이동
  (세션 tightening의 의도적 손실 — botment 운영지식이면 skill docs/md/botlog로 승격).
- `남은 작업 뭐지`: strict session golden에서 제외 → recall/NEXT workflow test로
  분리("two-step recall required" 케이스). golden 8/10의 2 탈락은 *의도된 손실*이라
  현 golden 수치가 오해를 부름 → 기대치를 코퍼스에 맞춰 정정.

### 우선순위 2 — 2e balanced windowed retrieval (아래 § 상세설계에 파라미터 주입)
GPT 권장 파라미터 (인덱스 아니라 retriever에서 skew 해소):
- `baseCandidates` ≥ `limit×10` (가능하면 `×20`). 코퍼스 작아져 후보 넉넉히 잡아도 부담↓.
- **score floor 먼저**: hybrid/semantic은 `score ≥ topScore×0.6`(또는 normalized floor)
  안에서만 diversity 강제 — relevance 망치지 않게.
- project **soft cap** `ceil(limit×0.25)` (limit=30 → project당 ~8), sparse fallback에선 초과 허용.
- source **minority rescue**: 50/50 강제 금지(pi 약하면 쓰레기 끌어올림). base 후보에 양
  source 있으면 minority를 최대 `ceil(limit×0.2~0.3)`까지 rescue.
- **sparse fallback** 강화: bucket round-robin 후 결과가 `limit`의 40~60% 미만이면
  active bucket 안에서 `(sessionFile, project)`-balanced fill.
- skew 수치(claude 89.5 / pi-shell-acp 37.1)를 **regression fixture**로 박을 것.

### 우선순위 3 — Read-only quality audit (threshold 변경 전 필수)
- 300/250/200KB dry-run 비교표: 파일 수·chunk 수·project/source 분포·golden 회복·
  noise 회귀. threshold 변경은 이 표 보고 **GLG decision**.
- 2a `parsePiLine` compaction schema fix: old schema는 top-level `type:"compaction",
  summary:...`인데 parser는 `parsed.compaction?.summary`만 봄 → `summary` top-level
  fallback 추가(비용 작고 future/legacy 안전). 단 compaction 복구 이유로 pre-0.9.0
  재유입 금지. 추후 "derived session summary chunk"(header/name + first/last user turn
  + NEXT link)는 별도 설계.
- doctor metric 추가: "compaction records filtered by filename policy"를 설명 가능하게.

## Next — Windowed sessions retrieval that survives daily use

**현재 주요 우선순위:** 2026-05-28 doomemacs-config 측 wrapper
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
| **2d** | Derived signals 인덱싱 — 헤더 `id`(garden sessionId) + `entwurf`/`control` 이름 태그 / commit_sha / slash_command. **0.9.0 이후 entwurf parent/child threading은 여기로 흡수** (파일명 공짜 소멸, 인덱싱 필수). 2c 결과 보고 결정 | deferred |

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

#### Step 2 — (제거됨) Entwurf 세션은 평범한 garden 세션으로 처리

**결정 (2026-06-05, 0.9.0 정렬).** 원래 Step 2는 entwurf 자식 세션을
별종으로 특별 취급(own-row vs fold, `[entwurf:<id>]` badge)하려 했고, 그
전제는 `<parent_id>_entwurf-<childId>.jsonl` 파일명에 부모-자식 링크가
박혀있다는 것이었다. pi-shell-acp 0.9.0 garden-native identity 릴리즈가
이 전제를 **두 방향에서 동시에 무너뜨렸다**:

1. **구현 근거 소멸.** 파일명이 `<created-at>_<sessionId>.jsonl`로 바뀌어
   파일명에 부모 링크가 없다. entwurf 정체성은 JSONL 헤더 `id` + 세션
   이름의 `entwurf` 태그로 이동했는데, andenken이 현재 인덱싱하는 컬럼엔
   둘 다 없다. 즉 retrieval 시점에 "이 세션이 entwurf 자식인가"를
   **공짜로 알 방법이 사라졌다** (파일명 substring 탐지가 유일한 경로였음).
2. **철학적 정렬.** 0.9.0의 선언은 "entwurf 세션을 worker artifact의
   별종으로 취급하지 않는다 — resident · entwurf · 1.0.0 meta-bridge가
   하나의 garden session ontology로 수렴한다". andenken retrieval이
   entwurf를 별종 분기로 다루는 것은 upstream 의도와 정면으로 어긋난다.

따라서 **2e ship에서 entwurf 특별 취급을 들어낸다.** Step 1 balance
스케줄러는 entwurf 세션을 그냥 평범한 garden 세션으로 다룬다 —
`(sessionFile, bucket)` dedup + project 다양성으로 동일하게 균형 잡힌다.
별도 fold/badge/threading 없음. 이건 타협이 아니라 0.9.0과의 정렬이다.

**threading을 정말 살리려면 → 2d로 강등.** 헤더 `id`(garden sessionId)와
`entwurf` 태그를 파생 신호로 **인덱싱해야** 가능하다. 파일명 공짜는 끝났고,
이제 진짜 schema 결정이다. 부모 링크 후보 소스는 entwurf-message
custom_message의 `sender_info`/`receiver_info` (session-excerpt.ts 346–348,
현재 excerpt 표시 레벨만 — 인덱싱 안 됨). 2d 본격화 시 재설계.

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
   - **0.9.0 정렬:** entwurf 세션이 평범한 garden 세션으로 surface하면
     통과 (별종 threading/badge 기대 안 함 — Step 2 제거). entwurf
     transcript가 balance 윈도우에 정상 포함되는지만 확인.
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

## Parked — Sessions cleanup after pruning sub-100KB transcripts

2026-05-29 사용자가 `100KB` 이하 세션 JSONL을 대거 삭제했다. 다음
세션에서 정리 방향 결정 필요.

- 현황: `deleted=860`, `to-index=44`
- dry-run: `cleanup sessions --dry-run` → `orphan files=812`, `orphan rows=2979`
- dry-run 실측: **~0.73s**
- 주의: 증분 `sync-sessions`만으로는 삭제된 세션 임베딩이 자동 제거되지 않음

다음 시작 순서:

1. `./run.sh status --json`
2. `pnpm exec tsx indexer.ts cleanup sessions --dry-run`
3. 목표가 검색면 정리면 `./run.sh cleanup sessions`
4. DB + manifest까지 완전 청소면 `scripts/rebuild-sessions-full.sh`

## Parked — openclaw memory-axis 동기화 검토 (baseline `v2026.6.8`, 결론: 포팅 없음)

`~/repos/3rd/openclaw`를 stable **`v2026.6.8`** (2026-06-19 재정비, 직전 baseline
`v2026.6.1`)로 checkout하고 우리가 포팅해온 기억축 로직과 대조했다.
**andenken이 채택할 알고리즘적 retrieval/chunking 개선은 없다.** 재조사를
막기 위해 결론을 박아둔다.

- **6.1→6.8 재검수 (2026-06-19)**: 2,652 커밋 / 16,831 파일 변경이지만 우리
  의존 표면은 무변경. `memory-host-sdk` md 청킹/임베딩은 **로직 0 변경**(98파일
  diff 대부분이 JSDoc 주석 스위프). embeddings는 `nodeLlamaCppImportUrl` 런타임
  주입 옵션만 가산(우리는 remote OpenRouter Qwen3 → 무관). sqlite-vec는
  robustness 하드닝(vec_version 헬스체크 + 플랫폼 변형 폴백 / 우리는 LanceDB →
  정보성). active-memory `agent-runner-memory.ts`는 우리 검색 API **계약 무변경**
  (변경분은 followup CLI-runtime alias 판별 + compaction-notice phase, openclaw
  내부 오케스트레이션). → COMPARISON.md 재정렬 불요.

아래는 5.22→6.1 검토 당시 결론 (여전히 유효):

- **한국어 particle/stem 로직**: `query-expansion.ts`의 `KO_TRAILING_PARTICLES`
  / `stripKoreanTrailingParticle` / `isUsefulKoreanStem`가 우리 `retriever.ts`
  포팅본과 **완전히 동일**. drift 없음, 새 particle 없음 → in sync.
- **CJK tokenizer 개선** (#56707 configurable FTS5 unicode61/trigram,
  #80613/#86645 dreaming dedupe CJK tokenizer): **SQLite FTS5 / dreaming
  axis 전용**. andenken은 LanceDB(tantivy)라 비적용 — 같은 "짧은 CJK 토큰
  드롭" 실패모드는 이미 `getShortCJKTokens` + `substringSearch`로 대응 중.
- **STOP_WORDS_KO 필터**: openclaw `tokenize`는 stopword를 거르지만 그건
  FTS-only fallback / 인덱싱 tokenize 경로용. andenken은 항상 임베딩(8B)이
  있어 BM25는 hybrid의 한 팔이고, query-side는 dual-emit(원본+stem)이 의도.
  gap 아님.
- **5.22→6.1 memory 커밋 대다수**: 방어적 하드닝(bound/cap/validate
  timeout·retry·JSON size)과 qmd salvage. qmd는 우리가 #8에서 retire,
  나머지는 openclaw runtime(remote worker/batch) 전용 → 비이식.

유일한 하드닝 후보 (committed task 아님, 다음에 우리 코드 확인만):
- `#85704 prevent silent vector index degradation when provider temporarily
  unavailable` — provider가 런 도중 죽을 때 degraded row를 조용히 쓰지 않게.
  andenken은 wrong-dim preflight + hard guard로 *시작 전* 차단은 있으나
  *런 도중 provider down* 각도는 미확인. 우려되면 indexer 경로 한 번 점검.
