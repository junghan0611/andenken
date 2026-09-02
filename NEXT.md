# NEXT — andenken

> RAIL: 세션 코퍼스 통합 ✅ → **[NOW] 굽고 나서 남은 것** → 배포면 정리
>
> `v2026.9.3`으로 통합 세션 임베딩이 닫혔다 → [CHANGELOG.md](./CHANGELOG.md).
> 실행 기록·측정치는 [#11](https://github.com/junghan0611/andenken/issues/11).
> 여기 남은 것은 그 정렬이 **열어놓고 간 것들**이다.

## NOW — 굽고 나서

인덱스는 살아 있다(75,290 chunks / 4096d / 양쪽 verify ✅). 아래는 그 위에서
이어지는 것들이고, 순서는 위험한 것부터다.

1. **인덱스 배포 방향을 표면으로 만든다.** 지금은 `sync:sessions --push`가 유일한
   경로이고 방향이 사람 손에 달려 있다. 오라클이 당기는 `pull:index`를 신설하고
   staging으로 받아 verify 후 swap. **인덱스를 밀면 코퍼스도 같이 밀어야 한다** —
   09-03에 오라클 orphan 7건이 정확히 이걸로 났다(코퍼스가 gather보다 뒤처짐).
2. **corpus lock 자동화.** 굽는 동안 입력 snapshot이 **운영 규율로만** 고정된다.
   rsync는 파일 단위로만 atomic하고 2,162개 전체는 아니다. host-local 고정 경로
   (`~/.local/state/andenken/…`) — 코퍼스 안에 두면 replication 대상에 섞인다.
   acquisition order는 `corpus → index`로 통일(섞으면 deadlock).
3. **shared prepare helper + receipt guard.** 두 wrapper에 gather 블록이 중복이고
   indexer는 receipt를 검증하지 않는다. **세 번째 caller가 다시 구멍을 낸다.**
4. **골든 세션 분기 추출.** `searchMdCore`처럼 공유 코어를 부르게 한다. `f048a0a`는
   값만 맞췄고, 사본이 남아 있는 한 다음 프로덕션 변경 때 또 뒤에 남는다.
5. **턴 단위 cap.** 수치는 나왔다 — parts 분포 2–5 6,110 / 6–10 1,035 / 11–40 222 /
   **41+ 단 4개**(487, 386, 86, 49). cap 40이면 4턴만 건드린다. 키는 `sessionFile` +
   `lineNumber`(둘 다 저장 컬럼) — `canonicalDocId` 재사용은 세션 파일 축으로 무너진다.
   `test.ts`의 "Sessions must not acquire a document cap"은 여전히 참이다(문서 상한이
   아니라 턴 상한이다).
6. **`truncateText` 죽은 코드 제거** (`session-indexer.ts`, 호출자 0건).
7. **build-state sidecar**: complete / partial-stale / partial-absent. 추가 전용
   코퍼스에서 원격 도달 불가는 "그 device 없는 인덱스"가 아니라 "마지막 성공
   snapshot을 포함한 stale-partial 인덱스"다.
8. **`~/.current-device` 폴백 제거 검토.** 파일이 없으면 hostname으로 떨어져 오타가
   새 device 디렉터리를 만든다. 코퍼스 모드에서는 roster id와 정확히 일치하지 않으면
   실패가 재현가능성에 맞다. (이제 authority 게이트도 이 값을 읽는다.)
9. **winner path churn doctor.** chunk id가 `sessionFile:lineNumber`이고 삭제/재삽입이
   물리 경로 기준이라, dedup 승자가 바뀌면 옛 경로 row가 남는다.

## 닫힘 — 가드 없는 창 (2026-09-03 06:14)

`v2026.9.3` 푸시 + 오라클 `git pull` 완료. 오라클 코드 `501cfe8`.
**"오라클에서 부르지 않는다"는 더 이상 유일한 방어가 아니다** — 스크립트가 막는다.
오라클에서 직접 실행해 확인: `sync:sessions`가 **gather는 마치고 인덱싱만 거절**하며,
왜 뒤처지지 않는지까지 출력한다. 실수로 불러도 코퍼스는 포크되지 않는다.
agent-config 쪽 8개도 GLG 지시로 푸시됨(`b3d8d01`).

## GLG 결정 대기

- **이슈 [#11](https://github.com/junghan0611/andenken/issues/11) 닫을지** —
  후속 코멘트 [게시 완료](https://github.com/junghan0611/andenken/issues/11#issuecomment-5516585307).
  §3 "굽기 전" 5항목은 전부 닫혔다. 남은 것들은 NEXT로 옮겨왔으니 닫아도 되는데,
  #10의 인수인계 사슬을 어디서 끊을지는 GLG 판단이라 열어뒀다.
- **형제 브로드캐스트** — GLG가 직접 부를 자리다. 문서면은 이미 원격에 있어
  (agent-config `b3d8d01`, andenken `v2026.9.3`) 세션 시작에 읽히므로, 발신은
  선택이지 blocker가 아니다. 에이전트가 형제 전체에 일방 발신하지 않는다.
- **골든 `"남은 작업 뭐지"`** — decay를 빼니 깨졌다. 즉 recency에 기대 통과하던
  케이스다. 지금 top-5는 전부 GLG가 실제로 그렇게 말한 발화인데 기대 키워드를 못
  맞춘다 — **query-echo**(질문의 메아리가 답보다 위). assertion을 결과에 맞추는 건
  게이트를 죽이는 짓이라 안 건드렸다.
- **garden-id 333건** — 이미 인덱싱된 이 세션들은 discovery에서 빠지지만 청크는
  남아 검색이 당분간 찾는다(의도된 상태). 매니페스트↔디스커버리 drift가 생기고 증분
  sync는 스스로 제거하지 않는다. 유지 vs `./run.sh cleanup sessions`.

## 닫힘 — 300KB floor (GLG 판정, 2026-09-03)

**모순이 아니었다. "모든"의 범위가 답이었다.**

#10의 "모든 프롬프트 원문 회수"에서 *모든*은 **회수할 가치가 있는 세션 전체**를
뜻한다. 잠깐 몇 마디 하고 끝난 세션의 프롬프트는 회수 대상이 아니다. 그래서
"모든 프롬프트 원문 회수"와 "300KB 이하 제외"는 동시에 참일 수 있고, 내가 둘을
모순으로 세운 것이 틀렸다.

300KB는 그 "가치 있는 세션"을 고르는 **현재의 대리 지표**이지 정의가 아니다.
**기준은 바뀔 수 있다**(GLG). 그러니 이건 열린 결정이 아니라, 더 나은 대리
지표가 나오면 갈아끼우는 자리다. 참고 실측: 300KB 이하 962파일 중 925개가 의미
있는 user text를 갖고 프롬프트 5,688개 / 4.05M자가 admission 밖인데, 파일 크기는
대부분 tool 페이로드라 **재는 것과 굽는 것이 다르다** — 크기를 대리 지표로 쓰는 한
이 어긋남은 남는다.

## 이번에 배운 것 — 결함 5건이 전부 같은 모양이었다

한쪽만 공유 경로를 안 쓴다. **넷 다 그 한쪽만 보면 안 보인다.**

| 결함 | 공유 경로 | 안 쓰던 쪽 |
|---|---|---|
| 이음매 거부 | `run.sh` + `sync-sessions.sh`가 `.env.local` 폴백 | 두 소비자 스킬이 `os.environ`만 |
| 스킬 무조건문 | Step 0 gather가 조건부 | SKILL.md가 단정문 |
| 골든 decay | md 분기의 `searchMdCore` | 세션 분기만 인라인 복제 |
| 좁은 가드 | 인덱싱 경로 | `push_replica()` 안에만 |
| 빈 문자열 해석 | 같은 변수 | 생산자 `-z` vs 소비자 `in os.environ` |

**넷 중 셋은 어제까지 옳았던 코드다.** `os.environ`만 보는 건 env가 바뀌기 전엔
맞았고, 좁은 가드는 리플리카가 인덱싱을 안 하던 동안엔 충분했고, 골든의 `14`는
프로덕션이 14였을 때 정확했다. **사본은 틀리게 태어나는 게 아니라 정본이 움직일 때
조용히 뒤에 남는다.** 다섯째는 정본을 다 안 읽고 사본을 새로 만든 경우인데 결과가
같다. 리뷰는 사본이 쓰인 시점을 보고 결함은 **다른 파일이 바뀐 시점**에 생기므로,
교차검수가 아니면 안 잡힌다.

부수: **리포를 건너가는 줄번호는 하룻밤을 못 넘긴다.** 하루에 셋이 서로의 커밋에
밀렸다. 건너가는 인용은 줄번호가 아니라 **이름과 위치**로 쓴다.

## 보류 — 자격증명

경계 강제 시 고유 20개(telegram 8, google-ai 8, gho_ 2, hf_ 1, slack 1,
replicate 0). 임베딩 입력과의 교집합은 6 chunks / 4파일, 전부 `role=user`.
**GLG 판단으로 치환 중단**(어차피 로테이션되는 값들). 라이브 저장소에는 1회
적용됐고 코퍼스는 대부분 미적용 상태다. `scripts/redact-credentials.py`는
남겨두었다.

주의: 500 vs 20은 **다른 정규식이 잰 다른 축**이다. 500은 좌측 경계 없는 prefix
매칭이 urlsafe-base64 본문에서 낸 오탐 포함이고, 20은 토큰 경계 강제 후다.
나중에 훅 숫자와 비교할 때 "왜 줄었지"로 읽으면 안 된다.

## Watching — OKF (Open Knowledge Format, Google knowledge-catalog)

따라갈 대상 아님. 중심은 andenken. 다만 **알아두면 고도화 유연성**이 된다 —
독불장군식으로 뻗지 않고 외부 표준과 손잡을 수 있는 export target 후보.

- **현 판단**: OKF v0.1은 schema-less·중앙권위 없음 → 포맷이 더 움직일 가능성.
  지금 denote↔OKF 컨버터 착수 금지. andenken md 축이 이미 가든 markdown
  (`~/repos/gh/notes/content`)을 임베딩 → OKF bundle에 ~90% 근접. ingestion이
  아니라 interchange/proof 표면.
- **우리 우위**: OKF concept ID는 경로 기반(파일 이동 시 깨짐). durable Denote
  ID가 그 약점을 이미 해결. 우리가 OKF에 맞추는 게 아니라 OKF가 우리 쪽으로.
- **트리거 (이때 재검토)**: OKF가 v0.1을 벗어나 schema/durable-ID 도입 시 →
  (1) denote↔OKF 매핑 정밀화, (2) andenken md export를 OKF bundle 표면으로
  노출 검토. "path-based ID라 깨진다" claim은 그때 SPEC 직접 확인.
- 맥락 노트: [[botlog]] `20260406T140411` §andenken — llm-wiki·OKF·EKG 수렴.
  EKG/semext(ahyatt) 동행 좌표도 거기.

## Parked — Copilot third source

- **안 함.** 양식은 커버 가능, 사용자 턴 코퍼스는 없다. 보라: [#9](https://github.com/junghan0611/andenken/issues/9).

## 세션 코퍼스 — 파일명 정렬 뒤 남은 것 (2026-08-10)

파일명 축은 `v2026.8.10`으로 닫혔다 → [CHANGELOG.md](./CHANGELOG.md).
재인덱싱 게이트는 `v2026.9.3`의 통합 재구축으로 닫혔고(현행 규격 세션 전량이
코퍼스를 통해 색인됐다), garden-id 333건 처리는 위 "GLG 결정 대기"로 옮겼다.
아래는 아직 열려 있는 것들이다.

- **2d entwurf parent/child threading은 여전히 기다린다.** 헤더 `id` +
  `entwurf`/`control` 태그 schema는 meta-bridge 표면이 굳은 뒤 한 번에 설계한다.
  파일명 정렬이 끝났다고 threading이 열린 것은 아니다.
- **헤더·세션이름 grammar 재점검은 아직 안 했다.** pi-shell-acp가 session identity
  표면을 다시 움직이면 파일명뿐 아니라 JSONL 헤더 `id`와 session-name 태그도 바뀐다.
  이번에 검증한 것은 **파일명 축뿐이고**, `session-indexer.ts`의 헤더 가정은
  손대지 않았다. 다음 identity 릴리즈가 landing하면 (1) 헤더/이름 grammar diff 확인,
  (2) indexer의 헤더 가정 재점검 — 이 둘은 열린 상태다.
- **다음 drift를 잡을 라이브 불변식이 없다.** `session-filename.test.ts`는 우리가
  방금 쓴 규격을 고정할 뿐, 업스트림이 문법을 바꾸는 이번 실패모드는 못 잡는다
  (`test.ts`의 `piFiles.length > 0`도 당시 garden-id가 남아 있어 통과했을 것이다).
  후보: "non-tmp pi 디렉토리의 최신 `.jsonl`(>300KB)은 반드시 admit" 같은 recency
  불변식, 또는 `.jsonl`이 있는데 admit 0인 프로젝트 디렉토리를 doctor가 WARN.
  이번 스코프에서는 구현하지 않았다.

> 아래는 그 위에서 이어지는 retrieval 품질 작업.

## Now — derive embedding quality from the canonical time axis

The direction changed on 2026-07-27 after reviewing the harness-side
`timeline` contract (`~/repos/gh/agent-config/skills/timeline/README.md`). The
previous md golden work exposed real component defects, but generic vocabulary
queries are not the reason andenken exists. The north-star question is:

> What did GLG live, what did GLG make, why did it happen, and where should
> continuity resume now?

### Boundary to preserve

- `timeline` owns exact KST coordinates, event identity, source status,
  provenance, and the distinction between an honest zero and a missing source.
- andenken owns semantic evidence over **sessions + md**: decisions, reasons,
  durable interpretation, and the next thread.
- the harness composes them. andenken does not parse natural-language dates,
  rebuild the timeline collector, or let similarity scores override temporal
  facts.
- do **not** create `timeline.lance` by assumption. Start with timeline exact
  slices plus existing session stored-signal filters and md file/Denote IDs.
  Add a derived event index only if real meaning→time scenarios prove a gap.

### The two retrieval turns

1. **time → meaning** — canonical date/window → timeline events/refs → session
   and md evidence around that window.
2. **meaning → time** — semantic evidence → candidate timestamps/files/entities
   → timeline confirmation and surrounding depth-0/1/2/3 context.

Start with time→meaning because its coordinate is already exact. Meaning→time
comes second and must end by pivoting back to the timeline.

### 2026-07-29 — the canonical concepts now live in the garden

Do not restate this design here. Two garden notes are the SSOT and stewards
read them in this order:

- **concept** — `20250214T145957` *왜 나는 지식그래프를 계속 묻는가 — 문과 길,
  자석과 살아 있는 프로피디아*. What GraphRAG is, what embedding is and is not,
  the six places and what each one refuses to do, Folgezettel signatures.
- **contract** — `20251024T085736` *에이전트 컨텍스트 레이어 기술 지도*, sections
  `[2026-07-29]` and `[2026-07-29 보완]`. Ownership, authority grades, the parser
  contract, and the four boundaries.

What andenken owns out of that: **one parse of the public garden, two artifacts**
(`summary.jsonl` + `edges.jsonl`). andenken never writes `skos:*Match`, never
assigns a signature, never invents a relation. Candidates only; promotion is the
author's, in ELOT Org.

Measured 2026-07-29 (public surface 2,240 files):

| axis | size | note |
|---|---|---|
| summary corpus | 339K tokens, **$0.0034** | 3.4% of the current chunk index; abstract present in 2,130 (95%) |
| doc-level vectors today | **0** | 10,533 chunks, no stable one-doc-one-vector |
| export scaffold in embedding input | **15.1%** | relref path + anchor + timestamp span; meta 33% |
| chunks straddling ≥2 sections | **4,590 / 10,543** | headings are not chunk boundaries |
| links | 22,271 occurrences / 20,278 unique pairs | |
| authority | filename 123 · human 4,804 · body 4,636 · export 800 · dblock 12,031 | **volume and authority run opposite** |
| author gloss on human links | **1,358 (28%)** | not reproducible by extraction |
| signature reach, human 2-hop | **1,052 / 2,240 (47%)** | meta 82% · botlog 88% · bib 42% · **notes 30%** · journal 1% |

### Next — one comparison, not more documents

The open question is whether the signature axis actually improves recall, so the
next step is an experiment, not a build.

- **A** embedding/chunks only · **B** A + human links + `raw_gloss` ·
  **C** B + mode-aware Folgezettel traversal
- Questions to run: *2024년 12월 나는 지식 지형의 어디를 지나고 있었나* /
  *메멕스·셀프트레킹이 왜 `1j2c`에 놓였는가* / a near-antonym pair that embedding
  places close (전쟁·평화) and must not be collapsed.
- Score: rank of the canonical evidence, explainable path, expansion volume,
  tokens to reach the source, honest abstain, and **whether the answer separates
  today's map from the map that existed at the time** (signature assignment time
  is recoverable from `~/sync/org` git rename history).

If C beats A/B, the signature axis is a real structural signal for the memory
layer. If not, it stays a filename search feature and the summary corpus alone
carries the doc-level gain.

Blocking on the author, not on code: whether a graft address (`1j1b` `1j2a`
`1j2b1` `1j2c`) is narrower or continuation, and whether an agent may ever assign
a signature (andenken's proposal: **read-only**).

> Parked below: the original timeline case-pack framing. Still valid as the
> temporal contract — the two-question distinction above is exactly its join.

1. Build a small case pack from real temporal recovery jobs, beginning with the
   two timeline golden days:
   - `2026-02-07`: depth 0 proves a lived day while journal/agenda/git/note
     residue is silent.
   - `2026-07-11`: timelog + `장염 복통` + `인간 환멸` explain a day with no
     depth-2/3 artifacts.
2. Add work-continuity cases with canonical anchors, for example a cost
   incident and the operating rule that followed it. Expected values are dates,
   event IDs/refs, session files, Denote IDs, and evidence ranks — not loose
   keyword presence.
3. Inventory the joins already available before adding storage:
   `dateFrom/dateTo`, project/source/role/sessionFile, chunk timestamps, Denote
   IDs, note paths, full git SHA, and timeline native identity.
4. Define three separate proof layers:
   - timeline fidelity belongs to the timeline skill;
   - embedding retrieval grades canonical evidence rank and honest corpus gaps;
   - final synthesis/continuity belongs to the harness.
5. Only after the cases expose a retrieval failure, continue the raw-component
   telemetry and fusion work documented in `COMPARISON.md` §11–12.

### Acceptance for the design

- A day with no commits is never answered as a day with no life.
- `empty`, `stale`, `partial`, and `unreadable` are not collapsed into zero.
- An explicit time window uses structured retrieval before semantic ranking.
- A semantic hit does not become temporal truth until the timeline confirms it.
- The answer can show not only what happened, but the decision/interpretation
  and the next thread when the evidence exists.

### 2026-08-10 — acceptance surface landed; layer 3 ran; one product gap left

`./run.sh accept` + `acceptance-cases.json` + the `andenken-acceptance` skill
carry the user-facing question ("what became better?") in three separated layers.
Design lives in the skill and in `acceptance.ts`; do not restate it here.

Layer-3 verdicts from the real pi tools (surface `pi-tools`, not the CLI):

- **garden lookup — usable**, **garden explore — usable**. The autholog usable
  gate is closed.
- **recent-session lookup — partial.** Evidence was recovered, but the production
  response carries **no freshness warning** while the index lags the transcript.

**Next product gap: freshness warning / provenance in the production response.**
Not a ranking problem — the response has no field to say "the index is behind
this source", so the user cannot tell recall from staleness. Technical green
still never implies acceptance; the runner cannot set the verdict.

**Measured debt: production-path parity.** On the same cases the CLI surface is
semantically worse than the pi tools (distractor above a helpful neighbor on
lookup; no labeled helpful neighbor on the explore first screen). Do not tune one
surface in isolation — the shared production core is the fix. Freshness comes
first.

### 2026-08-11 — md context efficiency landed; what it did and did not close

An independent review of the 2026-08-11 autholog link-curation job produced
measurements, and the patch that followed is in the working tree. Closed:

- **`knowledge_search` runs `searchMdCore()`.** The inline copy and the
  duplicated short-CJK helper are gone, so `golden` and `accept` finally measure
  the function the pi tool executes. `acceptance.ts` now hashes `index.ts` into
  `pipelineDigest` for the same reason. Parity is still reported as **unproven**
  — shared code is not a measurement, and this runner never executes the pi tool.
- **`limit` is no longer a ranking parameter.** `mdCandidateCount()` floors the
  candidate pool at 40, so display limit 5 and 10 now see the same universe.
  This was a real production defect, not a theory: two `knowledge_search` calls
  on the same query 46 minutes apart returned different rows at ranks 3 and 5
  (recall log, 01:10 vs 01:56).
- **Document identity comes from `SearchResult.sessionFile`.** The old id regex
  was a no-op for md *and* for sessions; it only ever collapsed the org shape.
  The md track now uses `capPerDocumentWithBackfill` (max 2/doc, over-cap chunks
  move behind the capped pass), so the output is a permutation of the input —
  recall provably unchanged, and a narrow single-document lookup still fills its
  screen. Sessions keep the legacy path deliberately; the windowed-session
  collapse belongs to the 2e scheduler below, not to a global cap.
- **Compact md screen, one formatting contract.** Document-grouped: title,
  Denote ID, openable path, and the author's description once per document, then
  per-chunk `#index Lline` with a 200-char display-cleaned snippet. Measured
  3.2–3.4× smaller than the previous limit-10 screen on live queries. The
  constant `[md] doc` tag is gone; the export mtime is no longer printed as
  `Time` (JSON calls it `indexedAt`).
- **md default limit is 5** on both surfaces, with `--full` on the CLI.
- **`recalls.jsonl` records `limit` and `returned`** (additive keys; older rows
  carry neither).

Explicitly NOT closed, and not to be inferred from the above:

- **Freshness is still the next product gap.** Unchanged by this work.
- **Stored md `timestamp` is still the export mtime.** `MdFrontmatter` already
  parses `date`/`lastmod` (present in 2,244/2,249 garden files) and discards
  them, while the org path stores the note's own date. Fixing it means
  rewriting every md row, so it rides the **next md re-index** and should land
  together with exposing `dateFrom`/`dateTo` on md — that is the capability it
  unlocks. Do not do one without the other.
- **No new acceptance case.** `garden-explore-diversity` already owns the
  monopoly contract; re-run it with `accept --retrieval --compare` rather than
  adding a case.
- **Caller practice** is unchanged and now enforced in `promptGuidelines`:
  conceptual discovery starts at 5, judge the top 3–5, and proper-noun/existence
  questions are semantic candidates followed by `denotecli` exact verification.

**Correction landed with it:** `knowledge_search.promptGuidelines` claimed
Korean verb stems were auto-indexed via Kiwi. They are not — `batchStem()` /
`enrichTextWithStems()` are reached from `indexOrg()` only, and org is disabled
in production. The claim was removed rather than reworded.

### What happened to the 2026-07-27 word-oriented work

The md gate, independent track scoring, shared `searchMdCore()`, stale-index
finding, score-semantics correction, and `weightedMerge` defect remain valid
engineering evidence. `피투성` may remain a low-level sparse lexical regression
case. `보편 학문` and `설계했다` are no longer quality-direction cases; dictcli
continues on its own vocabulary contract and does not block this plan.

The full forensic record is in `COMPARISON.md` §11–12 and commits
`85a38f4..bef9536`; it does not belong as the active queue here.

## Parked evidence — windowed sessions retrieval for time → meaning

This 2026-05-28 design is no longer the active implementation queue. Its raw
failure remains directly relevant: a KST day window sorted by timestamp DESC
collapsed a 24-hour day into its final hour. Keep the measurements and scheduler
proposal below as evidence for the new timeline-grounded case pack. Do not ship
the scheduler until those cases establish the required output shape.


**Historical repro:** 2026-05-28 doomemacs-config 측 wrapper
(`andenken-search-sessions-today/this-week`)를 사용자가 매일 쓰려고
처음 시도했다. 즉시 결과 미달. 실측으로 surface shape 문제 확정 (어제
KST 윈도우 / limit 30 / mode=recent):

| 축 | 분포 | 해석 |
|---|---|---|
| project | pi-shell-acp 25 / forge-config 5 | project 다양성 붕괴 |
| sessionFile | 한 세션이 17/30 (57%) | 세션 다양성 붕괴 |
| timestamp | 100%가 UTC 10:40~11:00 (KST 19:40~20:00 마지막 1시간) | **시간 다양성 붕괴 — 가장 critical** |

`mode=recent`는 stored-signal scan + timestamp DESC라 윈도우 끝 N분이
결과를 다 점령한다. 사용자가 보고 싶은 "어제 24h 전체 흐름"이 실제로는
**1/24만** 보인다. 인덱싱이 아니라 retriever surface shape 문제.

### Two consumers, one surface

이 단축 retrieval surface는 두 caller가 동시에 쓴다:

- **사용자** (emacs wrapper) — 화면 폭 한정 → default `limit=30`
- **에이전트** (`recall` skill, pi `session_search`) — context window 큼 → default `limit=100~200`. 사용자가 "이번주에 내 세션에서 뭐했는지 보자" 물을 때 에이전트가 시간 윈도우를 ISO로 잡고 같은 surface 호출, 결과를 다축 합성에 넣어 답.

두 caller가 **동일한 balance 행동**(time-bucket 균등 + project 다양성)을
받되 **default limit은 surface별 분리**. balance 로직은 `retriever.ts`
모듈에 두고 `cli.ts`와 `index.ts`(pi extension) 둘 다 호출.

### Sub-plan (순서대로)

| 단계 | 내용 | 상태 |
|---|---|---|
| **2e** | Multi-axis balanced windowed view — `(sessionFile, time-bucket)` group + project balancing tier. retriever module + `cli.ts` + `index.ts` parity. 인덱싱 무변경 | parked pending timeline cases |
| **2b** | Corpus noise threshold — simulation 병행 (read-only). 임계값 확정은 2e 안정 후 | 시뮬만 |
| **2a** | parsePiLine compaction schema fix + targeted reindex (Phase 1 stored signals 결손 채움) | 2e 다음 |
| **2c** | Golden quality 측정 — query #3 / #6 / #8. **2e 비차단** (regression check만 머지 직전) | pending |
| **2d** | Derived signals 인덱싱 — 헤더 `id`(garden sessionId) + `entwurf`/`control` 이름 태그 / commit_sha / slash_command. **0.9.0 이후 entwurf parent/child threading은 여기로 흡수** (파일명 공짜 소멸, 인덱싱 필수). 2c 결과 보고 결정 | deferred |

### Historical proposed step — 2e Multi-axis balanced view

#### Step 0 — Session-track fileDedup 분기 (1줄 fix 아님)

3차 리뷰(Gemini-3.1-pro)가 GPT-5.5의 "regex 1줄 fix" 추천을 정면 반박:

> fileDedup() regex가 sessionFile id에 안 먹는 것은 사실이지만, regex만
> 고치면 `maxPerFile=3`가 발동되어 **4시간 몰입한 핵심 세션도 3줄로
> 토막**난다. time-bucket balance 들어가기 *전에* base candidates 증발.

Step 0 정의:

1. fileDedup이 sessionFile id에 안 먹는 것 확인 (가설 검증, GPT 관점)
2. **Session track에서 fileDedup 우회 분기 또는 `maxPerFile` 대폭 증가
   (limit×10 이상)** — per-session truncation 방지
3. balance 책임은 전적으로 Step 1 scheduler에 위임

이거 함께 안 하면 17/30 독점이 풀려도 깊은 세션이 토막나서 다른 형태의
붕괴가 생긴다. **수술 1줄 아님**.

#### Step 1 — Selection scheduler (sort 아님)

dedup group key = `(sessionFile, bucketIndex)`. project / role / source는
metadata + tie-break tier, dedup tuple 안 들어감.

time-bucket = `window_length / target_limit`, 단 `minBucketMs` floor:

- 24h + 30 → ~48분 bucket
- 7d + 30 → ~5.6h bucket
- 1h window → 2분 bucket 회피 → `minBucketMs` 적용 + sparse fallback

**Scheduler — pass-N round-robin + evenly-spaced pick:**

```
1. group candidates by (sessionFile, bucketIndex)
2. select 1 representative per group:
   - recent: latest timestamp
   - hybrid: best score; tie-break user_message > assistant_response > tool
3. pass-N round-robin over non-empty buckets (과거 → 현재 chronological):
   for each pass:
     remaining = limit - result.length
     if remaining < activeBuckets.length:
       # Limit truncation 편향 방지 (Gemini 3차 발견)
       currentPass = selectEvenlySpaced(activeBuckets, remaining)
       # 예: 10 buckets 남고 3개만 더 → 0, 4, 9번 stride pick.
       # 단순 순회 시 가장 최근 bucket들이 통째로 잘림 — 역진동.
     else:
       currentPass = activeBuckets
     for bIdx in currentPass:
       pick representative, update projectCounts (least-seen project 우선)
4. sparse fallback: 빈 bucket 다 돌면 active bucket 안에서
   sessionFile/project balanced fill (24h에 1h만 작업한 날 1~2행 끝
   방지)
5. 최종 결과는 timestamp 오름차순 재정렬 — 사용자/에이전트가 시간
   흐름대로 읽도록
```

Hybrid mode 추가:

- **query semanticity 판별**: empty query / "최근 작업 요약" 같은 meta
  query는 vector score 자체가 노이즈 → relevance floor를 **graceful
  degrade** (off 또는 매우 낮게). 칼같이 적용하면 가장 중요한 최근
  작업이 "점수 낮다"고 떨어짐 (Gemini §C1).
- specific query에서만 floor 정상 적용.
- candidate budget: session view에서 `limit*10 max 1000` (현재 `limit*4
  max 200`은 7d에 작음).
- session view에서 MMR off — `(bucket, sessionFile, project)` balance가
  더 직접적 diversity.

#### Step 2 — (제거됨) Entwurf 세션은 평범한 garden 세션으로 처리

**결정 (2026-06-05, 0.9.0 정렬).** 원래 Step 2는 entwurf 자식 세션을
별종으로 특별 취급(own-row vs fold, `[entwurf:<id>]` badge)하려 했고, 그
전제는 `<parent_id>_entwurf-<childId>.jsonl` 파일명에 부모-자식 링크가
박혀있다는 것이었다. pi-shell-acp 0.9.0 garden-native identity 릴리즈가
이 전제를 **두 방향에서 동시에 무너뜨렸다**:

1. **구현 근거 소멸.** 파일명이 `<created-at>_<sessionId>.jsonl`로 바뀌어
   파일명에 부모 링크가 없다. entwurf 정체성은 JSONL 헤더 `id` + 세션
   이름의 `entwurf` 태그로 이동했는데, andenken이 현재 인덱싱하는 컬럼엔
   둘 다 없다. 즉 retrieval 시점에 "이 세션이 entwurf 자식인가"를
   **공짜로 알 방법이 사라졌다** (파일명 substring 탐지가 유일한 경로였음).
2. **철학적 정렬.** 0.9.0의 선언은 "entwurf 세션을 worker artifact의
   별종으로 취급하지 않는다 — resident · entwurf · 1.0.0 meta-bridge가
   하나의 garden session ontology로 수렴한다". andenken retrieval이
   entwurf를 별종 분기로 다루는 것은 upstream 의도와 정면으로 어긋난다.

따라서 **2e ship에서 entwurf 특별 취급을 들어낸다.** Step 1 balance
스케줄러는 entwurf 세션을 그냥 평범한 garden 세션으로 다룬다 —
`(sessionFile, bucket)` dedup + project 다양성으로 동일하게 균형 잡힌다.
별도 fold/badge/threading 없음. 이건 타협이 아니라 0.9.0과의 정렬이다.

**threading을 정말 살리려면 → 2d로 강등.** 헤더 `id`(garden sessionId)와
`entwurf` 태그를 파생 신호로 **인덱싱해야** 가능하다. 파일명 공짜는 끝났고,
이제 진짜 schema 결정이다. 부모 링크 후보 소스는 entwurf-message
custom_message의 `sender_info`/`receiver_info` (session-excerpt.ts 346–348,
현재 excerpt 표시 레벨만 — 인덱싱 안 됨). 2d 본격화 시 재설계.

#### Acceptance — 2단계 ship

1. **Raw repro acceptance** (semantic golden 전):
   - 같은 KST 5/27 윈도우 / limit 30 / mode=recent 다시 측정
   - timestamp가 24h에 퍼지는가 (마지막 1h 점령 깨졌나)
   - **동시에 가장 최근 bucket이 통째로 잘리지 않는가 (역진동 방지)**
   - sessionFile 17/30 독점 깨졌나 (단 깊은 세션이 3줄로 토막나지도
     않는가 — Step 0 caveat)
   - project 25/5 독점 완화됐나
2. **Dual-consumer parity check**:
   - emacs wrapper `--view session --limit 30` 호출
   - pi `session_search` `view: session, limit: 100~200` 호출
   - 같은 옵션 동일한 balance 행동
3. **Regression spot check** (2c 본 단계 전):
   - #3 entwurf 결과 / #6 multi-repo 의미연결 / #8 entwurf 흐름 한 번
   - **0.9.0 정렬:** entwurf 세션이 평범한 garden 세션으로 surface하면
     통과 (별종 threading/badge 기대 안 함 — Step 2 제거). entwurf
     transcript가 balance 윈도우에 정상 포함되는지만 확인.
   - 머지 직전 통과 확인 — quality tuning은 별 단계

#### Code location

- `retriever.ts` — `balanceSessionWindow(candidates, opts)` 새 함수,
  scheduler 본체. `selectEvenlySpaced(buckets, k)` helper. 기존
  `fileDedup()`은 Step 0에서 Session track 분기 (우회 또는
  `maxPerFile` 인자 외부 노출).
- `cli.ts` — `--view session` flag, opts 전달. default `limit=30`.
- `index.ts` (pi extension) — `session_search`가 같은 옵션 (`view:
  "session"`) 받기. default `limit=100~200`. 두 entry 모두에서 동일한
  `balanceSessionWindow` 호출.
- 인덱싱 무변경. `temporal decay`는 windowed mode에서 off.

#### Diagnostic (응답 JSON top-level)

- `bucketMs`
- `nonEmptyBuckets`
- `candidateGroups` / `selectedGroups`
- `truncated: bool`
- `timestampMissingRows`
- (필요 시) `hint: "increase --limit for denser weekly view"`

### Boundary principle — caller owns the time window, andenken owns the diversity

시간 윈도우는 caller가 잡는다 (emacs wrapper나 `recall` / `session_search`).
andenken은 그 안에서 **세션 중복 없는 / project 다양성 있는 / 시간 분포
균형 잡힌** 결과를 노출. 윈도우 자연어 파싱과 git/journal/bib 통합은
day-query / recall 영역.

### Non-goal

- md retrieval ranking 자체를 이번 항목에서 다시 튜닝하지 않는다
- org track은 건드리지 않는다 (production disable 유지)
- 인덱싱 schema 변경(2d)은 2c 측정 보고 결정 — 우선 retriever 후처리로
  끝나는 것부터
- per-source weight (pi vs claude) 적용 안 함 — 실제 작업 위치 왜곡 위험
- 자동 limit 증가 안 함 — caller가 화면 폭 / 비용 결정
- Reranker API 후처리 안 함 — 시간 균형 못 봄, UX 지연 (Gemini §B 기각)
- Pre-computed session summary indexing 안 함 — 실시간성 깨뜨림
  (Gemini §B 기각, 2d-deferred로 유지)

### Review trail

- 2026-05-28 1차: doomemacs-config Claude (Q1~Q7 입장 잠금)
- 2026-05-28 2차: GPT-5.5 (`.review/2026-05-28.md`, $0.58, 5 turns) —
  scheduler frame, `fileDedup()` regex 결함 가설, module parity,
  candidate budget, edge-case fallback, sparse window diagnostic
- 2026-05-28 3차: Gemini-3.1-pro (사용자 직접 호출, 실측 동반) —
  **fileDedup fix 역설** (regex 1줄 fix → 깊은 세션 토막, Session
  track 우회 필요), chronological traversal limit truncation 편향
  (`selectEvenlySpaced` 대응), empty/meta query × hybrid floor 충돌
  (graceful degrade), agent vs emacs limit default 분리

### 권장 자문 — Gemini-3.1-pro

이 작업 영역(windowed sessions retrieval, scheduler 설계, dual-consumer
surface)은 2026-05-28 첫 자문에서 Gemini-3.1-pro가 결정적 발견을 줬다
— 특히 fileDedup 역설은 직전 자문(GPT-5.5)의 답을 정면 반박하며 문제를
한 단계 더 깊이에서 막았다. 다음 라운드에서도 같은 지점에서 막히면 우선
Gemini로:

```
provider="pi-shell-acp"
model="gemini-3.1-pro-preview"
cwd 옵션으로 AGENTS.md inject
cost: subscription-backed (낮음)
```

다른 영역(예: corpus noise threshold 2b, derived signals 2d)에서는
이번 신호가 자동 적용되지 않는다 — 그 영역은 다시 처음부터 자문.

## Parked — Sessions cleanup after pruning sub-100KB transcripts

2026-05-29 사용자가 `100KB` 이하 세션 JSONL을 대거 삭제했다. 다음
세션에서 정리 방향 결정 필요.

- 현황: `deleted=860`, `to-index=44`
- dry-run: `cleanup sessions --dry-run` → `orphan files=812`, `orphan rows=2979`
- dry-run 실측: **~0.73s**
- 주의: 증분 `sync-sessions`만으로는 삭제된 세션 임베딩이 자동 제거되지 않음

다음 시작 순서:

1. `./run.sh status --json`
2. `pnpm exec tsx indexer.ts cleanup sessions --dry-run`
3. 목표가 검색면 정리면 `./run.sh cleanup sessions`
4. DB + manifest까지 완전 청소면 `scripts/rebuild-sessions-full.sh`

## Parked — openclaw memory-axis 동기화 검토 (baseline `v2026.6.8`, 결론: 포팅 없음)

`~/repos/3rd/openclaw`를 stable **`v2026.6.8`** (2026-06-19 재정비, 직전 baseline
`v2026.6.1`)로 checkout하고 우리가 포팅해온 기억축 로직과 대조했다.
**andenken이 채택할 알고리즘적 retrieval/chunking 개선은 없다.** 재조사를
막기 위해 결론을 박아둔다.

- **6.1→6.8 재검수 (2026-06-19)**: 2,652 커밋 / 16,831 파일 변경이지만 우리
  의존 표면은 무변경. `memory-host-sdk` md 청킹/임베딩은 **로직 0 변경**(98파일
  diff 대부분이 JSDoc 주석 스위프). embeddings는 `nodeLlamaCppImportUrl` 런타임
  주입 옵션만 가산(우리는 remote OpenRouter Qwen3 → 무관). sqlite-vec는
  robustness 하드닝(vec_version 헬스체크 + 플랫폼 변형 폴백 / 우리는 LanceDB →
  정보성). active-memory `agent-runner-memory.ts`는 우리 검색 API **계약 무변경**
  (변경분은 followup CLI-runtime alias 판별 + compaction-notice phase, openclaw
  내부 오케스트레이션). → COMPARISON.md 재정렬 불요.

아래는 5.22→6.1 검토 당시 결론 (여전히 유효):

- **한국어 particle/stem 로직**: `query-expansion.ts`의 `KO_TRAILING_PARTICLES`
  / `stripKoreanTrailingParticle` / `isUsefulKoreanStem`가 우리 `retriever.ts`
  포팅본과 **완전히 동일**. drift 없음, 새 particle 없음 → in sync.
- **CJK tokenizer 개선** (#56707 configurable FTS5 unicode61/trigram,
  #80613/#86645 dreaming dedupe CJK tokenizer): **SQLite FTS5 / dreaming
  axis 전용**. andenken은 LanceDB(tantivy)라 비적용 — 같은 "짧은 CJK 토큰
  드롭" 실패모드는 이미 `getShortCJKTokens` + `substringSearch`로 대응 중.
- **STOP_WORDS_KO 필터**: openclaw `tokenize`는 stopword를 거르지만 그건
  FTS-only fallback / 인덱싱 tokenize 경로용. andenken은 항상 임베딩(8B)이
  있어 BM25는 hybrid의 한 팔이고, query-side는 dual-emit(원본+stem)이 의도.
  gap 아님.
- **5.22→6.1 memory 커밋 대다수**: 방어적 하드닝(bound/cap/validate
  timeout·retry·JSON size)과 qmd salvage. qmd는 우리가 #8에서 retire,
  나머지는 openclaw runtime(remote worker/batch) 전용 → 비이식.

유일한 하드닝 후보 (committed task 아님, 다음에 우리 코드 확인만):
- `#85704 prevent silent vector index degradation when provider temporarily
  unavailable` — provider가 런 도중 죽을 때 degraded row를 조용히 쓰지 않게.
  andenken은 wrong-dim preflight + hard guard로 *시작 전* 차단은 있으나
  *런 도중 provider down* 각도는 미확인. 우려되면 indexer 경로 한 번 점검.
