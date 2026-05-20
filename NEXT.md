# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Sessions retrieval quality foundation (resumed)

**단 하나의 현재 우선순위:** 2026-05-18 framing 복귀. 2026-05-20 md incremental stale policy(ROADMAP 흡수)가 size-guard + payload-hash로 마무리되어 sessions retrieval quality foundation으로 다시 진입한다.

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

### Boundary principle — use explicit session signals, do not imitate day-query

Sessions track의 목표는 새로운 시간 해석기나 day-query 대체재를 만드는 것이 아니라, 세션에 속한 명시 신호를 검색 surface에서 사용할 수 있게 해 작업 기억축을 복원하는 것이다.

### md track follow-up (다음 publish 직후)

리뷰 결과 b37663f의 baseline-trust 분기가 silent miss를 만들 수 있어 1d0421a에서 보수적 정책으로 정정 (missing-hash → re-embed). 그 trade-off는 다음과 같이 명시한다.

- **다음 한 번의 sync:md는 오늘(5/20)과 비슷한 비용($0.08 수준)이 그대로 나올 가능성이 높다.** 현재 manifest 2217 entries 모두 `payloadHash`가 없는 legacy 상태이고, 5/20 publish 패턴이 반복되면 mtime touched + size same인 ~2150개 파일이 `missing-hash`로 분류되어 보수적 re-embed로 들어간다. 한 번의 legacy migration 비용 — silent miss를 막기 위한 의도적 trade-off. 괜찮음.
- **두 번째 사이클부터 절감 효과 측정 시작.** 첫 sync가 끝나면 manifest에 hash가 누적되어 git diff=0 파일들이 다음 publish에서 `hash-match`로 빠진다. 5/20 측정 기준 ~2150개가 match로 떨어지면 정상 동작.
- **1차 확인점:** 다음 publish 직후 `./run.sh estimate:md` breakdown을 본다.
  - `missing-hash`가 거의 0으로 떨어지면 정상 (hash 누적 완료).
  - `match`가 mtime-touched 파일 수와 거의 같으면 정상.
  - `mismatch`가 큰 수라면 build pipeline이 본문 byte에도 build-time 변경(자동 backlink, footer, 빌드 메타 등)을 박는 사이클이라 hash가 매번 달라지는 경우. 그때는 chunker 수준의 normalization 같은 후속 작업이 추가 NEXT 항목으로 떠오른다.
- 결과를 ROADMAP에 한 줄 기록 후 이 섹션 제거.

### Non-goal

- md retrieval ranking 자체를 이번 항목에서 다시 튜닝하지 않는다
- org track은 건드리지 않는다 (production disable 유지)
