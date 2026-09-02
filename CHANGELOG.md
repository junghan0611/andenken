# Changelog

andenken CalVer 스냅샷. 형식 `vYYYY.M.D[-suffix]`. 과거에 *닫힌* 작업을
기록한다(미래 방향은 `NEXT.md` / `ROADMAP.md`). 전체 커밋 타임라인은 `git log`.

## Unreleased

## v2026.9.3 — 통합 세션 임베딩: 기기 합본 코퍼스 위에서 굽는다

`v2026.8.10` 이후 **세션 축의 입력 자체가 바뀌었다.** 한 기계의 라이브 저장소가
아니라 양 기계를 합친 코퍼스를 인덱싱한다. 그 위에서 오래된 결함 둘(2K 절단,
14일 decay)이 닫혔고, 교차검수가 다섯 번째까지 잡아냈다.

### 세션 코퍼스 — 새 입력면

- **`~/repos/gh/session` 코퍼스**가 SSOT가 됐다. 레이아웃 `<device>/<하네스 원래
  저장 경로>` — 라이브 경로 앞에 device 한 마디만 덧댄 모양이고 **이게 계약이다**.
  `detectSource`는 `/.claude/`로, `extractProjectName`은 `projects`/`sessions`
  세그먼트로 판정하므로 둘 다 무수정 통과하고 **lance 스키마 변경이 없다.**
  규칙 둘: 추가 전용(`--delete` 없음), 실복사(하드링크 금지 — 공유 inode는 다른
  기계로 옮길 수 없다).
- **왜 필요했나(실측)**: 필터 적용 후 thinkpad 1,137 / oracle 1,008, 겹침 553,
  **oracle 고유 455건(0.69GB)**. 정체는 `entwurf` 194 · `nixos-config` 79 ·
  **openclaw workspace 64(thinkpad에 한 건도 없음)** 등. 오라클 에이전트가 시맨틱
  검색하면 자기가 한 일이 안 나오고 있었다.
- **git이 아니라 체크섬 매니페스트.** 코퍼스를 git으로 한 번 커밋해보고 물러섰다 —
  단일 커밋에 **806MB 팩 + gitleaks 47분 47초**가 들었고 추가 전용 데이터엔 읽을
  diff도 다시 쓸 히스토리도 없다. `MANIFEST.json`(SSOT) + `MANIFEST.sha256`
  (`sha256sum -c` 호환 — **andenken 없이 검증된다**). 전건 해시 3.5초 / 정상 갱신
  0.07초 / 전건 verify 2.2초.
- **`DEVICES.json` roster를 MANIFEST와 분리.** 코퍼스 디렉터리 목록을 roster로
  쓰면 **은퇴한 기계에 평생 접속을 시도한다.** `state: active|retired`,
  `transport: local|ssh|push`. push device는 조용히 건너뛰지 않고
  `delivered by push — not pulled from here`라고 말한다.
- 표면: `corpus:gather` / `corpus:manifest` / `corpus:replicate`. gather는
  `sync:sessions`·`rebuild:sessions`의 Step 0으로 자동 실행되고, **실패 시 인덱싱을
  거부한다**(신선도 불명 코퍼스로 인덱스를 만들지 않는다).

### 오늘 닫힌 품질 결함 둘

- **2K 절단 폐기.** `truncateText(text, 2000)`이 턴의 앞 2,000자만 임베딩하고
  있었다. 실측: user turn의 **30.3%가 2,000자 초과**(최장 79,928자), **전체 user
  문자의 51.1%가 색인 밖**. 프롬프트 원문을 회수하려고 모은 코퍼스를 굽는 시점에
  잘라내고 있었던 셈이다. `splitForEmbedding`이 문단→줄→문장 순으로 넓은 이음매부터
  나눈다. 요약이 아니라 분할이라 **모든 문자가 정확히 한 part에 살아남는 것이
  테스트의 핵심 불변식**이다. compaction summary도 함께 분할.
