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

### C2.0 완료 — transcript-window + line range read-only prototype

**완료일**: 2026-05-11
**산출물**: `~/org/llmlog/20260511T104934--§andenken-c2-transcript-window-line-range-prep...org`

A3 C1 직후 full sessions rebuild는 **일관성 정리**일 뿐 검색 품질 대폭 개선이 아니다. 따라서 rebuild하지 않고, DB/API 0 조건으로 C2.0 prototype을 먼저 검증했다.

C2.0 산출:

- `session-window.ts` — read-only transcript-window prototype
- `session-window.test.ts` — fixture tests, 25/25 pass
- `scripts/window-dryrun.ts` — parse-only corpus dry-run
- `./run.sh window:dryrun`, `./run.sh test:window`

검증:

- `pnpm exec tsc --noEmit`: clean
- `pnpm exec tsx session-window.test.ts`: 25/25 pass
- `./run.sh window:dryrun --source all --tokens 400 --overlap 80`: API 0 / DB 0 / network 0

기본안 400/80 결과:

| 항목 | 값 |
|---|---:|
| files scanned | 1,628 |
| old chunks | 28,367 |
| window chunks | 34,548 |
| delta | +6,181 (+21.79%) |
| avg messages/window | 1.93 |
| p50/p95 messages | 1 / 5 |
| estimated tokens | 13.00M |
| estimated 8B cost | ~$0.1300 |

해석:

- naive 400/80은 chunk 수와 비용을 늘린다.
- p50 messages/window = 1 이라 중앙값 기준 multi-turn context 개선이 약하다.
- 원인은 긴 assistant/tool-rich message가 window를 독점하는 세션 구조.
- 따라서 400/80을 그대로 C2.1로 밀어붙이는 것은 비추천.

대안 스윕:

| 설정 | window chunks | delta | avg msg/window | p50/p95 msg | est tokens | est cost |
|---|---:|---:|---:|---:|---:|---:|
| 400/0 | 26,162 | -7.77% | 1.94 | 1 / 5 | 9.69M | ~$0.0969 |
| 500/100 | 27,166 | -4.23% | 2.18 | 2 / 5 | 12.78M | ~$0.1278 |
| 600/100 | 21,542 | -24.06% | 2.44 | 2 / 6 | 12.11M | ~$0.1211 |
| 800/120 | 15,787 | -44.35% | 2.93 | 2 / 8 | 11.71M | ~$0.1171 |

### 지금 할 일 — C2.1a lineMap/excerpt first (구현 착수)

**결정일**: 2026-05-11
**큰 방향**: lineMap/excerpt first 승인. 현재 message-per-chunk 구조 유지, DB/embedding/full rebuild 무접촉. 검색 hit `sessionFile + lineNumber`를 입력으로 주변 JSONL을 read-only로 렌더링하는 helper/CLI를 만든다.

#### 우리 corpus 실측 (codex 1.2MB / 272-line entwurf 세션 기준)

| 카테고리 | 라인 비율 | 현재 indexer 처리 |
|---|---:|---|
| `type=message` assistant | 38% | 인덱싱 ✓ (단 tool-only turn은 텍스트 0으로 drop, p50=0) |
| `type=message` toolResult | **54%** | **silent skip** |
| `type=message` user | 4% | 인덱싱 ✓ |
| `type=custom_message` `entwurf-message` (display=true) | ~2% | **silent skip** ← 분신 통신 전문 |
| `type=custom` skill_loaded 등 (display=false) | ~3% | skip — 정당 |

OpenClaw 가정과 다른 점: 한 turn이 매우 길고(user p50≈1.5K chars / max 6.8K), tool-rich, 분신 통신은 별도 channel.

#### 파라미터 default

| 항목 | 값 | 근거 |
|---|---|---|
| `beforeLines` | 3 | turn당 1.5KB+, raw 6 lines가 ~3-4 turn 컨텍스트로 적정 |
| `afterLines` | 3 | 동일 |
| `maxChars` | 4000 | LLM 컨텍스트 추가 cost cap |
| `includeToolResults` | true | assistant 결정의 인과 보존 |
| `includeSessionMessages` | true | entwurf-message 등 inter-agent 통신 노출 |

