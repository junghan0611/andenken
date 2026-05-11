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

해야 할 것 (이번 단일 항목):

1. qmd installation smoke
   - `qmd status`
   - confirm `~/.local/bin/qmd` path and source repo build state
2. public garden collection plan 확정
   - start with five collections: `garden-bib`, `garden-botlog`, `garden-journal`, `garden-meta`, `garden-notes`
   - exclude `images`, `talks`, `test`, `tmp` for first baseline unless GLG asks
   - use source path `~/repos/gh/notes/content/<folder>` directly, not `~/.cache/andenken-qmd`
3. collection/context registration
   - either use existing `./run.sh qmd:bootstrap --cache-dir ~/repos/gh/notes/content --collection-prefix garden --execute`
   - or run explicit qmd commands if bootstrap needs adjustment
4. index/embed/query smoke
   - `qmd collection list` / `qmd status`
   - `qmd embed` if collection add does not embed automatically
   - smoke queries: `보편 학문`, `피투성`, `어쏠로지`, `바네바 부시`, `qmd 연결고리`
   - compare with `./run.sh qmd:bake-off --skip-andenken` or direct `qmd query/search/vsearch`
5. decide next single step
   - qmd collection quality tuning (contexts, masks, folder split)
   - qmd MCP/http integration
   - or return to org doctor WARN triage

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
