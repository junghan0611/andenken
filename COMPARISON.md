# COMPARISON — andenken vs OpenClaw vs Hermes

Sections 1–13 compare the **embedding surfaces** of andenken and OpenClaw.
Section 14 places a third system, NousResearch **Hermes Agent**, next to both —
not as another embedding implementation, but as the clearest available reference
for the **write-side** of memory, which andenken does not own.

As of 2026-07-27, comparison parity and generic vocabulary recall are not the
quality direction. The canonical KST timeline is the compass: andenken must
recover session and garden evidence that explains dated events and restores
continuity. Sections 11–12 remain a valid component-level retrieval audit; §13
records the product-level direction that governs what gets implemented next.

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
| End-user recovery scenarios | Per-agent continuity and session runtime context are covered as product behavior | Transitional vocabulary-heavy md golden exists; no timeline-grounded evidence case pack yet | The target is dated evidence and useful continuation, not generic term recall |

A crucial OpenClaw note from its own testing docs: **live transport gateway
lanes disable memory search; memory behavior stays covered by QA parity
suites**. That is a mature product-testing choice. It means OpenClaw's test
strength is broad runtime QA, not a GLG-specific garden relevance benchmark.

## 5. Recall usefulness bar

A comparison document is only useful if it says what counts as success for the
actual operator workflow. The canonical timeline supplies temporal truth;
andenken must supply the semantic evidence around it.

### Session retrieval must prove

- Given an exact KST window, decisions and turning points are recovered without
  collapsing a day or week into its final busy hour.
- Expected session-file/project/source anchors rank high enough to explain the
  event and restore the next thread.
- Source filters (`pi`, `claude`) do not cross-contaminate results.
- A one-turn or smoke session does not masquerade as the main thread.

### MD retrieval must prove

- A timeline note event can reach the intended dated garden file / Denote ID.
- Durable interpretation complements the event without pretending that the
  public garden is the complete lived record.
- Skipped files and honest corpus misses are explainable (`noembed_tag`,
  `min_body`, etc.), never silently relabeled as ranking failures.
- Vocabulary and sparse lexical probes protect components, but do not define
  product success.

### Timeline-grounded recall must prove

- `2026-02-07` is not called empty merely because artifact depths are silent.
- `2026-07-11` preserves timelog + journal evidence while honestly reporting no
  depth-2/3 artifact residue.
- time→meaning starts from structured coordinates; meaning→time ends with
  timeline confirmation.
- `/recall` can reach the next useful turn without the operator reverse-
  engineering the retrieval stack.
- failures are classifiable as timeline/source-status, corpus miss, ranking
  miss, join mistake, or synthesis mistake.

This is the real bar for andenken. Not "does search return something," but
"does dated evidence restore meaning and continuity quickly and honestly?"

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

> ⚠️ **이 소절의 초안에는 사실 오류가 있었고 §12에서 정정됐다.** 아래 표는 정정본이다.
> 결론(상대 정규화가 문제)은 유지되지만, **직접 이식은 불가**하다 — 두 시스템의
> component score가 같은 척도가 아니다.

| | OpenClaw `mergeHybridResults` | andenken `weightedMerge` |
|---|---|---|
| 벡터 항 | `vec_distance_cosine` → `1 - dist`, 즉 코사인 [0,1] | `1/(1+L2거리)` (`store.ts:353`), 실측 raw 0.42~0.43 |
| 키워드 항 | `bm25RankToScore` — FTS5 **음수** BM25를 `r/(1+r)`로 압축 | Lance `_score` **양수 high-is-good** 원본(실측 6.6~10.2) / `score / maxFts` |
| 정규화 | 없음 (두 항 모두 자체 절대 척도) | 양쪽 다 max 상대 정규화 |
| 결과 | 합산이 의미를 가짐 | **무관 결과도 `vecNorm≈1.0` 만점** |

- 참조: `extensions/memory-core/src/memory/hybrid.ts` (156줄 전체).
- **andenken 적용점**: `retriever.ts` `weightedMerge`. max 상대 정규화가 vector-only
  후보를 lexical-only 정답 앞으로 몰아주는 경로를 없애는 것이 목표다.
- **직접 이식 금지 (§12.2)**: `bm25RankToScore`를 그대로 쓰면 andenken의 양수
  `_score`에서 **순서가 역전**된다(`1/(1+s)`는 큰 점수를 작게 만든다). 대응 형태는
  최소한 `s/(c+s)`이고 `c`는 calibration 대상이다. raw Lance BM25(6~10)를 그대로
  `0.3`에 곱하면 이번엔 lexical이 vector를 압도한다.
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

