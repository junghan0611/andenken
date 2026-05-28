# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — Windowed sessions retrieval that survives daily use

**단 하나의 현재 우선순위:** 2026-05-28 doomemacs-config 측 wrapper
(`andenken-search-sessions-today/this-week`, KST 윈도우 → ISO UTC →
`--mode recent|hybrid`)를 사용자가 처음 매일 쓰려고 잡았다. 즉시 결과 미달.
실측으로 surface shape 문제 확정 (어제 KST 윈도우 / limit 30 / mode=recent):

| 축 | 분포 | 해석 |
|---|---|---|
| project | pi-shell-acp 25 / forge-config 5 (83% / 17%) | project 다양성 박살 |
| sessionFile | 한 세션이 17/30 (57%) | 세션 다양성 박살 |
| timestamp | 100%가 UTC 10:40~11:00 (KST 19:40~20:00 마지막 1시간) | **시간 다양성 박살 — 가장 critical** |

`mode=recent`는 stored-signal scan + timestamp DESC라 윈도우 끝 N분이
결과를 다 점령한다. 사용자가 보고 싶은 "어제 24h 전체 자리"가 실제로는
**1/24만** 보인다. 인덱싱이 아니라 retriever surface shape 문제.

### Sub-plan (순서대로)

| 단계 | 내용 | 상태 |
|---|---|---|
| **2e** | Multi-axis balanced windowed view — (sessionFile × time-bucket × project) 3축 dedup. retriever.ts post-process + cli.ts `--view session`. 인덱싱 무변경 | **현재 진입점** |
| **2b** | Corpus noise threshold — simulation 병행 (read-only). 임계값 박기는 2e 안정 후 | 시뮬만 |
| **2a** | parsePiLine compaction schema fix + targeted reindex (Phase 1 stored signals 결손 채움) | 2e 다음 |
| **2c** | Golden quality 측정 — query #3 entwurf 결과 / #6 multi-repo 의미연결 / #8 entwurf 흐름. 2e/2a/2b 전후 비교 | pending |
| **2d** | Derived signals 인덱싱 (entwurf_task_id / commit_sha / slash_command) — 2c 결과 보고 결정. 인덱싱 변경 자리 | deferred |

### Current step — 2e Multi-axis balanced view

dedup unit = (sessionFile, time-bucket, project) 3축.

| 축 | 정의 |
|---|---|
| sessionFile | 한 세션의 청크가 한 시간 구간 안에서 1행만 (대표 chunk) |
| time-bucket | 윈도우 길이 / target limit (24h+30 → ~48분 bucket; 7d+30 → ~5.6h bucket). bucket 균등 sampling이 1차 정렬 |
| project | 같은 bucket 안에서 project round-robin (`forge-config 1행 + pi-shell-acp 1행 + ...`) |

정렬 우선순위:

1. **time-bucket 균등 sampling** — 빈 query에서 마지막 N분 점령 방지
2. project round-robin — 멀티리포 다양성 강제
3. latest-touched (recent) / score (hybrid) — 같은 (bucket, project) 안에서 대표 선정

자식 entwurf 세션 처리 (sessionFile 정규식에서 derive): `chunks≥3` 자식만
별 행, 작은 자식은 부모 행에 count 표시.

코드 위치: `retriever.ts` 후처리 함수 + `cli.ts` `--view session` flag.
인덱싱 변경 없음. 기존 `--view chunk` (default) 유지. windowed 안에서
14d temporal decay는 off (이미 시간 잘림).

### Boundary principle — caller owns the time window, andenken owns the diversity

Sessions track의 목표는 새로운 시간 해석기를 만드는 것이 아니다. 시간
윈도우는 caller가 잡고(`--date-from/--date-to`), andenken은 그 안에서
**세션 중복 없는 / project 다양성 있는 / 시간 분포 균형 잡힌** 결과를
노출한다. 윈도우 자연어 파싱과 git/journal/bib 통합은 day-query / recall
자리.

### Non-goal

- md retrieval ranking 자체를 이번 항목에서 다시 튜닝하지 않는다
- org track은 건드리지 않는다 (production disable 유지)
- 인덱싱 schema 변경(2d)은 2c 측정 보고 결정 — 우선 retriever 후처리로
  끝나는 것부터

### Review pending

2026-05-28: 위 frame을 GPT-5.5에 2차 리뷰 요청 — `.review/2026-05-28.md`
참조. Q1~Q7 GLG 입장 잠금 (Q3은 raw 측정 결과 보고 시간 분포 균형으로 수정).
