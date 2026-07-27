# COMPARISON — andenken vs OpenClaw

This document compares the **embedding surfaces** only.

It does **not** try to restate OpenClaw's whole memory stack. Active memory,
short/long/dream orchestration, and harness-side recall remain out of scope
except where they change corpus boundaries or operator expectations.

## Snapshot — 2026-05-12

- **andenken live tracks:** `sessions` + `md`
- **andenken disabled track:** `org` (upstream R&D only)
- **andenken sessions:** OpenRouter `qwen/qwen3-embedding-8b` / `4096d`
- **andenken md:** OpenRouter `qwen/qwen3-embedding-8b` / `4096d`
- **andenken md baseline:** `10,119` chunks / `2,192` indexed files
- **OpenClaw reference for md logic:**
  `~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/`

---

## 1. Session embedding — OpenClaw vs andenken

| Aspect | OpenClaw session memory | andenken `sessions` |
|---|---|---|
| Primary goal | Per-agent / per-bot continuity inside the OpenClaw runtime | Personal cross-harness continuity for GLG's agent work |
| Corpus boundary | OpenClaw transcript/session files, scoped by agent/runtime | pi sessions + Claude Code sessions combined into one memory axis |
| Identity model | Bot/agent-local corpus | Human/operator-local corpus across harnesses |
| Storage backend | `sqlite-vec` + SQLite tables / FTS5 | LanceDB + side manifest |
| Full-text backend | SQLite FTS5, typically trigram-aware for CJK | BM25 + substring fallback; Korean particle stripping ported from OpenClaw |
| Embedding provider | Runtime-configured in OpenClaw | OpenRouter `qwen/qwen3-embedding-8b` |
| Embedding dimension | Depends on configured provider/model | `4096d` |
| Chunking style | Flattened transcript → message-aware chunking | JSONL transcript parsing → message-aware chunking |
| Retrieval shape | Hybrid retrieval | Hybrid retrieval |
| Shared tuning baseline | 2026-05-08 parity work aligned chunking / hybrid / MMR assumptions | Same baseline; then moved to 8B/4096d on 2026-05-10 |
| Time signal | Runtime memory stack can promote/demote across layers | Exponential temporal decay inside the retriever |
| Live operator surface | OpenClaw runtime / plugin / gateway side | `session_search`, `search-sessions`, `scripts/sync-sessions.sh` |
| Current state | Reference implementation for bot transcript memory | **Closed/stable** as of 2026-05-11 |

### Reading note

The important difference is **corpus ownership**, not just retrieval code.
OpenClaw remembers a bot's world. andenken remembers **GLG's work across
harnesses**.

---

## 2. Markdown embedding — OpenClaw builtin md memory vs andenken `md`

| Aspect | OpenClaw builtin md memory | andenken `md` |
|---|---|---|
| Primary goal | Let an OpenClaw agent search markdown roots inside its runtime/workspace | Provide a production knowledge axis for agents from the exported public garden |
| Corpus boundary | Runtime-configured markdown paths / collections | `~/repos/gh/notes/content` only |
| Source style | Generic markdown roots | Curated public garden export |
| Storage backend | `sqlite-vec` + SQLite FTS5 | LanceDB + `data/md-manifest.json` |
| Embedding provider | Runtime-configured | OpenRouter `qwen/qwen3-embedding-8b` |
| Embedding dimension | Depends on configured provider/model | `4096d` |
| Chunker | OpenClaw `chunkMarkdown` | **Port of OpenClaw `chunkMarkdown`** |
| CJK handling | Weighted sizing + surrogate-pair-safe splitting in builtin chunker | Same ported behavior |
| Retrieval shape | Hybrid search over markdown chunks | Hybrid search over markdown chunks |
| Scope discipline | General-purpose runtime memory surface | Single production knowledge axis for agent use |
| Incremental artifact | OpenClaw runtime-managed DB/files | `data/md-manifest.json` + `data/md.lance` |
| Explainability | Runtime/tooling dependent | `./run.sh doctor --md` explains manifest ↔ indexed gaps |
| Live operator surface | OpenClaw memory runtime | `knowledge_search`, `search-md`, `sync:md`, `doctor --md` |
| Current state | Upstream logic source | **First production cut closed** on 2026-05-12 |

### Port boundary

andenken's md track is **not inspired by** OpenClaw md memory in a vague sense.
It directly ports the builtin markdown chunking logic from:

