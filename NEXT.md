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

### A2 완료 — read-only mapping

**완료일**: 2026-05-11
**산출물**: `~/org/llmlog/20260511T095442--§andenken-openclaw-sanitization-readonly-mapping-a2...org`

OpenClaw `session-files.ts` ↔ andenken `session-indexer.ts` 1:1 mapping 확정. C1/C2/보류 항목 분리.

### A3 C1 완료 — sanitization-only code, API 0

**완료일**: 2026-05-11

OpenClaw `97d2d40fb7` 기준 **strip helper 일부를 verbatim port**한 선택적 sanitization 부분집합. 전체 `sanitizeSessionText`를 그대로 옮긴 것은 아니고, normalize/heartbeat/silent/exec/redact/provenance/lineMap 등은 의도적으로 제외.

C1 범위 (확정):

- `stripInboundMetadata` (user-role only, 6 sentinels + active_memory_plugin + trailing-untrusted)
- `stripInternalRuntimeContext` (delimited + legacy header + prompt preface)
- `GENERATED_SYSTEM_MESSAGE_RE` user wrapper drop
- `DIRECT_CRON_PROMPT_RE` user wrapper drop
- leading timestamp prefix strip

C1에서 의도적으로 **뺀** 것 (C2 또는 영구 제외):

- `HEARTBEAT_TOKEN` / silent reply / exec completion drops — OpenClaw-specific tokens, dry-run 0건 확인 (C2 후 실측 시점에 재검토).
- `redactSensitiveText(mode:"tools")` — andenken 핵심 가치 = 명령/파일명/에러 recall. 영구 제외.
- `hasInterSessionUserProvenance` — pi/Claude JSONL에 `message.provenance` 필드 자체 없음 (grep 실측). 호출점 미생성.
- `normalizeSessionText` newline collapse — 임베딩 입력 의미 변경 + 비용 큰 재인덱싱 트리거. C2.
- transcript-window chunking / lineMap / 800-char wrap. C2.

API 0 검증:

- `pnpm exec tsc --noEmit`: clean
- `session-sanitize.test.ts`: 77/77 fixture pass (6 inbound sentinels × {user, assistant} parametrized 포함)
- `test.ts` 신규 production-path 섹션 `Session Indexer (sanitize integration)`: extractSessionChunks 경로로 user envelope strip / assistant sentinel 보존 / envelope-only 미생성 / cron·system wrapper 미생성 / ordinary text 생성 검증
- `scripts/sanitize-dryrun.ts` reproduces full production decision tree
  (sanitize + length + isNoise + truncate). On 1,614 sessions / 114,296
  messages, 2.45s, API 0:
  - emitted (old) 28,327 → emitted (new) 28,319
  - net delta **-8 (0.03%)**
  - new drops 8 (모두 `under_length_after_strip` — trim 후 본문이 length threshold 아래)
  - **noise_after_strip 0** (trim이 PASS/FAIL/raw tool JSON 같은 noise prefix를 드러내는 시나리오 — 실제 corpus 0건)
  - newly_emitted 0 (sanitize가 OLD가 버린 텍스트를 살리는 케이스 없음)
  - generated_system_wrapper / generated_cron_prompt drops: 0건
  - changed_in_emit 1,132 — **대부분 leading whitespace trim** (검색 품질 신호 아님, cosmetic body shrink)
  - files w/ impact 392 (theoretical full-rebuild affected)

### A3 C1 적용 — 현재 corpus 효과: 미래 안전망 + 작은 과거 정제

**중요**: andenken session manifest는 `mtimeMs + size + chunks` 기반. session-sanitize.ts 코드 변경만으로 JSONL mtime/size는 바뀌지 않으므로 **incremental sync는 historical chunk에 새 sanitizer를 자동 적용하지 않는다**.

| 경로 | 동작 |
|---|---|
| 신규 append되는 JSONL 라인 | 새 sanitizer 자동 통과. **자연 누적**. 비용 = 평소 sync 비용. |
| 기존 28K chunk에 sanitizer 일치시키기 | `./run.sh rebuild:sessions` (paid full rebuild). 비용 ~$0.063 / 31분대. **GLG 승인 후 별도** |

dry-run 기준 full rebuild 기대효과 (만약 한다면):

- DB와 새 sanitizer 일치 (consistency)
- 8건 짧은 메시지 chunk 제거 (`under_length_after_strip`)
- 1,132건 trim 반영 (cosmetic, 검색 품질 신호 아님)

**검색 품질 대폭 개선 목적이라면 full rebuild는 정당화되지 않는다.** 일관성 목적이면 GLG가 선택지로 가져갈 수 있다.

### 지금 할 일 — 다음 한 가지 결정

A3 C1 commit/push 이후, 다음 **단일** 항목은 GLG 우선순위에 따라 두 갈래 중 하나:

**갈래 (a) — 일관성 우선**: full sessions rebuild로 새 sanitizer를 historical chunk에 적용. ~$0.063 / 31분. ROADMAP에 cutover 기록.

**갈래 (b) — 검색 품질 우선 (권장)**: C2 본류로 진입. 후보 두 가지 중 하나 선택:

1. **transcript-window chunking** — OpenClaw식 multi-turn window. 가장 큰 recall 개선 가능성. DB schema 변경 필요. 풀 재인덱싱 동반.
2. **lineMap / excerpt model** — chunk-to-source 정확도 개선. read-back UX 향상. DB schema에 line range 추가.

→ NEXT.md single-item 원칙에 따라 GLG가 갈래를 정해주면 그 항목 하나로 본 섹션을 갈아끼운다.

보조 참고 (C1 구현 시 참조 완료):

- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/openclaw-runtime-session.ts`
- `/home/junghan/repos/3rd/openclaw/src/agents/internal-runtime-context.ts`
- `/home/junghan/repos/3rd/openclaw/src/auto-reply/reply/strip-inbound-meta.ts`
- `/home/junghan/repos/3rd/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts`
- `/home/junghan/repos/3rd/openclaw/src/agents/pi-embedded-runner/transcript-rewrite.ts`

주의: `transcript-rewrite.ts` / `tool-result-truncation.ts`는 live transcript maintenance 쪽이다.
andenken indexing에 직접 참조한 본체는 `session-files.ts`의 `sanitizeSessionText` / `extractSessionText` 흐름이며, 그 중 strip helper 부분집합을 C1에 verbatim port 완료. 나머지는 본 문서의 "C1에서 의도적으로 뺀 것" 섹션 참조.

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
