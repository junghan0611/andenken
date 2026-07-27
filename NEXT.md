# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken에서 다음에 할 것들 / 잠시 주차한 것들**을 적는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

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

## Watching — pi-shell-acp 1.0.0 (session-identity 2차 정렬 예상)

0.9.0 garden-native identity 정렬은 끝났다 (`b77713d`). 그런데 0.9.0
changelog가 직접 예고하듯 **resident · entwurf · 1.0.0 meta-bridge가
하나의 garden session ontology로 수렴**한다 — 즉 1.0.0에서 세션 정체성/이름/
헤더 표면이 **또 바뀔 수 있다.** GLG가 지금 pi-shell-acp 1.0.0 작업 중이고,
끝나면 결과를 가지고 andenken과 논의 예정.

andenken 측 함의 (지금 착수 금지, 1.0.0 결과 본 뒤):

- **2d entwurf parent/child threading은 1.0.0 결과를 기다린다.** 헤더 `id` +
  `entwurf`/`control` 태그를 인덱싱하는 schema 결정인데, 1.0.0이 meta-bridge로
  그 표면을 또 바꾸면 지금 설계한 게 두 번 깨진다. 0.9.0에서 한 번 깨진 걸로
  충분 — threading은 1.0.0 session 표면이 굳은 뒤 한 번에 설계.
- 1.0.0이 landing하면: (1) 세션 파일명/헤더/이름 grammar diff 확인,
  (2) session-indexer.ts 파일명·헤더 가정 재점검, (3) AGENTS.md
  "Session corpus sources" 절 재정렬.

> 세션 코퍼스 정밀화(tmp/300KB/구형 파일명 가드 + delegate golden 제거)는
> `v2026.6.19`로 닫혔다 → [CHANGELOG.md](./CHANGELOG.md). 아래는 그 위에서
> 이어지는 retrieval 품질 작업.

## Now — md golden gate 신설 + 희소어 회수 결함 (2026-07-27) ⟵ 다음 에이전트 시작점

GPT 분신이 `--db session` 실행에서 "📡 Org provider: gemini (768d)" 출력을 보고
"표시만 잘못된 것, org 검색은 실행되지 않았다"고 판단한 데서 출발. 표층은 맞지만
**게이트 자체가 죽어 있었다.**

### 확정된 사실

- `.env.local`의 `ANDENKEN_ORG_*`는 전부 주석 처리인데 `createOrgProviderFromEnv()`가
  legacy Gemini 768d로 폴백한다. org.lance는 2560d(마지막 인덱싱 2026-05-07) →
  **인자 없는 `./run.sh golden`이 쿼리 하나도 못 돌리고 dim mismatch로 즉사.**
  `--db session`만 살아 있었고, 그마저 아무도 쓰지 않는 org provider를 출력했다.
- golden 26개 중 org 전용이 16개 = 실질 검수는 session 10개뿐이었다.
- **프로덕션 지식축(md.lance 10,533청크 / 2,221파일)에 golden이 0개.** AGENTS.md는
  `./run.sh golden`을 regression gate로 소개하고 있었다.

### 세운 것

- **md 트랙 신설.** org 가든 쿼리를 md로 이전 + 신규 케이스. `--db md`.
- **org 트랙 은퇴.** `--db org`는 명시적 에러로 거부.
- **`md-search.ts` 코어 추출.** `cli.ts search-md`와 golden이 같은 `searchMdCore()`를
  호출한다. 이전 org 분기는 golden이 파이프라인을 따로 구현해 `recencyHalfLifeDays: 90`
  (cli는 0)을 재고 있었다 — 아무도 쓰지 않는 파라미터를 게이트로 삼던 상태.
- **트랙별 독립 평가.** session은 RRF(실측 0.008~0.053), md는 weighted(0.94~1.10)로
  스케일이 비교 불가인데 한 리스트로 정렬 병합했다 → `both` 5개 쿼리가 md를 두 번
  채점하고 session은 한 번도 안 봤다. 이제 (쿼리 × 트랙) 행으로 분리 집계.
- 새 계약: `expectFiles`(희소어 정답을 Denote ID로 고정) / `topKMaxPerFile`(노트 단위
  다양성 — MMR은 chunk만 본다) / `top1MdScaffoldMax`(md scaffold 비율).