- `~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/internal.ts`

and runs that logic on top of the same retrieval philosophy, but with a
different storage and operator contract:

- OpenClaw: `sqlite-vec` + SQLite FTS5 inside the runtime
- andenken: LanceDB + manifest/doctor surfaces for external operator workflows

---

## 3. Retrieval baseline snapshot

This table captures the **comparison baseline we actually care about**. Some
OpenClaw runtime knobs are configurable, so read these as the working baseline
for parity discussions rather than a claim that every OpenClaw deployment is
identical.

| Knob | OpenClaw baseline | andenken |
|---|---|---|
| Session chunk budget | `400` tokens / `80` overlap | Same parity target for sessions |
| Hybrid merge | vector `0.7` / text `0.3` | vector `0.7` / BM25 `0.3` |
| MMR | enabled, `λ=0.7` baseline | enabled, `λ=0.7` |
| Temporal decay | enabled; 5/8 baseline noted `30d` half-life | enabled; default `14d` half-life |
| CJK full-text path | SQLite FTS5 trigram | BM25 + substring fallback |
| Markdown chunker lineage | builtin `chunkMarkdown` | direct port of `chunkMarkdown` |

For sessions, this means the comparison is mostly about **corpus and operator
surface**, not radically different retrieval philosophy. For md, the chunking
logic is intentionally shared while the storage/ops layer diverges.

## 4. Testing and evaluation — what is actually proven

OpenClaw and andenken do not prove the same thing today.

OpenClaw mostly proves **runtime memory as a product surface**: config,
plugin/runtime wiring, doctor/repair flows, session-context persistence,
and failure behavior under QA parity suites.

andenken currently proves **index integrity and operator visibility** much
better than **garden-specific relevance over time**.

| Proof target | OpenClaw evidence | andenken evidence | Why it matters for `/recall` |
|---|---|---|---|
| Runtime/config correctness | Dozens of memory-focused tests across `memory-search`, runtime, doctor, dreaming, plugin-sdk, plus QA parity/live smoke docs | Track-specific env/dim guards, `verify`, `status`, CLI/tool contracts | Recall that cannot start is useless no matter how good relevance is |
| Index integrity | SQLite/schema/runtime tests and doctor coverage | `./run.sh verify sessions`, `./run.sh verify md`, manifest accounting | A skewed corpus makes recall silently lie |
| Search relevance regression | General runtime memory behavior is exercised, but not against GLG's public garden as a named golden corpus. A rank-based retrieval eval exists but sits **unmerged** on `mariano/qa-memory-retrieval-eval` | md golden landed 2026-07-27 (`85a38f4`): baseline 31/33 = session 9/10 · md 22/23, per-track scoring, `searchMdCore` shared with the CLI. Judgement is still boolean top-K, not rank-based — see §11.2 | `/recall` quality is mostly a ranking problem, not only an indexing problem |
| Repairability / explainability | `doctor --fix`, recall-store repair, dreaming artifact repair | `doctor --md` explains manifest ↔ indexed gaps, but not yet retrieval misses | Operators need to know *why* recall failed |
| End-user recovery scenarios | Per-agent continuity and session runtime context are covered as product behavior | Manual smoke + real usage; no md recall benchmark yet | The target is fast continuation, not just passing unit tests |

A crucial OpenClaw note from its own testing docs: **live transport gateway
lanes disable memory search; memory behavior stays covered by QA parity
suites**. That is a mature product-testing choice. It means OpenClaw's test
strength is broad runtime QA, not a GLG-specific garden relevance benchmark.

## 5. Recall usefulness bar

A comparison document is only useful if it says what counts as success for the
actual operator workflow.

### Session recall must prove

- A concrete repo/task query recovers the last meaningful work in **top-3**.
- Recent shipped work beats generic old chatter.
- Source filters (`pi`, `claude`) do not cross-contaminate results.
- A one-turn or smoke session does not masquerade as the main thread.

### MD recall must prove

- A concept/person/work query returns the intended note in **top-5**.
- A day-specific query like `2026-05-11 andenken` can recover the actual day's
  working note instead of generic `andenken`-heavy notes.
- Korean↔English conceptual retrieval works without exact-title dependency.
- Skipped files are explainable (`noembed_tag`, `min_body`, etc.), never silent.

### Cross-axis recall must prove

- If session recall is thin, the shift to md knowledge is explicit, not hidden.
- `/recall` can reach the "next turn as a one-liner" goal without the operator
  reverse-engineering the retrieval stack.
