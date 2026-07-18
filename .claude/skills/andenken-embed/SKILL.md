---
name: andenken-embed
description: "andenken 임베딩 유지보수 워크벤치 — 이 리포 담당자가 매번 하는 status→estimate→sync(sessions+md)→verify→compact→oracle push 흐름을 한 곳에 고정. 세션·가든(md) 인덱스 재임베딩/증분, 무결성 검증, 조각 정리(코어 4개 제한), oracle 복제까지. Triggers: '임베딩 다시 하자', '세션/가든 임베딩', 'reindex', 'sync sessions', 'sync md', 'compact', 'oracle push', 'verify index', 'andenken 인덱스 정리'."
user_invocable: true
---

# andenken-embed — 임베딩 유지보수 워크벤치

andenken 담당자가 반복하는 인덱스 유지보수를 한 흐름으로 고정한다. 매번 명령을
재발견하지 않도록(토큰 절약) + 다른 에이전트/pi가 이 리포에서 바로 이어받도록.

**모든 명령은 리포 루트(`~/repos/gh/andenken`)에서 `./run.sh`로 실행.** run.sh가
`~/.env.local`을 source해 provider/키를 공급하고, provider/dim 안전장치를 건다.

- **세션만 가볍게 라이브 증분**이 필요하면 → 이 스킬 대신 `memory-sync` 스킬.
  이 스킬은 sessions+md 전체 유지보수 + compact + oracle 복제까지 하는 **풀 워크벤치**.
- 검색(search-sessions / search-md)은 이 스킬이 아니라 `semantic-memory`.

## 두 트랙, 한 규율

| 트랙 | provider | dim | 인덱스 | 증분 명령 |
|------|----------|-----|--------|-----------|
| **sessions** | OpenRouter `qwen/qwen3-embedding-8b` | 4096d | `data/sessions.lance` | `./run.sh sync:sessions [--push]` |
| **md (가든)** | 동일 8B | 4096d | `data/md.lance` | `./run.sh sync:md` + `./run.sh sync:md:oracle` |
| org | (768d 불일치) | — | `data/org.lance` | **production disable — 건드리지 않음** |

org은 dim mismatch(provider 768 vs DB 2560/설정)로 서비스 비활성이다. 진단 외
인덱싱/검색 경로는 refuse된다. 유지보수 대상이 아니다.

비용: 유료 remote(OpenRouter, `$0.01/M tokens`). 소액이지만 **0이 아니다**. 증분은
보통 세션 수십·md 수백 파일에 ~$0.01 규모. 풀 rebuild는 별개 게이트(아래).

## 정상 흐름 (증분 재임베딩)

```bash
cd ~/repos/gh/andenken

# 1. 현황 — to-index 규모/last indexed/frag 수 확인
./run.sh status

# 2. (선택) API 0 비용·규모 추정. 실제 호출 없음
./run.sh estimate:sessions      # 증분 대상 세션
./run.sh estimate:md            # 증분 대상 md (payload-hash probe 포함)

# 3. 세션 증분 — dim 4096 preflight 1콜 → to_index=0이면 API0 exit
./run.sh sync:sessions

# 4. 가든(md) 증분
./run.sh sync:md

# 5. 무결성 — dim / 중복 ID / orphan / row 일치
./run.sh verify sessions
./run.sh verify md

# 6. (선택) 조각 정리 — frag 많이 늘었을 때만. CPU 4코어 pin (아래)
./run.sh compact sessions
./run.sh compact md

# 7. (선택) oracle 복제 — GLG 확인 후. DB + manifest 동반 (아래)
./run.sh sync:sessions --push   # sessions.lance + session-manifest.json → oracle
./run.sh sync:md:oracle         # md.lance + md-manifest.json → oracle
```

긴 작업(세션 수십·md 수백)은 백그라운드로 돌리고 완료 알림을 기다린다. **폴링용
짧은 sleep 반복 금지** — 같은 sync를 다시 부르면 single-writer race.

### 흐름을 한 번에 (백그라운드 권장)

```bash
./run.sh sync:sessions && ./run.sh sync:md \
  && ./run.sh verify sessions && ./run.sh verify md
```

## 안전장치 (스크립트가 이미 강제)

- **dim 4096 preflight**: 세션/‌md 증분은 시작 전 1콜로 provider dim을 확인.
  DB dim과 어긋나면 **API 0 abort** — 잘못된 차원으로 임베딩하지 않는다. 이때는
  풀 rebuild(`scripts/rebuild-sessions-full.sh`)가 먼저다.
