# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 하려는 다음 한 가지**.
> 끝나면 ROADMAP History에 stamp 박고, 이 파일은 다음 항목으로 덮어씀.

## 다음: 세션메모리 평가 로직을 OpenClaw 수준으로 맞추기

ROADMAP §2 *"OpenClaw에 있고 우리에 없다 / 품질 측정 로직 / 이식 예정"*이 본 항목.
5/8 baseline에서 retrieval 튜닝이 수평 정렬됐으니, **다음은 비교 가능한 평가 도구**다.

### 왜 micro-fix가 아니라 평가인가

평가 도구가 들어와야 interleave ratio / boundary 확장 / 청킹 변경의 이득을 *데이터로* 본다.
평가 없이 튜닝하면 "감"으로 간다. 평가 로직 자체는 OpenClaw가 이미 운영 중이므로 **이식 가능 작업**.

### "OpenClaw 수준"의 분해 — 세 종류

| 종류 | 무엇 | 언제 |
|------|------|------|
| 운영 가시성 | provider/model/dim/source별 분포 한 번에 | 호출 시 |
| sanity 표 | 정해진 query 셋 → top-1 hit 의미 표 | 매 sync 후 자동 |
| bake-off | 같은 query → andenken vs OpenClaw top-3 나란히 | 비교 필요 시 |

andenken에는 이미 `./run.sh golden` (26 합성 query)이 있다. golden은 회귀 가드 (synthetic),
sanity는 운영 hit 안정성 (real), bake-off는 시스템 간 비교. 셋은 보완적이다.

### 3단계 — 단계당 한 commit, 각 끝에 ROADMAP History stamp

**A. `./run.sh status --json`** — 운영 가시성 확장
- 현재: chunks / files / manifest / last indexed
- 추가: provider / model / dimension / source별(sessions vs org) 분포 / FTS index 상태
- 대응: OpenClaw `memory status --deep --json`

**B. `./run.sh sanity`** — 매 sync 후 1차 회귀 가드
- 한국어 5–10 query 고정 셋 → 각 query의 top-1 hit을 표로 출력 (query / source / score / snippet)
- PASS/FAIL 아님. *읽을 만한 표*.
- query 셋은 OpenClaw 5/8 baseline llmlog §sanity search(`안녕/엄마/아빠/임베딩/openclaw/세션을`)를 참고하되 andenken corpus(pi sessions + org KB)에 맞게 재선정.
- `sync-sessions.sh` 끝에 자동 호출.

**C. `./run.sh bakeoff <query>`** — andenken vs OpenClaw 같은 query 비교
- 같은 자연어 query를 OpenClaw 6 agents + andenken sessions + andenken org에 던짐.
- 출력: 각 source의 top-3 결과를 한 표에 나란히 (path, score, snippet).
- 자동 verdict 없음 — 표를 *GLG가 읽고* 판단.
- OpenClaw 호출은 컨테이너 exec(`openclaw memory search`) 또는 SDK 직접 사용. 인증/네트워크 옵션은 작업 시작 시 결정.

### 의도적으로 안 하는 것

- 정량 top-1 precision / top-3 recall — *내* corpus라 정답 셋을 만들 수 없음. 합성 verdict는 무의미.
- 자동 PASS/FAIL — 첫 결과를 *읽을* 권한은 GLG.
- micro-fix (interleave ratio / `[-_.]` boundary / unit tests) — A/B/C가 끝난 *후* 데이터 위에서 본다.

### 시작 조건

GLG 승인 후 **A → B → C** 순서. 각 단계는 read-only 분석으로 시작해서 코드 변경, 끝에 ROADMAP History stamp.

A 한 단계만으로도 운영 즉효 (지금 `./run.sh status`로는 source별 분포가 안 보임).
B까지 가면 매 sync 후 품질 자기-진단이 가능.
C까지 가면 ROADMAP §1/§2/§3 비교표가 *측정*에 의해 뒷받침됨.

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록 (핵심 문서)
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 단축 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