- `retriever.ts`에 `MD_SCAFFOLD_MARKERS` / `mdScaffoldRatio` 추가 — **관측 전용**,
  랭킹 동작은 건드리지 않았다.

**baseline (2026-07-27): 전체 31/33 — session 9/10 · md 22/23.**
실패 2건은 아래 결함 1·3이며 둘 다 의도적으로 열어 둔 것이다.
실행 시간은 전체 스코프 기준 약 10분(md 인덱스 573MB, 쿼리마다 유료 임베딩 1회).

### ⚠️ 먼저 읽을 것 — 이 절의 초안은 교차검수로 정정됐다

같은 날 GPT(`20260727T165615-b9acf6`)와 dictcli 담당(`20260727T171701-026e1e`)의
검수로 **아래 결함 서술 중 여러 사실이 틀린 것으로 확인됐다.** 정정 전문은
[COMPARISON.md §12](./COMPARISON.md). 다음 세션은 **§12를 먼저 읽고** 이 절로 올 것.

한 줄 요약: **결함 판정은 유지, 원인 설명의 용어와 수치는 다시 잡아야 한다.**

### 다음 — 결함 1: 희소 고유어 회수 실패 (weightedMerge 상대 정규화)

golden `피투성` ❌로 고정해 뒀다. 통과시키려 기대치를 낮추지 말 것 — 이건 진짜 결함이다.
검수 측이 단계별로 재현했고, 기대 파일은 **MMR on/off 무관하게 22위**이며 `minScore`도
통과한다. 탈락 지점은 병합 단계가 맞다.

- 최종 top-5에 한 건도 안 남는 이유: `weightedMerge`가 max 기준 상대 정규화라
  **무관한 벡터 후보가 `vecNorm≈1.0` 만점**을 받고 BM25-only 정답을 밀어낸다.
  "벡터가 아무것도 못 찾았다"는 정보가 정규화에서 소멸한다.
- ⚠️ **초안의 "코사인 0.69 밴드"는 틀렸다** (§12.1). `store.ts:353`은 L2 거리를
  `1/(1+d)`로 접은 값이라 코사인이 아니다. raw 벡터 점수는 **0.4336 → 0.4236**이고,
  0.69~0.70은 **이미 `0.7 × score/maxVec`가 된 병합 후 값**이다.
  → **"cosine floor 0.75" 안은 폐기한다.** 현재 표현계에서 모든 결과를 자른다.
- ⚠️ **"가든에 2파일뿐"도 부정확하다** (§12.5). FTS 1위였던
  `botlog/20260319T110800`은 **인덱스에만 남은 유령 본문**이다(manifest 39,247 bytes
  vs 디스크 12,848, 현재 소스에 "피투성" 0건). **md sync 후 재측정이 선행되어야
  fixture를 믿을 수 있다.**
- `Geworfenheit`(라틴 문자)는 통과 → 한글 토큰화가 아니라 merge 단계 문제라는 대조는
  유효하다. **형태소도 해법이 아니다**: Kiwi는 "피투성이"를 `["피","개념"]`으로 쪼개고
  우리 `isUsefulKoreanStem`(retriever.ts:493)이 1음절을 버린다(§12.6).
- 후보 대책(§12.8 5단계에서 고른다): (a) 양수 BM25 단조 압축 `s/(c+s)`,
  (b) RRF/ordinal fusion, (c) **exact lexical hit에 top-K quota 또는 override**,
  (d) 벡터 채널이 평평할 때 weight/gate 조정. 희소 exact-term 계약에는 (c)가 가장
  직접적이다. ⚠️ **openclaw `bm25RankToScore`를 그대로 이식하면 안 된다** — 우리
  Lance `_score`는 양수 high-is-good이라 `1/(1+s)`가 **순서를 뒤집는다**(§12.2).
  판정은 두 케이스가 아니라 **expected rank / MRR**로.

### 다음 — 결함 2: md scaffold damping 부재 (단, 관측치부터 다시)

