# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Windowed sessions retrieval that survives daily use

**단 하나의 현재 우선순위:** 2026-05-28 doomemacs-config 측 wrapper
(`andenken-search-sessions-today/this-week`)를 사용자가 매일 쓰려고
처음 잡았다. 즉시 결과 미달. 실측으로 surface shape 문제 확정 (어제
KST 윈도우 / limit 30 / mode=recent):

| 축 | 분포 | 해석 |
|---|---|---|
| project | pi-shell-acp 25 / forge-config 5 | project 다양성 박살 |
| sessionFile | 한 세션이 17/30 (57%) | 세션 다양성 박살 |
| timestamp | 100%가 UTC 10:40~11:00 (KST 19:40~20:00 마지막 1시간) | **시간 다양성 박살 — 가장 critical** |

`mode=recent`는 stored-signal scan + timestamp DESC라 윈도우 끝 N분이
결과를 다 점령한다. 사용자가 보고 싶은 "어제 24h 전체 자리"가 실제로는
**1/24만** 보인다. 인덱싱이 아니라 retriever surface shape 문제.

### Two consumers, one surface

이 단축 retrieval surface는 두 caller가 동시에 쓴다:

- **사용자** (emacs wrapper) — 화면에서 어제 / 이번주 자리 잡기
- **에이전트** (`recall` skill, pi `session_search`) — 사용자가 "이번주에
  내 세션에서 뭐했는지 보자" 물을 때 에이전트가 시간 윈도우를 ISO로 잡고
  같은 surface 호출. 결과를 다축 합성에 넣어 답.

두 caller가 **동일한 balance 행동**(time-bucket 균등 + project 다양성)을
받아야 한다. balance 로직은 `retriever.ts` 모듈에 두고 `cli.ts`(Claude
Code / OpenCode 진입)와 `index.ts`(pi extension 진입) 둘 다 호출.

### Sub-plan (순서대로)

| 단계 | 내용 | 상태 |
|---|---|---|
| **2e** | Multi-axis balanced windowed view — `(sessionFile, time-bucket)` group + project balancing tier. retriever module + `cli.ts` + `index.ts` parity. 인덱싱 무변경 | **현재 진입점** |
| **2b** | Corpus noise threshold — simulation 병행 (read-only). 임계값 박기는 2e 안정 후 | 시뮬만 |
| **2a** | parsePiLine compaction schema fix + targeted reindex (Phase 1 stored signals 결손 채움) | 2e 다음 |
| **2c** | Golden quality 측정 — query #3 / #6 / #8. **2e 비차단** (regression check만 머지 직전) | pending |
| **2d** | Derived signals 인덱싱 (entwurf_task_id / commit_sha / slash_command) — 2c 결과 보고 결정 | deferred |

### Current step — 2e Multi-axis balanced view

#### Step 0 (수술 전 진단) — fileDedup() 결함 확인

GPT-5.5 리뷰 발견: 현재 `retriever.ts`의 `fileDedup()` regex가 org/md
chunk id (`:[ch]\d+`)를 가정해 sessionFile id (`/path/file.jsonl:line`)에
안 먹는다. 17/30 session 독점이 거기서 올 가능성 큼. **2e 본구현 전 1줄
fix → 같은 KST 5/27 윈도우 다시 측정**. 결함 confirmed면 3축 박살 중
session 축이 자동 풀릴 수 있고, scheduler 설계도 그 위에서 잡힘.

#### Step 1 — Selection scheduler (sort 아님)

dedup group key = `(sessionFile, bucketIndex)`. project / role / source는
metadata + tie-break tier, dedup tuple 안 들어감.

time-bucket = `window_length / target_limit`, 단 `minBucketMs` floor:

- 24h + 30 → ~48분 bucket
- 7d + 30 → ~5.6h bucket
- 1h window → 2분 bucket 회피 → `minBucketMs` 적용 + sparse fallback

**Scheduler (comparator-sort 아님):**

```
1. group candidates by (sessionFile, bucketIndex)
2. select 1 representative per group:
   - recent: latest timestamp
   - hybrid: best score; tie-break user_message > assistant_response > tool
3. pass-N round-robin over non-empty buckets:
   pass 1: bucket마다 1개씩, 같은 bucket 안 project tie-break는
           "global selected count가 적은 project 우선"
   pass 2: limit 남으면 또 한 바퀴
   ...
4. sparse fallback: 빈 bucket 다 돌면 active bucket 안에서
   sessionFile/project balanced fill (24h에 1h만 작업한 날 1~2행
   끝나는 것 방지)
```

Bucket traversal 순서: **과거 → 현재** (chronological). "이번주" 결과를
주초→주말 흐름으로 보여준다. 마지막 bucket이 1순위로 잡히지 않게.

Hybrid mode 추가:

- relevance floor 통과 candidate만 balance pool 진입 (무관 결과가 빈
  bucket 채우는 것 방지). floor는 score normalization 후 임계값 — 별
  구현 시 결정.
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
   - sessionFile 17/30 독점 깨졌나
   - project 25/5 독점 완화됐나
2. **Dual-consumer parity check**:
   - emacs wrapper `--view session` 호출
   - pi `session_search` 같은 옵션으로 같은 결과 받는가
3. **Regression spot check** (2c 본 단계 전):
   - #3 entwurf 결과 / #6 multi-repo 의미연결 / #8 entwurf 흐름 한 번
   - 머지 직전 통과 확인 — quality tuning은 별 단계

#### Code location

- `retriever.ts` — `balanceSessionWindow(candidates, opts)` 새 함수.
  scheduler 본체. 기존 `fileDedup()`은 Step 0에서 재평가.
- `cli.ts` — `--view session` flag, opts 전달.
- `index.ts` (pi extension) — `session_search`가 같은 옵션 (`view:
  "session"`) 받기. 두 entry 모두에서 동일한 `balanceSessionWindow` 호출.
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
day-query / recall 자리.

### Non-goal

- md retrieval ranking 자체를 이번 항목에서 다시 튜닝하지 않는다
- org track은 건드리지 않는다 (production disable 유지)
- 인덱싱 schema 변경(2d)은 2c 측정 보고 결정 — 우선 retriever 후처리로
  끝나는 것부터
- per-source weight (pi vs claude) 적용 안 함 — 실제 작업 위치 왜곡 위험
- 자동 limit 증가 안 함 — caller가 화면 폭 / 비용 결정

### Review trail

- 2026-05-28 1차: doomemacs-config Claude (Q1~Q7 입장 잠금)
- 2026-05-28 2차: GPT-5.5 (`.review/2026-05-28.md`, $0.58, 5 turns) —
  scheduler frame, `fileDedup()` 결함, module parity, candidate budget,
  edge-case fallback, sparse window diagnostic
