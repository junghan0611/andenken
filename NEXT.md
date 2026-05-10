# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 트랙별 다음 한 가지**를 잡는다.
> 현재 우선순위는 **sessions embedding**이다. org/qmd는 별도 트랙이며 지금 섞지 않는다.

## 트랙 A — sessions embedding: 8B/4096 cutover 먼저, 그 다음 sanitization

### 현재 결정

1. **먼저 현재 인프라 변경을 commit/push한다.**
2. **A1 — sessions 8B/4096 full rebuild를 진행하고 검토한다.**
3. **A2 — 그 다음 OpenClaw식 sanitization을 이식한다.**

이 순서의 이유: 현재 `ANDENKEN_SESSION_*`는 OpenRouter Qwen3-Embedding-8B
4096d로 전환됐고, 기존 `data/sessions.lance`는 2560d라 검색/증분이 의도적으로
막힌 상태다. 먼저 8B로 sessions 검색을 복구하고, 비용이 작으므로 sanitization
이후 한 번 더 rebuild하는 쪽이 운영상 안전하다.

### 완료된 구현/검수

**PR-A v3 — provider namespace split**
- `ANDENKEN_SESSION_*` / `ANDENKEN_ORG_*` 분리.
- sessions는 legacy `ANDENKEN_VLLM_*` fallback 제거.
- org는 2560d backward-compat fallback 유지.
- `openrouter` alias는 namespaced surface에서만 허용.
- `$VAR` placeholder 처리와 invalid provider fail-fast 보강.

**PR-D — dim guard / cross-track safety**
- sessions/org store dim mismatch 시 main search는 embed 전 fail-loud.
- `session_search → knowledge_search` fallback은 org provider로 재-embed.
- fallback org mismatch/unavailable은 sessions 결과를 죽이지 않고 diagnostic 처리.
- write/index path는 `assertCompatibleDim()`으로 잘못된 dim 쓰기 방지.

**PR-B.1~B.3 — OpenRouter 8B sessions path**
- `rebuild-sessions-full.sh`: estimate(API0) → `yes` → preflight(API1) → sessions-only destroy → paid full rebuild → verify.
- `sync-sessions.sh`: OpenRouter 8B incremental-only. wrong dim API0 abort, to-index=0 API0 exit.
- `estimate:sessions`: API0 cost estimate. 현재 full estimate 약 **$0.063**.
- direct `indexer.ts sessions --force`는 paidRemote guard로 차단.
- mixed `rebuild-full.sh` / `rebuild-incremental.sh`는 deprecated abort.
- `verify`는 target-aware dim 사용.

### 현재 env / DB 상태

`~/.env.local`:

- sessions: `ANDENKEN_SESSION_PROVIDER=openrouter`, `qwen/qwen3-embedding-8b`, `4096d`, `$0.01/M`.
- org: `ANDENKEN_ORG_PROVIDER=vllm`, `qwen/qwen3-embedding-4b`, `2560d`, `$0.02/M`.
- legacy `ANDENKEN_VLLM_*`: backward-compat only, 4B/2560.

DB:

- sessions DB actual dim: **2560d** → provider 4096d와 mismatch. search/index는 rebuild 전 refuse.
- org DB actual dim: **2560d** → org provider와 match.

### A1 — 지금 할 일: 8B full rebuild + 검토

1. Commit/push current infra changes.
2. Full rebuild dry-run 확인:
   ```bash
   ./scripts/rebuild-sessions-full.sh --dry-run
   ```
3. GLG가 비용/범위 확인 후 실제 실행:
   ```bash
   ./scripts/rebuild-sessions-full.sh
   # prompt에서 정확히: yes
   ```
4. rebuild 후 확인:
   ```bash
   ./run.sh status:json
   ```
   기대: `sessions.actual_dim = 4096`, org는 2560 유지.
5. `session_search` smoke query 몇 개로 검색 복구 확인.

### A1 검토 기준

- full rebuild 비용이 estimate와 같은 범위인지 (`~$0.06~0.08`).
- `sessions.actual_dim`이 4096인지.
- org DB/manifest가 변하지 않았는지.
- 기존 주요 쿼리에서 검색 결과가 정상적으로 나오는지.
- 30분/1시간 운영 경로는 `sync-sessions.sh` incremental-only인지.

### A2 — 다음: OpenClaw sanitization 이식

A1 검토가 끝난 뒤 진행한다. 이 단계가 **입력 품질 개선**이다.

참고 본체는 `transcript-rewrite.ts`가 아니라 OpenClaw memory export 쪽:

- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/session-files.ts`

이식 후보:

- inbound metadata strip
- internal runtime context strip
- generated system wrapper drop
- cron / heartbeat / silent reply / exec completion drop
- tool-sensitive redaction
- tool log / tool result noise 정리
- before/after chunk count
- spot-check 50개

의도적으로 분리:

- 800자 wrap/split은 별도 후속(A3). `truncateText(2000)` 유지한 C1부터.
- OpenClaw-specific dreaming/provenance file-level filter는 샘플 기반 전까지 보류.

## 트랙 B — org/qmd: 보류

org/qmd는 지금 진행하지 않는다. sessions 안정화 후 별도 판단한다.

현재 상태:

- PR #2 export-qmd는 forward-compatible 자산.
- PR #3 qmd bootstrap/query/bakeoff는 draft.
- org DB는 2560d 유지.
- `knowledge_search`는 org 4B/2560 provider와 DB dim이 맞는 상태로만 운영한다.

다음 org/qmd 판단은 sessions A1/A2 이후 GLG가 별도 지시할 때 재개한다.

## 외부 의존 / 주의

- OpenRouter Qwen3-Embedding-8B 가격은 현재 `$0.01/M` 기준.
- org full rebuild는 지금 하지 않는다. org 쪽은 qmd 결정 전까지 별도 트랙.
- long-lived pi/extension은 `.env.local` 변경 후 재시작해야 `ANDENKEN_SESSION_*`를 읽는다.
- commit/push 후에는 agenda stamp를 남긴다.

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
- 비교 근거 노트: `~/sync/org/llmlog/20260507T193005--openclaw-session-transcript-memory-vs-andenken-session-embedding...org`
