# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — B2: md retrieval quality follow-up

**단 하나의 현재 우선순위:** md 검색 품질을 정량적으로 추적할 수 있게 만든다.

B1c (md embedding production hardening) 와 B1d (md doctor V1) 는 2026-05-12 에 종료.
이제 남은 진짜 기술 부채는 검색 품질이다 — 인덱싱과 진단 도구는 갖췄지만
"이 쿼리에서 적합한 노트가 진짜 1순위로 뜨는가?" 를 시간축으로 비교할 수단이 없다.

### Why this is next

10-query md smoke 중 `2026-05-11 andenken` 은 결과가 나오기는 했지만 **그 날의
실제 현재 작업 노트가 1순위로 뜨지 않았다**. 이건 단발성 관찰일 수도 있고
구조적 이슈일 수도 있는데, golden query set 없이 알고리즘을 건드리면 회귀를
잡을 수 없다.

### Definition of done for B2

1. **md golden query set 정의** — `data/md-golden.json` (또는 `golden-queries.ts`
   확장)에 최소 10개 쿼리 + expected top-N 파일/folder 패턴. 후보:
   - `보편 학문`, `피투성`, `어쏠로지`, `바네바 부시`, `제프 베이조스`,
     `andenken openclaw`, `entwurf 시간축`, `일일일생`,
     `2026-05-11 andenken`, `디지털가든 메타휴먼`.
   - 각 쿼리에 대해 "이 노트가 top-5에 있어야 한다" 정도로 부드러운 매칭.
2. **`./run.sh golden:md` 추가** — 현재 baseline 점수 측정 + 마지막 점수 대비
   delta 출력. fail 임계값은 운영 데이터 1주일 모은 다음 결정 (placeholder OK).
3. **`2026-05-11 andenken` 실패 사례 분석** — 왜 day-specific 쿼리에서 당일성
   note 가 약하게 잡히는지 진단. 가설:
   - BM25 `2026-05-11` 토큰이 frontmatter `date:` 에 매칭 안 됨 (FTS text 가
     title + tags 만 prefix 됨)
   - 날짜 토큰을 query enrichment 단에서 별도 처리해야 할 수도
   - 또는 `andenken` 태그가 너무 흔해서 specificity 부족
   - **doctor 가 아니라 golden query 가 이 가설을 검증한다.**
4. **md doctor V2 의 smoke probe** — B2 가 golden 갖춰지면 `doctor --md --smoke`
   가 같은 골든을 read-only 로 회전시킬 수 있게 V2 작업 시작.

### Non-goal right now

- Org 트랙 손대지 않는다 (production disabled / upstream R&D).
- md chunker / sanitization 로직 변경하지 않는다 — golden 베이스라인 없이 건드리면
  회귀 검증이 안 됨.
- pi extension / live surface 추가 변경 없음. B1c 에서 sessions + md 로 정렬 완료.

### Completed prerequisites (closed)

| 마일스톤 | 종료일 | 핵심 산출물 |
|---|---|---|
| B0 | 2026-05-11 | `0831487` — qmd path 폐기, org 분리 |
| B1a | 2026-05-12 | `b431bf7` `db99aa2` `6d5ad90` — md 스캐폴딩 + OpenClaw chunkMarkdown 포팅 + CJK 가중 + 임베딩/FTS 분리 |
| B1b | 2026-05-12 | `9f16a24` — Oracle sync 핸드오프 (`sync:md:oracle`) |
| B1c | 2026-05-12 | local full index (10,119 chunks, 4096d, verify pass) + sessions/md live surface 전환 + agent-config 핸드오프 정렬 + Oracle sync `sync:md:oracle --smoke` pass |
| B1d | 2026-05-12 | `doctor --md` V1 — `analyzeMdFile` SSOT + manifest↔indexed gap explainability (3 noembed_tag + 15 min_body = 18 zero-chunk; unclassified=0 = drift 없음) |

B1d 의 SSOT 함수 `analyzeMdFile` 는 indexer 와 doctor 가 공유한다. 새 skip 분기를
추가할 때 두 소비자가 동시에 갱신되도록 강제하는 게 이 함수의 존재 이유다.

### Notes for future skip-class additions

`MdSkipReason` 에 새 카테고리를 추가하면 doctor-md 의 `ALL_REASONS` /
`emptyBreakdown` / `GapBreakdown` / pretty-render `order` 를 같이 갱신해야 한다.
그 외에는 SSOT 가 알아서 처리한다.