### 11.8 열린 질문 — ⚠️ **1~4번 전체가 §12에서 superseded되었다**

아래는 검수 전 초안이다. Q1은 §12.2가 전제를 깨고, Q2는 §12.1이 폐기하고,
Q3은 §12.3이 반증하고, Q4는 §12.4가 관측 자체를 무효화한다. **기록으로만 남긴다.**

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
---

## 12. GPT 검수 결과 (2026-07-27) — §11의 사실 오류 정정

`20260727T165615-b9acf6` (gpt-5.6-sol) 검수. **결함 판정(`피투성`을 golden ❌로
고정)은 유지**되지만, §11 초안의 원인 설명에 사실 오류가 있어 정정한다. 아래는
Claude 쪽에서 코드로 재확인한 것만 적는다 — 검수 주장을 그대로 옮기지 않았다.

### 12.1 정정 1 — "코사인 0.69 밴드"는 틀렸다

- `store.ts:353` — `score: 1 / (1 + r._distance)`. **L2 거리를 similarity로 접은
  값**이지 코사인이 아니다. 주석에도 `L2 distance → similarity: 1/(1+distance)
  — OpenClaw pattern`이라 적혀 있다.
- 검수 측 단계별 재현(동일 후보수 20): vector raw top-20은 **0.4336 → 0.4236**.
  기대 파일은 vector top-20에 없음. `weightedMerge` 이후 vector-only 20건이
  **0.7000 → 0.6837**로 1~20위를 독점하고 첫 기대 파일은 **22위**.
- 즉 §11이 "무관한 코사인"이라 부른 0.689~0.700은 **이미 `0.7 × score/maxVec`가
  된 병합 후 점수**다. raw는 0.42~0.43.
- **따라서 §11.8 Q2의 "cosine floor 0.75"는 폐기한다.** 현재 표현계에서 0.75는
  모든 결과를 자르는 값이다.

### 12.2 정정 2 — `bm25RankToScore` 오독

§11.8 Q1은 "`1/(1+rank)`가 BM25 점수 크기를 통째로 버린다"고 썼는데 틀렸다.

- OpenClaw의 **production 경로는 ordinal rank가 아니다.** FTS5 BM25는 음수이고,
  음수 분기 `relevance = -rank; relevance/(1+relevance)`가 실제로 타는 길이다.
  **원점수 크기를 버리지 않고 단조 압축**한다.
- andenken Lance `_score`는 실측 **양수 high-is-good**(6.65~10.16). 여기에
  OpenClaw 함수를 그대로 넣으면 `1/(1+s)`가 되어 **relevance 순서가 역전**된다.
- 대응 형태라면 최소 `s/(c+s)`이고 `c`는 calibration 대상. 한편 raw Lance
  BM25(6~10)를 그대로 `0.3`에 곱하면 이번엔 lexical이 vector(0.3점대)를 압도한다.
- **결론: "OpenClaw가 정규화 안 하니 우리도 raw 합산"은 해법이 아니다.** 먼저
  component score의 semantics(부호·척도·metric)를 통일하거나 보존해야 한다.

### 12.3 정정 3 — `Title:/Tags:` 프리앰블 가설은 **반증됐다**

§11.8 Q3의 의심은 코드로 닫힌다.

- `md-chunker.ts:211` — 저장 `text`는 "NOT used for embedding".
- `md-chunker.ts:599` / `indexer.ts:852` — 임베딩은 `chunks.map(c => c.embeddingInput)`,
  즉 **body-only**.
- 내가 검색 결과에서 본 `Title: ... Tags: ...`는 **FTS/표시용 저장 text**였다.
  프리앰블이 벡터 밴드를 평평하게 만든다는 가설은 성립하지 않는다.
- 남는 여지: MMR은 저장 `text`를 tokenize하므로 공통 title/tags 토큰이 Jaccard
  다양성에 미세 개입할 수 있다. FTS에는 의도적 개입이다.

### 12.4 정정 4 — `mdScaffoldRatio` 관측치는 과대계상

§11.8 Q4의 "md golden 23행 중 11행" 숫자를 그대로 믿으면 안 된다.

- `golden-queries.ts`는 `r.text.slice(0, 500)` 한 뒤 `mdScaffoldRatio()`를 부른다
  → **chunk 비율이 아니라 앞 500자 excerpt 비율**이다.
