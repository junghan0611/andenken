# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Sessions Phase 2: T11 parser fix + targeted reindex

**단 하나의 현재 우선순위:** 2026-05-18 audit이 framing을 뒤집었다. "재색인-backed metadata slice"가 아니라, **이미 있는 corpus 신호를 살려내는 parser fix**가 가장 큰 한 걸음.

### Current step — fix `parsePiLine` compaction schema mismatch

`session-indexer.ts:110-119` + `:313`이 nested `parsed.compaction.summary`를 기대하지만 **실제 pi corpus는 top-level `parsed.summary`**. 결과: pi 111줄 compaction 전부 drop.

1. **Fix**
   - `PiJsonlMessage` 인터페이스: 실제 형식에 맞게 `summary?: string`을 top-level로.
   - `parsePiLine` line 313: `parsed.summary`를 우선 사용. 옛 nested 형태가 코퍼스에 정말 없다면 backward-compat 코드 빼고 단일 path로.
   - 단위 테스트 한 줄: sample compaction JSON line이 chunk role=compaction으로 분류되는지.

2. **Targeted reindex**
   - 영향 파일: pi compaction line 가진 모든 sessions JSONL. `grep -rl '"type":"compaction"' ~/.pi/agent/sessions/` 로 추출.
   - 그 파일들의 manifest entry를 invalidate (mtime은 안 변하므로 단순 sync로는 안 잡힘). 옵션:
     - 옵션 A: manifest entry 삭제 후 `sync-sessions`.
     - 옵션 B: `force=true` 한정 path (file 리스트).
   - 비용 추정: 영향 파일 수 × 평균 chunk × $0.01/M tokens — pi compaction은 111줄이지만 파일들은 전체 재처리 필요. doctor `compaction` row count로 검증.

3. **Verify**
   - `doctor --sessions` 재실행: `role=compaction > 0` 으로 surface 변경.
   - `./run.sh verify sessions` pass.
   - baseline T11 query (`role=compaction` filter) → honest hits.

### Audit log (B + C) — 2026-05-18

**B. T11 진단 (corpus side):**
- pi corpus `"type":"compaction"` line 111건 존재. 모두 **top-level `summary`** 형식.
- nested `compaction.summary` 형식은 0건.
- `extractSessionChunks` 직접 호출(sample 파일, compaction 1줄): total=13 chunks, **compaction=0**.
- → **parser bug 확정**. corpus 부재 아님.

**C. slice 정량 비교 결과 (참고용 — Phase 2 metadata slice는 deferred):**
- TRUE basename collision (same source, same project, >1 dir): **단 1건** (`pi/pi-mono` 41 rows = 0.13%). 나머지 보이는 collision은 pi vs claude 자연 분리로 `source` column이 이미 풀어줌.
- entwurf: 333 rows / 33 distinct dirs로 이미 정확히 격리. bypass 충분.
- session_kind: T11 fix 전엔 측정 가치 부재.
- → 세 후보 모두 즉시 ROI 낮음. Phase 2 metadata slice는 fix 이후로 재평가.

이번 audit이 **doctor V1 surface로 framing 자체를 옳게 바꿔준 패턴** — 가장 큰 가치 있는 발견.

### Direction fixed by GLG — 2026-05-13

andenken에는 두 개의 살아있는 임베딩 표면이 있지만 기대하는 성격이 다르다.

| Track | Primary expectation | Notes |
|---|---|---|
| **sessions** | **시간축 + 담당자/경로 축** | “어제/최근/그 repo에서 하던 일”을 이어가기 위한 작업 기억. timestamp, project/cwd, session path, line number가 의미 유사도만큼 중요하다. |
| **md garden** | **의미공간** | public garden 자체는 meta / bib / autholog / botlog / notes 등이 엮인 개념 공간. 시간보다 개념·주제·인명·문헌 연결이 중심이다. |

### Boundary principle — use explicit session signals, do not imitate day-query

Sessions track의 목표는 새로운 시간 해석기나 day-query 대체재를 만드는 것이 아니라, 세션에 속한 명시 신호를 검색 surface에서 사용할 수 있게 해 작업 기억축을 복원하는 것이다.

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
- commit: `0dcba81` — `feat(sessions): add stored-signal search filters`
- skill doc: agent-config `bf15ba6` — `docs(semantic-memory): document session stored-signal filters`

### Deferred — Phase 2 metadata slice (재평가 시점)

T11 fix + 재색인 후 doctor surface가 변경되면 다시 본다. 그때 기준:

- `cwd` / normalized project path — 현재 측정 0.13% collision. fix 후에도 그대로면 추가 안 함.
- `entwurf_task_id` / `is_entwurf` — 현재 bypass 충분. semantic gap 측정 후 판단.
- `session_kind` — compaction이 살아난 뒤 의미 가짐.
- scalar indexes — 검색 latency 측정 후 필요시.

가치가 명확한 한 조각만 자른다. 명확하지 않으면 자르지 않는다.

### Non-goal

- T11 fix 한 번에 여러 변화를 묶지 않는다 (parser fix + targeted reindex만).
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
| Sessions Phase 1 | 2026-05-13 | `0dcba81` stored-signal filters + `recent` mode, baseline recovered, skill interface documented |
| Sessions doctor V1 | 2026-05-18 | `b37307c` `doctor --sessions` — provider/DB/manifest/gap + role/source/project/null/timestamp/entwurf distribution. Phase 2 audit 도구로 사용. |
