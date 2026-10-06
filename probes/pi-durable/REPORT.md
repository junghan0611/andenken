# andenken → agent-config: `pi-durable` 세션 source 준비 보고

Author: claude-opus-5-5 (Claude Code, andenken 담당자, garden 20261006T102129-a7ad17, oracle, 2026-10-06) — not GLG direct; review as a separate viewpoint.

받은 것: 브리핑 `andenken-pi-durable-source-brief.md` sha256 `ea3a3a87…afbf086`(일치 확인), codex 브리핑 sha256 `5052bbd4…f955ac`(일치 확인), agent-config 메일 2통(격리 샘플 경로 / GLG 배치 발언 "코어 durable은 oracle 상주").

근거 표기: **[측정]** 이번 턴에 직접 잰 것 · **[읽음 file:line]** 소스를 읽은 것 · **[상속]** 받은 것, 미확인 · **[제안]** 설계, 사실 아님.

게이트 준수: commit/push 0, 유료 임베딩 0, `sessions.lance` 무변경, sync/global/replicate/authority override 0, live 코디네이터 DB 접속 0(RO 포함), auth/token 0, entwurf/native 코드 수정 0, durable 팀 연락 0. andenken 리포 working tree clean(`git status --short` 0줄) [측정].

Scratch: `/home/junghan/tmp/andenken-pi-durable-probe/` (원본 증거는 cp 후 RO로만 열었다).

---

## 3. RO 측정 결과 (먼저 — 계약이 여기에 기대므로)

### 3.1 합성 DB는 API 0으로 만들 수 있다 — 브리핑 (b) 가능

- [측정] `make-sample.mts`: 고정된 fixture 소스(`cd32f772`+overlay)를 **읽기만** 하며 import, `fauxProvider` + `Harness.open(openNodeSqliteStorage)`. fixture에 `dist/`가 없어 scratch 안의 resolve hook(`dist-to-src.mjs`, realpath로 `dist/*.js`→`src/*.ts`)으로 해결. 네트워크·자격증명 0. 실행: `node --conditions=source --import ./register.mjs make-sample.mts <out>`.
- [측정] 시나리오 9종을 한 DB에: GLG 평문 턴 / tool 왕복 / **entwurf doorbell**(실제 adapter와 같은 requestId·문구) → `entwurf_inbox_read` / **실제 `Subagent` 확장**(coding-agent 소스) / 수동 compaction / fork / handoff reset / provider error→retry / abort.
- [측정] codex 형제 격리 샘플(`…/forensic-sqlite/session.sqlite`, sha256 `eb4b6012…07c7` 일치)은 scratch 사본을 `sqlite3 -readonly`로 열었다: doorbell→inbox_read→`read.` 5행, cwd `/tmp/pi-durable-receive-5dPL8G/project`.

### 3.2 스냅샷 방식 — live(WAL) 상태에서 [측정]

writer를 열어 둔 채(close 전) 측정. live 파일: main **4,096 B** + WAL **3,856,352 B** + shm.

| 방식 | 결과 |
|---|---|
| main 파일만 `cp` | `no such table: entries` — **전손** |
| `file:…?immutable=1` | `no such table: entries` — **전손** |
| `sqlite3 -readonly … ".backup"` | 32 entries 완전. 단 결과물이 WAL 헤더(2/2)를 물려받아, 나중에 RO로 열 때 `-shm`/`-wal`을 새로 만든다 |
| `sqlite3 -readonly … "VACUUM INTO"` | 32 entries 완전. journal=`delete`, 헤더 1/1 → **단일 자기완결 파일**, RO open에 부수 파일 없음 |