- `mdScaffoldRatio()`는 첫 marker부터 문자열 **끝까지** 전부 scaffold로 센다.
  실제 파일은 `## 관련메타` 뒤에 다시 실질 H2가 오는 경우가 있어 과대계상된다.
- `md-chunker.ts:660` `stripBibliographyTail()`이 이미 후반 50% 이후의
  CITATIONS/BIBLIOGRAPHY/REFERENCES/RELATED-NOTES를 `embeddingInput`에서 제거하고
  있다. **기존 정책과의 중복·충돌을 먼저 표로 정리해야 한다.**
- 재측정 방법: marker 섹션의 다음 same-or-higher heading까지만 span으로 세고,
  excerpt가 아니라 full chunk에서 잰다.

### 12.5 정정 5 — `피투성` fixture의 corpus/index provenance 불일치

- 소스 `rg` 기준 2파일이 맞지만, md.lance에는 **과거 본문이 남은
  `botlog/20260319T110800`** 이 있고 그것이 FTS 1위(10.1619)다.
- 확인: 해당 소스는 현재 12,848 bytes(15:29 수정), md-manifest 기록은
  **39,247 bytes**. 현재 소스에 "피투성"은 **0건**. → **인덱스가 stale**이고 그
  FTS 1위는 유령 본문이다.
- 즉 FTS 8건은 **인덱스 기준 3파일**이었다. 결함 자체는 사라지지 않지만
  (`expectFiles`의 두 파일은 여전히 소스·인덱스 양쪽에 실재), fixture를 신뢰하려면
  **sync 후 재측정**이 선행되어야 한다.

### 12.6 dictcli / Kiwi stem — 초안이 과장이었다 (정정본)

초안은 "stem 경로가 죽어 있다"고 썼다. dictcli 담당 세션
(`20260727T171701-026e1e`)의 반박을 받아 **우리 코드로 다시 확인한 결과 그 표현은
틀렸다.** 확정된 사실만 남긴다.

**내가 틀린 것:**

- "andenken 프로덕션 코드에 stem 호출이 없다" → **거짓.** `indexer.ts:44`에
  `batchStem()`이 있고 `:971`에서 호출된다. 초안의 grep이 `head -10`에 잘려
  놓쳤다.
- "`run.sh`가 없어 stem은 실행 불가" → **부정확.** `indexer.ts:34`
  `getDictcliDir()`는 스킬 번들이 아니라 **`~/repos/gh/dictcli` repo를 직접**
  가리키고, 거기에는 `run.sh`가 있다. 실행 가능하다.

**그럼에도 남는 사실:**

- `batchStem`은 `indexOrg()` 안에서만 호출된다(확인: `:971`이 속한 함수는
  `:891 indexOrg`). `indexSessions`(`:500`) / `indexMd`(`:666`)에는 없다.
  → **md.lance는 stem enrichment 없이 색인되어 있다.** 원인은 삭제가 아니라
  **org 트랙 은퇴에 딸려간 트랙 이동**이다.
- 검색 경로(`md-search.ts` / `cli.ts` / `retriever.ts`)에는 stem 호출이 없다.
  `dictcliExpand`만 있고 이쪽은 `execSync` + **1초 타임아웃 + 매 단어 프로세스
  spawn**이다.
- `enrichTextWithStems`(`indexer.ts:88`)는 `[stems: ...]` 블록을 텍스트 끝에
  붙인다. 주석대로 **FTS 인덱스에만 들어가고 벡터는 원문**을 쓴다.
- `./dictcli expand "설계" --json` → 빈 출력. 담당자 확인으로 이것은 **정책이
  아니라 미수집**이다(`디자인 :trans design`은 있는데 `설계`가 없는 비대칭,
  `data/practical.edn` 92줄).

**golden `설계했다`에 대한 판정 (수정):** 기대치 자체("설계"가 회수되어야)는
정당하다. 잘못된 것은 **description이 "Kiwi stem이 동작해야"라고 쓴 것**과, 그
계약을 검증하지 않는 PASS다. 검색 경로가 stem을 부르지 않으므로 이 케이스는 stem을
증명할 수 없다.

**중요 — 형태소는 `피투성`의 해법이 아니다.** 담당자 실측:
`피투성이라는 개념` → `["피", "개념"]`. Kiwi가 "피투성이"를 "피"로 쪼갠다(사용자
사전에 없음). 게다가 우리 `retriever.ts:493 isUsefulKoreanStem`이 1음절 한글
어간을 버리므로 그 "피"는 어차피 탈락한다. **stem을 붙였어도 `피투성`은 회수되지
않는다.** 결함 1의 원인은 병합 정규화라는 결론이 그대로 유지된다.