CLI는 명시적 override 허용 (`--before 8 --after 8 --max 8000 --no-tool --no-session`).

#### 렌더링 룰 (라인 종류별)

| 라인 종류 | 렌더 |
|---|---|
| `message` user | `User: <sanitized text>` (A3 C1 sanitizer 재사용) |
| `message` assistant 텍스트 | `Assistant: <sanitized text>` |
| `message` assistant tool-only (pi `toolCall` / claude `tool_use`) | `Assistant: [tool: <name>(<short args>)] [tool: ...]` (여러 toolCall 한 줄) |
| `message` toolResult | `→ tool result [<toolName><" ERROR" if isError>]: <첫 200자>... [N chars total]` |
| `custom_message` `display=true` 중 `entwurf-message` / `session-message` / `delegate-complete` | `Entwurf[<sender-prefix>→<receiver-prefix>]: <full text>` |
| `custom_message` `display=false` (예: `session-info`) | skip |
| `custom_message` `entwurf-sessions` | skip (default) |
| `compaction` | `[Compaction summary] <text>` |
| `custom` (skill_loaded, model_change 등) | skip |
| invalid JSON | skip + count |

#### 5가지 추가 규칙 (GLG/지피티 검토 반영)

1. **center-preserving truncation**: maxChars 초과 시 centerLine 무조건 보존, 가장 먼 line부터 양쪽 균형으로 제거. 단순 head/tail truncate 금지.
2. **includeSessionMessages 범위**: `entwurf-message` / `session-message` / `delegate-complete` (display=true). `session-info` 같은 display=false는 skip. `entwurf-sessions`는 default skip.
3. **toolResult 렌더에 toolName/isError 포함**: `→ tool result [bash ERROR]: ...`. pi 스키마 확인 — `.message.toolName` + `.message.isError` 존재.
4. **assistant tool-only는 여러 toolCall 짧게**: `Assistant: [tool: read(path=...)] [tool: bash(command=...)]`. pi block schema는 `{type:"toolCall", name, arguments}`, claude는 `{type:"tool_use", name, input}`.
5. **skipped 라인은 text에 섞지 말 것**: `skippedCounts: Record<string, number>` 로 별도 반환. invalid JSON / display=false 등.

#### 산출물 계획

| # | 파일 | 내용 |
|---|---|---|
| 1 | `session-excerpt.ts` | `readSessionExcerpt(sessionFile, centerLine, opts)` + 라인별 renderer + center-preserving truncation |
| 2 | `session-excerpt.test.ts` | fixture JSONL (pi/claude/entwurf/toolResult/invalid/maxChars/boundary/center-preserve) |
| 3 | `scripts/session-excerpt.ts` | CLI: `<file> <line> [--before N --after N --max N --no-tool --no-session --json]` |
| 4 | `run.sh` | `excerpt:session <file> <line>`, `test:excerpt` |
| 5 | sample 3건 manual | claude session, codex entwurf-heavy 세션, 오래된 pi 세션 각 1 |

#### 검증 게이트

- `pnpm exec tsc --noEmit` clean
- `pnpm exec tsx session-excerpt.test.ts` 모두 pass
- sample 3건 출력에서 entwurf-message 1건 이상, toolResult 요약 1건 이상, center 보존 확인
- API 0 / DB 0 / network 0 명시

#### 금지 (재확인)

- DB write
- embedding API call
- sessions full rebuild
- search/sync 실행
- store schema 변경
- org/qmd 변경
- transcript-window production 적용

#### 후속 (C2.1b 후보, 보류)

- `session_search` tool에 `withExcerpt: boolean` 옵션 추가
- `entwurf-message` / `toolResult` 인덱싱 dry-run (chunk 수 폭증 가능)
- assistant tool-only turn을 `[tool: read /path]` 텍스트로 인덱싱

보조 참고:

- `session-indexer.ts` — `extractSessionChunks` (centerLine = 결과 `lineNumber`)
- `session-sanitize.ts` — A3 C1 sanitizer (그대로 재사용)
- `session-window.ts` — C2.0 prototype의 `extractTextContent`/`pushTranscriptLine` 패턴 일부 참고
- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/session-files.ts` — buildSessionEntry, lineMap 개념

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
