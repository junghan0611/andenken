# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Sessions retrieval quality foundation

**단 하나의 현재 우선순위:** 2026-05-18 audit + 실사용 검색 평가 + corpus quality 측정이 framing을 한 번 더 옮겼다. 단일 parser fix가 아니라 **retrieval quality의 토대 (corpus signal 살리기 + corpus noise 빼내기 + 정량 측정)** 를 한 묶음으로 자른다.

### Sub-plan (4단계, 순서대로)

| 단계 | 내용 | 상태 |
|---|---|---|
| **2a** | Corpus signal 살리기 — `parsePiLine` compaction schema fix + targeted reindex | pending |
| **2b** | Corpus noise 빼내기 — session quality threshold 정책 결정 + 재색인에 통합 | **현재 진입점** (시뮬레이션 먼저) |
| **2c** | Quality 정량 측정 — sessions/md golden set + `doctor --golden` surface | pending |
| **2d** | (2c 결과 보고) metadata slice 결정 | deferred |

### Current step — 2b threshold candidate simulation (코드 변경 X)

2b는 측정-우선이다. 임계값 후보별로 **빠지는 세션 수 / row 수 / 검색 결과 영향**을 정량 비교한 뒤 2a 재색인에 통합한다.

후보 dimension:

| 후보 | 의미 | 시뮬레이션 출력 |
|---|---|---|
| `MIN_TOTAL_EXTRACTED_TEXT_BYTES` (현재 `MIN_SESSION_SIZE_BYTES=2048`은 부정확) | actual extracted text length 기반 | threshold별 빠지는 sessions 수 |
| `MIN_CHUNK_COUNT_PER_SESSION` | 1-chunk ping 제거 | threshold별 빠지는 sessions 수 |
| `--delegate--/` 디렉터리 명시적 skip | entwurf 이전 legacy delegate | 빠지는 sessions 수 |
| `_entwurf-*` 자식 중 chunks<2 skip | reply-OK 자식 분신 | 빠지는 entwurf rows 수 |

산출물:
- 시뮬레이션 스크립트 (read-only) 또는 `doctor --sessions --quality-sim` 옵션
- 각 후보 + 조합의 정량 결과
- GLG가 임계값 한 세트 선택 → 2a fix와 함께 적용

### Audit log — 2026-05-18

**A. T11 진단 (B 단계):**
- pi corpus `"type":"compaction"` line 111건 존재. 모두 **top-level `summary`** 형식. nested `compaction.summary`는 0건.
- `extractSessionChunks` 직접 호출: sample 파일 1줄 compaction → chunks=0.
- → **parsePiLine schema mismatch 확정**. corpus 부재 아님. → 2a로.

**B. Slice 정량 비교 (C 단계):**
- TRUE basename collision (same source, same project, >1 dir): **단 1건** (`pi/pi-mono` 41 rows = 0.13%). 나머지 보이는 collision은 pi vs claude 자연 분리로 `source` column이 이미 풀어줌.
- entwurf: 333 rows / 33 distinct dirs로 정확히 격리. bypass 충분.
- session_kind: T11 fix 전엔 측정 가치 부재.
- → 세 후보 모두 즉시 ROI 낮음. → 2d로 미룸.

**C. 실사용 검색 평가 (4 쿼리):**
- Q1 "T11 compaction parser bug" (sessions) — Phase 2 회의 5일 전 잘 잡힘. 하지만 **다중 의미어 노이즈** (`pi-shell-acp`의 cacheRead/compaction이 같이 매칭). 점수 0.025→0.020 gap 좁아 cut-off 어려움.
- Q2 "Sessions Phase 1 stored-signal" (sessions) — **6/6 정확**. top score 0.05+. sessions track의 best case.
- Q3 "Mitsein 비대칭" (md) — 4/6 정확. 2/6은 **"비대칭" 분기 매칭 노이즈** (물리/암호). score 0.85~0.99 균질 → cut-off 곤란.
- Q4 "보편" (md, dictcli expand 데모) — **6/6 정확**. `["universal", "universalism", "paideia", ...]` expand로 cross-lingual 완벽.
- → 패턴: **P1 의미 다중성 / P2 분기 매칭 / P3 score 균질도 / P4 fresh 한계.** 단일 알고리즘 변경으로 풀리지 않음. **정량 측정 layer가 우선** → 2c로.