- `isScaffoldChunk()` 마커는 org 인용문 형식(`> History`)이라 md에서 **0건 매치**.
  가든 Hugo export는 `## 히스토리 {#히스토리}` 헤딩이다 (실측: 히스토리 862파일,
  관련메타 864, History 586, BIBLIOGRAPHY 1570). 이 사실은 유효하다.
- ⚠️ **"23행 중 11행" 수치는 무효다** (§12.4). golden이 `text.slice(0,500)` 한
  excerpt에 대고 재고, `mdScaffoldRatio()`가 첫 마커부터 **문자열 끝까지** 세는데
  실제 파일은 그 뒤에 실질 H2가 다시 온다 → 과대계상. 재측정은 marker 섹션의 다음
  same-or-higher heading까지만 span으로, excerpt가 아니라 **full chunk**에서.
- `md-chunker.ts:660 stripBibliographyTail()`이 이미 후반 50% 이후의
  CITATIONS/BIBLIOGRAPHY/REFERENCES/RELATED-NOTES를 `embeddingInput`에서 제거한다.
  **기존 정책과의 중복·충돌 표를 먼저 만들 것.**
- 전면 제외는 반대. History는 실제 시간/운영 질의 신호다. `chunkKind =
  content|history|related|bibliography` 같은 구조 신호를 두고 definition 질의에는
  감쇠, history/recovery 질의에는 살리는 쪽. **모든 H2를 경계로 되돌리는 것은 금지**
  (과청킹 회귀).

### 다음 — 결함 3: `dual GPU 인덱싱 튜닝` 0 results (session)

- v2026.6.19 이전부터 실패 중. 세션 tightening의 의도적 손실인지 회수 실패인지 미확정.
  아래 우선순위 1의 "기대치를 코퍼스에 맞춰 정정"과 같은 판단이 필요하다.

### 다음 — 결함 4: `설계했다`는 계약이 허구다

- description이 "한국어 어간 '설계' — Kiwi stem이 동작해야"인데 **검색 경로는 stem을
  부르지 않는다**(`batchStem`은 `indexOrg`에만 있고 `indexMd`에는 없다, §12.6).
  이 PASS는 아무것도 증명하지 않는다.
- **기대치 자체("설계"가 회수되어야)는 정당하다.** dictcli 담당 확인 결과 expand의
  빈칸은 정책이 아니라 미수집이다. 잘못된 건 description과 판정 방식이다.
- 검수 권고: 문구만 바꾸고 끝내지 말 것. **canonical path/content rank로 검증할 명확한
  retrieval 계약이 없으면 `suspicious` / `weak` 케이스로 두는 편이 안전하다.**
- ⚠️ **dictcli 개선을 기다리지 말 것** — GLG가 직접 조율하는 별도 라인이다(§12.6 말미).

### 코퍼스 제약 — 가든 영어 태그는 **통제 어휘**다 (2026-07-27, GLG 통보)

다음 세션이 반드시 알아야 할 상류(上流) 변경. andenken이 만든 게 아니라 **가든
내보내기 쪽에서 조인 것**이다.

- doomemacs-config의 가든 export가 **org 문서의 태그를 무시하고 meta 노트에 등록된
  영어 태그만** md front matter로 내보낸다. org 쪽은 영어 태그 단복수조차 정리가
  안 된 상태라 그 혼란을 하류로 흘리지 않으려는 조치다.
- 그 결과 가든 영어 태그가 **약 1,243개**로 수렴했다
  (`~/repos/gh/notes/content/index.md` §택소노미의 `tags index (1243)`).
  andenken 쪽 실측(2026-07-27)은 front matter 유니크 **1,253개**, 태그 부착
  총 **8,457건**.
- **한글은 자유, 영어는 통제.** GLG 원칙: 한글 표현은 마음대로 쓰되 영어는 쌍으로
  어휘를 제한한다. 이것이 **임베딩과 dictcli 양쪽에서 유효해야 한다.**

#### andenken 함의 (측정 결과)

`Tags:` 는 chunk의 **저장 `text`** 에 들어가고 `embeddingInput`(body-only)에는
들어가지 않는다(§12.3). 즉 이 통제 어휘는 **벡터가 아니라 FTS/표시 축**의 성질이다.

