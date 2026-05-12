# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## 트랙 A — sessions embedding: closed

Sessions track은 2026-05-11 기준 안정화 종료.

운영 상태:

- model / dim: OpenRouter `qwen/qwen3-embedding-8b` / 4096d
- corpus: `pi` + standalone Claude Code (`~/.claude/projects`) only
- forbidden: `~/.pi/agent/claude-config-overlay/projects` (중복 기억)
- full rebuild 완료: `28,537` chunks / 0 errors / verify pass / cost ~$0.065
- C2.1c 완료: `session_search.withExcerpt` opt-in
- 2026-05-11: source filter 정합화 + golden harness sessions/org dim 분리
- 2026-05-11: memory-sync incremental `174 chunks` 통과, DB total `28,641`

닫은 뒤 원칙:

- sessions 관련 새 기능은 GLG가 명시적으로 다시 열 때만 한다.
- 평소 운영은 `scripts/sync-sessions.sh` / `memory-sync` incremental만.

## 트랙 B — md embedding: 지금 할 일 (Issue #8)

### 결정 (2026-05-12)

GLG 결정으로 qmd 경로는 폐기한다. 디렉션을 원점으로 돌리고, md 트랙은
sessions와 동일한 패턴 — **OpenClaw 빌트인 md 메모리 로직 + LanceDB 백엔드** —
으로 다시 세운다. 이건 새 발명이 아니라, andenken의 org 트랙이 처음 만들어진
방식 그대로다 (OpenClaw 초기 임베딩 코드 + sqlite 대신 LanceDB).

#### 왜 md로 가는가 — 업스트림 vs 당장 줄 것 분리

GLG 방침 (2026-05-12):

- **에이전트들에게 당장 줄 기억축이 필요하다.** sessions만으로는 지식
  retrieval이 약하다. 가든 export는 통제된 정보라 튜닝 사이클이 빠르고,
  바로 에이전트가 쓸 수 있다.
- **org는 업스트림 개발로 분리한다.** org 트랙은 풍부하지만 거칠고,
  실제로 잘 retrieve되지 않는다 (다들 쓰지도 않는다는 GLG 관찰). doctor /
  chunker / source policy 정리는 그 자체로 의미가 있지만, 지금 시점에
  agent surface로 노출할 가치는 없다. **production에서 disable**.
- **최근 작업은 모두 sessions로 흡수 가능.** sessions track이 안정화됐고,
  md가 그 옆에 동일 contract로 들어오면 에이전트 입장에서는 새 surface
  하나가 켜지는 것일 뿐 — 추가 인지 부담 없음.
- **오늘 오전 목표**: md 로직을 살려서 에이전트에 노출. B0 (qmd 흔적 제거)
  + B1a (md 골격) 까지가 1차. 리뷰는 GLG가 따로 gpt-5.5 호출해서 본다.

요점:

- **md라고 못박는다.** qmd, garden-md, memory-md 같은 부분 명명을 쓰지 않는다.
  첫 corpus가 public garden export인 것은 구현 상세.
- **org 코드는 baseline 그대로 보존**한다. 롤백 = 신규 qmd 파일/문서/run.sh
  서브커맨드 삭제. org-chunker.ts / indexer.ts / store.ts / retriever.ts /
  session-indexer.ts 는 qmd가 만진 적이 없다 (검증: `git log --name-status`,
  e8acae0 커밋 메시지에 명시).
- **brain platform이 아니라 embedding engine으로 남는다.** local rerank /
  query expansion / 별도 실행면 운영 없음. provider/dim/store contract만
  명시적으로 유지.

### B0 — qmd 흔적 제거 (단일 commit)

미커밋 잔여 + 신규 qmd 파일 + 문서 qmd 흔적을 한 commit으로 정리한다.

#### 미커밋 drop

- `run.sh` (+1 line: sample/sample-clean/bake-off 서브커맨드)
- `scripts/qmd-garden.sh` (+210 lines: smoke corpus 빌더 + bake-off)

→ `git restore`로 폐기. qmd 보류 결정과 일관.

#### 파일 삭제

| 파일 | 줄 | 비고 |
|---|---:|---|
| `export-qmd.ts` | 375 | org → memory-md export (Stage 1) |
| `export-qmd-template.ts` | 126 | template generator |
| `qmd-bakeoff.ts` | 351 | bake-off harness |
| `qmd-context.ts` | 192 | collection/context bootstrap |
| `query-qmd.ts` | 270 | qmd query wrapper |
| `scripts/qmd-garden.sh` | 350 | shell runner (committed 본체) |
| `QMD.md` | 194 | 운영 문서 |

