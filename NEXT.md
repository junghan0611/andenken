# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## 트랙 A — sessions embedding: closed

Sessions track은 2026-05-11 기준 안정화 종료.

현재 운영 상태:

- model / dim: OpenRouter `qwen/qwen3-embedding-8b` / 4096d
- corpus: `pi` + standalone Claude Code (`~/.claude/projects`) only
- forbidden: `~/.pi/agent/claude-config-overlay/projects` — pi-shell-acp Claude overlay, 중복 기억이므로 인덱싱 금지
- full rebuild 완료: `28,537` chunks, `0` errors, verify pass, cost `~$0.065`
- C2.1c 완료: `session_search.withExcerpt` opt-in으로 search hit → 원문맥 readback 연결
- 2026-05-11 추가: source filter 정합화 (validation + LanceDB push-down + 명시적 source 시 org fallback suppress + golden harness sessions/org dim 분리)
- 2026-05-11 memory-sync 완료: incremental `174 chunks`, DB total `28,641`, verify pass

닫은 뒤 원칙:

- sessions 관련 새 기능은 GLG가 명시적으로 다시 열 때만 한다.
- 평소 운영은 `scripts/sync-sessions.sh` / `memory-sync` incremental만 수행한다.
- score threshold / source weight / toolResult indexing / window chunking은 모두 보류. 지금 추격하지 않는다.

## 트랙 B — qmd / garden / org: 지금 할 일

### B1 — qmd public garden MD bootstrap + quality baseline

**목표**: 당장 사용할 검색축은 org 원천이 아니라 **public garden Markdown → qmd**로 먼저 세운다. org→qmd와 org embedding은 doctor WARN 정리 후의 정밀화 축으로 미룬다.

왜 순서를 바꾸는가:

- GLG 목표는 “qmd로 당장 쓰는 연결고리”다. qmd를 실제로 써야 품질을 올릴 수 있다.
- `~/repos/gh/notes/content`는 이미 ox-hugo/export가 끝난 public garden Markdown이라 qmd 입력으로 현실적이다.
- org 원천은 현재 `malformedBlockFiles=10`, `zeroChunkUnexpectedFiles=4`, `hardGuardSkipTotal Δ+2`가 있어 먼저 qmd 실험에 태우면 원천/chunker 문제까지 같이 끌고 간다.
- sessions embedding은 이미 안정화됐으므로, 지식축은 **qmd public garden MD**와 **org→qmd/org embedding**을 분리해서 본다.

현재 측정 (2026-05-11):

| 축 | 위치 | 상태 |
|---|---|---|
| qmd source | `~/repos/3rd/qmd` | cloned from `https://github.com/tobi/qmd`, HEAD `746beed`, built with bun |
| qmd local bin | `~/.local/bin/qmd -> ~/repos/3rd/qmd/bin/qmd` | `qmd status` 실행됨 |
| qmd DB | `~/.cache/qmd/index.sqlite` | currently 0 docs indexed |
| public garden MD | `~/repos/gh/notes/content` | `2,218` md files, `27.2MB` md payload, content dir `33MB` |
| folder counts | `notes 837`, `bib 678`, `meta 538`, `journal 94`, `botlog 63`, small `talks/test/tmp` | qmd collection 후보 |
| largest md | max `486KB`, top files 300–486KB range | qmd `multi-get --max-bytes`/chunking 관찰 필요 |
| andenken org→qmd export | `~/.cache/andenken-qmd` | dry-run: `2,003` files, `196` zero-chunk skips |
| qmd bridge code | `export-qmd.ts`, `qmd-context.ts`, `qmd-bakeoff.ts`, `query-qmd.ts` | 총 ~1,398 LOC, 기존 org→memory-md 중심 |
| openclaw qmd references | `~/repos/3rd/openclaw/docs/concepts/memory-qmd.md`, `extensions/memory-core/src/memory/qmd-*`, `packages/memory-host-sdk/src/host/qmd-*` | 설계/호스트 참고 |

qmd upstream notes:

- `~/repos/3rd/qmd/CLAUDE.md` says: use Bun, do not run collection/embed/update automatically without operator intent, DB at `~/.cache/qmd/index.sqlite`.
- We are operating under explicit GLG instruction to install and prepare qmd.
- Commands available: `qmd collection add`, `qmd context add`, `qmd embed`, `qmd search`, `qmd vsearch`, `qmd query`, `qmd mcp --http`.