**D. Corpus quality 측정:**
- Total indexed sessions: **1,819**, total rows: 31,546.
- **1 chunk only (ping): 183 sessions (10.1%)**. 2-3 chunks: 548 (30.1%).
- **Low-signal (chunks≤3 AND avgChunkLen<200): 256 sessions (14.1%)**, 그들의 rows 497 (1.6%).
- Sample low-signal:
  - `chunks=1 totalLen=22 fileSize=5710` pi `--home-junghan--/` (사용자 한 마디 응답)
  - `chunks=1 totalLen=24 fileSize=2661` pi `--delegate--/` (legacy delegate channel)
  - `chunks=1 totalLen=46 fileSize=3123` pi `--home-junghan--/..._delegate-*.jsonl`
- 현재 `MIN_SESSION_SIZE_BYTES=2048` 파일 크기 필터는 **부정확** — pi format이 metadata + tool calls로 file size를 부풀려서 actual text 22 chars여도 통과.
- → 2b 필요성 확정.

### Direction fixed by GLG — 2026-05-13

andenken에는 두 개의 살아있는 임베딩 표면이 있지만 기대하는 성격이 다르다.

| Track | Primary expectation | Notes |
|---|---|---|
| **sessions** | **시간축 + 담당자/경로 축** | "어제/최근/그 repo에서 하던 일"을 이어가기 위한 작업 기억. timestamp, project/cwd, session path, line number가 의미 유사도만큼 중요하다. |
| **md garden** | **의미공간** | public garden 자체는 meta / bib / autholog / botlog / notes 등이 엮인 개념 공간. 시간보다 개념·주제·인명·문헌 연결이 중심이다. |

### Boundary principle — use explicit session signals, do not imitate day-query

Sessions track의 목표는 새로운 시간 해석기나 day-query 대체재를 만드는 것이 아니라, 세션에 속한 명시 신호를 검색 surface에서 사용할 수 있게 해 작업 기억축을 복원하는 것이다.

Do:

- 저장된 metadata를 명시적 filter / sort / grouping / excerpt readback에 사용한다.
- 없는 신호는 억지 추론하지 말고 `metadata_missing`으로 기록한 뒤 indexer 보강으로 해결한다.
- natural-language time은 호출자가 ISO range로 변환해 넘긴다고 가정한다.
- 재색인은 비용/시간 때문에 피하지 않는다. 가치가 명확하면 재색인한다.
- **데이터 품질이 검색 품질의 토대다.** 의미 없는 ping-pong 세션은 인덱싱하지 않는다.

Do not:

- "어제/지난주/방금" 자연어 시간 파싱을 andenken에 넣지 않는다.
- git / journal / lifetract / day-query 집계를 따라 하지 않는다.
- embedding으로 없는 metadata를 추론하지 않는다.
- 세션 내용을 요약해 시간표처럼 재구성하지 않는다.
- 측정 없이 임계값을 추정으로 정하지 않는다.

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

### Deferred — 2d Phase 2 metadata slice (재평가 시점)

2a + 2b + 2c 끝낸 뒤 doctor / golden surface가 변경되면 다시 본다. 그때 기준:

- `cwd` / normalized project path — 현재 측정 0.13% collision. 그대로면 추가 안 함.
- `entwurf_task_id` / `is_entwurf` — 현재 bypass 충분. golden 측정 후 판단.
- `session_kind` — compaction이 살아난 뒤 의미 가짐.
- scalar indexes — 검색 latency 측정 후 필요시.

가치가 명확한 한 조각만 자른다. 명확하지 않으면 자르지 않는다.

### Non-goal

- 2b 임계값을 측정 없이 정하지 않는다. 시뮬레이션 → 비교 → 선택.
- 2a + 2b를 분리된 재색인으로 가지 않는다. 한 번에 묶어서 비용/시간 최소화.
- md golden은 2c 안에서 sessions golden과 함께 다룬다 (분리 안 함).
- org track은 건드리지 않는다.
- recall orchestrator 전체 설계는 andenken 책임이 아니다. 단, sessions 검색 API가 제공해야 할 계약은 정리한다.
- day-query 역할을 흡수하지 않는다. andenken은 저장된 세션 신호를 노출하고, 날짜 해석/집계/요약은 호출자 축에 맡긴다.

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
| Phase 2 framing | 2026-05-18 | retrieval quality foundation으로 재정렬. 2a parser fix / 2b quality threshold / 2c golden+doctor / 2d slice. |
