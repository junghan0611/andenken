# ROADMAP — andenken

> andenken은 **임베딩 기억축 1개**를 담당합니다.
> 다축 맥락 복원(recap)은 GLG가 직접 합니다 — andenken 담당자의 책임이 아닙니다.
>
> **이 문서가 andenken의 핵심 문서입니다.** 비교표 + 변화 기록 + 운영 신호 +
> 역할 분담. 라운드 / 마이크로 픽스 / 추격 항목은 들어오지 않습니다.
> 기술 디테일은 코드와 commit message에 있습니다.

## OpenClaw 5.7 vs andenken — 비교표 (2026-05-08 baseline)

비교 근거 노트:
- `~/sync/org/llmlog/20260507T193005--openclaw-session-transcript-memory-vs-andenken-session-embedding...org`
- `~/sync/org/llmlog/20260507T144916--§andenken-세션-임베딩-품질-openclaw-대비-개선사항...org`

### 1. 같다 — 5/8 baseline에서 수평 정렬됨

| 축 | 값 | 비고 |
|----|-----|------|
| 임베딩 모델 | `qwen/qwen3-embedding-4b` | 5/8 baseline. 5/10부터 andenken sessions는 8B로 이동 |
| 차원 | 2560d | 5/8 baseline. 5/10부터 andenken sessions는 4096d |
| 토크나이저 | trigram 기반 (CJK) | OpenClaw는 FTS5 trigram, andenken은 substring fallback |
| 청킹 | 400 tokens / 80 overlap | 동일 |
| Hybrid 가중치 | vector 0.7 / text 0.3 | 동일 |
| MMR | enabled (λ=0.7) | 동일 |
| Temporal decay | enabled | half-life 다름 (OpenClaw 30d / andenken 14d) |

→ 5/8 nixos-config 담당자가 OpenClaw에 baseline SSOT v2를 박은 후, **retrieval 튜닝 우위 차이는 사실상 사라졌습니다**. 5/10에는 andenken sessions track만 OpenRouter Qwen3-Embedding-8B 4096d로 먼저 전환했습니다.

### 2. OpenClaw에 있고 우리에 없다

| 축 | 우리 상태 | 처리 방향 |
|----|-----------|-----------|
| **active memory** | 미보유 | **나중에 유사물 도입 예정** (slot 비워둠) |
| memory layer (active / short / long / dream) | 미보유 | OpenClaw 단독. andenken은 단축 담당이라 의도적 미보유. |
| **품질 측정 로직** | 미보유 | **OpenClaw에서 이식 예정** |
| 봇별 분리 corpus | 미보유 (전체 통합) | 의도적 — corpus 단위가 다름 |
| sqlite-vec / SQLite FTS5 백엔드 | 미보유 (LanceDB) | 의도적 |

### 3. 우리에 있고 OpenClaw에 없다 — andenken의 차별점

| 축 | 규모 | 의의 |
|----|-----|------|
| **org corpus** | ~45,000 chunks / 2,198 files | org-mode KB. 차별점의 본체이지만 **현재 production에서는 disable**. 업스트림 R&D로 분리. |
| **md corpus (public garden)** | 2,218 .md / ~27MB | 가든 export를 직접 임베딩. 통제된 surface라 튜닝 빠름. 에이전트가 당장 쓰는 지식축. |
| pi sessions + Claude Code 통합 | 1,600+ sessions / 28,537 chunks | OpenClaw는 봇별 transcript. 우리는 *나*의 모든 세션. 2026-05-11 sessions track 안정화 종료. |
| **denote graph** | denotecli sidecar | back-link / 카테고리 / 시간축 |
| 한국어 형태소 | dictcli sidecar | Kiwi stem + 한↔영 expand |
| bibliography | bibcli sidecar | citation graph (`#+reference:` + `[cite:@key]`) |

### 4. 둘 다 아직 안 하는 것 — 가능성 (GLG 결정 대기)

다축 recap 설계 흐름 안에서 GLG가 결정합니다. andenken이 단독으로 결정하지 않습니다.

