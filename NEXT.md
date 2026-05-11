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

### C2.1a 완료 — lineMap/excerpt first (read-only readback)

**완료일**: 2026-05-11

#### 산출물

| 파일 | 라인 | 역할 |
|---|---:|---|
| `session-excerpt.ts` | ~470 | `readSessionExcerpt(sessionFile, centerLine, opts)` + 6종 line renderer + center-preserving truncation + claude tool_result 분기 |
| `session-excerpt.test.ts` | ~520 | fixture tests (pi/claude/entwurf/toolResult/Claude tool_result/totalLines/maxChars/boundary/center-preserve/args) |
| `scripts/session-excerpt.ts` | ~110 | CLI: `<file> <line> [--before --after --max --no-tool --no-session --json]` + `Number.isInteger` + bounds 에러 |
| `run.sh` | +6 | `excerpt:session`, `test:excerpt` |

#### 검증

- `pnpm exec tsc --noEmit`: clean
- `pnpm exec tsx session-excerpt.test.ts`: **76/76 pass**
- `./run.sh excerpt:session <pi> 181 --before 1 --after 1 --max 3000`: pi entwurf-heavy 정상 렌더
- `./run.sh excerpt:session <claude> 13 --before 1 --after 1`: claude tool_result block이 `→ tool result [01CEHoNp]: ...`로 렌더 (이전 `empty:user` skip 회귀 fix)
- API 0 / DB 0 / network 0

#### 우리 corpus 맞춤 튜닝 반영 (모두 구현 확인)

| 항목 | 구현 |
|---|---|
| toolResult one-line summary, toolName/isError | pi `role==="toolResult"` + claude `tool_result` block 양쪽 |
| Claude tool_result 분기 | `extractClaudeToolResultBlocks()` + `renderClaudeToolResultLine()` |
| entwurf-message (custom_message display=true) 풀 렌더 | `SESSION_MESSAGE_CUSTOM_TYPES` set + sender/receiver 짧은 id |
| assistant tool-only 다중 toolCall | pi `toolCall` + claude `tool_use` 양쪽 지원 |
| center-preserving truncation | `applyCenterPreservingTruncation()` distance-sorted, centerIdx 보호 |
| skipped 격리 | `skippedCounts` 별도 필드, text에 미주입 |
| CLI bounds 명시 에러 | `Number.isInteger` 체크 + `centerLine > totalLines` 시 throw |

#### 변경되지 않은 것 (재확인)

- DB schema, embedding pipeline, manifest, store, indexer.ts, retriever.ts, cli.ts — 무접촉
- A3 C1 sanitizer 그대로 재사용
- transcript-window prototype (C2.0 산출) 그대로 보존

#### Source policy 정합성 (AGENTS.md/README.md GLG 직접 갱신 반영)

session sources는 정확히 둘만 지원: `pi` = `~/.pi/agent/sessions`, `claude` = `~/.claude/projects`. `~/.pi/agent/claude-config-overlay/projects`는 절대 인덱싱 금지 (pi/entwurf 중복). excerpt는 path-based read이므로 source enumeration을 강제하지 않지만, `detectSource()`(session-indexer.ts)는 `/.claude/` substring 기준으로 동작하므로 overlay 경로는 자동으로 `pi`로 분류됨. 이는 정책과 어긋나지 않음 (excerpt는 indexer가 발견한 파일만 받는 게 정상 흐름).

### Sessions full rebuild 완료 — 8B/4096d 전체 재임베딩

**완료일**: 2026-05-11

GLG 승인으로 sessions corpus를 OpenRouter Qwen3-Embedding-8B 4096d 기준으로 전체 재임베딩했다. org track은 무접촉.

| 항목 | 값 |
|---|---:|
| files | 1,653 |
| chunks | 28,537 |
| indexed files | 1,611 |
| dim | 4096d |
| duration | 2,574.8s (~42.9분) |
| API calls | 1,773 |
| tokens | ~6.48M |
| cost | ~$0.065 |
| errors | 0 |

검증:

- `verify sessions`: pass
- duplicate IDs 없음 (`28,537 unique`)
- orphan files 없음 (`1,611 files all exist`)
- row count consistent (`28,537`)
- Lance fragments: 23, size 542M