작업 분할 (관리자 관점의 하위 단계):

#### B1a — qmd 설치 / 실행 표면 확인

목표: qmd 자체가 operator surface로 재현 가능하게 동작하는지 확인한다.

- `which qmd`, `qmd status`
- `~/.local/bin/qmd -> ~/repos/3rd/qmd/bin/qmd` 링크 확인
- `~/repos/3rd/qmd` build state 확인
- qmd DB 위치 `~/.cache/qmd/index.sqlite` 확인

산출물: qmd 실행 가능 / 불가능, 현재 DB 상태, 실행 전 리스크.

#### B1a-1 — model / serving gate before first embed — passed

목표: 첫 qmd embed 전에 GLG 가든에 맞는 embedding model과 노트북 serving 방식을 고정한다. 기본 `embeddinggemma-300M`로 embed하지 않는다.

판단:

- qmd는 Ollama/vLLM/OpenRouter를 호출하지 않는다. `node-llama-cpp`가 GGUF 모델을 로컬 프로세스 안에서 로드한다.
- 기본 embedding model `embeddinggemma-300M`은 영어 중심이라 한국어/CJK + English proper noun 혼합 가든에는 부적합하다.
- first baseline embedding은 qmd README가 CJK용으로 권장하는 `Qwen3-Embedding-0.6B-GGUF`로 고정한다.