- **org × sessions 교차 retrieval** — 같은 query에 두 corpus 결과가 동시에 뜨는 경험. OpenClaw는 자체 corpus가 없어 불가.
- **org-native 구조 활용** — 카테고리(journal / botlog / llmlog / notes / bib / meta)별 가중치, heading hierarchy, citation/back-link graph 통합.
- **agent-as-author signal** — llmlog / botlog가 sessions의 "결정 인덱스"로 작동.
- **md (public garden) → org 정리** — sessions는 2026-05-11에 8B/4096d 안정화 종료. 다음 축은 raw org가 아니라 export된 public garden Markdown을 직접 임베딩(`data/md.lance`, 4096d)해서 에이전트에게 즉시 주는 지식축이다. 구현은 OpenClaw `memory-host-sdk/src/host` 빌트인 md 로직 + sessions와 동일한 LanceDB 백엔드 (origin org 트랙이 만들어진 패턴과 같다). org은 그 다음, doctor/chunker 정리로 들어가며 그 동안은 production에서 disable. 모델 변경은 manifold drift라 해당 corpus *전체 reindex* 필요.

## 변화 기록 (History)

새 변화는 위에 추가. 시간 역순.

- **2026-05-12** — qmd 경로 폐기 (issue #8). 신규 파일 7개(`export-qmd*`, `qmd-*`, `scripts/qmd-garden.sh`, `QMD.md`) 삭제. `test.ts` / `run.sh` / `tsconfig.json` 수술. retriever.ts "QMD pattern" 주석은 일반화. **org 트랙은 production에서 disable**로 명시 — 에이전트가 당장 쓸 기억축은 sessions + md로 정렬, org는 업스트림 R&D로 분리 (지금 garden export는 통제된 정보라 튜닝이 쉽다는 판단). md 트랙은 OpenClaw `memory-host-sdk/src/host` 빌트인 md 로직을 LanceDB 백엔드 위로 포팅 — 이는 origin org 트랙을 만든 동일 패턴이다. 차원/store/manifest contract: 4096d OpenRouter `qwen/qwen3-embedding-8b`, `data/md.lance`, `data/md-manifest.json`, env namespace `ANDENKEN_MD_*`.
- **2026-05-11** — qmd-first 중단 결정 (실코드 정리는 2026-05-12). qmd local stack은 설치/runner/Vulkan까지 검증됐고 `garden-smoke` 90 files / 1215 vectors까지 임베딩됐으나, full `qmd query`가 rerank 39~40 chunks에 약 53초/query를 써서 interactive 지식축으로 과하다고 판단. GLG의 실제 목적은 qmd 자체가 아니라 exported public garden Markdown을 급히 semantic retrieval에 태우는 것이므로, 다음 track은 LanceDB + OpenRouter `qwen/qwen3-embedding-8b` 4096d baseline으로 재정의.
- **2026-05-11** — qmd garden runner 도입 (다음날 폐기). `scripts/qmd-garden.sh` / `./run.sh qmd:garden`가 GLG public garden qmd 작업의 operator surface였음. Env는 Qwen3-Embedding-0.6B GGUF + Vulkan + NixOS `LD_LIBRARY_PATH=$NIX_LD_LIBRARY_PATH`로 고정. thinkpad AMD Radeon 780M Vulkan offload verified.
- **2026-05-11** — qmd 방향 전환 시도 (다음날 폐기). `~/repos/3rd/qmd`를 clone/build하고 `~/.local/bin/qmd`로 연결. qmd DB는 `~/.cache/qmd/index.sqlite`, 첫 corpus는 exported public garden Markdown `~/repos/gh/notes/content`(2,218 md / ~27.2MB). qmd 자체 채택은 issue #8로 회수되어 폐기.
- **2026-05-11** — sessions track 안정화 종료. C2.1a excerpt readback(`16e6abf`), 전체 sessions rebuild(28,537 chunks, 4096d, ~6.48M tokens, ~$0.065, verify pass), C2.1c `session_search.withExcerpt` opt-in(`3cafb36`) 완료. transcript-window production / toolResult indexing / source weight / score threshold 조정은 보류.
- **2026-05-10** — andenken sessions track을 OpenRouter `qwen/qwen3-embedding-8b` 4096d로 전환. commit `c618a73`. Provider namespace 분리(`ANDENKEN_SESSION_*` / `ANDENKEN_ORG_*`), dim guard, paid full-rebuild guard, `rebuild-sessions-full.sh`, OpenRouter incremental `sync-sessions.sh` 도입. 첫 full rebuild: 28,188 chunks, ~6.34M tokens, ~$0.063, 31.7분, errors 0. Smoke query `openclaw session embedding` top 5 모두 관련. Org는 2560d 유지.
- **2026-05-08** — OpenClaw 측 Qwen3-Embedding-8B 변경 테스트 시작 (nixos-config 담당자). andenken은 결과 보고 적용 여부 검토 — NEXT.md *외부 의존 대기* 항목으로 등록. matryoshka 2560d truncate 옵션이 있어 schema 무변경 가능.
- **2026-05-08** — andenken 문서 정리. MEMORY.md 폐기. ROADMAP.md(한글, 비교표 중심) 신설을 핵심 문서로. NEXT.md는 *지금 하려는 한 가지*만 담는 좁은 surface로 재정의 (라운드 큐 폐기). 임베딩 단축 담당 명시.
- **2026-05-08** — NEXT.md를 sanitization-first로 갈아끼움 (이전 안: 평가 도구). 같은 pi JSONL을 OpenClaw가 0.45–57%까지 정제하는데 andenken은 line-based로 거의 전부 통과시킨다는 5/8 baseline 발견 반영. 평가 도구는 sanitization 끝난 후 다음 NEXT로.
- **2026-05-08** — OpenClaw 5.7 baseline 박힘 (nixos-config 담당자, commit `58844b9`). sessions chunks 1306 → 3747 (+187%, transcript-hygiene). 같은 모델 / 차원 / tokenizer / chunking / MMR / decay로 horizontal 정렬. → andenken과의 retrieval 튜닝 우위 차이 사라짐.
- **2026-05-07** — sessions live tier 승격. ollama 로컬 fast path + hourly cadence. doctor `reasons[]`, CJK boundary guard, recalls.jsonl persistence 가동. commits `32478c3`, `76d9703`, `1b99dbf`, `10ffa53`.
- **2026-04-30** — gpu2i를 VOS chat-completion으로 전환. embedding은 gpu1i 단일.
- **2026-04-22** — `doctor --org` stage 1 (retrieval / chunk / structure 진단).
- **2026-04-17** — OpenRouter query path 분리 + provider split. 첫 reproducible dual rebuild (sessions 17,384 / org 44,167 / golden 26/26 PASS).
- **2026-03-30** — Korean particle stripping (BM25 전처리, openclaw에서 이식). 증분 org indexing manifest.
- **2026-03-21** — 2-step search strategy (abstract → top-3 읽기 → concrete re-search).

## 운영 신호 (Maintenance signals)

> doctor / status / verify 결과는 여기로. **로드맵 항목 아닙니다.**
> doctor가 던지는 신호로 *구조*를 설계하지 않습니다 — maintenance로만 받습니다.

| 명령 | 용도 | 호출 시점 |
|------|------|-----------|
| `./run.sh status` | manifest stale / cadence 모니터 | 정기 |
| `./run.sh sync:md` | md 증분 (OpenRouter 8B 4096d, garden export) | NEXT 트랙 도착 후 정기 |
| `./run.sh index:md --force` | md 전체 인덱스 (paid-remote gate) | 초기 / 모델 변경 시 |
| `./run.sh search:md "<query>"` | md 검색 smoke | 품질 점검 |
| `./run.sh verify md` | md 인덱싱 후 무결성 확인 | sync 후 |
| `./run.sh doctor --org` | malformed block / oversize / zero-chunk / hard-guard skip 신호 | **업스트림 R&D 한정** (org disable 상태) |
| `./run.sh verify sessions` | sessions 인덱싱 후 무결성 확인 | sync 후 |
| `scripts/sync-sessions.sh` | sessions 증분 (OpenRouter 8B 4096d, wrong-dim API0 abort) | 시간당 |
| agent-config `memory-sync` skill | 위 스크립트의 skill wrapper | 사용자 호출 |

## 역할 분담 — 다른 담당자와의 경계

| 누구 | 책임 |
|------|------|
| **andenken** (이 repo) | 임베딩 기억축 + md 트랙으로 에이전트에게 지식축 제공. corpus / index / retrieval 운영. OpenClaw 비교 SSOT 유지. **org 트랙은 disable / 업스트림 R&D**로 분리. |
| **GLG** | 다축 맥락 복원(recap) 설계. 담당자 간 인터페이스. 모든 commit 최종 결정. |
| **agent-config** | semantic-memory 스킬을 모든 surface(pi / Claude Code / Codex / Gemini)에 노출. memory-sync 스킬 (sessions 증분). |
| **denotecli** | org 구조 그래프 (Layer 2). dblock / backlink. |
| **dictcli** | 한국어 형태소 + 한↔영 확장 (Layer 3). |
| **bibcli** | bibliography (citation graph). |
| **nixos-config / OpenClaw** | 봇 inference + active / short / long / dream layer. 봇별 transcript memory. |

## 관련 문서

- 정체성 / 경계: [AGENTS.md](./AGENTS.md)
- 깨지면 안 되는 규칙: [INVARIANT.md](./INVARIANT.md)
- 외부 표면: [README.md](./README.md)
- 운영 메뉴: `./run.sh`
