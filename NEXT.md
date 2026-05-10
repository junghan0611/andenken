# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 트랙별 다음 한 가지**를 잡는다.
> 현재 우선순위는 **sessions embedding**이다. org/qmd는 별도 트랙이며 지금 섞지 않는다.

## 트랙 A — sessions embedding: 다음은 OpenClaw sanitization

### A1 완료 — 8B/4096 cutover

**완료일**: 2026-05-10

Sessions track을 OpenRouter Qwen3-Embedding-8B 4096d로 전환했다.

결과:

| 항목 | 값 |
|------|----|
| commit | `c618a73 feat(sessions): add OpenRouter 8B cutover path` |
| model | `qwen/qwen3-embedding-8b` |
| dim | 4096d |
| chunks | 28,206 (sync 후) |
| full rebuild cost | ~$0.063 |
| full rebuild duration | 31.7분 |
| errors | 0 |
| org | 2560d 유지, 무접촉 |

검증:

- `sessions.actual_dim = 4096`
- `org.actual_dim = 2560`
- `session_search` smoke: `openclaw session embedding` top 5 모두 직접 관련
- `sync-sessions.sh` incremental: rebuild 중 생긴 stale/new 처리, 비용 ~$0.0005
- `to_index`는 live session drift 때문에 0이 아닐 수 있음. 운영상 다음 sync가 처리.

운영 경로:

- full rebuild: `./scripts/rebuild-sessions-full.sh`
- incremental: `./scripts/sync-sessions.sh`
- estimate: `./run.sh estimate:sessions [--full]`
- status: `./run.sh status:json`

안전 경계:

- sessions legacy `ANDENKEN_VLLM_*` fallback 제거.
- sessions/org provider 분리.
- dim mismatch면 main search/index가 embed 전에 refuse.
- paid full rebuild는 `ANDENKEN_ALLOW_PAID_FULL_REBUILD=1` guard 필요.

### 지금 할 일 — A2 read-only mapping

OpenClaw식 sanitization 이식 전에 **read-only mapping**을 먼저 한다.

목표: andenken `session-indexer.ts`와 OpenClaw session memory export sanitization을 1:1로 비교하고,
무엇을 이식할지 범위를 좁힌다. 코드 변경은 아직 하지 않는다.

핵심 참고 파일:

- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/session-files.ts`

보조 참고:

- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/openclaw-runtime-session.ts`
- `/home/junghan/repos/3rd/openclaw/src/agents/internal-runtime-context.ts`
- `/home/junghan/repos/3rd/openclaw/src/auto-reply/reply/strip-inbound-meta.ts`
- `/home/junghan/repos/3rd/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts`
- `/home/junghan/repos/3rd/openclaw/src/agents/pi-embedded-runner/transcript-rewrite.ts`

주의: `transcript-rewrite.ts` / `tool-result-truncation.ts`는 live transcript maintenance 쪽이다.
andenken indexing에 직접 이식할 본체는 `session-files.ts`의 `sanitizeSessionText` / `extractSessionText` 흐름이다.

### A2 read-only 산출물

llmlog 1건 또는 이 repo 내 임시 검토 문서로 다음을 남긴다.

| 항목 | 내용 |
|------|------|
| OpenClaw 단계 | `stripInboundMetadata`, `stripInternalRuntimeContext`, generated wrapper drop 등 |
| andenken 현 상태 | `extractTextContent`, `isNoise`, length threshold, `truncateText(2000)` |
| gap | 어떤 strip/drop/redact가 빠졌는지 |
| 이식 우선순위 | C1에 넣을 것 / 보류할 것 / C2로 뺄 것 |
| risk | 사용자 의도 손실 가능성, Claude/pi 포맷 차이, tool 결과 과삭제 위험 |

### A3 예정 — sanitization C1 구현

A2 mapping 검토 후 GLG 승인 시 진행한다.

C1 후보:

- inbound metadata strip
- internal runtime context strip
- generated system wrapper drop
- cron / heartbeat / silent reply / exec completion drop
- tool-sensitive redaction
- tool log / tool result noise 정리
- before/after chunk count
- random 50 spot-check

의도적으로 C1에서 안 하는 것:

- 800자 wrap/split. `truncateText(2000)` 유지 후 별도 C2.
- OpenClaw-specific dreaming/provenance file-level filter 무차별 이식.
- org/qmd 변경.

## 트랙 B — org/qmd: 보류

org/qmd는 지금 진행하지 않는다. sessions 안정화와 A2/A3 이후 별도 판단한다.

현재 상태:

- PR #2 export-qmd는 forward-compatible 자산.
- PR #3 qmd bootstrap/query/bakeoff는 draft.
- org DB는 2560d 유지.
- `knowledge_search`는 org 4B/2560 provider와 DB dim이 맞는 상태로만 운영한다.

## 외부 의존 / 주의

- OpenRouter Qwen3-Embedding-8B 가격은 현재 `$0.01/M` 기준.
- org full rebuild는 지금 하지 않는다. org 쪽은 qmd 결정 전까지 별도 트랙.
- long-lived pi/extension은 `.env.local` 변경 후 재시작해야 `ANDENKEN_SESSION_*`를 읽는다.

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
- 비교 근거 노트: `~/sync/org/llmlog/20260507T193005--openclaw-session-transcript-memory-vs-andenken-session-embedding...org`