- Once the golden baseline lands, failure cases should be classifiable as one
  of: corpus miss, ranking miss, source-boundary mistake, or operator-surface
  mistake.

This is the real bar for andenken. Not "does search return something," but
"does recall restore the operator's next move quickly and honestly?"

## 6. What is intentionally different

| Topic | OpenClaw | andenken |
|---|---|---|
| Memory layers | active / short / long / dream | embedding axis only |
| Active recall ownership | Runtime/harness concern | Out of scope; consumed by other harness surfaces |
| Corpus granularity | Per-agent / per-bot / per-runtime | Per-human / cross-harness |
| Markdown mission | Generic runtime memory roots | Public-garden knowledge axis |
| Storage choice | SQLite family | LanceDB family |
| Quality harness | Runtime-side memory QA and plugin contracts | `doctor`, `verify`, and the upcoming md golden baseline |

These differences are not regressions. They are the result of different jobs.
OpenClaw is a full runtime. andenken is the **embedding hub** for GLG's harness.

---

## 7. What OpenClaw has that andenken does not own

| Surface | Owner |
|---|---|
| Active memory before reply | OpenClaw / harness side |
| Multi-layer memory promotion | OpenClaw |
| Dreaming / overnight consolidation | OpenClaw / separate harness axis |
| Per-bot isolated memory worlds | OpenClaw |

andenken can be a backend for these experiences, but it does not implement them
in this repo.

---

## 8. What andenken has that OpenClaw does not target in the same way

| Surface | andenken value |
|---|---|
| Cross-harness session corpus | pi + Claude Code together |
| Public-garden-first knowledge axis | Exported `notes/content` as a production corpus |
| Sidecar graph ecosystem | `dictcli`, `denotecli`, `bibcli` |
| Operator-first integrity tools | `doctor --md`, `verify`, manifest accounting |

---

## 9. Code map

| Concern | OpenClaw reference | andenken implementation |
|---|---|---|
| Markdown chunking | `packages/memory-host-sdk/src/host/internal.ts` | `md-chunker.ts` |
| SQLite schema / FTS | `packages/memory-host-sdk/src/host/memory-schema.ts` | `store.ts` + `retriever.ts` |
| Session transcript classification | `packages/memory-host-sdk/src/host/session-files.ts` | `session-indexer.ts` |
| Query expansion / CJK token handling | `packages/memory-host-sdk/src/host/query-expansion.ts` | `retriever.ts` + sidecar `dictcli` boundary |
| Runtime memory orchestration | `packages/memory-host-sdk/src/host/openclaw-runtime-memory.ts` | Not owned here |
| Hybrid merge / score normalization | `extensions/memory-core/src/memory/hybrid.ts` | `retriever.ts` `weightedMerge` / `rrfFusion` — see §11.1 |
| Retrieval quality eval | `extensions/qa-lab/src/memory-retrieval-eval.ts` (unmerged branch) | `golden-queries.ts` + `md-search.ts` |

---

## 10. Current judgment

### Sessions

For session embedding, the meaningful comparison is no longer "who has the
better trick." The more important question is whether the two systems are
**horizontally aligned enough** that regressions are obvious.

That alignment largely exists now. The remaining differences are corpus and
operator model, not first-order retrieval philosophy.

### Markdown

For markdown, andenken's md track should be read as:

1. **OpenClaw builtin md memory logic**,
2. transplanted onto a **LanceDB operator surface**,
3. narrowed to a **single curated public-garden corpus**.

That is why the right comparison is not "OpenClaw vs andenken" in the abstract,
but:

- **OpenClaw runtime markdown memory**
- vs **andenken production knowledge axis (`md`)**

### Next quality step

The next real gap is no longer bring-up. It is **retrieval quality accounting**:
md golden queries that can fail when relevance drifts.

As of 2026-05-12, the gap-analysis phase closed via a trace-mining survey
(1,716 sessions → 90 md calls, 20 strong seeds, hard-negative bucket of 19
repeat-refinement cases, and `2026-05-11 andenken` ranking failure generalized
across `2026-03-19`, `2026-03-15`, `2026-04-15`).

The immediate next step is a **trace-seeded baseline** — no judge, no cadence
yet — measured once, then iterated. Judge integration, sentinel ratio,
regression cadence, and date+project ranking work wait on what that baseline
measures. See `NEXT.md` for the active item.