> **의존 금지 (GLG 지시, 2026-07-27).** dictcli 개선은 GLG가 직접 조율하는 별도
> 라인이다. andenken의 retrieval 품질 계획은 **dictcli 쪽 변경을 전제하지
> 않는다.** stem 소켓 서버(`stem_server.clj`, 포트 18230)나 expand 시드 확장이
> 언제 오든, 그것을 기다리거나 그것에 맞춰 설계하지 말 것. 우리 쪽 할 일은
> 계약을 정직하게 다시 쓰는 것까지다.

### 12.7 그 밖에 지목된 허술한 통과면

- definition 6개 케이스의 `top1NoScaffold` / `topKScaffoldMax`는 org 마커용
  `isScaffoldChunk()`를 쓴다 → md에서 0건 매치 → **사실상 no-op**.
- `뜻새김`, `일일일생 왜 중요`는 사실상 `resultCount`만 확인. vector search가 늘
  5건을 채우는 구조에서는 회귀를 거의 못 잡는다.
- diversity 케이스는 relevance anchor 없이 파일 분산만 본다 → 무관하지만 다양한
  결과로 통과 가능.
- `--compare`가 expected rank/pass가 아니라 `topScore` 증감만 비교하는 것도
  max-normalized 점수에서는 품질 비교로 약하다.
- `설계했다`의 `0.7000`은 "가짜의 충분조건"이 아니라 **max 정규화에서 top
  vector-only 후보라는 대수적 sentinel**이다. 점수 밴드는 자동 FAIL이 아니라
  **suspicious / weak-review 플래그**로 쓰는 게 맞다.

### 12.8 다음 Opus 세션 실행 순서 (fusion 변경은 마지막)

**fusion부터 손대지 않는다.** 초안은 5단계였는데, "score metric 바로잡기"가
*이름을 고치는 것*인지 *계산을 바꾸는 것*인지 모호하다는 2차 검수 지적을 받아
그 단계를 둘로 쪼갰다. 원칙은 **raw vocabulary → telemetry → interpretation**의
3단 분리다.

1. **corpus/index sync provenance 정합** — md sync 후 `피투성` fixture 재측정.
   유령 본문이 FTS 1위인 상태로는 어떤 튜닝도 근거가 흔들린다.
2. **관측 스키마·용어 계약 확정 — behavior 불변.** backend raw field를 그 이름
   그대로 박는다: `_distance`, `distanceMetric=l2`, `similarityTransform=1/(1+d)`,
   Lance `_score`, `higherIsBetter=true`. `vectorScore` / `cosine` / `rank`처럼
   **의미가 섞인 이름은 이 단계에서 금지**한다. 계산식과 랭킹은 건드리지 않는다.
   `s/(c+s)` 적용·metric 교체·floor 도입 같은 **행동 변경은 이 단계가 아니다**
   (그것을 여기서 하면 순서가 틀린 것이고 3번이 먼저여야 한다).
3. **raw component 계측** — raw distance와 현재 transformed score를 **둘 다**
   보존. raw FTS score와 fallback 여부도 **둘 다**. 여기에 `vectorRank` /
   `ftsRank` / `inBoth` / `expectedRank`. 이것 없이는 개선 진척을 볼 수 없다.
4. **계측값으로 empirical semantics / calibration 결정 + 같은 후보셋 replay** —
   shell candidate마다 유료 임베딩을 반복하지 말고, 한 번 얻은 raw vector/FTS
   후보를 저장해 **fusion만 in-process replay**한다. 청킹이나 문서 임베딩 자체를
   바꿀 때만 shadow index가 필요하다.
5. **calibrated transform / fusion behavior 변경.** 후보는 (a) 양수 BM25 단조
   압축 `s/(c+s)`, (b) RRF/ordinal fusion, (c) exact lexical hit에 top-K quota
   또는 override, (d) vector 채널이 평평할 때 weight/gate 조정. **희소 exact-term
   회수 계약에는 (c)가 가장 직접적**이고, 전체 품질에는 (a)/(d)가 정교하다.
   판정은 `피투성` / `Geworfenheit` 두 케이스가 아니라 **expected rank / MRR**로.
6. golden 판정을 `pass` / `weak-pass` / `fail`로 확장. canonical path·content
   anchor가 있는 케이스는 **그 anchor의 rank가 최종 판정**이어야 한다.

