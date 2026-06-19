# Changelog

andenken CalVer 스냅샷. 형식 `vYYYY.M.D[-suffix]`. 과거에 *닫힌* 작업을
기록한다(미래 방향은 `NEXT.md` / `ROADMAP.md`). 전체 커밋 타임라인은 `git log`.

## Unreleased

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