That is the path from "index exists" to "`/recall` shows real skill."

---

## 11. 2026-07-27 재조사 — OpenClaw `v2026.6.33` 대비 이식 후보

**조사 시점 상태.** OpenClaw 로컬 체크아웃을 `v2026.6.8` → `v2026.6.33`
(2026-07-21, beta 제외 최신 stable)으로 올린 뒤 검색 품질/검수 표면만 다시 읽었다.
andenken 쪽은 같은 날 md golden gate를 세운 직후 (`85a38f4`, baseline 31/33 =
session 9/10 · md 22/23).

§4의 "md still lacks a measured golden baseline"은 이제 닫혔다. 대신 **golden이
측정하는 방식 자체**가 OpenClaw 대비 뒤처진 지점이 드러났다.

### 11.1 이식 후보 A — 하이브리드 병합에서 상대 정규화를 버린다 ★최우선

andenken NEXT.md 결함 1(희소 고유어 `피투성` 회수 실패)의 **직접 해법이
OpenClaw 쪽에 이미 있다.**

| | OpenClaw `mergeHybridResults` | andenken `weightedMerge` |
|---|---|---|
| 벡터 항 | 원본 코사인 **그대로** | `score / maxVec` (max 상대 정규화) |
| 키워드 항 | `bm25RankToScore(rank)` = `1/(1+rank)` | `score / maxFts` |
| 결과 | 두 항 모두 절대 스케일 → 합산이 의미를 가짐 | 무관 결과도 `vecNorm≈1.0` 만점 |

- 참조: `extensions/memory-core/src/memory/hybrid.ts` (156줄 전체).
- `bm25RankToScore`는 음수 rank를 relevance로 해석해 `r/(1+r)`로 접는다 —
  LanceDB FTS가 음수 BM25를 돌려주는 우리 상황과 형태가 같다.
- **andenken 적용점**: `retriever.ts` `weightedMerge`. 코사인 0.69 밴드(무관)가
  정규화로 만점이 되는 경로가 사라진다.
- **주의**: 우리 `session` 경로는 RRF라 이 변경의 영향을 받지 않는다. md/knowledge
  (weighted) 경로만 대상.

### 11.2 이식 후보 B — rank 기반 판정 + `weak-pass` 등급

참조: `extensions/qa-lab/src/memory-retrieval-eval.ts` (465줄, 브랜치
`origin/mariano/qa-memory-retrieval-eval` 커밋 `634c8f99c70`, **미병합**).

- 정답의 **순위**(`expectedRank`)를 기록하고 priority별 `rankThresholds`와 비교
  (기본 p0/p1 = 3, p2 = 5).
- status가 5단계: `pass` / `weak-pass` / `fail` / `timeout` / `error`.
  `weak-pass` = 정답을 찾긴 했으나 threshold 밖. **찾았는데 밀린 것**과
  **아예 없는 것**을 구분한다.
- **andenken 적용점**: 현재 golden은 "top-K 안에 있나"만 본다. `피투성`이 6위인지
  아예 없는지 구분하지 못하므로, 개선 작업의 진척(20위 → 8위 → 3위)을 볼 수 없다.
  `expectFiles` 판정을 boolean에서 rank로 바꾸는 것이 최소 변경.

### 11.3 이식 후보 C — candidate A/B 비교를 1급 개념으로

같은 파일. `--candidate label=command-template` 를 여러 개 받아 **같은 케이스팩을
여러 검색 구성에 돌리고 나란히 리포트**한다. 템플릿은 `{query}` / `{agent}` /
`{caseId}` 치환 + shell quoting.

- **andenken 적용점**: 11.1을 실제로 고칠 때 "고치기 전 / 후"를 한 번의 실행으로
  비교해야 한다. 지금 구조로는 커밋을 되돌려가며 두 번 돌려야 하고, 그 사이
  코퍼스가 변하면 비교가 무의미해진다.
- 유료 임베딩 호출이 candidate 수만큼 곱해지는 점은 andenken 쪽 제약
  (전체 스코프 1회가 약 10분 / 33행).

### 11.4 이식 후보 D — 케이스팩 외부화 + `excludeResultNeedles`

- 케이스팩이 **외부 JSON** (`caseFile`). 케이스 추가에 코드 수정이 필요 없다.
  andenken은 `golden-queries.ts`에 TS 리터럴로 하드코딩.