> 잘못 의미화한 필드(`vectorScore=0.4336`, `bm25Rank=10.16`)를 먼저 쌓으면 나중에
> 마이그레이션 비용이 된다. 반대로 계측 전에 calibrated semantics를 정하면 근거
> 없는 튜닝이 된다. 2번이 **이름만** 고치는 단계라는 것이 이 순서가 성립하는
> 조건이다.

### 12.9 다음 코드 라운드에서 같이 정정할 주석

`store.ts:311` / `:8`의 `L2 distance → similarity: 1/(1+distance) — OpenClaw
pattern`은 오해를 부른다. OpenClaw는 `vec_distance_cosine` 후 `1 - dist`이므로
**계산이 같지 않다.** `andenken legacy transform` 류로 바꿔야 SSOT가 정직해진다.
(이번 문서 라운드에서는 코드를 건드리지 않았다.)

---

## 13. 2026-07-27 direction reset — embedding as a lens over the time axis

The score audit above found real defects, but it also exposed a larger problem:
the fixture set had made generic terms such as `보편 학문` and `설계했다` look
like the purpose of andenken. They are not. The purpose is recollection on a
time axis: recovering what GLG lived and made, why it mattered, and where the
thread continues.

### 13.1 Ownership

| Surface | Owns | Must not claim |
|---|---|---|
| agent-config `timeline` | Canonical KST coordinates, native event identity, depth 0/1/2/3, source status, provenance, exact slices | Semantic interpretation of the event |
| andenken `sessions` | Decisions, reasons, conversation continuity, stored time/project/source/file signals | That a similarity score establishes when something happened |
| andenken `md` | Durable public interpretation in dated garden notes | That the public garden is the full lived record |
| harness / recall | Natural-language time resolution and composition of timeline facts with semantic evidence | Ownership of either underlying corpus |

The interface is bidirectional:

1. **time → meaning:** timeline date/window → events and refs → sessions/md
   evidence around the canonical coordinate.
2. **meaning → time:** semantic evidence → candidate timestamps/files/entities
   → timeline confirmation and the surrounding depth context.

Explicit time windows use structured retrieval first. A semantic hit becomes a
time claim only after timeline confirmation.

### 13.2 Evaluation hierarchy

A single golden runner must not pretend to prove all layers.

- **Timeline fidelity** belongs to the timeline skill. Its golden days include
  `2026-02-07` (depth 0 only) and `2026-07-11` (timelog + journal, no artifact
  residue). An answer that calls either day empty is wrong before embeddings
  are considered.
- **Embedding retrieval** belongs here. It should grade canonical evidence
  anchors: expected date/window, session file, Denote ID/path, event ref, and
  rank. It must report an honest corpus miss separately from a ranking miss.
- **Synthesis and next-move recovery** belong to harness recall. That layer
  proves whether factual slices and semantic evidence become a useful answer.

Loose `expectKeywords` may remain as smoke diagnostics, but it is not a
product-quality verdict. Sparse lexical cases such as `피투성` can continue to
protect a hybrid-merge component without directing the roadmap.

### 13.3 Start without a timeline embedding track

No `timeline.lance` is implied by this direction. Existing surfaces already
provide exact timeline slices, session `dateFrom/dateTo` and stored-signal
filters, md paths / Denote IDs, and git SHAs. The next design pass must exercise
those joins first. A derived event index is justified only if real
meaning→time scenarios cannot find a candidate coordinate through sessions and
md; if added, it references canonical `event_id` records and never becomes a
second time axis.

### 13.4 Consequence for §§11–12

The metric/sign corrections, raw-component telemetry, same-candidate replay,
and fusion defect remain valid engineering work. Their order changes only in
one respect: real timeline-grounded cases define the acceptance surface before
fusion is tuned. OpenClaw remains a source of techniques; parity with it is not
the destination.

---

## 14. 2026-08-06 — Hermes Agent as the third reference point

**Surveyed:** NousResearch `hermes-agent` `v0.20.0` (`3c27eb6`, 2026-08-03),
local checkout at `~/repos/3rd/hermes-agent`.

### 14.1 Why Hermes enters a document about embeddings

It does not have one. `hermes_state_search.py` is SQLite **FTS5 only** — no
`sqlite-vec`, no vectors, no rerank. Vectors reach Hermes exclusively through
external memory-provider plugins (Honcho, Mem0, Hindsight, Supermemory, …),
which are opt-in and additive.