- **14일 recency decay 제거.** 점수에 `exp(-ln2 × 나이/14)`를 곱한 뒤 `minScore
  0.001`을 적용해, 보통 hit는 **약 49일**·강한 hit도 **약 85일**이면 바닥 아래로
  떨어졌다. 몇 년을 거슬러 올라가라고 만든 기억축에서 계절 하나를 넘기면 지우는
  감쇠는 **랭킹 신호의 탈을 쓴 하드 삭제**였다. 최근성 의도는 `mode=recent`가 담당한다.

### 권위와 안전 — 인덱스를 누가 쓰는가

- **`ANDENKEN_INDEX_AUTHORITY`(기본 `thinkpad`) 게이트.** `INVARIANT.md` §7.1대로
  canonical host만 인덱스를 쓴다. **`--push`만이 아니라 인덱싱 진입 자체를 막는다** —
  push만 막으면 정본은 지켜지지만 리플리카가 스스로를 포크하는 것은 열려 있고,
  그게 §7.1이 실제로 이름 붙인 실패다(2026-06-19→07-06, 27,966 vs 24,882).
  게이트는 Step 0 뒤라 **거절된 호출도 gather는 마친다** — 리플리카 세션은 소스
  파일로 authority에 가서 밀려오는 인덱스에 담겨 돌아온다. 탈출구
  `ANDENKEN_ALLOW_REPLICA_INDEX=1`은 따라잡는 수단이 아니라 포크다.
- **재현가능성 — 서버에서도 굽을 수 있다.** `thinkpad → oracle` ssh만 되고 역방향은
  안 되며, 뚫어도 **노트북이 꺼져 있으면 못 당긴다**. pull 대칭을 포기하고 push
  모델로 갔다. 양 기계에서 같은 명령이 같은 뜻으로 돈다(코드 HEAD·코퍼스 sha256
  전건·견적 $0.2480 vs $0.2481).
- `rebuild-sessions-full.sh`에 **writer lock**(destroy보다 먼저 잡아 경합에서 진
  실행이 무언가를 지우는 데까지 가지 않는다)과 **Step 0 gather** 추가.
- 버그 2건: `gather-corpus.sh`가 다른 env 이름을 읽어 **다른 데를 수집하고 다른
  데를 색인**할 수 있었다. 두 스크립트가 `~/.env.local`을 안 읽어 직접 호출·systemd
  경로에서 **조용히 라이브 저장소로 폴백**했다.
- 오라클 라이브 중복본 **548건 / 0.70GB 삭제**(md5 전건 검증 후) — gather의 오라클
  열거가 1,008 → 460건.

### 첫 통합 재구축 (2026-09-03)

**75,267 chunks / 1,608파일 / 1.7GB / 4096d**, 8,055초, 전량 $0.25. verify는
thinkpad·oracle 양쪽 통과.

- **cutover 무결성**: 인덱스 경로 100% 코퍼스, 옛 라이브 경로 0건.
- **합본 증명**: thinkpad에 한 건도 없던 오라클 openclaw 세션이 최상위 hit.
- **분할 효과**: 7,371턴이 분할, **25,133 chunk(전체의 33%)가 그 덕에 존재**.
- **턴 cap 수치**: parts 분포 2–5 **6,110** / 6–10 **1,035** / 11–40 **222** /
  **41+ 단 4개**(487, 386, 86, 49). cap 40이면 건드리는 턴이 4개다.
- 굽는 중 3파일이 OpenRouter 60초 타임아웃으로 실패했으나 인덱서가 파일 단위 에러를
  모아 끝에 throw하므로 인덱스는 온전했고 증분이 err:0으로 채웠다. **재구축 불필요.**

### 골든

- **`golden-queries.ts`의 세션 분기가 프로덕션이 삭제한 decay를 아직 주입하고
  있었다.** 코드베이스에 남은 유일한 `14`였다. 게이트가 몇 달 된 hit를 `minScore`
  아래로 지운 뒤 그 부재를 근거로 질의를 실패시키고 있었다 — **하네스가 자기 증거를
  지우고 있었다.** md 분기는 `searchMdCore`를 부르는데 세션 분기만 인라인 복제본이라
  프로덕션 변경이 게이트에 안 닿았다. `operational-recovery` 4/5 → 5/5, 전체 30/32.