- `scoring.excludeResultNeedles`: 채점 **전에** 결과에서 걷어내고 순위를 다시
  매긴다. andenken `topKMustNotContain`은 "있으면 fail"이라 성격이 다르다 —
  **둘 다 필요**하다. 측정 대상이 아닌 잡음은 제외하고, 진짜 금지물은 실패시켜야.

### 11.5 가져올 것 — 가짜 성공 탐지

`extensions/qa-lab/src/agentic-parity-report.ts`의
`SUSPICIOUS_PASS_FAILURE_TONE_PATTERNS`: `pass`로 집계됐지만 details 텍스트가
"timed out" / "failed to" / "could not" 류면 **가짜 성공으로 플래그**한다.
긍정 톤 탐지는 정상 통과를 오탐해서 제거했다는 이력까지 남아 있다.

- **andenken 적용점**: 우리도 같은 위험이 있다. `설계했다`(md)는 topScore
  `0.7000` — 11.1에서 지목한 무관 밴드 정확히 그 값인데 `expectKeywords` 하나가
  걸려 통과한다. **점수 밴드 기반 가짜 성공 탐지**가 필요하다.

### 11.6 설계 태도로 가져올 것 — "계약을 걸지 않는 이유"를 남긴다

`qa/scenarios/memory/memory-recall.yaml` 상단에는 *이 시나리오에 tool-call
assertion을 걸지 않은 이유*가 20줄 넘게 적혀 있다: 강제하면 "모델이 아니라
하네스를 테스트하게 된다", 대안 경로도 정당한 동작이다, 그래서 prose-only로
두고 **예외를 침묵시키지 않고 명시한다**.

andenken NEXT.md의 "우선순위 1 — golden contract cleanup"이 정확히 같은 문제를
다루고 있다(`남은 작업 뭐지`의 2 탈락은 *의도된 손실*인데 현 수치가 오해를 부름).
결론을 코드가 아니라 **케이스 옆 주석**으로 남기는 방식을 그대로 쓸 만하다.

### 11.7 참고만 — 지금 가져오지 않을 것

| 표면 | 참조 | 판단 |
|---|---|---|
| FTS-only 폴백용 stop-word 제거 | `host/query-expansion.ts` | 영어/중국어 stop-word 목록. 한국어가 없어 그대로는 못 쓴다. `dictcli` stem과 합칠 여지는 있음 |
| temporal decay 기본값 | `memory/temporal-decay.ts` (half-life 30일) | andenken은 session 14일 / md 0일(의도적 무감쇠). 값 차이는 코퍼스 성격 차이라 정합 |
| render-aware chunking | `packages/markdown-core/src/render-aware-chunking.ts` | 전송 크기 제한용 청킹이지 임베딩 청킹이 아니다. 이름이 비슷해 혼동 주의 |
| QA 시나리오 YAML 실행기 | `qa/scenarios/memory/*.yaml` + qa-lab | 게이트웨이/에이전트 런타임을 띄우는 e2e 하네스. andenken은 런타임이 없어 통째로는 부적합 |

### 11.8 열린 질문 — 검수에서 깨야 할 것

1. `1/(1+rank)`는 BM25 **점수 크기를 통째로 버린다**. `피투성` FTS 8건처럼 상위
   몇 건의 relevance 차이가 큰 경우, 랭크 역수가 원점수 정규화보다 나은가?
2. 벡터 절대 코사인 floor를 어디에 둘 것인가. Qwen3-8B/4096d의 무관 밴드가 실측
   0.689~0.700인데, floor 0.75가 안전한지 아니면 진짜 매치까지 잘라내는지 —
   **코퍼스 실측 없이 정하면 안 되는 값**이다.
3. 모든 md chunk가 `Title: ... Tags: ...` 프리앰블로 시작한다(실측). 가든 포맷이
   안정화되고 있다면 이 프리앰블을 **임베딩 입력에서 분리**하고 메타로만 쓰는
   설계가 가능한가? 지금은 프리앰블이 모든 chunk를 서로 닮게 만드는 쪽으로
   작동한다는 의심이 있고, 11.1의 무관 밴드 0.69가 그 증상일 수 있다.
4. scaffold 섹션(`## 히스토리` 862파일 / `## 관련메타` 864)을 chunk 경계로 쓸
   것인가, 별도 chunk로 뺄 것인가, 아예 임베딩에서 제외할 것인가. 제외하면
   "언제 무슨 일이 있었나" 류 질의를 잃는다.