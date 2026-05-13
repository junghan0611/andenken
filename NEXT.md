# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Sessions Phase 2: reindex-backed session signals

**단 하나의 현재 우선순위:** Phase 1에서 저장된 신호 surface revival을 끝냈으므로, 이제 재색인을 전제로 **missing session metadata**를 추가해 sessions를 시간축 + 담당자/경로 축으로 더 정확히 만든다.

### Direction fixed by GLG — 2026-05-13

andenken에는 두 개의 살아있는 임베딩 표면이 있지만 기대하는 성격이 다르다.

| Track | Primary expectation | Notes |
|---|---|---|
| **sessions** | **시간축 + 담당자/경로 축** | “어제/최근/그 repo에서 하던 일”을 이어가기 위한 작업 기억. timestamp, project/cwd, session path, line number가 의미 유사도만큼 중요하다. |
| **md garden** | **의미공간** | public garden 자체는 meta / bib / autholog / botlog / notes 등이 엮인 개념 공간. 시간보다 개념·주제·인명·문헌 연결이 중심이다. |

### Boundary principle — use stored signals, do not imitate day-query

Sessions track의 1차 목표는 새로운 시간 해석기나 day-query 대체재를 만드는 것이 아니라, 세션에 속한 명시 신호를 검색 surface에서 사용할 수 있게 해 작업 기억축을 복원하는 것이다.

Do:

- 저장된 metadata를 명시적 filter / sort / grouping / excerpt readback에 사용한다.
- 없는 신호는 억지 추론하지 말고 `metadata_missing`으로 기록한 뒤 indexer 보강으로 해결한다.
- natural-language time은 호출자가 ISO range로 변환해 넘긴다고 가정한다.
- 재색인은 비용/시간 때문에 피하지 않는다. 가치가 명확하면 재색인한다.

Do not:

- “어제/지난주/방금” 자연어 시간 파싱을 andenken에 넣지 않는다.
- git / journal / lifetract / day-query 집계를 따라 하지 않는다.
- embedding으로 없는 metadata를 추론하지 않는다.
- 세션 내용을 요약해 시간표처럼 재구성하지 않는다.

### Completed — Phase 1 stored-signal surface revival

2026-05-13 Phase 1은 재색인 없이 완료했다.

- 추가 surface: `dateFrom/dateTo`, `project`, `role`, `sessionFile`, `sessionFileContains`, `mode=semantic|hybrid|recent`.
- `recent`는 embedding/BM25/dictcli 없이 stored-signal scan + timestamp DESC.
- 반영 surface: `session_search`, CLI `search-sessions`, `run.sh` help, agent-config `semantic-memory` skill 문서.
- 검증:
  - `npm run build` pass
  - `npm run test:unit` 125/125 pass
  - `./run.sh verify sessions` pass
  - 11 baseline 재측정: T1/T2/T3/T4/T6/T9/T10 recovered, T5/T11 honest empty, T7/T8 semantic sentinel 유지

### Definition of done — Phase 2

1. **Metadata design — reindex-backed only**
   - Phase 1에서 `metadata_missing` 또는 lossy로 확인된 신호만 추가한다.
   - 후보:
     - `cwd` / normalized project path — basename `project` 충돌을 줄이고 담당자/경로 축 강화.
     - `entwurf_task_id` / `is_entwurf` — `*_entwurf-<taskId>.jsonl` 파일명에서 파싱.
     - `session_kind` 후보 — normal / entwurf / compaction-bearing 등 파일·row 수준에서 명시 가능한 것만.
     - scalar index 후보 — `timestamp`, `project`, `cwd`, `role`, `sessionFile` 성능 보강.
   - 하지 않을 것: 자연어 시간 파싱, day-query 집계, 요약 생성, missing signal 추론.

2. **Indexer + store schema update**
   - `session-indexer.ts`가 새 metadata를 명시적으로 산출한다.
   - `store.ts` row schema / filters가 새 metadata를 안전하게 다룬다.
   - 기존 DB와의 dim/schema guard를 깨지 않도록 한다.

3. **Reindex + verify**
   - 비용 추정 후 sessions 재색인 또는 필요한 범위의 force rebuild를 실행한다.
   - `./run.sh verify sessions` 통과.
   - status에서 새 metadata가 실제로 검색 가능한지 확인한다.

4. **Baseline after Phase 2**
   - Phase 1 baseline 중 T9류(`entwurf`)와 T11류(`compaction`/인접 chunk)가 개선되는지 측정한다.
   - T1/T2/T3/T4/T6/T10 recovered 상태와 T7/T8 semantic sentinel을 유지한다.

### Non-goal

- md golden B2a 구현은 보류. 단, md는 의미공간이라는 방향은 유지한다.
- org track은 건드리지 않는다.
- recall orchestrator 전체 설계는 andenken 책임이 아니다. 단, sessions 검색 API가 제공해야 할 계약은 정리한다.
- day-query 역할을 흡수하지 않는다. andenken은 저장된 세션 신호를 노출하고, 날짜 해석/집계/요약은 호출자 축에 맡긴다.

### Deferred — md 의미공간 golden

md 쪽 다음 항목은 여전히 유효하지만, sessions Phase 2 이후로 미룬다.

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
| Sessions Phase 1 | 2026-05-13 | stored-signal filters + `recent` mode, baseline recovered, skill interface documented |
