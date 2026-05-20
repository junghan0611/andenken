# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — MD incremental stale policy for link-only edits

**단 하나의 현재 우선순위:** 2026-05-20 md sync가 `new 3`인데 `stale 2214`로 잡혀 거의 전체 가든을 다시 임베딩했다. 가든에는 링크 수정, 메타 정리, 경미한 문장 손질이 많기 때문에 **retrieval payload가 실질적으로 안 바뀐 파일까지 전부 stale로 재임베딩하는 현재 정책**을 먼저 줄여야 한다.

### Why this is next

- 실제 실행:
  - `MD: 2217 | indexed: 2196 | new: 3 | stale: 2214`
  - `API: 2205 calls, ~7966K tokens, ~$0.080`
- 사용자가 말한 변경 성격:
  - "미세한 가든 수정"
  - 링크 몇 개 수정된 파일도 많음
- 현재 문제:
  - manifest stale 판정이 파일 전체 재임베딩으로 직결됨
  - retrieval 품질에 거의 영향 없는 수정도 비용과 시간이 크게 듦

### Target

`sync:md`가 **검색에 쓰이는 chunk payload 변화**를 기준으로 stale를 판정하게 만든다. 최소한 아래는 full re-embed를 피해야 한다.

- link-only edits
- front matter / metadata touch with unchanged body payload
- whitespace / formatting churn that does not change emitted chunks materially

### Expected output

- md manifest 또는 stale detector가 file mtime/size보다 **chunk-relevant fingerprint**를 우선 사용
- `./run.sh estimate:md`가 "왜 stale인지"를 설명할 수 있는 surface를 가짐
- smoke case:
  - link-only 변경 N개 → stale가 N 전부가 아니라 payload-changed subset만 잡힘
  - 실제 임베딩 비용/시간이 미세 수정 규모에 비례

### Non-goal

- md retrieval ranking 자체를 이번 항목에서 다시 튜닝하지 않는다
- org track은 건드리지 않는다
- sessions quality work를 없애는 게 아니라, md 쪽 운영 비용 누수를 먼저 막는다