운영 env 후보:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
export QMD_LLAMA_GPU=vulkan
```

thinkpad AMD Phoenix 확인 결과:

- `/dev/dri/renderD128` 있음 — AMD iGPU/Vulkan 사용 가능성이 있음.
- `vulkaninfo`는 현재 PATH에 없음.
- first probe: `QMD_STATUS_DEVICE_PROBE=1 QMD_LLAMA_GPU=vulkan qmd status` 결과 `node-llama-cpp` Vulkan prebuilt incompatible → CPU fallback도 prebuilt incompatible.
- 원인: qmd는 Nix `node` 프로세스가 `.node` addon/`.so`를 `dlopen`한다. 이 경우 `nix-ld`의 `NIX_LD_LIBRARY_PATH`만으로는 부족하고, addon dependency lookup에 `LD_LIBRARY_PATH=$NIX_LD_LIBRARY_PATH`가 필요하다.
- NixOS thinkpad fix confirmed: `programs.nix-ld.libraries = [ stdenv.cc.cc.lib vulkan-loader ];` exposes `libstdc++.so.6` and `libvulkan.so.1` under `$NIX_LD_LIBRARY_PATH`.
- Verified command: `LD_LIBRARY_PATH="$NIX_LD_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" QMD_LLAMA_GPU=vulkan bun -e 'import("node-llama-cpp").then(m=>m.getLlama({gpu:"vulkan"})).then(async l=>console.log(l.gpu, await l.getGpuDeviceNames()))'` → `vulkan [ "AMD Radeon 780M Graphics (RADV PHOENIX)" ]`.
- `qmd status` with `QMD_STATUS_DEVICE_PROBE=1 QMD_LLAMA_GPU=vulkan` now reports GPU offloading yes and VRAM. Note: qmd status currently prints default model URIs from constants, not env overrides; trust embed command/env for the actual embedding model.
- Trap: if qmd/node-llama-cpp runs once without `LD_LIBRARY_PATH`, it may create a CPU-only source fallback under `~/repos/3rd/qmd/node_modules/node-llama-cpp/llama/localBuilds`, which can take precedence over the prebuilt Vulkan addon. Before baseline embed, remove it.

qmd 실행 env:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
export QMD_LLAMA_GPU=vulkan
export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

Operator wrapper:

- `scripts/qmd-garden.sh` pins the env above, injects `LD_LIBRARY_PATH`, and exposes `env`, `preflight`, `status`, `bootstrap`, `embed`, `query`, `search`, `vsearch`, `mcp-http`, `raw`.
- `./run.sh qmd:garden <cmd>` is the supported entrypoint for GLG public garden qmd work.
- Use `./run.sh qmd:garden preflight` before collection registration / embed.
- Use `./run.sh qmd:garden bootstrap` for dry-run command review, then `./run.sh qmd:garden bootstrap --execute` after GLG approval.

서빙 선택지:

1. **local Vulkan** — 추천 목표. NixOS에서 node-llama-cpp가 Vulkan backend를 build/load하게 만든 뒤 qmd CLI/MCP를 사용.
2. **local CPU** — 기능 검증은 가능하나 embed/rerank/query expansion이 느릴 수 있음. prebuilt CPU도 현재 probe 실패했으므로 build 문제 해결은 필요.
3. **remote/ollama** — qmd 기본 구조가 외부 Ollama embedding 서버를 쓰지 않으므로 바로 선택 불가. 쓰려면 qmd adapter/code change가 필요해서 B1 baseline 범위를 넘는다.

Gate result:

- `./run.sh qmd:garden preflight` passed.
- `node-llama-cpp` reports `vulkan [ "AMD Radeon 780M Graphics (RADV PHOENIX)" ]`.
- `qmd status` reports `GPU: vulkan (offloading: yes)`, VRAM about `16.4 GB free / 17.5 GB total`.
- 모델 캐시 예상: default 3종 합계 약 2GB + Qwen3-Embedding-0.6B 추가. 실행 전 디스크/시간 보고.

#### B1b — GLG garden 특이점 반영한 collection 설계

목표: 단순 폴더 인덱싱이 아니라 GLG 가든의 역할 차이를 qmd collection/context에 반영한다.

초기 5개 collection:

| collection | source | 역할 / 검수 관점 |
|---|---|---|
| `garden-notes` | `~/repos/gh/notes/content/notes` | 개념 노트. 보편/존재/어쏠로지 같은 장기 개념 recall |
| `garden-bib` | `~/repos/gh/notes/content/bib` | bibliography/citation 축. 인명/저작/키워드 recall |
| `garden-meta` | `~/repos/gh/notes/content/meta` | 사이트/태그/분류/가든 운영 메타 |
| `garden-journal` | `~/repos/gh/notes/content/journal` | 시간축. 날짜/일일일생/작업 흐름 recall |
| `garden-botlog` | `~/repos/gh/notes/content/botlog` | agent-authored public synthesis. 세션 chatter보다 conscious marker에 가까움 |

보류/제외:

- `images` symlink 제외
- `talks`, `test`, `tmp`는 첫 baseline에서 제외 unless GLG asks
- `~/.cache/andenken-qmd` org export는 사용하지 않음

산출물: collection/context naming, 포함/제외 규칙, qmd query 시 어느 collection을 우선 볼지 기준.

#### B1c — collection/context 등록 + indexing/embed smoke — current

목표: public garden Markdown을 qmd에 실제 등록하고, 색인/임베딩까지 최소 동작을 확인한다. 전체 5개 collection 전에 `garden-meta` 하나로 GPU/model/download smoke를 먼저 본다.

1. `garden-meta` smoke
   - `./run.sh qmd:garden bootstrap --only meta` dry-run 확인
   - `./run.sh qmd:garden bootstrap --only meta --execute`
   - `./run.sh qmd:garden embed -c garden-meta`
   - 기록: 모델 다운로드 시간, embed duration, VRAM/CPU, indexed docs/vectors, 실패 파일
2. smoke query
   - `./run.sh qmd:garden query "보편 학문" -c garden-meta -n 5`
   - `./run.sh qmd:garden search "어쏠로지" -c garden-meta -n 5`
   - `./run.sh qmd:garden vsearch "디지털 가든" -c garden-meta -n 5`
3. 전체 5개 collection 등록
   - `./run.sh qmd:garden bootstrap` dry-run
   - `./run.sh qmd:garden bootstrap --execute`
   - `./run.sh qmd:garden embed`
4. 상태 확인
   - `./run.sh qmd:garden raw collection list`
   - `./run.sh qmd:garden status`

산출물: 등록된 collection/context 목록, indexed docs 수, embed 상태, smoke timing, 실패 파일/대용량 파일 목록.

#### B1d — garden-specific 품질 검수 baseline

목표: qmd가 GLG 가든의 실제 검색 경험을 살리는지 검수한다. 단순 pass/fail이 아니라 “어떤 축이 강하고 약한가”를 본다.

대표 쿼리 묶음:

| 축 | 쿼리 예시 | 기대 |
|---|---|---|
| 한국어 개념 | `보편 학문`, `피투성`, `어쏠로지` | notes/meta/botlog 개념 노트가 상위에 떠야 함 |
| 인명/저작 | `바네바 부시`, `제프 베이조스`, citation key 일부 | bib + 관련 notes 연결 확인 |
| agent/history | `qmd 연결고리`, `andenken`, `entwurf`, `openclaw` | botlog/meta/notes의 conscious synthesis 확인 |
| 시간축 | `2026-05-11 andenken`, `일일일생` | journal이 과도하게 지배하지 않는지 확인 |
| 혼합언어 | Korean + English proper noun mixed query | exported Markdown title/body 검색 품질 확인 |

비교 방식:

- qmd `query/search/vsearch` 직접 비교
- 가능하면 `./run.sh qmd:bake-off --skip-andenken`
- 필요 시 `knowledge_search`와 spot-check하되, qmd baseline이 목적이므로 andenken org 문제로 확대하지 않는다.

산출물: query별 top results, miss 사례, collection split/contexts 조정 필요 여부.

#### B1e — 운영/통합 판단

목표: qmd를 “설치됨”이 아니라 “쓸 수 있는 검색축”으로 관리할 다음 결정을 내린다.

결정 후보:

1. qmd collection quality tuning
   - context 문구 개선
   - collection split/merge
   - large file handling
2. qmd MCP/http integration
   - `qmd mcp --http`
   - OpenClaw / agent-config surface 연결 검토
3. org doctor WARN triage 복귀
   - qmd baseline이 충분히 서면 org 원천 정리로 돌아감

산출물: NEXT.md의 다음 단일 항목으로 승격할 하나의 결정.

금지 / 보류:

- org incremental sync 금지 (qmd public garden baseline 전에는 하지 않는다)
- org full rebuild 금지
- org→qmd export production 전환 금지
- qmd DB 직접 SQLite 수정 금지
- qmd source repo 자체 변경 금지 unless GLG explicitly asks
- qmd 모델 다운로드/embedding은 명시 진행 중이므로 허용하지만, 실행 전 예상 시간/디스크를 보고한다.

## 보류 — org doctor WARN 신호 격리

B0 baseline triage(2026-05-11 완료)에서 잡힌 WARN 3건은 유지한다. 다만 qmd 당장 사용 축을 먼저 만들기 위해 B1 뒤로 미룬다.

현재 org 상태:

| 항목 | 값 |
|---|---:|
| org rows | 44,916 |
| org files | 2,199 |
| indexed files | 2,025 |
| new | 7 |
| stale | 541 |
| deleted | 6 |
| to_index | 548 |
| dim | 2560d |
| last indexed | 2026-05-07 |

Doctor WARN 신호:

| 신호 | 카운트 | 분류 가설 |
|------|------:|----------|
| `malformedBlockFiles` | 10 | source 파일 손상(GLG 영역) + chunker 패턴 부족 혼재 의심 |
| `zeroChunkUnexpectedFiles` | 4 | chunker가 모든 청크를 exclusion으로 잡거나 빈 본문 → chunker 결함 의심 |
| `hardGuardSkipTotal Δ+2` | 2 | 새 파일이 hard guard 패턴 트리거 — chunker 한계점 |

나중에 할 일:

1. `zeroChunkUnexpectedFiles` 4건의 본문 확인
2. `malformedBlockFiles` 10건 source 손상 vs chunker 결함 분류
3. `hardGuardSkipTop` 2건 트리거 조건 확인
4. incremental sync 가능 여부 결정

## 별도 이슈 — dictcli expansion 보정

andenken 작업은 아니지만 품질 검수에서 발견한 Layer 3 이슈로 별도 추적한다.

- 문제: `초기` → `enactment`, `establishment`, `institution` 등으로 확장됨.
- 기대: `initial`, `early`, `beginning`, `earlystage` 계열.
- 영향: Korean→English mixed query에서 BM25/embedding query enrichment가 엉뚱해질 수 있음.
- 처리 위치: `dictcli` vocabulary graph. andenken에서는 증상과 재현 쿼리만 기록한다.

## 외부 의존 / 주의

- sessions는 8B/4096d, org는 4B/2560d. 두 DB/provider 차원을 섞지 않는다.
- OpenRouter Qwen3-Embedding-8B 가격은 현재 `$0.01/M` 기준.
- long-lived pi/extension은 코드 변경 후 재시작해야 새 `session_search` schema를 읽는다.
- `./run.sh golden --db session`은 sessions provider(`ANDENKEN_SESSION_*`)로 자동 분기. `--db org`는 org provider(`ANDENKEN_ORG_*` / legacy `ANDENKEN_VLLM_*`). 한쪽이 unset이면 그 분기 호출 시 `process.exit(1)` 명시적 에러.

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
- `./run.sh` — 운영 메뉴