#### 품질 검수 요약

Claude 검수 10-query matrix 기준 PASS.

- 최신성: 2026-05-11 C2.1a running session까지 hit.
- 시간 폭: 3월~5월 분포 정상.
- 언어: Korean / English / mixed 모두 동작.
- source: `pi` 우세, `claude`도 cross-source 검색에 노출. overlay 미포함 정책 위반 없음.
- sanitization: A3 C1 회귀 없음. 옛 envelope leakage 없음.
- excerpt: search hit `file:L#` → 앞뒤 toolResult + assistant 흐름으로 펼쳐지는 C2.1a 가치 실증.

알아둘 점:

- Score range가 8B/4096d에서 매우 압축됨 (`~0.004–0.066`). 랭킹은 맞지만 `minScore`/fallback threshold는 추후 실측 기반으로 조정해야 한다.
- dictcli expansion 이슈는 별도. 예: `초기`가 `initial/early`가 아니라 `enactment/establishment/institution` 쪽으로 확장됨.
- cross-source ranking weight는 **source별 가중치로 pi를 더 세게 밀자는 뜻이 아니다**. corpus가 pi 중심이면 pi가 자연스럽게 더 자주 나온다. 별도 weight는 오히려 Claude Code의 희소하지만 중요한 hit를 묻을 수 있다. 필요하면 source prior보다 `source` 필터(`pi`/`claude`/`all`)와 source별 진단 지표를 먼저 다룬다.

### 지금 할 일 — C2.1c `session_search.withExcerpt` 옵션

다음 단일 항목은 C2.1c다.

목표: 검색 결과에 C2.1a excerpt를 선택적으로 붙여, “찾기 → 주변 원문맥 펼치기”를 한 번에 한다. full rebuild 없이 품질 체감이 가장 큰 다음 단계다.

범위:

- pi extension `session_search` parameter에 `withExcerpt?: boolean` 추가.
- CLI `search-sessions`에도 `--with-excerpt` 추가 여부 검토.
- 기본값은 `false`. 토큰/출력 폭증을 막기 위해 명시 opt-in.
- excerpt 기본 옵션은 C2.1a 기본값(`before=3`, `after=3`, `maxChars=4000`)보다 작게 시작하는 것도 검토 (`before=1`, `after=1`, `maxChars=2000`).
- result당 excerpt는 top N에만 붙인다. 후보: `excerptLimit=3` 기본.
- DB write / embedding API / rebuild 없음.

검증:

- 기존 `session_search` 출력 완전 호환 (`withExcerpt=false`).
- `withExcerpt=true`에서 pi toolResult, entwurf-message, Claude tool_result가 적어도 하나씩 sample로 확인.
- score/fallback 동작 변화 없음.
- 8B/4096d score range 관찰을 함께 기록한다. 현재 검수 범위는 `~0.004–0.066`; `retriever.ts`/fallback의 임계값이 이 분포와 맞는지 read-only로 확인하고, 조정은 별도 승인 후 진행한다.

#### 별도 이슈 — dictcli expansion 보정

andenken 작업은 아니지만 품질 검수에서 발견한 Layer 3 이슈로 별도 추적한다.

- 문제: `초기` → `enactment`, `establishment`, `institution` 등으로 확장됨.
- 기대: `initial`, `early`, `beginning`, `earlystage` 계열.
- 영향: Korean→English mixed query에서 BM25/embedding query enrichment가 엉뚱해질 수 있음.
- 처리 위치: `dictcli` vocabulary graph. andenken에서는 증상과 재현 쿼리만 기록.

#### 후속 후보 (C2.1c 이후)

- C2.1b — source policy optionalization: indexer가 `pi` / `claude` / `all`만 받도록 명시적 enum 확립, overlay 경로 거부 단정.
- C2.2 — `entwurf-message` / `toolResult` 인덱싱 dry-run: 현재 silent skip되는 데이터 인덱싱 시 chunk 수 폭증 / 비용 영향 추정.
- window chunking revised dry-run: C2.0의 600/100, 800/120 등 재평가.

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