That absence is the finding. Hermes ships a mature, heavily-tested agent memory
product whose recall layer is keyword search plus a **bounded curated context
block**, and it invests its engineering elsewhere: in deciding *what gets
written down in the first place*. andenken has the opposite shape — a serious
retrieval engine over corpora that nobody curates on write.

The word **axis** does not appear in Hermes' vocabulary. It decomposes memory
into *store · provider · lifecycle hook* instead. Reading it is therefore a test
of whether our axis framing survives contact with a system that never adopted
it.

### 14.2 Three-system placement

| Memory concern | OpenClaw | Hermes Agent | andenken |
|---|---|---|---|
| Recall before reply | active-memory layer in runtime | provider prefetch (background, **non-blocking**) + frozen system-prompt block | out of scope; must expose graceful-degrade contract |
| Semantic retrieval | `sqlite-vec` + FTS5 hybrid, builtin | **none in core**; external providers only | **owned** — LanceDB, Qwen3-8B/4096d, hybrid + MMR + decay |
| Keyword retrieval | FTS5 (trigram for CJK) | FTS5 + sanitizer + session scroll (`~20ms`, no LLM) | BM25 + substring fallback, particle stripping |
| Curated always-on facts | promotion across short/long layers | **`MEMORY.md` 2,200 chars + `USER.md` 1,375 chars**, hard-capped | none — andenken has no bounded store |
| Procedural memory | — | **`SKILL.md` library**, agent-written, curator-pruned | none |
| Write-side loop | **dreaming** — 3 phases, promotion gated on *recall statistics*; default-on behind provenance gates since the 7.2 beta (§14.4) | **background review fork** — every 10 turns, promotion gated on *LLM judgment*, on by default (§14.3) | none |
| Context compaction | runtime-side | batch, or `micro_compact` (one exchange per turn, off by default) | not applicable |
| Corpus ownership | per-bot / per-runtime | per-profile (`~/.hermes/`), agent-runtime-local | **per-human, cross-harness** |
| Canonical time axis | none | none | harness `timeline` skill; andenken is the lens over it |

Two properties remain andenken-only across all three: the **cross-harness human
corpus** and the **canonical KST spine** that retrieval must not fabricate.
Neither OpenClaw nor Hermes has an equivalent of §13.1 ownership.

### 14.3 What Hermes calls self-improvement, mechanically

A three-stage write-side loop. Worth reading precisely, because "the agent
learns" is otherwise unfalsifiable marketing.

**Trigger — counters, not cron.** `agent/agent_init.py:1656,1756`:
`memory_nudge_interval = 10` user turns, `skill_nudge_interval = 10` tool
iterations (reset whenever `skill_manage` actually fires). Evaluated in
`turn_finalizer.py:700` after the turn closes.

**Execution — an isolated fork of itself.**
`agent/background_review.py:1030 spawn_background_review_thread` forks `AIAgent`
into a daemon thread. Three deliberate constraints:

- `_bg_review_auto_deny` (`:674`) — approval-gated commands are auto-denied.
  A no-user-present actor may not escalate.
- the fork's own nudge intervals are zeroed (`:815`) — a review cannot spawn a
  review.
- same model ⇒ verbatim replay on a warm prompt cache; different model ⇒
  `_digest_history` (`:123`, last 24 turns verbatim + summary of the rest), so a
  cheap review model does not pay for a cold full transcript.

**Judgment — the prompt is the policy.** `_SKILL_REVIEW_PROMPT` (`:182`, ~120
lines) is the actual artifact:

- *Bias to act*: "A pass that does nothing is a **missed learning opportunity,
  not a neutral outcome**."
- *Action precedence*: patch a skill loaded this session → patch an existing
  class-level umbrella → add `references/` · `templates/` · `scripts/` support
  files → only then create a new umbrella. A name that only makes sense for
  today's task is defined as a wrong name.
- *Store separation*: memory = "who the user is"; skill = "how to do this class
  of task for this user". A style correction belongs in the **skill body**, not
  memory.
- *Explicit do-not-capture list*, the most transferable part:
  environment-dependent failures; **negative claims about tools**, which
  "harden into refusals the agent cites against itself for months after the
  actual problem was fixed"; and unresolved failures written up as validated
  workflow, which "presents an untested sequence of failures as guidance a
  future session will trust and repeat".
- *Protected skills*: bundled / hub / pinned / user-owned are refused writes.
  "Being in play does not make one yours to edit." Ownership transfer is an
  explicit human act (`hermes curator adopt <name>`).

