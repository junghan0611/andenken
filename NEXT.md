# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — B2a: md golden trace-seeded baseline (no judge)

**단 하나의 현재 우선순위:** trace-derived golden 20건 + read-only baseline
한 번 측정을 1차 PR로 자른다. judge / sentinel 비율 / cadence / 알람 경로는
**측정 결과를 본 다음** 결정한다.

### Why this is next

2026-05-12 사전조사로 B2 가설 4개가 데이터로 갈음됨
(`~/org/llmlog/20260512T165651--md-golden-사전조사__andenken_evaluation_golden_llmasjudge_llmlog_md.org`).
핵심 발견:

- 실제 에이전트 쿼리는 keyword bag (mixed 63.3%, median 38자) — NEXT의 자연어
  후보(`보편 학문`, `피투성`)는 실제 사용 surface와 형태가 다름.
- md 호출 90건 중 **strong seed로 바로 쓸 수 있는 게 20건**, weak 포함 26건.
  strong은 *assistant가 명시 수용한 케이스만* 추출 → 사람 라벨링과 동치.
  추가 calibration 라벨링은 strong seed에는 불필요.
- `2026-05-11 andenken` 실패는 단발 아님 (`2026-03-19`, `2026-03-15`,
  `2026-04-15`에서 재현) → **date+project combined ranking failure**로 일반화.
  단 ranking 알고리즘 손대는 건 B2a non-goal — 측정만 먼저.
- schema 3층 분리(raw / curated / surface)는 over-engineering 위험. 30건
  안 되는 데이터에 분리 비용 과함. 단일 JSONL + 단일 JSON으로 1차 cut.

### Definition of done for B2a

1. **`scripts/build-md-traces.py` 정착** — `/tmp/andenken_md_trace_mining.py`
   에서 옮기고 `./run.sh build:md-traces`로 등록. Python 유지 (TS 포팅 무의미).
2. **`data/md-golden-traces.jsonl`** — mining 결과 90건 그대로 dump. 필드는
   사전조사 §schema 권고 그대로 (`id` / `source` / `surface` / `query_raw`
   / `intent_context` / `usefulness_signal` / `ground_truth_extractable` /
   `next_assistant_excerpt`). curated 분리 안 함 — 30건 넘으면 그때.
3. **`data/md-golden.json`** — strong seed 20건 + GLG sentinel 별도 섹션.
   두 그룹은 다른 metric으로 본다 (seed = top-5 hit rate, sentinel =
   boolean must-hit).
4. **`./run.sh golden:md`** — top-1 / top-3 / top-5 hit rate + MRR +
   repeat_refinement count. **judge 없음.** baseline 한 번 측정으로 끝.
5. **query vector cache** — paid embedding 1회만. `data/md-golden-vectors.lance`
   또는 `golden.json` 안에 인라인. 매 실행마다 OpenRouter 호출하면 안 됨.
6. **첫 baseline 숫자 commit log에 박기** — "오늘 측정됨"이 운영 닻.

### Non-goal for B2a

- judge 본체 통합 (4축이든 2축이든) — baseline 측정 후 silver 승격 때만.
- sentinel 비율 확정 (5~10 vs 15~20) — measurement 보고 결정.
- regression cadence / 알람 경로 — measurement 보고 결정.
- ranking 알고리즘 수정 (`andenken` 태그 specificity / date+project) —
  golden 없이 건드리면 회귀 검증 안 됨. baseline이 측정 도구다.
- md chunker / sanitization 변경.
- Org 트랙.

### Deferred — measurement 후 결정 (큐 아님, 기록일 뿐)

baseline이 굴러가면 그때 한 줄씩 골라 다음 NEXT로 승격. 여러 항목 동시
진행 안 함.

- (D1) repeat_refinement 18건을 **negative bucket이 아니라 fix-target list**로
  격상할지 — `data/md-repeat-refinement.jsonl` 분리 여부.
- (D2) judge 도입 — 2축(relevance + next_action) vs 4축, calibration cadence,
  cost gate.
- (D3) sentinel 비율 / 회귀 안전망 확장.
- (D4) golden 실행 cadence — `sync:md` 후 자동? `memory-sync` 후크? 수동?
  실패 알람 경로 (CI fail / GLG 확인 / Google Chat 알림).
- (D5) date+project combined ranking — `andenken` 태그 IDF / dense note
  specificity. ranking 알고리즘 측면. ROADMAP 운영 신호로 이동 후보.

### Completed prerequisites (closed)

| 마일스톤 | 종료일 | 핵심 산출물 |
|---|---|---|
| B0 | 2026-05-11 | `0831487` — qmd path 폐기, org 분리 |
| B1a | 2026-05-12 | `b431bf7` `db99aa2` `6d5ad90` — md 스캐폴딩 + OpenClaw `chunkMarkdown` 포팅 + CJK 가중 + 임베딩/FTS 분리 |
| B1b | 2026-05-12 | `9f16a24` — Oracle sync 핸드오프 (`sync:md:oracle`) |
| B1c | 2026-05-12 | local full index (10,119 chunks, 4096d, `verify md` pass) + sessions/md live surface 전환 + agent-config 핸드오프 정렬 + Oracle `sync:md:oracle --smoke` pass |
| B1d | 2026-05-12 | `c20de24` `baa5a61` `e5154f8` — `doctor --md` V1 (`analyzeMdFile` SSOT + manifest↔indexed gap explainability) + 문서 정렬 |
| B2-survey | 2026-05-12 | llmlog `20260512T165651` — 1,716세션 마이닝, md 90호출, strong seed 20 / hard-negative 19, judge 설계 권고, `2026-05-11 andenken` ranking 일반화 |

### Notes

- B2-survey 가 갈음한 가설: 이전 NEXT의 4개 가설 중 #1 (frontmatter `date:`
  미매칭)은 *약화*, #2 (`andenken` 태그 specificity 부족) + #4 (단순 ranking
  failure)는 *강하게 의심*, #3 (date enrichment)은 *후속 실험 필요*.
- B2a 끝나면 NEXT는 D1~D5 중 baseline 측정이 가장 강하게 가리키는 하나로
  덮어쓴다. 여러 항목 큐로 쌓지 않는다.
- B1d의 SSOT 함수 `analyzeMdFile` 는 indexer / doctor 공유. 새 `MdSkipReason`
  추가 시 `ALL_REASONS` / `emptyBreakdown` / `GapBreakdown` / pretty-render
  `order` 동시 갱신.
