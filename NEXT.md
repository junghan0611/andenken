# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Sessions as time/project memory axis

**단 하나의 현재 우선순위:** 세션 임베딩을 **시간축(time axis) + 담당자/경로(project/cwd axis)** 중심으로 다시 점검하고, 현재 retrieval surface가 이 기대를 충족하지 못하는 지점을 먼저 보강한다.

### Direction fixed by GLG — 2026-05-13

andenken에는 두 개의 살아있는 임베딩 표면이 있지만 기대하는 성격이 다르다.

| Track | Primary expectation | Notes |
|---|---|---|
| **sessions** | **시간축 + 담당자/경로 축** | “어제/최근/그 repo에서 하던 일”을 이어가기 위한 작업 기억. timestamp, project/cwd, session path, line number가 의미 유사도만큼 중요하다. |
| **md garden** | **의미공간** | public garden 자체는 meta / bib / autholog / botlog / notes 등이 엮인 개념 공간. 시간보다 개념·주제·인명·문헌 연결이 중심이다. |

따라서 B2a md golden은 중요하지만, 지금 우선순위는 md sentinel 확장이 아니다. 세션 임베딩이 “시간축 작업 기억”으로 충분히 동작하는지 먼저 확인한다. 부족하면 sessions 쪽을 선행한다.

### Why this is next

오푸스 설계 검토에서 확인한 현재 상태:

- session chunks에는 `timestamp`, `project`, `role`, `source`, `sessionFile`, `lineNumber` 메타가 보존된다.
- 하지만 retrieval surface는 주로 semantic similarity 중심이며, 노출된 필터는 제한적이다.
- `timestamp range` / `project or cwd` / `session path` 기반의 명시적 조회·rerank surface가 약하면, “어제 한 일”, “이 repo에서 직전에 하던 일”, “담당자 맥락”을 임베딩이 우연히 맞히는 구조가 된다.
- GLG의 기대는 세션 임베딩이 단순 의미공간이 아니라 **작업 시간축의 연결고리**가 되는 것이다.

### Definition of done

1. **Current capability audit**
   - `session-indexer.ts`, `store.ts`, `retriever.ts`, `cli.ts`, `index.ts`에서 sessions 검색 surface를 확인한다.
   - timestamp / project / cwd / sessionFile / lineNumber가 어디까지 저장되고 어디서 버려지는지 표로 정리한다.

2. **Time/project query baseline**
   - 실제 질문 유형을 최소 8~12개로 만든다.
   - 예: “어제 andenken에서 한 일”, “2026-05-13 오전 세션 임베딩”, “nixos-config 직전 작업”, “pi-shell-acp 담당자에서 하던 일”.
   - 각 query를 semantic-only, date/project constrained, two-step 방식으로 비교한다.

3. **Gap classification**
   - 실패를 다음 중 하나로 분류한다.
     - `metadata_missing` — 저장 자체가 부족
     - `surface_missing` — 저장되어 있으나 검색 API/CLI에서 못 씀
     - `ranking_miss` — surface는 있으나 정렬 실패
     - `chunk_context_miss` — line/session 인접 맥락 복원이 부족
     - `orchestration_miss` — andenken이 아니라 recall/day-query 라우팅 문제

4. **Smallest next fix proposal**
   - 코드 수정 전, 가장 작은 보강안을 하나만 고른다.
   - 후보: timestamp range filter, project/cwd filter, sessionFile grouping, date+project query mode, recency-aware rerank, session-excerpt 연결.
   - md golden으로 돌아갈지, sessions surface fix로 이어갈지 GLG가 결정할 수 있게 한다.

### Non-goal

- md golden B2a 구현은 보류. 단, md는 의미공간이라는 방향은 유지한다.
- org track은 건드리지 않는다.
- recall orchestrator 전체 설계는 andenken 책임이 아니다. 단, sessions 검색 API가 제공해야 할 계약은 정리한다.
- 코드 수정은 audit 이후 별도 결정으로 한다.

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