dictcli `:trans` 영어 출력(1,950개)과 가든 태그(1,253개)의 정렬도 실측:

| 구분 | 개수 | 뜻 |
|---|---|---|
| 교집합 | **661** | expand 결과가 태그 축에 실제로 착지 |
| 가든에만 (dictcli 미등록) | **592** | 그 태그로 가는 한→영 경로 없음 |
| dictcli에만 (가든 태그 아님) | **1,289** | expand 출력의 66%가 태그 축에서는 헛돔 |

빈도 가중이 더 아프다. **미등록 592개가 태그 부착 3,723건 / 8,457건 = 44%를
차지한다.** 미등록 상위를 보면 성격이 분명하다:

- 구조 태그 — `bib(985)`, `meta(498)`
- 도구·고유명사 — `orgmode(63)`, `doomemacs(22)`, `quarto(20)`, `gptel(17)`, `nixos(7)`
- 최근 AI 실무어 — `llm(33)`, `anthropic(16)`, `vibecoding(13)`, `mcp(12)`, `rag(10)`
- 힣 고유어 — `hangul(40)`, `metameta(40)`, `entwurf(16)`, `emacsian(12)`

dictcli 담당자가 짚은 "`practical.edn` 92줄, 실무어가 통째로 빠짐"과 정확히 겹친다.

**단, 44%가 전부 손실은 아니다.** 도구명·고유명사는 사용자가 영어로 직접 질의하므로
한→영 경로가 없어도 FTS가 잡는다. 실제 손실은 **한글로 질의될 법한데 영어 태그만
있는 개념**(예: "한글" → `hangul`)에 한정된다. 그 부분집합을 분리 계량하는 것이
다음 라운드 과제다. ⚠️ **dictcli 시드 확장을 기다리지 말 것**(§12.6 말미) — 이
측정은 andenken 쪽 계약을 정직하게 쓰기 위한 것이지, 저쪽 작업의 선행조건이 아니다.

**golden에 대한 함의**: 태그 축에 착지하지 못하는 expand 결과는 `expectKeywords`를
우연히 만족시킬 수 있다(본문에 그 단어가 있으면). 결함 4(`설계했다`)와 같은 계열의
가짜 통과 경로다. rank 기반 판정으로 옮길 때 같이 봐야 한다.

### 실행 순서 — fusion은 마지막 (§12.8 전문)

1. corpus/index sync provenance 정합 (md sync → `피투성` fixture 재측정)
2. **관측 스키마·용어 계약 확정 — behavior 불변** (raw field 이름 그대로:
   `_distance` / `distanceMetric=l2` / `similarityTransform=1/(1+d)` / Lance `_score` /
   `higherIsBetter=true`. `vectorScore`·`cosine`·`rank` 같은 섞인 이름 금지)
3. raw component 계측 (raw distance와 transformed score를 **둘 다**, raw FTS score와
   fallback 여부를 **둘 다**, `vectorRank`/`ftsRank`/`inBoth`/`expectedRank`)
4. 계측값으로 empirical semantics/calibration 결정 + 같은 후보셋 **in-process replay**
   (shell candidate마다 유료 임베딩 반복 금지)
5. calibrated transform / fusion behavior 변경
6. golden 판정을 `pass`/`weak-pass`/`fail`로 확장 (anchor 있으면 그 rank가 최종 판정)

원칙은 **raw vocabulary → telemetry → interpretation**. 2번이 *이름만* 고치는
단계라는 것이 이 순서가 성립하는 조건이다.

## Next — Post-rebuild 품질 개선안 (2026-06-19, GPT 검수 반영)

full rebuild 후 1차 검수(golden 세션 8/10, doctor 분포) + GPT 분신
(`20260619T095519-55dcb9` gpt-5.5) 검수 결론: **rebuild는 성공("핵심만"
정책 정상 작동). 지금 손댈 건 threshold 완화가 아니라 (1) golden 계약 정리
(2) 2e retrieval balancing (3) read-only 민감도 계측.** 300KB는 유지.

검수 사실:
- 세션 15,581청크/376파일, md 10,404/2217, verify 로컬 clean (oracle orphan은
  raw 소스 미보유 host-locality 아티팩트).
