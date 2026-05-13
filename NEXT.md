# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Sessions as time/project memory axis

**단 하나의 현재 우선순위:** 세션 임베딩을 **시간축(time axis) + 담당자/경로(project/cwd axis)** 중심으로 다시 점검하되, 새 해석기를 만들지 않고 **이미 저장된 신호를 검색 surface에서 살리는 것**에 집중한다.

### Direction fixed by GLG — 2026-05-13

andenken에는 두 개의 살아있는 임베딩 표면이 있지만 기대하는 성격이 다르다.

| Track | Primary expectation | Notes |
|---|---|---|
| **sessions** | **시간축 + 담당자/경로 축** | “어제/최근/그 repo에서 하던 일”을 이어가기 위한 작업 기억. timestamp, project/cwd, session path, line number가 의미 유사도만큼 중요하다. |
| **md garden** | **의미공간** | public garden 자체는 meta / bib / autholog / botlog / notes 등이 엮인 개념 공간. 시간보다 개념·주제·인명·문헌 연결이 중심이다. |

따라서 B2a md golden은 중요하지만, 지금 우선순위는 md sentinel 확장이 아니다. 세션 임베딩이 “시간축 작업 기억”으로 충분히 동작하는지 먼저 확인한다. 부족하면 sessions 쪽을 선행한다.

### Boundary principle — use stored signals, do not imitate day-query

Sessions track의 1차 목표는 새로운 시간 해석기나 day-query 대체재를 만드는 것이 아니라, 이미 저장된 `timestamp` / `project` / `sessionFile` / `lineNumber` / `role` / `source` 신호를 검색 surface에서 사용할 수 있게 해 작업 기억축을 복원하는 것이다.

Do:

- 저장된 metadata를 명시적 filter / sort / grouping / excerpt readback에 사용한다.
- `surface_missing`을 우선 해결한다. 저장되어 있는데 못 쓰는 신호가 1순위다.
- 없는 신호는 억지 추론하지 말고 `metadata_missing`으로 기록한 뒤 별도 indexer 보강 후보로 둔다.
- natural-language time은 호출자가 ISO range로 변환해 넘긴다고 가정한다.

Do not:

- “어제/지난주/방금” 자연어 시간 파싱을 andenken에 넣지 않는다.
- git / journal / lifetract / day-query 집계를 따라 하지 않는다.
- embedding으로 없는 metadata를 추론하지 않는다.
- 세션 내용을 요약해 시간표처럼 재구성하지 않는다.

### Why this is next

오푸스 설계 검토에서 확인한 현재 상태:

- session chunks에는 `timestamp`, `project`, `role`, `source`, `sessionFile`, `lineNumber` 메타가 보존된다.
- 하지만 retrieval surface는 주로 semantic similarity 중심이며, 노출된 필터는 제한적이다.
- `timestamp range` / `project or cwd` / `session path` 기반의 명시적 조회·rerank surface가 약하면, “어제 한 일”, “이 repo에서 직전에 하던 일”, “담당자 맥락”을 임베딩이 우연히 맞히는 구조가 된다.
- GLG의 기대는 세션 임베딩이 단순 의미공간이 아니라 **작업 시간축의 연결고리**가 되는 것이다.

### Definition of done — sessions only, two-phase

0. **No-code baseline (done by Opus, 2026-05-13)**
   - 현 surface로 11개 sessions time/project query를 측정했다.
   - 결과: 대부분 `surface_missing`, semantic sentinel은 통과, `entwurf_task_id`는 `metadata_missing`.
   - raw JSON: `/tmp/sessions_baseline/T*.json`.

1. **Phase 1 — valuable without reindex: revive stored signals**
   - 이미 저장된 `timestamp`, `project`, `role`, `source`, `sessionFile`, `lineNumber`를 검색 surface에서 쓸 수 있게 한다.
   - 대상 surface: `session_search`, `cli.ts search-sessions`, `store.search/fullTextSearch/substringSearch`, `retriever` 호출부.
   - 후보 API:
     - `dateFrom` / `dateTo` — caller가 ISO range로 넘김. andenken은 자연어 시간 파싱을 하지 않는다.
     - `project` — 현재 저장된 basename 기준 exact/OR filter.
     - `role` — user / assistant / compaction filter.
     - `sessionFile` — exact 또는 safe substring filter. entwurf 파일 패턴 회수의 단기 우회.
     - `mode` — `semantic` / `hybrid` / `recent`; `recent`는 hard filter 후 timestamp DESC 중심.
   - 검증:
     - baseline 11개를 before/after로 재실행한다.
     - T1/T2/T3/T4/T5/T6/T10/T11의 `surface_missing`이 줄어드는지 확인한다.
     - T7/T8 semantic sentinel은 filter 없이 기존 품질이 유지되어야 한다.
   - 완료 기준: 재색인 없이 저장된 신호만으로 회수 가능한 항목을 끝까지 살리고, 결과를 llmlog와 ROADMAP History 후보로 남긴다.

