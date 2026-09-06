# NEXT — andenken

> `AGENTS.md`는 상시 기준선, 여기는 다음 한 걸음. 닫힌 이력은 커밋과 이슈에 있다.

# RAIL — 현재 좌표

- [x] **1. 세션 코퍼스 통합** — 평생 폴더 + device roster (`v2026.9.3`, #10·#11 닫힘)
- [x] **2. 2면 SSOT 동기화** — thinkpad↔oracle, 인덱스·매니페스트·코퍼스 한 묶음
- [x] **3. OpenClaw 면 회수** ([#13](https://github.com/junghan0611/andenken/issues/13)) — 4,737 chunks / API 0 / 교차검수 + 방향 재점검 통과, `0fbc92a`…`3143d07` push 완료
- [ ] **4. 근본 정리** ← CURRENT: 위 §근본 1·2·3 — 오늘 정정 16건이 가리킨 자리
- [ ] **5. 회수 품질** ([#12](https://github.com/junghan0611/andenken/issues/12)) ← PAUSED: 골든 세션 분기 추출이 선행(백로그 4번)

현재 좌표: 3 완료 → 4 진행(§sorge#1 반환분 닫힘, MD 축 freshness 남음) → 5 보류

# NOW — 근본 정리 (오늘 정정 16건이 가리킨 자리)

- **Current**: tier 4는 섰고 **전부 push 됐다**(09-04 harvest 넷 + 09-06 `1e61698`).
  남은 것은 기능이 아니라 **09-03의 16건이 드러낸 세 자리**다 — 아래 §근본 1·2·3.
  그리고 sorge#1이 남긴 **MD 축 freshness** 한 자리(아래 §sorge#1 반환).
- **Next**: (1) §근본 1의 한 줄을 `AGENTS.md`에 넣을지 GLG 판정 → (2) §근본 2의
  문서↔`--help` 대조 테스트 → (3) §근본 3으로 `doctor`의 0 신호 훑기 →
  (4) MD 축 `export → 재색인` 순서와 `state:"stale"`.
- **Blocker**: (1)만 GLG 판정. (2)(3)(4)는 판정 없이 시작 가능.  09-04에 `run.sh` 도움말이
  또 코드 뒤에 남아 있었으므로 (2)의 근거는 하나 더 늘었다.
- **Read**: 아래 §근본 절. 그리고 [#13](https://github.com/junghan0611/andenken/issues/13)
  코멘트 5개 — 특히 마지막 둘(구현 결과·교차검수). 본문과 스레드가 어긋나면 스레드가 이긴다.
- **Do not touch**: tier 4의 append-only(§7.3 규칙 1). path 단위 대체로 옛 판 누적을
  흉내내면 `.deleted.` 행까지 지우는 길이 열린다 — 그건 GLG 정책 항목이지 최적화가 아니다.

## ✅ 커밋 전에 고칠 것 — 넷 다 수리됨 (2026-09-04)

어제 형제가 잡은 둘에 더해, 오늘 방향 재점검에서 **동작 버그 하나**, GLG의 경계
질문에서 **권한 한 자리**가 더 나왔다. 넷 다 고쳤고 각각 실측 영수증이 있다.

1. **[버그] `search-openclaw`가 `--limit 10`에 1건만 돌려줬다.** `minScore`는
   **머지 스케일 위에서 읽히는 수**인데, rrf 점수는 `weight/(60+rank+1)`+상위보너스라
   천장이 약 0.066이고 2위가 ~0.031이다. 거기에 md 트랙의 **weighted 스케일 0.05**를
   붙여놨으니 1위 말고는 전부 바닥에 걸려 잘렸다. sessions 축(같은 rrf)은 0.001을 쓴다.
   → `minScore: 0.001`. **실측: `"가족 건강" --limit 10` 1건 → 10건**, agent도
   main 하나에서 main·glg·bbot·gpt로, source도 memory/sessions 양쪽으로 벌어졌다.
   *두 트랙에서 파라미터를 반씩 베껴 오면 각각은 정본인데 합이 틀린다 — C형의 변종.*

2. **[①] `>=` 경계 비용을 "한 행"이라 적은 주석.** 경계는 그 밀리초 버킷 전체다.
   **실측(2026-09-04, 스테이징 덤프): 312행 전부가 자기 agent의 워터마크 ms에 정확히
   얹혀 있었고 그 위에 있는 행은 0이었다** — gpt 228 · main 78 · glg 3 · bbot/gemini/mini 각 1.
   → 주석을 사실로 고쳤다(`export-openclaw.sh`, `openclaw-import.test.ts`).
   **덤으로 09-03에 열어둔 해석이 닫혔다**: 델타 312는 "gpt/main이 재인덱스를 돌았다"가
   아니라 경계 그 자체였다. 새 행은 한 톨도 없었다.

3. **[②] 워터마크가 host별이 아니었다.** 주석은 per host+agent를 약속하는데 키는 agent뿐.
   → 제3안 채택: 워터마크 파일에 `_host`를 기록하고 **양쪽 끝에서 거절**한다 — export는
   ssh 왕복 전에(`exit 2`, 실측 확인), importer는 커서를 쓰는 쪽이라 직접 호출도 막힌다.
   포맷을 안 깼고 커서 리셋도 없다. `--full`이 새 host로 가는 정식 통로.
   `_host` 없는 옛 파일은 **거절이 아니라 승계**된다(모순만 거절, 침묵은 아니다).
   테스트 9건 추가(`test:openclaw` 25 → 34).

4. **[경계] 그쪽 DB를 read-write로 열고 있었다.** GLG가 "compact은 우리 일이 아니지
   않나"를 물어 경계를 다시 그으면서 나왔다. `compact openclaw`는 **우리 것이 맞다** —
   `openclaw.lance`는 우리 스키마·우리 id·우리 FTS이고, 파편은 importer의 200행 배치
   쓰기가 낸다(**실측: 481행 import에 frags 1 → 4**, compact 후 7 → 1 / 96M → 82M).
   그쪽 sqlite는 그동안 읽히기만 했다.
   그런데 그 "읽기만"이 **주장이었지 강제가 아니었다**: `sqlite3 "$db" "VACUUM INTO"`는
   기본이 read-write라 살아있는 WAL DB를 체크포인트할 권한을 갖는다.
   → `sqlite3 -readonly`. **실측: oracle에서 mini DB에 동일한 49M 스냅샷 생성**,
   넓은 권한으로 사는 게 없다. 경계를 주석이 아니라 커널이 잡게 했다.
   `indexer.ts`에서 우리 파편화를 "OpenClaw rebake" 탓으로 돌린 주석도 함께 정정.

부수 수리: `run.sh` 도움말에 `search:openclaw`와 `compact ... openclaw`가 빠져 있었다
(케이스는 있는데 메뉴에 없으면 오퍼레이터에겐 없는 것 — AGENTS.md). `status`의 워터마크
출력이 `_host`를 일곱 번째 봇으로 오해하지 않도록 필터. `cli.ts`의 중복 import 정리.

검증: `sync:openclaw` 두 번 실행(두 번째는 `-readonly`로) — 481 / 449행 import,
API 0, 4,651 → 4,737 chunks(두 번째 449행은 전부 자기 자리 교체, 총계 불변),
`_host: oracle` 기록됨. `export --host not-oracle` → `exit 2`, ssh 안 함.
`compact openclaw` → 7 frags/96M → 1 frag/82M.
테스트 197·132·77·76·34·25·19·14·13·all — 0 failed.

## tier 4 잔여 (기능, #13 열린 항목)

- [ ] pi extension `openclaw_search` — 없으면 pi 형제는 이 축을 영영 못 본다.
      CLI만 나누면 GLG의 "축을 나눠라"가 절반만 지켜진다
- [x] ~~`verify openclaw`~~ — **09-06 닫힘.** 대상으로 추가했고, 더 나쁜 자리를 하나
      찾았다: 모르는 대상은 **조용히 org로 떨어졌다.** `verify openclaw`가 org의
      44,916행과 orphan 373건을 openclaw 이름으로 찍고 있었다 — C-b와 같은 모양의
      "읽기 명령이 딴 축을 자신 있게 답하는" 고장. 이제 거절한다(exit 1).
      openclaw의 orphan 검사는 건너뛴다 — `sessionFile`이 harvest 호스트의 경로이고
      OpenClaw가 이미 지운 전사의 경로도 섞여 있다(append-only의 의도). 실측:
      4,737 unique · 261 source paths · 1 frag/82M · all passed
- [ ] 재군음 사건당 전량 재전송 — 정확도는 지금이 최선(`updated_at` ⊃ id-diff ⊃ hash).
      2단계(원격 id manifest 후 로컬 diff)는 키가 id여야 하고 **provider 변경 실명을
      GLG가 승인**해야 한다
- [ ] 편집된 파일의 옛 판 누적 — append-only의 의도된 귀결. **오늘 누적 0이라 아직
      관측된 적 없는 비용이다.** 다음 편집 사건 뒤에 재고 정한다
- [x] ~~경계 재반입이 매 런 파편을 늘린다~~ — **09-04 오후 닫힘.** 아래 §경계 참조
- [ ] **드롭된 행은 워터마크를 못 밀어준다** (09-04 관측, 아직 무해). `mergeWatermark`는
      import된 행에만 걸리므로, 어느 agent의 최신 행이 boilerplate 드롭이면 그 agent는
      매 런 그 아래부터 다시 끌어온다. **09-04 덤프에서는 드롭 0이라 실제로 발생한 적이
      없다.** 커서 의미를 "받아들인 행"에서 "처리한 행"으로 바꾸는 문제라, 관측되기
      전에 고치면 관측에서 규칙을 발명하는 B형이 된다 — 발생하면 그때 잰다

## 경계 재반입 — 묻는 건 그대로, 쓰기만 끊었다 (2026-09-04 오후)

`>=` 경계는 **없앨 수 없다**. 워터마크와 같은 ms에, 우리 스냅샷 **이후** 커밋된 행이
있을 수 있고 `>`면 그건 영영 안 보인다. (단 그런 행을 실제로 관측한 적은 없다 —
설계 근거이지 측정된 사건이 아니다.)

그래서 질의는 그대로 두고 **저장 층에서** 끊었다. `partitionByChange`가 (id, updated_at)로
"이미 같은 걸 들고 있나"를 묻고, 같으면 안 쓴다. id에 source·path·행 범위·chunk hash·
model이 이미 들어 있으므로 같은 id·같은 stamp면 같은 행이다. stamp가 움직인 경우
— 같은 model 문자열에 provider/embedding 버전만 바뀐, **시간 커서만 볼 수 있는 그 경우** —
는 그대로 쓴다. 판단은 순수 함수라 DB 없이 시험한다(4건 추가, 34 → 38).

측정 (2026-09-04):

| | 전 | 후 |
|---|---|---|
| export가 가져오는 행 | 449 (9.0MB) | 449 (9.0MB) — **그대로** |
| DB에 쓰는 행 | 449 | **0** |
| 실행당 파편 증가 | +3 | **0** |

경계 크기가 어제 312 → 오늘 449로 하루 만에 늘었고(gpt 버킷 266), 나와 소넷이 14분
간격으로 독립 실행해 **같은 449를 두 번** 받았다 — 워터마크는 한 바이트도 안 움직였다.
전송 비용은 남아 있다(9MB/런). 그건 openclaw가 주는 대로 받는다는 정책의 값이고,
우리가 관리하는 건 우리 저장소 쪽이다.

## harvest는 authority 전용 — 이제 코드가 막는다 (2026-09-04, 오라클 pull 직후 발견)

오라클에 코드를 올린 순간 생긴 자리다. `INDEX_AUTHORITY` 검사는 `sync-sessions.sh`에만
있었고(`:186` 인덱싱 진입, `:242` push) **harvest에는 없었다.** `ANDENKEN_OPENCLAW_HOST`
기본값이 `oracle`이라, 오라클에서 `sync:openclaw`를 치면 **자기 자신에게 ssh해서 성사된다.**

§7.1보다 더 나쁜 자리다: 세션은 갈라져도 다음 canonical push가 덮지만, `openclaw.lance`는
publish 단계가 없어서 **되돌릴 rsync가 아예 없다.**

게이트를 `export-openclaw.sh` 맨 앞에 뒀다 — sessions는 gather라는 자기 몫이 있어서
게이트가 Step 0 뒤지만, harvest는 모든 행이 ssh로 오므로 거절이 **연결조차 안 하는** 게
맞다. 실측: `ANDENKEN_INDEX_AUTHORITY=somewhere-else`로 거절 확인(exit 1, ssh 0),
thinkpad에서는 정상 통과(449 exported / 0 written).

전략(GLG, 09-04): 노트북이 오라클 것까지 가져와서 인덱싱하고 넣어준다. openclaw 세션도
같은 방식. 오라클은 질의 레플리카.

## sorge#1 반환 — read 경로가 write 한다 (2026-09-06, C-b + B층 판정)

`sorge`가 세 집에 나눠 돌린 이슈의 andenken 몫. **두 가지를 receipt로 되돌리고**
근본 불변식을 닫았다. 상세는 [INVARIANT §7.4 / §7.5](./INVARIANT.md).

- **되돌림 1 — B층은 pending이 아니라 접혀 있었다.** 이슈 C-3은 색인 mtime 12:04 <
  staging mtime 12:13만 보고 449행이 미반영이라 읽었다. `--dry-run` 실측:
  **0 written / 449 already held with the same stamp.** 449는 경계 재fetch이고,
  아무것도 안 쓰는 게 이 importer의 정답이라 파편 mtime이 뒤에 남는 게 정상이다.
  → **mtime을 증거로 쓰지 않게 만들었다**: `openclaw-staging/last-import.json`이
  자기 결과를 읽은 아티팩트의 mtime에 묶어 기록하고, `status`가 folded/PENDING을
  그 키로 답한다. 449는 09-06에 실제로 접어 receipt를 남겼다(파편 mtime 12:04 불변).
- **되돌림 2 — C-b는 openclaw 전용이 아니었다. sessions가 더 크다.** 빈
  `ANDENKEN_DATA` 실측: `search-openclaw`도 `search`도 lance를 **만들고** `count:0`
  exit 0. md만 게이트가 있었다(`cli.ts:447`). pi 확장은 `session_start` hover에서도
  만들고 있었다 — 보고하는 행위가 대상을 존재하게 했다.
  → `VectorStore`에 opt-in `readOnly`. mkdir·connect 앞에서 거절하고
  `AxisAbsentError`를 던진다. 4축 공유라 `doInitialize()`를 통째로 막지 않았고,
  인덱서는 그대로 쓴다(테스트가 그 자리를 지킨다).
- **계약**: `agent-config` wrapper(`ad347ef`)와 같은 JSON·같은 **exit 4**.
  wrapper는 이제 빠른 길이지 유일한 문이 아니다. `state`는 축을 불문하고 한 값이다 —
  `absent`/`not-indexed` 분리를 잠깐 넣었다가 `agent-config` 논거로 뺐다: 그 차이는
  축의 성질이 아니라 **(축, 호스트) 쌍의 성질**이고(thinkpad에 md 없음=빌드해라,
  oracle에 md 없음=복제가 안 왔다), 축에 박으면 레플리카에 authority의 답을 줘서
  이 이슈가 시작된 자리로 돌아간다. 판별자는 이미 payload의 `host === authority`이고,
  `state` 자리는 완료조건 4번의 `"stale"`이 쓴다. 갈래는 `reason`/`next` 산문이 든다.
- 부수: `status`의 워터마크가 **UTC를 라벨 없이** 찍고 있었다(KST와 9시간). KST 표기로
  고쳤다 — `SKILL.md`의 "this machine"이 공간에서 낸 것과 같은 고장이 시간에서 난 것.
  `openclaw-importer.ts`는 tsconfig `include`에 없어 **한 번도 타입체크된 적이 없었고**,
  넣자마자 실제 타입 오류가 하나 나왔다(`batch`가 store 파라미터 타입을 빌려 써서
  `partitionByChange`와 어긋남). `md-search.ts`도 같이 넣었다.
- 새 테스트: `./run.sh test:absent` (API 0, 25건). 이 고장은 **조용해서** 라이브 런으로는
  구분이 안 된다 — fixture만이 잡는다(INVARIANT §8).
- **커밋 `1e61698` · push 완료** (2026-09-06 15:40 KST, 어젠다 도장). 10파일 +673/−44.

**이슈 쪽 귀결 (sorge 인계, 2026-09-06):** 이 커밋이 완료조건 **1·2b**를 닫았고, 그것이
9번(`agent-config` wrapper 은퇴)의 조건①이었다. oracle receipt(`55ef65d`)로 조건②까지 서서
**7번도 닫혔다** — 오라클에서 wrapper·raw CLI·컨테이너 세 경로 전부 exit 4, **§1의
`os error 30` 소멸**, 그리고 **세 경로로 읽었는데도 잔여물이 안 생겼다**(게이트가 실제
호스트에서 섰다는 receipt). 6번은 「캐시 정리」에서 **「기억축 복구」로 승급**해 oracle /
`nixos-config` 로 갔다 — semantic search latency 가 embedding 바이트에 선형(≈0.5초/MB)이라
glg 가 85.4초, 봇 도구의 15초 게이트를 통과하는 건 mini 하나뿐이다. **우리 축 아니다.**

**남은 내 몫 둘:**

- [ ] **4번 MD 축 freshness** — `export → 재색인` 순서(§2, 18:43 index vs 19:17 export).
      openclaw 축은 import receipt 로 닫혔지만 **MD 는 다른 수선**이다. `state` 에 `"stale"`
      자리를 비워 뒀다(INVARIANT §7.4 규칙 2).
- [ ] **`verify openclaw` 계열을 문서에 남기기** — 축이 없을 때 **다른 축의 답을 내는**
      모양은 오늘 없앤 `count:0 exit 0` 과 같은 계열이다. ROADMAP 의 유지보수 절에 한 줄.

# RECENT

09-02~09-03에 닫힌 것(코퍼스·sync 두 모드·스킬 문서·#10/#11)은 `v2026.9.3`과
`v2026.9.4`의 [CHANGELOG.md](./CHANGELOG.md)로 옮겼다. 여기는 다음 한 걸음만 둔다.

- **[2026-09-04] 문서면 다섯 장을 같은 날 다 옮겼다** (`v2026.9.4`, `v2026.9.4-docs.1`).
  09-03의 교훈이 "정본이 움직일 때 사본이 조용히 뒤에 남는다"였으므로, 사본을
  하나씩이 아니라 **한 번에** 옮겼다 — README·AGENTS·ROADMAP·COMPARISON·INVARIANT.
  decay가 다섯 장 중 네 장에서 기능처럼 적혀 있었고(실제로는 두 라이브 트랙 모두
  `recencyHalfLifeDays: 0`), `--push`는 세 장에 남아 있었다.
  INVARIANT에 §7.2(최근성은 정렬이지 곱셈이 아니다)를 신설하고 §7.1을
  authority 게이트로, §6.6을 코퍼스까지 확장했다. 담당자 문서
  [`20260319T110800`](https://notes.junghanacs.com/botlog/20260319T110800.html)를
  README 상단과 AGENTS.md 신원절에 Denote ID로 박았다.

- **[2026-09-03] tier 4(OpenClaw 회수)가 섰다.** 봇들이 이미 `qwen/qwen3-embedding-8b`
  4096d로 구워둔 벡터를 재임베딩 없이 가져온다 — 4,651 chunks / 80MB / **임베딩 API 0 calls**.
  `sync:openclaw`(export+import) · `search:openclaw` · `compact openclaw` · `status`에 축 추가.
  append-only이고 `openclaw.lance`는 **로컬 전용**(push 단계 없음, INVARIANT §7.3).
  검색은 절대 폴백이 아니다 — 축을 못 대는 답은 사람의 회상이 아니라 시스템의 회상이다.

# 근본 — 오늘 정정 16건이 세 종류였다 (2026-09-03)

형제 넷과 GLG가 하루에 16건을 정정했다. 개수가 아니라 **분포**가 문제다.

| 종류 | 건수 | 뿌리 | 누가 잡았나 |
|---|---|---|---|
| **A. 관측을 사실/규칙으로 승격** | **9** | 본 것을 있는 것으로 착각 | **전부 남이** |
| C. 사본이 정본 뒤에 남음 | 4 | 진실이 두 곳에 | 절반은 스스로 |
| D. 경계·실패 경로 미고려 | 3 | happy path | 절반은 스스로 |

A의 사례가 전부 같은 모양이다 — 데이터에 6봇이 보임 → "여섯 봇이다"(호스트엔 7,
`claude`는 행이 0이라 데이터에 안 나타났다) · 9/1~9/3 밀집이 보임 → "주기적 재군음"
(소스는 사건성이라 말한다) · 가족 대화가 보임 → "벽이 필요하다"(아무도 요청 안 함)
· 4,651+312이 보임 → "4,963"(안 셈).

**A는 교차검수 아니면 안 잡힌다.** 내가 본 것을 나는 다시 봐도 같게 본다. 9건 전부
남이 잡았고, 내가 스스로 잡은 것은 C·D 계열뿐이다.

**다만 "관측하지 말자"가 처방이 아니다.** 교차검수자(zai/glm-5.3)가 정확히 짚었다 —
워터마크 문제는 내가 준 의심 목록에 없었고, 거기로 들어간 입구가 **내 덤프 측정**이었다.
소스에서 답을 얻은 뒤 다시 덤프로 확인했다. 그의 문장:

> **관측은 입구고 소스가 출구다.** 입구와 출구를 둘 다 열어둔 탓에 여섯 번째는
> 잡힌 게 아니라 처음부터 안 났다.

그러니 결함은 관측이 아니라 **입구에서 멈추는 것**이다. 관측이 질문을 열고, 정본이
그 질문을 닫는다. 관측이 질문을 닫게 두지 않는다.

## 근본 1 — 관측 수치에 출처를 붙인다 (A를 막는 유일한 값싼 수)

구조가 아니라 한 줄 규율이다. **관측한 수·범위·목록을 문서나 코드 주석에 쓸 때,
그 관측이 무엇을 보고 나왔는지 함께 쓴다.**

- ❌ "여섯 봇" → ✅ "그날 데이터에 나타난 여섯 (호스트 디렉토리는 일곱)"
- 그러면 다음 사람이 *"데이터에 안 나타난 건 없나?"* 를 묻게 된다.

`scripts/export-openclaw.sh`의 `HOW MANY AGENTS` 주석이 그 모양이다. **AGENTS.md에
넣을지는 GLG 판정 대기** — 리포 규칙으로 박는 것이 맞아 보인다.

## 근본 2 — 사본을 구조로 묶는다 (C)

`credential-parity.test.ts`가 사본 하나를 **규율이 아니라 기계로** 묶었다: 두 소스에서
패턴 몸통을 추출해 바이트 동일성을 검사하므로, 한쪽만 고치는 순간 실패한다. 이 패턴을
남은 사본에 일반화한다.

- `golden-queries.ts`의 세션 분기 (아래 백로그 4번) — 아직 인라인 복제
- **문서가 인용하는 코드 사실** — `andenken-embed`/`memory-sync` 문서가 `--help` 표를
  인용하는데 검증이 없다. 09-03 테스터가 P1/P2로 정확히 그 자리를 밟았다.
  후보: 문서에 박힌 표를 `--help` 출력과 대조하는 테스트.

## 근본 3 — "0이 정상인지 확인 불가인지"를 가른다 (D)

F2가 그 모양이었다 — 6봇 전원 실패가 `✅ nothing new`와 같은 출력이었다. 크레덴셜
0건도 같았다(고장 난 검출기와 깨끗한 코퍼스가 구별 불가). 둘 다 닫았지만 **같은 모양이
어디 또 있는지는 안 봤다.**

후보: `doctor`가 각 신호에 대해 *"이 0은 측정된 0인가, 측정 못 한 0인가"* 를 구분.
sessions/md 쪽 `to_index=0`, `orphan=0`, `dup=0`이 각각 어느 쪽인지 훑어야 한다.

# 백로그 — 굽고 나서 남은 것

순서는 위험한 것부터. 4번은 RAIL 4(#12)의 선행 조건이다.


인덱스는 살아 있다(75,922 chunks / 4096d / 양쪽 verify ✅). 순서는 위험한 것부터다.

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

## GLG 결정 대기

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

## 이번에 배운 것 — 결함 7건이 전부 같은 모양이었다

한쪽만 정본을 안 따라간다. **전부 그 한쪽만 보면 안 보인다.**

| 결함 | 공유 경로 | 안 쓰던 쪽 |
|---|---|---|
| 이음매 거부 | `run.sh` + `sync-sessions.sh`가 `.env.local` 폴백 | 두 소비자 스킬이 `os.environ`만 |
| 스킬 무조건문 | Step 0 gather가 조건부 | SKILL.md가 단정문 |
| 골든 decay | md 분기의 `searchMdCore` | 세션 분기만 인라인 복제 |
| 좁은 가드 | 인덱싱 경로 | `push_replica()` 안에만 |
| 빈 문자열 해석 | 같은 변수 | 생산자 `-z` vs 소비자 `in os.environ` |
| `--help` 범위 (09-03) | 헤더 코멘트 블록 | `sed -n '2,32p'` 고정 줄번호 — 헤더가 자라 Usage를 잘라먹음 |
| 스킬 아래쪽 절 (09-03) | 상단 usual-ask | 아래 넷이 `--push`를 계속 권함 |

**넷 중 셋은 어제까지 옳았던 코드다.** `os.environ`만 보는 건 env가 바뀌기 전엔
맞았고, 좁은 가드는 리플리카가 인덱싱을 안 하던 동안엔 충분했고, 골든의 `14`는
프로덕션이 14였을 때 정확했다. **사본은 틀리게 태어나는 게 아니라 정본이 움직일 때
조용히 뒤에 남는다.** 다섯째는 정본을 다 안 읽고 사본을 새로 만든 경우인데 결과가
같다. 리뷰는 사본이 쓰인 시점을 보고 결함은 **다른 파일이 바뀐 시점**에 생기므로,
교차검수가 아니면 안 잡힌다.

부수: **리포를 건너가는 줄번호는 하룻밤을 못 넘긴다.** 하루에 셋이 서로의 커밋에
밀렸다. 건너가는 인용은 줄번호가 아니라 **이름과 위치**로 쓴다.

**09-03 오후에 둘이 더 나왔고, 둘 다 같은 과다.** `--help`의 고정 줄번호는 파일
안에서조차 정본을 못 따라간다 — 내가 `--strict` 문단을 넣자마자 Usage가 범위 밖으로
밀렸다. 그래서 범위를 줄번호가 아니라 **코멘트 블록 끝에 앵커**했다. 스킬 아래쪽
절은 상단을 고치고 아래를 안 본 경우다. **일곱 중 다섯을 남이 잡았다** — 형제 둘,
테스터 하나. 저자는 자기가 방금 고친 자리를 보고, 결함은 **고치지 않은 자리**에
남는다. 교차검수가 사치가 아니라 이 결함군의 유일한 검출 수단이다.

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

## 백로그 — derive embedding quality from the canonical time axis

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

> **2026-09-03 주의**: 아래 "포팅 없음" 결론은 **알고리즘을 베껴올 것이 있느냐**에 대한
> 답이고 지금도 유효하다. **OpenClaw 인덱스를 회수하는 것은 별개 사안**이며 [#13](https://github.com/junghan0611/andenken/issues/13)이
> 받았다 — 코드를 가져오는 게 아니라 이미 구운 벡터를 가져온다. 이 절을 근거로
> "openclaw는 볼 것 없다"로 읽지 마라.

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
