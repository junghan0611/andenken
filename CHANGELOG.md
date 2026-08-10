# Changelog

andenken CalVer 스냅샷. 형식 `vYYYY.M.D[-suffix]`. 과거에 *닫힌* 작업을
기록한다(미래 방향은 `NEXT.md` / `ROADMAP.md`). 전체 커밋 타임라인은 `git log`.

## Unreleased

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
