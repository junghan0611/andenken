# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## 트랙 A — sessions embedding: closed

Sessions track은 2026-05-11 기준 안정화 종료.

현재 운영 상태:

- model / dim: OpenRouter `qwen/qwen3-embedding-8b` / 4096d
- corpus: `pi` + standalone Claude Code (`~/.claude/projects`) only
- forbidden: `~/.pi/agent/claude-config-overlay/projects` — pi-shell-acp Claude overlay, 중복 기억이므로 인덱싱 금지
- full rebuild 완료: `28,537` chunks, `0` errors, verify pass, cost `~$0.065`
- C2.1c 완료: `session_search.withExcerpt` opt-in으로 search hit → 원문맥 readback 연결
- 2026-05-11 추가: source filter 정합화 (validation + LanceDB push-down + 명시적 source 시 org fallback suppress + golden harness sessions/org dim 분리)

닫은 뒤 원칙:

- sessions 관련 새 기능은 GLG가 명시적으로 다시 열 때만 한다.
- 평소 운영은 `scripts/sync-sessions.sh` / `memory-sync` incremental만 수행한다.
- score threshold / source weight / toolResult indexing / window chunking은 모두 보류. 지금 추격하지 않는다.

## 트랙 B — org/qmd: 지금 할 일

### B1 — org doctor WARN 신호 격리 (read-only, 진단 종결)

**목표**: B0 baseline triage(2026-05-11 완료)에서 잡힌 doctor WARN 3건의 원인을 **chunker 결함** vs **source 파일 손상** vs **운영 backlog**로 분리한다. 분리되기 전에는 org incremental sync로 넘어가지 않는다. chunker 결함이면 sync해도 똑같이 깨지므로 비용만 낭비된다.

**왜 이게 먼저인가**:

- 4일간(2026-05-07 → 2026-05-11) org indexing이 멈춰있고 `to_index=548` (stale 541 + new 7 + deleted 6). 4일간 manifest는 변동 0.
- sessions track은 모두 정상이라 응급도가 아님 — paid embed 호출 전에 chunker 결함부터 격리해야 cost-effective.
- qmd bridge 정리/문서화는 활용 신호가 아직 없어서 over-engineering 위험. doctor 신호가 더 구체적인 작업단.

**B0 baseline 측정 결과 (2026-05-11)**:

| 항목 | 값 | NEXT.md 작성 시점(B0) | Δ |
|---|---:|---:|---:|
| org rows | 44,916 | 44,916 | 0 |
| stale | 541 | 541 | 0 |
| to_index | 548 | 548 | 0 |
| last indexed | 2026-05-07 | 2026-05-07 | 0 |

→ 4일간 indexing 변화 없음. 순수 backlog.

**Doctor WARN 신호 3건 (`./run.sh doctor --org --no-smoke`)**:

| 신호 | 카운트 | 분류 가설 |
|------|------:|----------|
| `malformedBlockFiles` | 10 | source 파일 손상(GLG 영역) + chunker 패턴 부족 혼재 의심 |
| `zeroChunkUnexpectedFiles` | 4 | chunker가 모든 청크를 exclusion으로 잡거나 빈 본문 → chunker 결함 의심 |
| `hardGuardSkipTotal Δ+2` | 2 | 새 파일이 hard guard 패턴 트리거 — chunker 한계점 |

**malformedBlockFiles 패턴 분석**:

- journal 파일 5개: `unclosed #+begin_src`/`stray #+end_src` — 사용자가 src block 닫지 않고 저장한 흔적. source 파일 측 손상.
- botlog 1개: 90+ imbalance — nested begin/end가 진짜로 깨졌거나, chunker가 nested src을 못 트래킹. 양면 가능성.
- bib/meta/notes 4개: 각 1-10건 imbalance. source 측이 다수.

**해야 할 것 (이번 단일 항목 안에서)**:

1. `zeroChunkUnexpectedFiles` 4건의 본문을 직접 확인 — 정말 0 청크가 합당한가, chunker 결함인가.
2. `malformedBlockFiles` 10건을 source 손상 vs chunker 결함으로 분류. source 손상은 GLG가 직접 source 파일 수정.
3. `hardGuardSkipTop` 2건의 트리거 조건 확인 — `indexer.ts` 어떤 가드인지.
4. 분류 결과를 **한 줄 결론**으로 정리:
   - "chunker 결함만 N건 — 코드 수정 필요"
   - "source 손상만 M건 — GLG 수정 필요"
   - 두 영역이 분리되면 incremental sync로 넘어갈 수 있는 상태.

**금지**:

- org incremental sync 금지 (이 진단이 끝나기 전)
- org full rebuild 금지
- qmd production 전환 금지
- embedding API 호출은 incremental dim 가드 검증 외에는 보류
- chunker 코드 변경은 진단에서 chunker 결함이 확정되면 별도 NEXT 항목으로 분리. 진단 단계에서 같이 고치지 않는다.

## 별도 이슈 — dictcli expansion 보정

andenken 작업은 아니지만 품질 검수에서 발견한 Layer 3 이슈로 별도 추적한다.

- 문제: `초기` → `enactment`, `establishment`, `institution` 등으로 확장됨.
- 기대: `initial`, `early`, `beginning`, `earlystage` 계열.
- 영향: Korean→English mixed query에서 BM25/embedding query enrichment가 엉뚱해질 수 있음.
- 처리 위치: `dictcli` vocabulary graph. andenken에서는 증상과 재현 쿼리만 기록한다.

## 외부 의존 / 주의

- sessions는 8B/4096d, org는 4B/2560d. 두 DB/provider 차원을 섞지 않는다.
- OpenRouter Qwen3-Embedding-8B 가격은 현재 `$0.01/M` 기준.
- long-lived pi/extension은 코드 변경 후 재시작해야 새 `session_search` schema를 읽는다.
- `./run.sh golden --db session`은 이제 sessions provider(`ANDENKEN_SESSION_*`)로 자동 분기. `--db org`는 org provider(`ANDENKEN_ORG_*` / legacy `ANDENKEN_VLLM_*`). 한쪽이 unset이면 그 분기 호출 시 `process.exit(1)` 명시적 에러.

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
- `./run.sh` — 운영 메뉴
