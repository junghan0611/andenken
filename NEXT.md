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

닫은 뒤 원칙:

- sessions 관련 새 기능은 GLG가 명시적으로 다시 열 때만 한다.
- 평소 운영은 `scripts/sync-sessions.sh` / `memory-sync` incremental만 수행한다.
- score threshold / source weight / toolResult indexing / window chunking은 모두 보류. 지금 추격하지 않는다.

## 트랙 B — org/qmd: 지금 할 일

### B0 — org/qmd baseline triage (read-only)

**목표**: sessions 트랙을 닫고 org/qmd로 넘어가기 전에, org track의 현재 품질·stale·qmd bridge 상태를 read-only로 재측정한다. 바로 org rebuild나 qmd production 적용으로 가지 않는다.

현재 상태(2026-05-11 status):

| 항목 | 값 |
|---|---:|
| org rows | 44,916 |
| org files | 2,199 |
| indexed files | 2,025 |
| manifest entries | 2,198 |
| new | 7 |
| stale | 541 |
| deleted | 6 |
| to_index | 548 |
| dim | 2560d |
| last indexed | 2026-05-07 |

해야 할 것:

1. 문서/코드 현재 상태 확인
   - `ROADMAP.md`의 org/qmd 관련 항목
   - `README.md` provider split / qmd bridge 설명
   - `export-qmd.ts`, `qmd-context.ts`, `qmd-bakeoff.ts`, `query-qmd.ts`
2. read-only 진단 실행
   - `./run.sh status:json`
   - `./run.sh doctor --org --no-smoke --json`
   - 필요 시 `./run.sh qmd:bake-off --skip-qmd` 또는 dry-run 성격의 비교만 사용
3. stale 원인 분리
   - 실제 org 파일 변경인지
   - manifest 정책 변경/mtime drift인지
   - qmd/export 계층과 무관한 indexing backlog인지
4. 다음 단일 항목 결정
   - org incremental sync 먼저인지
   - qmd bridge 정리/문서화 먼저인지
   - org doctor 신호 수정 먼저인지

금지:

- sessions 기능 추가/튜닝 재개 금지
- org full rebuild 금지
- qmd production 전환 금지
- embedding API 호출이 필요한 smoke/golden은 B0 결과 전까지 보류

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

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
- `./run.sh` — 운영 메뉴