- [측정] `VACUUM INTO` 결정성: 같은 소스에서 두 번 → sha256 동일(`9a759991…18ab`). 변화 없는 소스는 같은 바이트.
- [측정] 리더가 읽기 트랜잭션을 쥔 상태에서 writer close: EOF 125.73 → CLOSED 130.80(≈5.07s). native `DEFAULT_BUSY_TIMEOUT_MS = 5_000` [읽음 `durable/src/storage/sqlite/node.ts:17`]. **close는 성공**, 최종 단일 파일(WAL truncate됨). 즉 긴 스냅샷은 native 종료를 최대 5s 늦출 수 있다 → 스냅샷은 짧은 단일 트랜잭션이어야 한다.
- [측정 안 함] 코디네이터 규모(DB 4.0MB + WAL 4.2MB [상속 #13])에서 `VACUUM INTO` 소요 시간. ms~수백 ms로 예상하지만 미측정.

### 3.3 구조 사실 — 브리핑 15개 위에 새로 확인한 것

| # | 사실 | 근거 |
|---|---|---|
| N1 | GLG TUI 입력은 `submit({type:"input", content, whenBusy})` — **requestId 없음** → `submissions.request_id` NULL | [읽음 `coding-agent/…/durable/runtime.ts:259`] + [측정] 합성 DB 사람 턴 8개 전부 NULL |
| N2 | entwurf doorbell은 `pi.user`(role user), requestId `entwurf-doorbell:<garden>:<msgfile>`, 본문 `[entwurf inbox] …` | [읽음 `entwurf/pi-extensions/meta-bridge-pi-durable.ts:598–605,753–761`] + [측정] codex 샘플·합성 DB |
| N3 | 형제 메시지 **본문**은 `entwurf_inbox_read`의 `pi.tool-result`에만 있다 → tool-result 제외로 agent↔agent 본문은 구조적으로 빠진다 | [측정] codex 샘플 e13, 합성 e25 |
| N4 | subagent 프롬프트: 자식 대화(owner=task)의 `pi.user`, requestId `subagent:<taskId>` | [읽음 `coding-agent/…/durable/subagent.ts:46`] + [측정] 합성 e39 |
| N5 | compaction: `pi.compaction`, role user, requestId `compaction:<taskId>`, 본문은 `The conversation history … <summary>…</summary>` 래퍼 | [측정] 합성 e48 |
| N6 | handoff reset: `pi.reset`, role user, **requestId NULL**(write submission) → request_id만으로는 GLG와 구별 불가, **kind로만** 구별된다 | [측정] 합성 e65 / submission 66 |
| N7 | `submissions.record`에 `entry`(놓인 entry)와 `answer`(최종 assistant entry)가 있다 | [측정] 합성·codex 샘플 |
| N8 | `submissions.request_id`와 `documents.kind`는 **JSON 인코딩 문자열**로 저장(`'"pi.agent"'`, `'"entwurf-doorbell:…"'`) — 쿼리에서 따옴표 포함 비교 필요 | [측정] |
| N9 | provider error: `stopReason:"error"` 부분 텍스트 행이 남고, 재시도 최종이 별도 행 | [측정] 합성 e72/e73 |
| N10 | 응답 전 abort: assistant 행 없음, submission `unanswered/aborted`. 사용자 행은 남는다 | [측정] 합성 e77 |
| N11 | `pi.agent` 문서는 대화마다 base revision 하나, `cwd` 포함. fork·subagent 대화도 같은 cwd를 복사 | [측정] |
| N12 | faux는 assistant `timestamp`를 응답 생성 시점에 박아 user보다 같거나 이를 수 있다(합성 artifact). codex scripted 샘플은 user < assistant | [측정] — **순서는 `commit_seq`/`id`로, 시각은 `model[0].timestamp`로** |

### 3.4 andenken 현행 코드가 durable에서 깨지는 자리 [읽음]

1. `dedupeByBasename`(`session-indexer.ts:229–245`) — durable 세션은 전부 `session.sqlite` → **모든 durable 세션이 하나로 붕괴**. 세션 디렉토리로 키를 잡아야 한다.
2. `detectSource`(`:408–411`) — `/.claude/` 아니면 `pi` → durable이 `pi`로 오분류.
3. `extractProjectName`(`:369–403`) — durable 경로는 `projects`/`sessions` 분기에 안 걸려 `basename(dirname)` = `<ms>-<uuid>`가 project가 된다.
4. `corpus-manifest.sh` `walk()`(`:56–66`) — `*.jsonl`만 센다 → durable 스냅샷은 MANIFEST에 안 잡힌다.
5. `gather-corpus.sh`(`:102–116,166–167`) — live 파일을 rsync → durable엔 쓰면 안 된다(3.2).
6. `indexer.ts` stale 경로(`:188–206`, `:600–606`) — mtime/size 변화 → 파일 전체 삭제 후 재임베딩. 몇 달 사는 코디네이터 DB를 sync마다 통째로 다시 임베딩하게 된다.
7. `replicate-corpus.sh` — `rsync -a "$CORPUS/"`, `--update` 없음 → 제자리 교체되는 파일은 **더 오래된 사본이 replica의 더 새 사본을 덮을 수 있다**. JSONL에도 같은 모양이 있으나, durable을 oracle에서 따로 스냅샷하면 실제로 발생한다 [읽음 + 도출, 미측정].
8. `normalizeSourceFilter`/`parseSourceArg`(`:52–71`), `SessionSource` 타입 — `pi | claude`만. store의 `source`는 문자열 컬럼(`store.ts:35`)이라 **lance 스키마 변경은 불필요**.
9. `MIN_SESSION_SIZE_BYTES` 200KB 바닥(`:90`) — SQLite 바이트 크기는 대화량의 척도가 아니다(WAL·free page).

### 3.5 프로토타입 추출기 [측정]

`extract-durable.py`(stdlib, `mode=ro`, 닫힌 스냅샷만) — 아래 계약을 그대로 구현.

합성 스냅샷(`corpus-sim/oracle/.pi/agent/experimental/durable-sessions/<bucket>/<dir>/session.sqlite`, VACUUM INTO):

- project `entwurf`, `bucketMatchesCwd: true`, 대화 3, maxEntryId 77, **emit 18**
- census: `user:human 8` · `assistant:to-human 8` · `compaction 1` · `reset:handoff 1` → emit / `user:harness-doorbell 1` · `user:agent-brief 1` · `assistant:to-agent 1`(subagent 답) · `assistant:error 1` · `assistant:no-text 3` · `drop:pi.tool-result 3` · `drop:pi.system 4` → drop
- GLG 발화 8/8 입장, doorbell·subagent 브리프·subagent 답·error 부분응답 0 입장, fork의 GLG-7F는 **한 번만**(상속 중복 0), compaction 래퍼 제거됨.
- `--watermark 54` → emit 8, 전부 id > 54. 증분 커서가 그대로 선다.
- codex 샘플: emit 0(doorbell + 사람 없음 → `assistant:to-None`), cwd가 `/tmp/…` → project `tmp-…` → 기존 tmp 제외 규칙에 그대로 걸린다.

---

## 1. `pi-durable` source 계약 초안 [제안]

| 항목 | 초안 |
|---|---|
| **discovery** | `<root>/.pi/agent/experimental/durable-sessions/<[0-9a-f]{24}>/<\d{13}-UUIDv4>/session.sqlite`, 전체 앵커. `<dir>.lock`, `-wal`, `-shm`는 admit·복사 대상 아님. live root와 corpus root(`<corpus>/<device>/…`) 같은 문법 |
| **admission** | 경로 문법 + `durable_schema.version ≤ 1`(초과는 이름 붙여 refuse) + root `pi.agent.cwd` 존재 + cwd에서 만든 디렉토리명에 기존 tmp 규칙. **바이트 바닥 없음**(사람 발화 0이면 어차피 emit 0). root는 있는데 0개 admit → doctor WARN |
| **스냅샷** | DB를 가진 호스트에서, RO 연결로 `VACUUM INTO <staging>` 한 번(짧은 단일 read txn). `immutable=1`·main만 cp·DB/WAL 따로 rsync·`Harness.open`·lock 조작 금지. live/closed 구분 없이 같은 경로(닫힌 세션도 VACUUM INTO가 안전하고 결정적) |
| **어느 호스트가 언제** | 원격 peer는 `corpus-admit.py`처럼 **stdlib 스크립트를 ssh로 파이프**해 그 호스트에서 스냅샷을 만들고, 닫힌 파일만 운반. 기본 = authority의 gather Step 0(`--global`일 때 oracle 포함). oracle 독자 타이머는 두지 않는다(아래 Q2·3.4-7) |
| **corpus 형태** | 원본 경로 모양 그대로(`<corpus>/<device>/.pi/agent/experimental/durable-sessions/…/session.sqlite`)에 **원본 스냅샷**(파생 형식 아님). 같은 경로를 더 새 스냅샷으로 **조건부 교체**: `quick_check` ok + 지원 스키마 + 옛 사본의 entry id 전부 포함. 실패 시 옛 사본 유지·보고. `durable_metadata.next_seq` 같으면 교체 안 함(mtime·manifest 정지) |
| **manifest 영향** | `MANIFEST.json`/`.sha256`이 durable `session.sqlite`도 포함해야 한다(현재 `*.jsonl`만). sha는 교체 때마다 바뀌는 게 정상(성장하는 JSONL과 같은 의미). `session-manifest.json` 항목에 `watermark`(임베딩된 max entry id)와 `nextSeq` 추가 |
| **chunk identity** | `<corpus path>:e<entryId>[#part]`, `lineNumber` = entryId. metadata: `type`(분류), `entryId`, `conversationId`, `commitSeq`, `byTaskId?` |
| **kind→role** | `pi.user`+request_id NULL+기동 브리프 아님 → `user` · `pi.user`+`entwurf-doorbell:` → drop(수신자 불변) · `pi.user`+`subagent:` 또는 기동 브리프 → drop(수신자=agent) · `pi.user`+미지 prefix → drop+집계(수신자=unknown, fail closed) · `pi.assistant` text만, stop∈{stop,length,toolUse}, 수신자=human → `assistant` · stop∈{error,aborted} → drop · `pi.compaction` → `compaction`(래퍼 제거) · `pi.reset`+handoff → `compaction`(metadata `type=reset:handoff`) · `pi.tool-result`/`pi.system`/미지 kind → drop. role enum 3종 유지(소비자 영향 0). 길이·noise 필터는 기존 그대로(user >20, assistant >100) |
| **수신자 규칙** | RAIL 5 규칙을 대화(conversation)별 상태로: task-owned 자식은 `agent`로 시작, fork는 부모의 `at` 시점 상태 상속(현 프로토타입은 단순화 — 구현 시 보완) |
| **시계** | 저장 timestamp = `model[0].timestamp`(UTC ISO, KST 변환은 소비자). 순서 = `commit_seq`. `documents.created_at`은 시각 아님. 세션 생성 시각 = 디렉토리 prefix ms |
| **watermark** | 파일별 max 임베딩 entry id. 증분 = 스냅샷 전체를 파싱(수신자 상태 재구성은 싸다)하되 **id > watermark만 임베딩**, 파일 선삭제 없음. watermark 저장은 WriteBuffer flush 뒤(INVARIANT 6.4/6.5) |
| **provenance** | device = corpus 경로 segment. project = root `pi.agent.cwd`를 `extractProjectName`과 같은 정규화로(`/home/junghan/repos/gh/entwurf` → `entwurf`, pi/claude와 같은 facet 값), bucket 해시로 교차검증(불일치 WARN). meta-record 비의존 |
| **source 값** | `pi-durable`. `--source`: `pi | claude | pi-durable | all`. lance 스키마 무변경 |

---

## 2. AGENTS.md / INVARIANT.md 개정안 (미커밋)

- diff: `/home/junghan/tmp/andenken-pi-durable-probe/andenken-docs-revision.diff` (185줄) — 리포 HEAD `4eccaaa`에 `git apply --check` 통과 [측정], 적용 안 함.
- AGENTS.md: 소스 표에 3행 추가 / "not a third source" 문단을 **"Entwurf never creates a source; a harness storage format does."**로 대체(entwurf-on-pi는 여전히 pi, durable 시민은 코디네이터 포함 평범한 pi-durable 세션 — 코디네이터 계급 없음) / `--source` 유효값에 `pi-durable` / 새 소절 *pi-durable source contract*(위 표의 산문판, 측정 근거 포함) / path contract 문단에 "durable은 경로 계약은 지키되 detectSource·extractProjectName 지름길은 안 쓴다".
- INVARIANT.md: 새 **§7.6 "the snapshot is the copy, the row is the unit"** 7규칙(live 복사 금지·소유 호스트 스냅샷·행 단위 append-only·native 비접촉·kind 분류·물리 행·flush 뒤 watermark) + basename dedupe 경고 / §8 테스트 불변식 12–16 / §9 체크리스트 1줄.
- 일부러 안 건드린 것: NEXT.md(RAIL 순서는 GLG 판정 Q5), ROADMAP History(착지 시 도장), README.

---

## 4. GLG 판정이 필요한 것

### 사실 상자 (측정·읽음 — 판정 불필요, 판정의 재료)

- F1. live durable DB의 main 파일만 복사하면 아무것도 없다. 일관 스냅샷은 DB를 가진 호스트에서 만들어야 한다 [측정 3.2].
- F2. 스냅샷 리더는 native close를 최대 5s 늦출 수 있다(그 이상의 부작용은 관측 안 됨) [측정].
- F3. authority = thinkpad, 코어 durable = oracle 상주·항상 live [상속: GLG 발언 via agent-config]. 따라서 durable 기억이 색인에 닿는 시점 = GLG가 thinkpad에서 `--global`을 치는 시점 [도출].
- F4. GLG 발화 판별의 유일한 구조 신호는 "request_id NULL"이다 [측정 N1/N6]. entwurf가 언젠가 requestId **없이** durable root에 본문을 넣으면(현 문서상 direct body admission은 deferred [읽음 `entwurf/docs/durable-native-support.md`]) 형제 말이 GLG 말로 색인된다.
- F5. `replicate-corpus.sh`는 `--update` 없이 corpus 전체를 민다 [읽음] → oracle에서 독자 스냅샷을 찍으면 되돌림이 생길 수 있다 [도출, 미측정].

### 결정 상자 (제안 — GLG가 채택하거나 달리 정한다)

- **Q1. corpus 형태.** (a) 원본 스냅샷 + 행 단위 조건부 교체 **[권장]** / (b) 스냅샷을 시점별로 누적(용량 증가, 이력 보존) / (c) 파생 entry stream(JSONL 별도 형식)만 보관 — 정규화가 틀리면 원본으로 되돌아갈 길이 없어 비권장.
- **Q2. 스냅샷 시점.** (a) authority gather 때만(`--global`) — 단순, oracle 타이머 0, 대신 신선도는 GLG의 `--global` 박자 **[권장, 당분간]** / (b) oracle 로컬 저비용 타이머(API 0, 색인 없음)로 corpus만 신선하게 — replicate 되돌림(F5)부터 막아야 한다. authority 이전은 제안하지 않는다(GLG 판정 영역).
- **Q3. 형제 보고에 대한 코디네이터의 반응문.** doorbell 뒤 assistant 텍스트는 기존 규칙상 직전 GLG 턴을 수신자로 물려받아 **남는다**(합성 ASSISTANT-3). 코디네이터는 이 텍스트를 대량으로 만들 것이다. 남길지(권장: 남김 — TUI에서 GLG가 읽는 말이고 pi 규칙과 같다) / 뺄지.
- **Q4. entwurf와의 계약 한 줄.** "entwurf가 durable root에 넣는 모든 input은 requestId를 단다" — F4를 계약으로 굳힐지. 굳힌다면 전달 경로는 agent-config/GLG가 정한다(나는 durable 팀에 연락하지 않았다).
- **Q5. RAIL 순서.** andenken NEXT의 현재 레일은 RAIL 5(세션 입장 경계, 수신자 규칙 코드화)다. pi-durable은 같은 수신자 규칙을 쓴다. (a) RAIL 5 코드화를 먼저 끝내고 pi-durable을 그 위에 / (b) pi-durable을 RAIL 5와 함께 한 규칙 모듈로 **[권장 — 규칙이 두 벌이 되는 걸 막는다]**.
- **Q6. 첫 live 측정 승인.** oracle에서 코디네이터 DB에 RO 연결 1회 → `VACUUM INTO` 스냅샷 → `extract-durable.py` census(API 0). 접촉면: live DB의 `-shm` 매핑/read mark, 최대 5s close 지연 가능성. 얻는 것: 실제 GLG 발화 수·doorbell 수·subagent 수·미지 prefix 유무·예상 임베딩 문자량 → 유료 게이트 크기. 승인 전엔 하지 않는다.
- **Q7. 경로 안정성.** `experimental/durable-sessions`가 upstream에서 졸업·이동할지 모른다 [상속 — codex 형제 "조사 안 됨"]. 경로를 하드코딩하되 0-admit WARN으로 드리프트를 시끄럽게 할지(권장), 설정값으로 뺄지.

---

## 산출물 목록 (scratch, 미커밋)

| 파일 | 역할 |
|---|---|
| `make-sample.mts` + `register.mjs` + `dist-to-src.mjs` | API 0 합성 DB 생성기(fixture 읽기 전용) |
| `extract-durable.py` | 계약 프로토타입 추출기(RO, 닫힌 스냅샷만) |
| `q-entries.sql` | entry+submission 조인 RO 쿼리 |
| `corpus-sim/…/session.sqlite` | corpus 모양 VACUUM INTO 스냅샷(합성) |
| `snap/` | 스냅샷 방식 비교 산출물 |
| `codex-sample/session.sqlite` | 격리 샘플 사본(원본 불변) |
| `andenken-docs-revision.diff` | AGENTS/INVARIANT 개정 diff |
