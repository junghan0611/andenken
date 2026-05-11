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

## 트랙 B — garden-md / qmd / org: 지금 할 일

### B1 — garden-md OpenRouter embedding baseline

**목표**: 급한 지식축은 qmd local-GGUF stack이 아니라, 이미 export된 **public garden Markdown을 OpenRouter Qwen3-Embedding-8B로 직접 임베딩**해서 만든다.

왜 qmd-first를 중단했는가:

- GLG의 원래 목표는 “qmd 자체 최적화”가 아니라 “급한대로 `~/repos/gh/notes/content` Markdown 결과물을 임베딩해서 검색에 쓰는 것”이다.
- qmd local stack은 smoke 90 files / 1215 vectors에서 full `qmd query`가 rerank 39~40 chunks에 query당 약 53초를 썼다. interactive 운영에는 과하다.
- qmd는 기본적으로 OpenRouter/Ollama endpoint를 쓰지 않고 `node-llama-cpp` GGUF 모델을 로컬 프로세스에 로드한다. OpenRouter를 쓰려면 qmd adapter/code change가 필요하고, 지금 급한 baseline 범위를 넘는다.
- sessions track에서 OpenRouter `qwen/qwen3-embedding-8b` / 4096d는 이미 검증됐다. 같은 provider family로 garden Markdown을 별도 track에 태우는 것이 빠르다.

현재 qmd 실험 결과 (보류 근거):

| 항목 | 값 |
|---|---|
| qmd source | `~/repos/3rd/qmd`, `~/.local/bin/qmd` |
| qmd DB | `~/.cache/qmd/index.sqlite` |
| qmd smoke | `garden-smoke`, 90 files, 1215 vectors |
| local runtime | AMD Radeon 780M Vulkan offload OK |
| local embedding candidate | `Qwen3-Embedding-0.6B-Q8_0` |
| observed issue | full `qmd query` rerank latency ~53s/query on smoke |
| decision | qmd local semantic/rerank path 보류. qmd may remain useful for `search/get/multi-get` only. |

#### B1a — garden-md track design (current)

정의할 것:

- Source: `~/repos/gh/notes/content`
- Store: `data/garden-md.lance` (new; do not reuse `org.lance` or qmd sqlite)
- Manifest: `data/garden-md-manifest.json`
- Model: OpenRouter `qwen/qwen3-embedding-8b` / 4096d
- Env namespace: `ANDENKEN_GARDEN_*` or explicit provider wiring. Do **not** mix with `ANDENKEN_SESSION_*` or `ANDENKEN_ORG_*`.
- Corpus folders: start with `notes`, `bib`, `meta`, `journal`, `botlog`; exclude `images`, `talks`, `test`, `tmp` for first baseline.
- Chunking: Markdown-aware enough for exported Hugo Markdown; do not use org chunker directly unless deliberately adapted.

API / commands to add:

```bash
./run.sh index:garden-md [--force]
./run.sh verify garden-md
./run.sh search:garden-md "보편 학문" --limit 5
./run.sh status:json   # include garden-md section
```

Optional later surface:

```ts
knowledge_search({ query, source: "garden-md" })
```

#### B1b — small smoke before full garden

Before indexing all `2,218` Markdown files, build a small representative corpus:

| axis | sample |
|---|---:|
| meta | 20~50 |
| notes | 20~50 |
| bib | 10~30 |
| botlog | 10~20 |
| journal | 5~10 |

Representative queries:

```text
보편 학문
피투성
어쏠로지
바네바 부시
제프 베이조스
qmd 연결고리
andenken openclaw
entwurf 시간축
일일일생
2026-05-11 andenken
```

검수 기준:

- Korean concept recall: `notes` / `meta` / `botlog`가 맞게 뜨는가
- person/work recall: `bib` + related notes가 연결되는가
- time-axis recall: `journal`이 필요한 경우만 뜨고 과도하게 지배하지 않는가
- bilingual mixed query: Korean + English proper noun이 함께 살아남는가
- latency/cost: OpenRouter 8B cost estimate를 기록하고 full garden으로 갈지 결정

#### B1c — full public garden MD baseline

Smoke가 통과하면 full garden-md index:

- `~/repos/gh/notes/content` 전체 중 5개 주요 folder만 index
- expected size: `2,218` md files, `27.2MB` md payload, content dir `33MB`
- verify dim 4096d / no duplicate IDs / no orphan files / row count consistency
- search quality spot-check 후 `README.md` / `QMD.md` naming을 `garden-md` 중심으로 정리

금지 / 보류:

- qmd full `query` / local reranker를 기본 운영으로 채택하지 않는다.
- qmd DB 직접 SQLite 수정 금지.
- org incremental sync / org full rebuild 금지. org doctor WARN은 garden-md baseline 뒤에 본다.
- qmd OpenRouter adapter는 지금 구현하지 않는다. 필요하면 별도 이슈로 분리한다.

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