- **compaction=0**: GPT가 로컬 raw 확인 — pi compaction 107개 전부
  garden-native=false라 정책상 정상 제외. 94개 신형 파일엔 `type=compaction`
  자체가 없음 → **parser 고쳐도 즉시 복구 안 됨.** legacy 재유입 금지.
- 분포 skew: source claude 89.5%/pi 10.5%, project pi-shell-acp 37.1%.

### 우선순위 1 — Golden contract cleanup (작고 즉시)
- `delegate session directory` 제거 ✅ (v2026.6.19에서 완료).
- `봇멘트 remark42`: session golden에서 제거 또는 md/skill-doc golden으로 이동
  (세션 tightening의 의도적 손실 — botment 운영지식이면 skill docs/md/botlog로 승격).
- `남은 작업 뭐지`: strict session golden에서 제외 → recall/NEXT workflow test로
  분리("two-step recall required" 케이스). golden 8/10의 2 탈락은 *의도된 손실*이라
  현 golden 수치가 오해를 부름 → 기대치를 코퍼스에 맞춰 정정.

### 우선순위 2 — 2e balanced windowed retrieval (아래 § 상세설계에 파라미터 주입)
GPT 권장 파라미터 (인덱스 아니라 retriever에서 skew 해소):
- `baseCandidates` ≥ `limit×10` (가능하면 `×20`). 코퍼스 작아져 후보 넉넉히 잡아도 부담↓.
- **score floor 먼저**: hybrid/semantic은 `score ≥ topScore×0.6`(또는 normalized floor)
  안에서만 diversity 강제 — relevance 망치지 않게.
- project **soft cap** `ceil(limit×0.25)` (limit=30 → project당 ~8), sparse fallback에선 초과 허용.
- source **minority rescue**: 50/50 강제 금지(pi 약하면 쓰레기 끌어올림). base 후보에 양
  source 있으면 minority를 최대 `ceil(limit×0.2~0.3)`까지 rescue.
- **sparse fallback** 강화: bucket round-robin 후 결과가 `limit`의 40~60% 미만이면
  active bucket 안에서 `(sessionFile, project)`-balanced fill.
- skew 수치(claude 89.5 / pi-shell-acp 37.1)를 **regression fixture**로 박을 것.

### 우선순위 3 — Read-only quality audit (threshold 변경 전 필수)
- 300/250/200KB dry-run 비교표: 파일 수·chunk 수·project/source 분포·golden 회복·
  noise 회귀. threshold 변경은 이 표 보고 **GLG decision**.
- 2a `parsePiLine` compaction schema fix: old schema는 top-level `type:"compaction",
  summary:...`인데 parser는 `parsed.compaction?.summary`만 봄 → `summary` top-level
  fallback 추가(비용 작고 future/legacy 안전). 단 compaction 복구 이유로 pre-0.9.0
  재유입 금지. 추후 "derived session summary chunk"(header/name + first/last user turn
  + NEXT link)는 별도 설계.
- doctor metric 추가: "compaction records filtered by filename policy"를 설명 가능하게.

## Next — Windowed sessions retrieval that survives daily use

**현재 주요 우선순위:** 2026-05-28 doomemacs-config 측 wrapper
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
| **2e** | Multi-axis balanced windowed view — `(sessionFile, time-bucket)` group + project balancing tier. retriever module + `cli.ts` + `index.ts` parity. 인덱싱 무변경 | **현재 시작점** |
| **2b** | Corpus noise threshold — simulation 병행 (read-only). 임계값 확정은 2e 안정 후 | 시뮬만 |
| **2a** | parsePiLine compaction schema fix + targeted reindex (Phase 1 stored signals 결손 채움) | 2e 다음 |
| **2c** | Golden quality 측정 — query #3 / #6 / #8. **2e 비차단** (regression check만 머지 직전) | pending |
| **2d** | Derived signals 인덱싱 — 헤더 `id`(garden sessionId) + `entwurf`/`control` 이름 태그 / commit_sha / slash_command. **0.9.0 이후 entwurf parent/child threading은 여기로 흡수** (파일명 공짜 소멸, 인덱싱 필수). 2c 결과 보고 결정 | deferred |

### Current step — 2e Multi-axis balanced view

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