**Gardening — the curator.** `curator.enabled: true` by default, fires on
`interval_hours: 168` **plus** `min_idle_hours: 2`. Deterministic phase (no
LLM): unused 30d → `stale`, 90d → `~/.hermes/skills/.archive/`. It **never
deletes**; pinned skills and skills referenced by any cron job (including
paused ones) are exempt; never-used skills get an age grace floor because zero
uses is absence of evidence. The LLM consolidation phase (merge overlapping
skills into umbrellas, 50–100 API calls) is **opt-in**, defers its first run by
one full interval, and has `--dry-run`.

**Consent.** `memory.write_approval` / `skills.write_approval` stage every
background write for `/memory pending` · `/skills diff` · approve/reject. The
docs name the motivating failure directly: "the agent saved a wrong assumption
about me".

### 14.4 OpenClaw already has the write-side loop — now provenance-gated by default

The framing "Hermes innovated on the write side, OpenClaw has not caught up" is
wrong. OpenClaw's `dreaming` (`docs/concepts/dreaming.md`,
`extensions/memory-core/src/dreaming-phases.ts`,
`src/memory-host-sdk/dreaming.ts`, plus `qa/scenarios/memory/*.yaml`) is the
same class of system, built more conservatively:

| | OpenClaw dreaming | Hermes background review |
|---|---|---|
| Phases | Light (stage, no write) → Deep (promote, writes `MEMORY.md`) → REM (reflect, no write) | Single review pass |
| Promotion gate | `minScore` + **`minRecallCount`** + **`minUniqueQueries`** — *did this actually get recalled, across distinct queries* | LLM asked "did you learn something" |
| Stale defense | Rehydrates snippets from live daily files before writing; deleted/stale candidates are skipped | None |
| Audit surface | `DREAMS.md` + per-phase reports under `memory/dreaming/<phase>/YYYY-MM-DD.md` | One `💾 Memory updated` line in chat |
| Default | **On since the 7.2 beta, provenance-gated** (#114819) | **On** (every 10 turns) |

The decisive difference is **evidence-gated vs judgment-gated promotion**.
OpenClaw promotes what retrieval statistics prove was useful; Hermes promotes
what a model believes was instructive. The first is falsifiable and cannot
promote something that was never recalled. The second can, and its 120-line
do-not-capture list is the compensating guardrail — guardrail volume is
evidence of misfire frequency.

**Correction (2026-08-10).** The original survey called dreaming opt-in and
disabled, then treated that state as a durable product judgment. OpenClaw 7.2
beta changed the premise: dreaming is now default-on under the provenance gate
introduced by #114819. The earlier "keeps it off" interpretation is withdrawn.
The important comparison is no longer on/off; it is OpenClaw's evidence and
provenance gates versus Hermes' model-judgment gate.

**Consequence for andenken.** When the dream axis is specified, the reference
implementation to study is OpenClaw's, not Hermes'. Specifically:
recall-count/unique-query gating maps directly onto andenken's existing recall
tracking, and rehydrate-before-promote is the same defect class as §12.5 (ghost
bodies surviving in the index after the source changed).

### 14.4b Reading — this is an adjacent axis, not our dream axis

Hermes' loop compresses **behavior**, not corpus. Its output is a changed
starting state for the next session (`SKILL.md`, `MEMORY.md`), not a distilled
retrieval unit. The consolidation axis andenken defers to the harness compacts
*what can be recalled*; Hermes sediments *how to act*. They are complementary
and should not be conflated when the dream axis is eventually specified.

The sharper observation is about corpus curation. Hermes bounds its always-on
memory at ~1,300 tokens and refuses the write when full — forcing the agent to
consolidate in the same turn — and prunes its procedural library on a 30/90-day
clock. andenken indexes everything and sorts it out at query time. Our defects
in §§11–12 (stale ghost bodies ranked first, scaffold sections diluting chunks,
generic fixtures masquerading as purpose) are all **write-side problems being
attacked from the read side**.

### 14.5 Transfer candidates

| # | Surface | Hermes reference | Real owner | andenken applicability |
|---|---|---|---|---|
| A | Refuse-on-full instead of silent drop | `tools/memory_tool.py` capacity error carrying `current_entries` | **harness** | None. andenken has no bounded always-on store. Belongs to `next-handoff` / `AGENTS.md` contracts, which have no capacity discipline today |
| B | Do-not-capture list for a write loop | `_SKILL_REVIEW_PROMPT` negative section | **harness (dream axis)** | None — andenken has no write loop by invariant. Reusable text when that axis is specified |
| C | Deterministic prune before LLM pass | `curator.py` two-phase run | **andenken** ✅ | An `md` corpus hygiene pass (stale manifest entries, ghost bodies from §12.5) is fully deterministic and needs no model. Already the §12.8 step-1 item |
| D | Staged writes with human approve/reject | `write_approval`, `/memory pending` | **n/a** | andenken's only write is indexing, and the query path never writes (`INVARIANT.md` §0) |
| E | Compaction cost as an explicit tuning knob | `docs/micro-compaction.md` | **harness** | None. Context compaction is not an andenken concern |

**Scope guard.** One of these five is andenken's, and it is already on the
roadmap. The other four belong to the harness. **Being written down in this
repo's COMPARISON.md is not a reason for them to enter this repo's roadmap.**
This section exists so the harness has a surveyed reference, not so andenken
grows a write side.

Explicitly **not** transferable at all: the provider-plugin architecture. Eight
memory providers each doing their own prefetch, injection, and summarization is
exactly the "no document says which axis owns what" failure that
`INVARIANT.md` §0 exists to prevent. Hermes' breadth here is a product-surface
decision, not an architectural one to copy.

### 14.6 What Hermes has that we cannot answer

No bounded always-on store. No procedural memory. No write-side loop at all.
andenken is correct to exclude these by invariant — but the harness as a whole
currently has no owner for them either, and `AGENTS.md` / skills are maintained
by GLG by hand. That gap belongs in the harness roadmap, not in this repo.

### 14.7 Research lineage — where these ideas actually came from

Hermes' memory design publishes no paper, and its repository cites no memory
research (`grep` across `website/docs`, `agent/`, `tools/` finds arXiv only as
an example *skill*). It is an engineering product, not a research artifact —
and its components have clear 2023 antecedents:

| Hermes component | Antecedent |
|---|---|
| `MEMORY.md` / `USER.md` — bounded, self-edited via add/replace/remove, agent consolidates on overflow | **MemGPT** (Packer et al., 2023) — core-memory blocks (persona/human) with `core_memory_append` / `core_memory_replace` under a hard bound. Near 1:1 |
| `SKILL.md` library grown from experience | **Voyager** (Wang et al., 2023) — iteratively growing skill library of reusable procedures |
| Post-turn background review that decides what was learned | **Generative Agents** (Park et al., 2023) reflection; **Reflexion** (Shinn et al., 2023) verbal self-reflection into episodic memory |
| Honcho dialectic user modeling | plastic-labs — the one component with its own research posture |

Two consequences worth recording.

**First**, "self-improving agent memory" is a three-year-old idea being
productized, not a new capability. That does not diminish the work — the
non-obvious parts of Hermes are the operational ones no paper contains (the
do-not-capture list, auto-deny in the review fork, the curator's never-delete
rule, grace floors for never-used skills).

**Second**, current research is moving toward OpenClaw's shape, not Hermes'.
*Memory Beyond Recall: A Dual-Process Cognitive Memory System for Self-Evolving
LLM Agents* (DPCM) argues that memory systems fail because they "collapse belief
revision, causal coupling, and cross-domain abstraction into a single retrieval
surface tuned for surface recall," and proposes a synchronous daytime writer
plus an **asynchronous nighttime abstraction engine**, with a read path that
traverses the store deterministically **without invoking any LLM**.

That is OpenClaw's Light/Deep/REM split, and it is andenken's axis separation
plus `INVARIANT.md` §0 ("andenken never calls LLMs for recall"). It is not a
flat `MEMORY.md` plus FTS5. The state of the field, read honestly: **the
attention is on Hermes; the design direction the research is converging on is
the provenance-gated design OpenClaw now ships by default.**

### 14.8 Standing judgment (2026-08-06)

- andenken's axis framing survives contact with a system that never adopted it.
  Hermes' `store · provider · lifecycle hook` decomposition is a valid product
  vocabulary but leaves no document answering "which layer owns what," which is
  precisely why it can host eight overlapping providers.
- The reference implementation for the future dream axis is **OpenClaw's
  dreaming**, on the strength of evidence-gated promotion. Hermes is the
  reference for *operational guardrails on a write loop*, which is a different
  and smaller borrow.
- Nothing in §14 changes what andenken builds next. §13 still governs; §12.8
  still orders the work.
