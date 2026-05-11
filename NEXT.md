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

### 지금 할 일 — C2.1 방향 결정

C2.0 결과만으로 "OpenClaw식 400/80 window로 가면 품질이 좋아진다"고 단정할 수 없다. 다음 단일 항목을 GLG가 골라야 한다.

**권장: lineMap/excerpt first**

- 현재 message chunk 구조를 유지하면서 readback UX를 먼저 개선.
- 검색 hit 이후 주변 JSONL line range를 빠르게 펼치는 도구/CLI를 만든다.
- full rebuild 없이도 일부 효과를 얻을 수 있고, compact 없는 전략의 rediscovery에 직접 기여한다.

대안:

1. **window chunking revised** — 600/100 또는 800/120 후보로 sample quality를 더 본 뒤 C2.1 구현.
2. **hybrid message+window dual index** — recall은 좋아질 수 있으나 DB/비용이 커져 보류.

보조 참고:

- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/session-files.ts` — `buildSessionEntry()` / `lineMap`
- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/internal.ts` — `chunkMarkdown()` / `remapChunkLines()`
- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/session-files.test.ts` — lineMap / archive / invalid JSON / inbound metadata fixture
- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/internal.test.ts` — chunking / surrogate pair / line remap fixture

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