- **to_index=0 → API 0 exit**: 증분할 게 없으면 프로브도 안 하고 종료. 방금 돌린
  뒤 다시 불러도 무해(비용 0).
- **org 격리**: 세션 스크립트는 `ANDENKEN_ORG_*`/`ANDENKEN_VLLM_*`/`org.lance`를
  절대 읽거나 쓰지 않는다.

## compact — 반드시 코어 제한

`compact`/`cleanup`은 LanceDB `table.optimize()`를 호출하고, 그 Rust rayon/tokio
풀이 **16코어를 전부 100%로 잡아먹는다**. run.sh는 이를 `taskset -c`로 CPU
affinity에 pin한다 — rayon/tokio가 `available_parallelism()`(sched_getaffinity)로
스레드 수를 정하므로, 코어를 4개로 묶으면 스레드도 4개로 준다.

```bash
./run.sh compact md                        # 기본: 코어 0-3 (4개)
ANDENKEN_COMPACT_CPUS=0-7 ./run.sh compact md   # 8코어로 오버라이드
```

- 기본값 `0-3`. `ANDENKEN_COMPACT_CPUS`로 taskset `-c` 문법 오버라이드(`0-3`, `0,2,4,6`).
- compact는 **frag가 크게 늘었을 때만**. 증분마다 할 필요 없다. 이전에 md를
  162조각→1조각까지 줄인 적. verify는 조각 수를 보여준다.

## oracle 복제 — DB와 manifest는 함께 간다

thinkpad가 **정본**, oracle은 **query replica**(복제본). 복제 규율:

- **§6.6 (INVARIANT.md)**: `.lance` DB만 밀면 안 된다. 세션은
  `session-manifest.json`, md는 `md-manifest.json`을 **같이** rsync해야 원격이
  정합한다. 두 sync 명령 모두 manifest를 동반하도록 이미 맞춰져 있다.
- **§7.1**: oracle은 인덱싱 노드가 아니다. **oracle에서 인덱서를 돌리면 정본과
  갈라진다.** 복제만.
- push는 outward-facing이다 — **GLG 확인 후** 실행. 임베딩·verify 통과가 선결.
- 참조: `INVARIANT.md` §6.4~§6.6, §7~§7.1.

## 풀 rebuild — 사람 게이트 (에이전트 자동화 금지)

증분이 아니라 전체 재구축이 필요할 때만:

```bash
./run.sh rebuild:sessions:dry   # estimate → 확인 → preflight → (destroy) → rebuild
./run.sh rebuild:sessions       # 실제 파괴적 재구축
```

- ₩100K 사고 잔존 안전: **풀싱크/비용 게이트/파괴적 rebuild는 에이전트가
  자동화하지 않는다.** 사람이 estimate를 보고 결정한다.
- md 풀 rebuild는 `ANDENKEN_ALLOW_PAID_FULL_REBUILD=1`을 먼저 검토한 뒤에만.

## single-writer

- 같은 트랙에 대해 **한 번에 한 writer**. 두 인스턴스가 동시에 sync/compact하면
  index race. 시작 전 확인: `pgrep -af 'sync-sessions|indexer.ts'`.
- 답답해서 백그라운드 sync를 재호출하지 말 것. 완료 알림을 기다린다.

## 빠른 참조

| 하려는 것 | 명령 |
|-----------|------|
| 현황 | `./run.sh status` (`status:json` 기계용) |
| 세션 증분 | `./run.sh sync:sessions` |
| 가든 증분 | `./run.sh sync:md` |
| 검증 | `./run.sh verify sessions\|md\|all` |
| 조각 정리(4코어) | `./run.sh compact sessions\|md` |
| dedup+orphan+manifest 수리 | `./run.sh cleanup sessions\|md` (compact 포함, pin됨) |
| 운영 진단 | `./run.sh doctor --sessions\|--md [--json]` |
| oracle 복제 | `./run.sh sync:sessions --push` / `./run.sh sync:md:oracle` |
| 비용 추정(API0) | `./run.sh estimate:sessions\|md [--full]` |

SSOT는 `run.sh` + `scripts/` + `INVARIANT.md`. 이 스킬은 그 흐름의 안내판이다 —
동작이 문서와 어긋나면 run.sh/INVARIANT.md가 이긴다.
