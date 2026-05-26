# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Sessions retrieval quality foundation (resumed)

**단 하나의 현재 우선순위:** 2026-05-18 framing 복귀. 2026-05-20 md incremental stale policy의 첫 legacy migration 사이클이 2026-05-21에 정상 완료(`missing-hash=0` 확인, ROADMAP 흡수)되어 sessions retrieval quality foundation으로 다시 진입한다.

### Sub-plan (4단계, 순서대로)

| 단계 | 내용 | 상태 |
|---|---|---|
| **2a** | Corpus signal 살리기 — `parsePiLine` compaction schema fix + targeted reindex | pending |
| **2b** | Corpus noise 빼내기 — session quality threshold 정책 결정 + 재색인에 통합 | **현재 진입점** (시뮬레이션 먼저) |
| **2c** | Quality 정량 측정 — sessions/md golden set + `doctor --golden` surface | pending |
| **2d** | (2c 결과 보고) metadata slice 결정 | deferred |

### Current step — 2b threshold candidate simulation (코드 변경 X)

2b는 측정-우선이다. 임계값 후보별로 **빠지는 세션 수 / row 수 / 검색 결과 영향**을 정량 비교한 뒤 2a 재색인에 통합한다.

2026-05-26 사용자 검토 의견도 여기로 합친다: 최근 sessions sync에서 `new 95`가 한 번에 들어올 정도로 세션량이 늘었고, 이제는 **너무 짧거나 의미 없는 세션을 판별해 인덱스에서 정리하는 로직**이 필요하다. 이번 단계는 그 요구를 바로 코드로 박기보다, 어떤 임계값이 실제로 low-signal chatter / ping-pong / tool-noise를 줄이면서도 작업 기억을 해치지 않는지 먼저 수치로 보자는 단계다.

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
- 특히 "짧고 의미 없는 sessions"가 얼마나 빠지는지에 대한 사람이 읽을 수 있는 샘플 세트
- GLG가 임계값 한 세트 선택 → 2a fix와 함께 적용

### Boundary principle — use explicit session signals, do not imitate day-query

Sessions track의 목표는 새로운 시간 해석기나 day-query 대체재를 만드는 것이 아니라, 세션에 속한 명시 신호를 검색 surface에서 사용할 수 있게 해 작업 기억축을 복원하는 것이다.

### Non-goal

- md retrieval ranking 자체를 이번 항목에서 다시 튜닝하지 않는다
- org track은 건드리지 않는다 (production disable 유지)