#### 수술적 수정

| 위치 | 작업 |
|---|---|
| `test.ts` | qmd imports (l.29-42) + 4개 섹션 (Export QMD / path safety / Bootstrap / Query wrapper) 제거 |
| `tsconfig.json` | qmd 파일 경로 정리 |
| `run.sh` | `qmd:garden`, `qmd:bootstrap` 서브커맨드 + "QMD bridge (experimental)" 그룹 제거 |
| `retriever.ts:164,197` | "QMD top-rank bonus" 주석 → 일반 "top-rank bonus" 문구. 로직은 sessions/md 모두에 유용하므로 보존 |

#### 문서 정렬

| 파일 | 작업 |
|---|---|
| `README.md` | "qmd over public garden MD" 트랙 → "md direct embedding". provider split 표에서 qmd 행 삭제 (l.113-219ish 다수) |
| `AGENTS.md` | 트랙 표(l.35-36)·sessions 다음 단계 문구(l.39-40)·endpoint 표(l.85, 91)·운영 가이드(l.113+) qmd 문구 → md 트랙으로 교체 |
| `ROADMAP.md` | 비교표(l.44, l.57)·History 2026-05-11 항목들(l.63-65) 수정. 2026-05-12 History에 "qmd path retired; md track defined on OpenClaw builtin + LanceDB" 추가 |
| `NEXT.md` | 이 문서 — 이미 정렬됨 |

### B1 — md track 구현

#### 설계 (sessions와 동형 + OpenClaw 빌트인 md 로직)

| 측면 | 값 |
|---|---|
| Source | `~/repos/gh/notes/content` (public garden export) |
| Corpus subfolders (first baseline) | `notes`, `bib`, `meta`, `journal`, `botlog` |
| Excluded folders | `images`, `talks`, `test`, `tmp` |
| Provider | OpenRouter `qwen/qwen3-embedding-8b` / 4096d (sessions와 동일) |
| Env namespace | `ANDENKEN_MD_*` (sessions `ANDENKEN_SESSION_*`, org `ANDENKEN_ORG_*` 와 분리) |
| Store | `data/md.lance` (sessions/org와 별도 LanceDB 파일) |
| Manifest | `data/md-manifest.json` |
| Schema | `memory-host-sdk/.../memory-schema.ts` 참고 (LanceDB row 매핑) |

#### OpenClaw 빌트인 로직 포팅 매핑

원본: `~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/`

| OpenClaw 파일 | andenken 어디로 | 비고 |
|---|---|---|
| `read-file.ts` / `read-file-shared.ts` | md 입력 파이프라인 | 텍스트 정규화 + frontmatter 처리 |
| `embedding-chunk-limits.ts` | md-chunker chunk 한계점 | 청크 크기/카운트 |
| `embedding-input-limits.ts`, `embedding-inputs.ts` | provider 입력 검증 | 8B 토큰 한계 검사 |
| `embedding-model-limits.ts` | provider 모델 한계 | 4096d 검증 |
| `embeddings-remote-client.ts`, `embeddings-remote-provider.ts`, `embeddings-remote-fetch.ts` | **md provider 어댑터** ← 핵심 | OpenAI-compat remote — OpenRouter 그대로 활용 |
| `embedding-provider-adapter-utils.ts` | md provider 유틸 | sessions provider와 통일 |
| `embedding-vectors.ts` | 벡터 normalize / dim 검사 | doctor 흐름 |
| `memory-schema.ts` | LanceDB row schema 참고 | sessions schema와 row 모양 통일 |
| `openclaw-runtime-memory.ts` | runtime 사용 패턴 참고 | host SDK 사용법 |
| `embeddings-debug.ts` | doctor 디버그 | run.sh `doctor:md` |

원칙:

- **포팅이지 dependency 추가가 아니다.** openclaw 패키지를 직접 import하지 않고, 필요한 로직만 andenken 코드로 옮긴다 (라이선스/버전 안정성).
- 백엔드는 **무조건 sessions와 같은 LanceDB**. sqlite/sqlite-vec는 채택하지 않는다.
- chunker는 markdown 전용 (frontmatter strip, H2/H3 경계, code block 보존). org chunker는 재사용하지 않는다 — md는 헤드라인 의미가 다르고 ARCHIVE/exclusion-tag 개념도 없다.

#### run.sh 명령군 (sessions 모양)