2. **Phase 2 — valuable with reindex: add missing session signals**
   - Phase 1 검증 이후에만 진행한다. 재색인은 두려워서 피하는 것이 아니라, surface revival을 끝낸 뒤 얻는 가치가 명확할 때 한다.
   - 후보 metadata:
     - `cwd` / normalized project path — basename `project` 충돌을 줄이고 담당자/경로 축을 강화.
     - `entwurf_task_id` / `is_entwurf` — `*_entwurf-<taskId>.jsonl` 파일명에서 파싱.
     - session-level aggregate 후보 — `sessionFile`, start/end timestamp, project/cwd, chunk count, role distribution, hasCompaction, entwurf task id.
     - optional scalar indexes — `timestamp`, `project`, `cwd`, `role`, `sessionFile` 성능 보강.
   - 검증:
     - 재색인 전후 `verify sessions` 통과.
     - Phase 1 baseline 중 `metadata_missing`이었던 T9류가 개선되는지 확인.
     - day-query를 흉내내지 않고, 저장된 세션 신호를 더 정확히 노출하는지 확인한다.

3. **Decision after Phase 2**
   - sessions surface가 시간축 + 담당자/경로 축으로 충분히 안정화되면 md 의미공간 golden으로 돌아간다.
   - 아직 sessions gap이 남으면 한 가지 다음 항목만 골라 NEXT를 갱신한다.

### Non-goal

- md golden B2a 구현은 보류. 단, md는 의미공간이라는 방향은 유지한다.
- org track은 건드리지 않는다.
- recall orchestrator 전체 설계는 andenken 책임이 아니다. 단, sessions 검색 API가 제공해야 할 계약은 정리한다.
- day-query 역할을 흡수하지 않는다. andenken은 저장된 세션 신호를 노출하고, 날짜 해석/집계/요약은 호출자 축에 맡긴다.
- Phase 1은 재색인 없이 저장된 신호를 surface로 되살리는 작업이다.
- Phase 2는 재색인을 전제로 missing metadata를 추가하는 작업이다. 재색인은 비용/시간 때문에 피하지 않는다. 다만 Phase 1 검증 후 가치가 명확할 때 실행한다.

### Deferred — md 의미공간 golden

md 쪽 다음 항목은 여전히 유효하지만, sessions audit 이후로 미룬다.

- trace-derived golden 20건 + sentinel bucket
- concept / keyword-bag / date+project / entity bucket 분리
- dictcli expand on/off 비교
- top-1 / top-3 / top-5 / MRR / repeat_refinement count
- date+project 항목은 md에서는 ranking vs surface를 구분해 측정

### Completed prerequisites

| 마일스톤 | 종료일 | 핵심 산출물 |
|---|---|---|
| B0 | 2026-05-11 | `0831487` — qmd path 폐기, org 분리 |
| B1a | 2026-05-12 | `b431bf7` `db99aa2` `6d5ad90` — md 스캐폴딩 + OpenClaw `chunkMarkdown` 포팅 + CJK 가중 + 임베딩/FTS 분리 |
| B1b | 2026-05-12 | `9f16a24` — Oracle sync 핸드오프 (`sync:md:oracle`) |
| B1c | 2026-05-12 | local full index + sessions/md live surface 전환 + Oracle `sync:md:oracle --smoke` pass |
| B1d | 2026-05-12 | `c20de24` `baa5a61` `e5154f8` — `doctor --md` V1 + 문서 정렬 |
| B2-survey | 2026-05-12 | llmlog `20260512T165651` — md 90호출, strong seed 20, date+project failure 일반화 |
| Fresh index | 2026-05-13 | sessions incremental + md near-full incremental 완료, md Oracle sync + smoke pass |
