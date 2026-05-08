# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 하려는 다음 한 가지**.
> 끝나면 ROADMAP History에 stamp 박고, 이 파일은 다음 항목으로 덮어씀.

## 다음: 세션 입력 sanitization을 OpenClaw 수준으로 맞추기

평가 도구(`status --json` / `sanity` / `bake-off`) *전에* **입력 정제**를 먼저 한다.

이유: andenken 검색 품질이 OpenClaw에 못 미친다면, 가장 가능성 큰 원인은
*알고리즘이 아니라 입력 corpus의 noise/signal 비율*이다. 정제 안 된 corpus
위에서는 무엇을 측정해도 의미가 약하다.

### 같은 pi JSONL, 다른 결과

OpenClaw 5/8 baseline (llmlog `20260507T193005`)에서 같은 pi 세션을 정제한 결과:

| agent | raw size | chunks | 살아남음 |
|-------|---------|--------|---------|
| main | 6 MB | 31 | **0.8%** |
| gpt | 17.8 MB | 50 | **0.45%** |
| glg (가족봇) | 3 MB | 1060 | 57% |

→ 가족 직접 대화는 wrapper 적어서 거의 다 살림. **코드/툴 호출 transcript는
system meta + tool result + provenance를 다 strip**. 이게 OpenClaw 정제의 본체.

andenken sessions: 27,252 chunks / 1,573 sessions. 같은 입력 pi JSONL인데
*훨씬 많이 살리고 있다*. 이건 우위가 아니라 **정제가 약하다는 신호**.

### 현 andenken sanitization 깊이 (`session-indexer.ts`, 384 lines)

- `isNoise()` — noise pattern 정규식 몇 개 (tool errors, delegate failures, smoke tests)
- `truncateText(text, 2000)` — 일괄 2000자 자르기
- length threshold (assistant 100자 미만 필터)
- compaction 이벤트 추출
- pi/Claude Code source 분리

빠진 것 (구조적 정제):
- system meta strip
- tool result truncation/제거
- provenance / metadata 정리
- transcript rewrite (대화 흐름 정제)
- repeated tool call collapse

### OpenClaw에서 이식할 위치 (`/home/junghan/repos/3rd/openclaw/`)

| 파일 | 역할 |
|------|------|
| `src/agents/pi-embedded-runner/transcript-rewrite.ts` | **핵심** — transcript 정제 본체 |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | **핵심** — tool result 자르기 |
| `src/sessions/transcript-events.ts` | transcript update emit/listener (참조) |
| `src/config/sessions/transcript.ts` | transcript 설정 진입점 (참조) |
| `src/agents/command/attempt-execution.ts` | tool 실행 정보 처리 (참조) |
| `extensions/memory-core/src/memory/manager-sync-ops.ts` | session dirty/sync 흐름 (참조) |

핵심은 위 두 파일(transcript-rewrite, tool-result-truncation). 나머지는 컨텍스트.

### 3단계 — 단계당 한 commit, 끝에 ROADMAP History stamp

**A. read-only 매핑**
- OpenClaw 정제 로직 위 6개 파일 읽기.
- andenken `session-indexer.ts`와 1:1 매핑. *어떤 strip이 우리에게 없는지* 표로.
- 결과는 llmlog 한 건. 코드 변경 0건.

**B. transcript-rewrite + tool-result-truncation 이식**
- andenken에 동등 함수 추가. `parseMessageContent` / `extractTextContent` 호출 라인에 삽입.
- before/after chunk 수 비교 (현 27,252 → 얼마로 떨어지나).
- glg-equivalent(가족봇 같은 직접 대화)에 해당하는 *내* pi 세션은 손실 안 나는지 spot-check.

**C. signal density spot-check**
- 정제 후 sessions에서 무작위 50 샘플 뽑아 *읽고* 판단.
- PASS/FAIL 아님. "쓸 만한 신호 비율이 OpenClaw 수준인가"를 사람이 결론.
- 결과를 ROADMAP.md History stamp.

C가 끝나면 NEXT.md는 다음 항목으로 덮어씀: **평가 도구**
(`status --json` / `sanity` / `bake-off`) — 정제된 corpus 위에서야 의미를 가짐.

### 의도적으로 안 하는 것

- **정제 강도 정량화** — `sanity` 도구가 들어올 일. 지금은 chunk 수 변화 + spot-check면 충분.
- **가족봇 같은 직접 대화 정제 강화** — wrapper 적어서 이미 잘 살아남음. 잘못 건드리면 신호 손실.
- **평가 도구 (status --json / sanity / bake-off)** — 정제된 corpus 위에서 의미. 다음 NEXT 항목.
- **chunking 알고리즘 변경** (transcript window 등) — 정제 효과를 본 *후* 별도 NEXT로.

### 시작 조건

GLG 승인 후 **A → B → C** 순서. A는 read-only라 가장 작은 비용으로 가장 큰
정보를 준다 — A 결과만 보고도 B 범위를 좁힐 수 있다.

## 외부 의존 — 대기 중

> 이 항목은 *현재 작업 한 가지*가 아니라 **다른 담당자의 결과를 기다리는 결정**.
> 결과가 들어오면 sanitization 작업과의 순서를 그때 다시 판단.

### OpenClaw 임베딩 모델 8B 점프 테스트

- **담당**: nixos-config 담당자 (2026-05-08 시작)
- **변경**: Qwen3-Embedding-**4B → 8B**
- **차원**: matryoshka representation으로 **2560d truncate 가능** → 양쪽 DB schema 무변경
- **비용**: OpenRouter query $0.02 → $0.01 (50% 절감)
- **운영 영향**: 모델 변경은 manifold drift이므로 양쪽 *전체 reindex* 필요 (차원과 무관)
- **andenken 액션**: OpenClaw 측 sanity / freshness / 한국어 단문 결과 보고 적용 검토
- **순서 결정**: 결과 들어오면 (a) sanitization 우선 후 8B (corpus 작아진 상태로 reindex 비용 ↓), (b) 8B 우선, (c) 보류 중 하나로 GLG 결정
- **참고**: ROADMAP §4 가능성 / §변화 기록 5/8 stamp

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록 (핵심 문서)
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 단축 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
- 비교 근거 노트: `~/sync/org/llmlog/20260507T193005--openclaw-session-transcript-memory-vs-andenken-session-embedding...org`