### 그 밖

- `redact-credentials.py` — 토큰 경계 강제 시 고유 20개, 임베딩 입력과의 교집합
  6 chunks / 4파일 전부 `role=user`. **GLG 판단으로 치환 중단**, 스크립트는 보존.
  주의: **500 vs 20은 다른 정규식이 잰 다른 축이다**(500은 좌측 경계 없는 prefix
  매칭의 오탐 포함).
- md 문서 우선 검색 결과 압축(`088502b`).
- `andenken-embed` 스킬에 코퍼스 축 문서화. 스킬이 아직 "라이브 저장소를
  인덱싱한다"고 말하고 있었다.
- 낡은 테스트 단언 하나 정정: `all chunks ≤ 2000 chars`는 2K 절단 시대의 상한이었다.
  분할은 짧은 꼬리를 마지막 part에 접어 넣으므로 실제 상한은 `target +
  minTailChars + 1 = 2201`이다(실측 최대 2193). 절단이 사라진 뒤에도 절단을 재고 있었다.


## v2026.8.10 — 수용 판정 표면 + 세션 코퍼스 현행 파일명 정렬

`v2026.6.19` 이후 두 갈래가 닫혔다. 하나는 **"사용자에게 무엇이 좋아졌나"를 묻는
수용 판정 표면**이고, 다른 하나는 **세션 코퍼스 admission을 현행 native 파일명으로
되돌린 정정**이다.

### Acceptance / retrieval 품질
- `./run.sh accept` + `acceptance-cases.json` + `andenken-acceptance` 스킬. 세 층
  분리(인덱스·운영 건강 / andenken 검색 행동 / **인간** usable·partial·not-improved
  판정). 기본 API 0, `--retrieval`로만 유료 질의 임베딩. `--compare`는 두 런이 같은
  것을 재지 않았으면 방향 판정을 거부한다. 자동 런은 판정을 세울 수 없다.
- golden에 md 트랙 추가, org 트랙 은퇴, 트랙별 독립 채점. `md-search.ts`
  `searchMdCore()`를 `cli.ts search-md`와 golden이 공유.
- 품질 방향을 canonical 시간축(harness `timeline`)에서 도출하도록 재정렬. 어휘형
  golden은 컴포넌트 테스트로 강등, north-star는 time↔meaning 두 회전.

### Sessions 운영
- `sync-sessions`를 flock 단일 writer로 보호.
- oracle rsync에 `session-manifest.json`을 DB와 **항상 함께** 밀도록 수정
  (INVARIANT 6.6).
- 임베딩 대기가 0일 때도 replica push가 진행되도록 수정.
- 세션 교차폴백을 비활성 `org.lance` 대신 md로 보냄.

### 세션 코퍼스 admission 정정
- admission을 현행 native id suffix **`_<UUIDv7>.jsonl`** 단일 규격으로 정렬.
  하위호환 없음 — garden-id `_YYYYMMDDTHHMMSS-<hex6>`, UUIDv4, `_entwurf-`,
  `_delegate-`는 OR로 되살리지 않는다 (GLG 판정 2026-08-10).
- **종의 역사 정정.** UUIDv7은 새 종이 아니다 — pi는 2026-04-15부터 써왔고,
  garden-id 형식과 2026-06-03~08-06 내내 병존했다. 바뀐 것은 **2026-08-07부터
  UUIDv7 단일**이 되었다는 점이다. garden-id를 계속 요구하던 필터는 그날부터 신규
  pi 세션을 0건 받아들였다 — 에러 없이 코퍼스의 pi 절반이 조용해졌다.
- 파일명은 **코퍼스 소속만** 결정한다. created-at prefix는 일부러 검사하지 않으며,
  `garden id ↔ nativeSessionId ↔ transcriptPath` join은 entwurf meta-record 소유다.