```bash
./run.sh index:md [--force]
./run.sh sync:md              # incremental
./run.sh verify md
./run.sh search:md "<query>" --limit 5
./run.sh status:json          # md section 포함
./run.sh doctor --md          # read-only triage
./run.sh golden               # md 카테고리 추가 (선택)
```

(Optional later surface)

```ts
knowledge_search({ query, source: "md" })
```

#### 진행 순서

1. **B0 commit** (qmd 흔적 제거) → 단일 commit `chore(qmd): retire qmd path`
2. **B1a** — 새 파일 골격: `md-chunker.ts`, `md-indexer.ts`, store 분기, manifest, env loader. provider는 sessions OpenRouter 어댑터를 그대로 재사용 (env namespace만 다름).
3. **B1b** — smoke index (notes 20~50 / bib 10~30 / meta 20~50 / botlog 10~20 / journal 5~10). 대표 쿼리 10개:

   ```text
   보편 학문
   피투성
   어쏠로지
   바네바 부시
   제프 베이조스
   andenken openclaw
   entwurf 시간축
   일일일생
   2026-05-11 andenken
   디지털가든 메타휴먼
   ```

4. **B1c** — full index (`2,218` md / 27.2MB). verify dim 4096d / row count consistency / duplicate ID 검사 / orphan 검사.
5. **B1d** — `knowledge_search({ source: "md" })` 노출 (선택).

#### 비목표 / 금지

- qmd 어떤 부분도 다시 채택하지 않는다. local GGUF / rerank / query expansion 전부 비목표.
- org-derived markdown 경로는 **B1c 안정 후** 별도 단계. 지금은 garden export만.
- org chunker / store / manifest는 건드리지 않는다. org 트랙은 별도 보류.
- openclaw npm 패키지 의존 추가하지 않는다. 로직만 포팅.

## 보류 — org 트랙: 업스트림 R&D만, production disable

org 트랙은 production에서 disable. `./run.sh index:org` / `./run.sh
sync:org`는 일반 운영 흐름에서 호출하지 않는다. doctor WARN 정리는 별도
이슈로 분리하고, 그 자체로 release-blocking이 아니다.

doctor WARN 3건 (2026-05-11 baseline triage):

| 신호 | 카운트 | 분류 가설 |
|------|------:|----------|
| `malformedBlockFiles` | 10 | source 손상 + chunker 패턴 부족 혼재 |
| `zeroChunkUnexpectedFiles` | 4 | chunker가 본문을 exclusion으로 잡거나 빈 본문 |
| `hardGuardSkipTotal Δ+2` | 2 | 새 파일이 hard guard 패턴 트리거 |

상태 스냅샷 (2026-05-07 기준):

| 항목 | 값 |
|---|---:|
| org rows | 44,916 |
| org files | 2,199 / indexed 2,025 |
| new / stale / deleted / to_index | 7 / 541 / 6 / 548 |
| dim | 2560d |

## 별도 이슈 — dictcli expansion 보정

andenken 작업은 아니지만 품질 검수에서 발견:

- 문제: `초기` → `enactment`, `establishment`, `institution` 등으로 확장.
- 기대: `initial`, `early`, `beginning`, `earlystage`.
- 영향: Korean→English mixed query에서 query enrichment가 엉뚱해질 수 있음.
- 처리 위치: `dictcli` vocabulary graph. andenken에서는 증상만 기록.

## 외부 의존 / 주의

- sessions와 md는 같은 8B/4096d, org는 4B/2560d. **3개 DB/provider** 차원을 섞지 않는다.
- OpenRouter Qwen3-Embedding-8B 가격: `$0.01/M` 기준.
- long-lived pi/extension은 코드 변경 후 재시작해야 새 `knowledge_search` schema를 읽는다.
- `./run.sh golden`은 트랙별 provider로 자동 분기. 한쪽 env unset이면 그 분기 호출 시 `process.exit(1)` 명시 에러.

## 관련 문서

- [ROADMAP.md](./ROADMAP.md) — 정체성 / 비교표 / 변화 기록
- [AGENTS.md](./AGENTS.md) — 정체성 / 경계 / 담당 원칙
- [INVARIANT.md](./INVARIANT.md) — 깨지면 안 되는 규칙
- `./run.sh` — 운영 메뉴
- Issue #8 — qmd 폐기 + md direct embedding 전환
- `/home/junghan/repos/3rd/openclaw/packages/memory-host-sdk/src/host/` — md 빌트인 로직 포팅 원본