- `session-filename.test.ts` 픽스처(API 0) + 운영 진입점 `./run.sh test:filename`.
  짝인 `agent-config/skills/session-recap`과 같은 규격을 공유하며 함께 움직인다.
- **실측 효과 (2026-08-10T17:39 KST 스냅샷, 300KB 상회·tmp 제외):** pi UUIDv7
  218건이 매니페스트에 없다 — 8/07 이후 gap 21건, 나머지 197건은 `v2026.6.19`가
  "pre-0.9.0 `_<uuid>`"로 은퇴시켰던 세션의 소급 재편입이다. 동시에 이미 인덱싱된
  garden-id 333건이 discovery에서 이탈한다(청크는 잔존). 살아 있는 transcript가
  300KB를 넘을 때마다 gap 수가 움직이므로 **수치의 권위는 문서가 아니라
  `./run.sh estimate:sessions`**다. 재인덱싱은 GLG 게이트 앞에 정지 상태로 남는다.

### 문서 / 조사
- openclaw `v2026.6.33` retrieval 이식 조사 + Hermes memory survey (COMPARISON §11–12).
  이식 대상 없음을 근거와 함께 확정.
- 가든의 controlled English tag vocabulary(~1,243) 기록 — org 태그 수프가 md에
  닿지 않는 이유.
- `andenken-embed` 유지보수 스킬(status → sync → verify → compact → oracle push),
  compact 4코어 pin.
- 은퇴한 Gemini 임베딩 스위트 제거.

## v2026.6.19 — 강화된 규약: 세션 코퍼스 정밀화 + openclaw 6.8 정렬

andenken의 첫 CalVer 스냅샷. 이 태그까지 sessions / md(public garden) / org
세 기억축과 doctor·golden·manifest 운영 인프라가 자리잡았다. 이번 창의 닫힌 작업:

### Sessions
- 세션 임베딩 코퍼스를 "핵심만"으로 정밀화. 가드 3종(`session-indexer.ts`):
  - tmp/probe/release-gate 디렉토리 제외(양 런타임, `isExcludedProjectDir`).
  - 300KB 미만 제외(`MIN_SESSION_SIZE_BYTES` 2048 → 300×1024, `size > MIN`).
  - pi 구형 파일명 제외 — pre-0.9.0 `_<uuid>`/`_entwurf-`/`_delegate-` 폐기,
    garden-native `_YYYYMMDDTHHMMSS-<hex6>` 만 인덱싱(`isGardenNativePiFile`,
    pi-shell-acp SSOT `SESSION_ID_RE`에 anchoring). claude는 UUID라 tmp+size만.
  - 실측 코퍼스: pi 1041→94, claude 786→282. GPT-5.5 분신 공동검토 반영
    (regex anchoring, `> MIN` 정확화, tmp 주석 범위 정정).
  - OpenRouter Qwen3-Embedding-8B 4096d full rebuild로 cutover.
- delegate golden query 제거(구형 `_delegate-` + <300KB라 새 코퍼스에서 탈락).
- pi-shell-acp 0.9.0 garden-native identity 정렬 흡수(entwurf 파일명 종 폐기 →
  헤더 id + session-name 태그로 이동).

### OpenClaw 동기화
- openclaw baseline `v2026.6.1` → `v2026.6.8` 재정비 + 기억축 재검수. memory-host-sdk
  md 청킹/임베딩 로직 무변경(주석 스위프), sqlite-vec robustness 하드닝, active-memory
  검색 API 계약 무변경 확인 → andenken 비이식. COMPARISON.md 재정렬 불요.

### Watching (parked)
- OKF(Open Knowledge Format) 관찰 항목 등록 — 따라가지 않되 export target 후보로
  유연성 확보. durable Denote ID가 OKF 경로기반 ID보다 우위.
- pi-shell-acp 1.0.0 session ontology 2차 정렬 대기.
