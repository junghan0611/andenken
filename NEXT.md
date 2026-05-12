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

### 진행 현황 (2026-05-12)

- **B0 완료** — commit `0831487` `chore(qmd): retire qmd path; split org from agent-facing surface (#8)`. 신규 qmd 파일 7개 삭제 + test.ts/run.sh/tsconfig 수술 + 4개 문서 정렬. 2,661줄 제거, 317줄 추가. tsc 클린 + unit 71/0/0.
- **B1a 완료** — md 트랙 골격. commit `b431bf7` `feat(md): scaffold md track — public garden direct embedding (#8)`. 1,344줄 추가 / 45줄 제거.
  - 신규 `md-chunker.ts` (~470줄). Hugo frontmatter strip + heading-bounded segmentation + 코드블록 보존 + per-folder 크기 정책 + 12K hard guard + sha256 chunk hash + denote-id 자동 추출.
  - `store.ts`: `getMdDbPath()` → `data/md.lance` (sessions/org와 별도).
  - `embedding-provider.ts`: `createMdProviderFromEnv()` (`ANDENKEN_MD_*` namespace, legacy fallback 없음).
  - `indexer.ts`: `indexMd(force)` (sessions 미러 + paid-remote gate), `MdFileManifest`, `collectMdStatus()`, dispatch `case "md":`, compact/cleanup/verify에 md 분기, status 출력에 md 라인 추가, org는 "disabled in production" 라벨.
  - `cli.ts`: `searchMd(query, limit)` + `search-md` dispatch + `mdDbPath`. hybrid + dictcli expand + MMR. recency half-life 90d.
  - `run.sh`: `index:md` / `sync:md` / `search:md` 명령군 + help 텍스트. compact/cleanup/verify target에 md 추가.
  - `tsconfig.json`: `md-chunker.ts` 등재.
  - `test.ts`: `testMdChunker()` (27 assertions). 전체 suite 98/0/0.
  - 검증: tsc 클린, real garden `findMdFiles` 2,210 files (bib 678 / botlog 63 / journal 94 / meta 538 / notes 837), `./run.sh status`에 `📝 MD: not indexed yet` 신규 라인.
- **env 셋업 완료** — GLG가 `~/.env.local`에 `ANDENKEN_MD_*` 활성, `ANDENKEN_ORG_*` / `ANDENKEN_VLLM_*` 주석 처리. `createMdProviderFromEnv()`가 정상적으로 `vllm (md:openrouter) (4096d, paid)` 만드는 것 확인.

### B1a-rev — gpt-5.5 리뷰 반영 완료 (2026-05-12, commit pending)

GPT 리뷰 + GLG 추가 지시(openclaw md 방식 충실 포팅 / CJK 고려 / decay 비활성화)를
한 번에 반영. 검증된 효과는 estimate:md 측정에서 바로 보임 — chunks/file 17.5 →
4.7, full 비용 추정 $0.35 → $0.097. preset도 잡힘.

핵심 변경:

| 영역 | before | after |
|---|---|---|
| chunker | heading-aware H2~H6 + enrichText 4줄 prefix | **OpenClaw `chunkMarkdown` 그대로 포팅** + CJK weighting + body-only embedding |
| chunks/file (실측) | 17.5 (p50 194c) | 4.7 |
| full cost (실측 추정) | $0.35 (avg chunks/file 26 기반) | $0.097 |
| recency decay | 90d (knowledge와 동일) | **0 (off)** — 가든은 시간축이 본질 아님 |
| role | "" (공란) | **"doc"** — sessions와 union 검색 시 분류 가능 |
| paid-remote gate | --force 시에만 | --force OR 첫 full run (DB 비어있고 manifest 없음) — first paid index도 명시 confirm 필수 |
| partial-run safety | manifest checkpoint 100 files, ghost zone skip | checkpoint **25 files**, ghost zone(`indexed && !manifest[f]`)을 staleFiles로 → 자동 재인덱싱 |
| cleanup md | 미구현 | **manifest repair 추가** (org와 동일 분기) |
| estimate md | 없음 (메시지만 안내) | **`./run.sh estimate:md`** 구현 — CJK-weighted, per-folder 분해 |
| verify md | org provider dim 비교(false warning) | md provider dim 직접 비교 |
| cli.ts status JSON | md 없음 | md 섹션 포함 |
| preset 매칭 | OpenRouter lowercase `qwen/qwen3-embedding-8b` → preset 미적용 (batch=64, no instruction) | **case-insensitive** → preset `Qwen/Qwen3-Embedding-8B` 잡힘 (batch=100 + instruction) |
| frontmatter TOML | delimiter strip만 | `key = value` 파싱 추가 |

GPT 리뷰 10개 응답:

| # | GPT 답변 | 우리 처리 |
|---|---|---|
| 1 | 청크 정책: 과분할. H2/H3까지만 + coalescing 필요 | **OpenClaw 알고리즘으로 교체** (heading boundary 폐기, GLG 지시) — 더 강한 해결 |
| 2 | enrichText: anchor 제거 + description 첫 청크만 | **enrichText 자체 폐기** (OpenClaw style) — title/desc/tags는 metadata only |
| 3 | fence detection: heading은 OK, splitSegment가 fence 쪼개기 가능 | 새 chunker는 line-based라 fence-aware 불요 |
| 4 | JSON FM: corpus 없음, 비블로커 | 그대로. TOML `=` 파싱은 추가 |
| 5 | denote-id: 파일명 충분 | 파일명 유지 |
| 6 | chunk id: `filePath#chunkIndex` OK | 유지. hash는 metadata에 박힘 |
| 7 | role: "doc" 권장 | **"doc"으로 변경** |
| 8 | recency 90d: garden은 짧을 수 있음, 별도 decay | **decay off** (GLG 지시) |
| 9 | paid gate: 첫 인덱스도 게이트 필요 | **첫 full run 게이트 추가** |
| 10 | partial-run safety: 고쳐야 함 | **getStaleFiles 분기 수정 + cleanup md manifest repair + checkpoint 25 files** |

GPT non-blocker 2건:

- verify md provider dim: **md provider 직접 사용**
- cli.ts status JSON: **md 섹션 추가**

수정 파일:

| 파일 | 변경 |
|---|---|
| `md-chunker.ts` | 재작성 (~530줄, OpenClaw `chunkMarkdown` 포팅 + CJK weighting `estimateStringChars`/`estimateTokensFromChars` 포팅 + heading-aware/enrichText/hierarchy 폐기 + role=doc) |
| `indexer.ts` | getStaleFiles ghost-zone fix + indexMd paid-remote 강화 + checkpoint 25 + cleanup md manifest repair + estimateMd 구현 + verify md provider 정확화 |
| `cli.ts` | searchMd `recencyHalfLifeDays: 0` + status JSON에 md 섹션 |
| `model-presets.ts` | getModelPreset case-insensitive (정확/basename 둘 다) |
| `run.sh` | `estimate:md` 명령 + help 텍스트 |
| `test.ts` | testMdChunker 새 shape 대응 (CJK weighting 5개 assertion, role="doc", TOML, 큰 본문 분할, monotonic chunkIndex) |

검증:

- tsc 클린
- unit 115/0/0 (+17 from previous 98)
- `./run.sh estimate:md` 실측: 2210 files / 10,297 chunks / avg 4.7/file / ~9.7M tokens (CJK-weighted) / **$0.097** estimated
- preset 로그: `📋 md:openrouter preset: qwen/qwen3-embedding-8b (4096d, batch=100)`

### B1a-rev2 — gpt-5.5 2차 리뷰 + 가든 품질 감사 반영 (2026-05-12, commit pending)

분신(gpt-5.4, cwd=`~/repos/gh/notes`) 가든 품질 감사 결과 + gpt-5.5 2차 리뷰
세 항목을 한 라운드에 정리.

#### 가든 품질 감사 결과 (분신 task-id 34796430)

| 폴더 | files | body p10 | p50 | p90 | max | stub<200 | oversize>20K |
|---|---:|---:|---:|---:|---:|---:|---:|
| notes | 837 | 860 | 3,292 | 14,501 | 290K | 0 | 49 |
| bib | 678 | 1,272 | 4,946 | 17,751 | 178K | 0 | 51 |
| meta | 538 | 1,065 | 3,498 | 10,448 | 42K | 0 | 13 |
| journal | 94 | 2,547 | 10,248 | 39,501 | 71K | 0 | 25 |
| botlog | 63 | 3,480 | 10,707 | 33,536 | 54K | 0 | 17 |

핵심 관찰:

- **strict stub은 0건** — Hugo export가 description + [!abstract] 자동 주입.
  실전 stub은 sanitized body < 250 (notes 20 / bib 1 / meta 6).
- **bib ToC dump**: 목차 헤딩 112건, severe (페이지번호 나열) 3건.
- **영→한 병치 중복** (영문 단락 + 한국어 단락 반복): notes 146 / bib 74 / meta 33.
- **journal CITATIONS tail** (`## CITATIONS` 이후 citeproc anchor 다수): journal에 가장 심함, anchor 30+개짜리 다수.
- **footnote/bibliography tail**: notes/bib에도 파일 후반부에 붙는 경우 多.
- **heading-only shell**: notes 6 / meta 2 / journal 1.

분신 권장 sanitization 정책 (high-impact / low-risk만 이번 라운드에 반영):

| 항목 | 처리 | 다음 라운드 |
|---|---|---|
| `noembed` / `tts` frontmatter opt-out | **반영** (NOEMBED_TAGS set) | |
| `MIN_CHUNK_CHARS` 40 → 100 | **반영** | |
| `MIN_FILE_BODY_CHARS = 250` | **반영** (sanitize 후 250 미만 skip) | |
| `## CITATIONS` / `## BIBLIOGRAPHY` / `## REFERENCES` / `## RELATED-NOTES` tail strip (50% char 이후만) | **반영** (`stripBibliographyTail`) | |
| 영→한 병치 collapse | — | 패턴 매칭 false positive 위험 |
| 책 ToC dump 패턴 제거 | — | 패턴 정확도 추가 검증 필요 |
| heading-only shell skip | — | 임팩트 작음 |

#### gpt-5.5 2차 리뷰 (3개)

| # | 지적 | 처리 |
|---|---|---|
| 1 | metadata (title/tags)가 LanceDB FTS에 안 잡힘. 현재 chunk.text=body-only이므로 title/tag 쿼리 약함 | **반영** — MdChunk를 `embeddingInput` (body-only, vector용) + `text` (Title+Tags+body, FTS용)으로 분리. `mdChunkToStoreRow`는 chunk.text를 store row로 넣음. embedding 비용은 그대로 (body-only), FTS surface만 enriched. |
| 2 | searchMd에 short CJK fallback 없음 — 1-2 char Hangul 쿼리 0-hit 가능 | **반영** — searchSessions 동일 패턴(getShortCJKTokens + substringSearch + RR interleave) 적용 |
| 3 | gate 메시지 `./run.sh estimate md`는 legacy. 실제는 `./run.sh estimate:md` | **반영** |

#### 측정된 효과

| 지표 | 1차 (rev1) | 2차 (rev2) | 변화 |
|---|---:|---:|---:|
| files | 2,210 | 2,192 | -18 (stub 제거) |
| chunks | 10,297 | **10,119** | -178 |
| journal chunks | 1,009 | **936** | -73 (CITATIONS tail strip 정상 작동) |
| notes files (chunks 출력) | 837 | 823 | -14 (stub) |
| meta files | 538 | 535 | -3 |
| bib files | 678 | 677 | -1 |
| cost (estimated) | $0.0974 | **$0.0956** | -1.9% |

#### 수정 파일

| 파일 | 변경 |
|---|---|
| `md-chunker.ts` | NOEMBED_TAGS / MIN_CHUNK_CHARS 100 / MIN_FILE_BODY_CHARS 250 / stripBibliographyTail (char-position 50%) / MdChunk에 `embeddingInput` 필드 분리 / buildFtsText (Title+Tags prefix) / mdChunkToStoreRow는 chunk.text(enriched)를 row.text로 |
| `indexer.ts` | `provider.embedDocumentBatch(chunks.map(c => c.embeddingInput))` / estimateMd도 embeddingInput 기반 / gate 메시지 `./run.sh estimate:md`로 수정 |
| `cli.ts` | searchMd에 short CJK fallback (sessions 패턴) |
| `test.ts` | embedding/FTS 분리 검증 / noembed opt-out / CITATIONS tail strip / bib early bibliography 보존 |

검증: tsc 클린, unit **125/0/0** (+10).

### B1b — 본 임베딩 (env confirm 후 즉시 실행)

paid-remote gate 통과 필요 (`ANDENKEN_ALLOW_PAID_FULL_REBUILD=1`):

```bash
./run.sh estimate:md                            # 이미 실측: ~$0.097
ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 ./run.sh index:md  # 실제 인덱싱 (~50분 추정)
./run.sh status                                 # md count / actual_dim 확인
./run.sh verify md                              # 무결성
./run.sh search:md "보편 학문" --limit 5
./run.sh search:md "피투성" --limit 5
./run.sh search:md "어쏠로지" --limit 5
./run.sh search:md "바네바 부시" --limit 5
./run.sh search:md "제프 베이조스" --limit 5
./run.sh search:md "andenken openclaw" --limit 5
./run.sh search:md "entwurf 시간축" --limit 5
./run.sh search:md "일일일생" --limit 5
./run.sh search:md "2026-05-11 andenken" --limit 5
./run.sh search:md "디지털가든 메타휴먼" --limit 5
```

### B1b — (legacy 섹션, 위 내용으로 대체됨) 임베딩 보류 (GPT 리뷰 대기, 2026-05-12)

GLG 결정: **첫 임베딩 전에 gpt-5.5 리뷰를 통해 한 번 수정한 다음 본 임베딩 들어간다.** 한 번에 끝내자 (두세번 안 하려고).

첫 시도 부분 인덱싱 (멈춤):

| 항목 | 값 |
|---|---:|
| 진행 | 65/2210 files 인덱싱 후 중단 |
| 관찰된 chunks/file 평균 | ~26 (1703 chunks / 65 files) |
| 관찰 throughput | ~0.5 files/s (concurrency=2, OpenRouter 8B) |
| ETA full | ~72분 (4290s) |
| 추정 chunks (전체) | ~57,500 (28K~64K 사이 폭) |
| 추정 tokens (전체) | ~35M (chunks × ~600 tokens) |
| 추정 cost (full) | **~$0.35** at $0.01/M |
| ETA cost 갱신 | 2026-05-12 09:24 KST 기준. 첫 50개 평균 22 chunks/file. |
| 부분 인덱스 처리 | `data/md.lance` + `data/md-manifest.json` 삭제 후 clean. 다음 인덱스는 처음부터. |

**예상보다 chunks/file이 큰 이유 (리뷰 포인트 후보)**:

- Hugo export 본문에 frontmatter 외에도 footnotes / 참고문헌 블록이 길게 붙어 청크 수 증가
- meta/notes 폴더의 큰 파일(특히 메타뷰)이 maxChars 4000 기준 다수 분할
- per-folder config: `meta: 6000, bib: 4800, notes: 4000` 인데 실효치 평균이 이보다 작게 잘리는 듯 → splitSegment의 paragraph 경계 분할이 너무 공격적일 수 있음
- enrichText 프리픽스가 매 청크에 붙어 토큰 부풀림 (Title + Description + Path + Tags 4줄)

### B1b-pre — GPT 리뷰 대기 (지금 단계)

GPT에게 보여줄 review surface:

| 파일 | 라인 | 핵심 |
|---|---:|---|
| `md-chunker.ts` | ~470 | 가장 큰 변경 면. 청킹 정책 자체. |
| `indexer.ts` | +316 | `indexMd()` + manifest + dispatch. 패턴은 sessions와 거의 동형. |
| `cli.ts` | +100 | `searchMd()`. hybrid weights는 knowledge와 동일. |
| `embedding-provider.ts` | +48 | `createMdProviderFromEnv()`. sessions 미러. |
| `store.ts` | +9 | `getMdDbPath()`. |
| `run.sh` | +23 | 명령 등록. |

검수 권장 포인트 (GPT에게 명시):

1. **chunker 청크 크기 정책** — per-folder maxChars / overlap이 가든 export 실데이터(observed 22~26 chunks/file)에 맞나? 더 큼직하게 잘라도 retrieval 품질이 유지될지?
2. **enrichText 프리픽스** — Title/Description/Path/Tags 4줄을 매 청크에 prepend하는 게 비용 효율 OK인가? 첫 청크만 enrich + 나머지는 hierarchy만 붙이는 변형 가능.
3. **fence detection** — `^\s{0,3}\`\`\`` 또는 `~~~` 만 본다. inline backtick(\`code\`)는 영향 없음. nested code (예: org-src-export) 케이스가 가든에 있는지?
4. **frontmatter parser** — YAML/TOML만 처리, JSON frontmatter는 body로 흘림. 가든에 JSON frontmatter md가 있는지 확인.
5. **denote-id 매핑** — `parseDenoteId` 파일명에서만 본다. frontmatter `identifier` 필드도 같이 보는 게 좋은지?
6. **chunk id 안정성** — `id = filePath#chunkIndex`. 파일 변경 시 chunkIndex 시프트되면 stale chunk 정리는 manifest 기반 `wb.add()` 자동 delete가 처리하지만, 검색 결과 영속 ID 관점에서는 hash-based ID가 나은지?
7. **role 필드 공란** — store 스키마의 `role`을 "" 로 두는 게 그대로 OK인지, "doc" 같은 라벨 박는 게 좋을지 (sessions와 union 검색할 가능성 대비).
8. **search recency half-life 90d** — knowledge와 동일하게 했다. 가든은 시간순이 본질이 아니라 더 길게 가야 할 수도(180d / 365d). journal 폴더만 짧게 하는 것도 옵션.
9. **paid-remote gate** — `--force` 일 때만 ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 require. 첫 인덱스는 indexed=empty라 사실상 full인데 gate 안 발동. 의도된 것인지 (sessions도 같은 동작) 명시 필요.
10. **partial run safety** — 인덱싱을 중간에 끊었을 때 manifest checkpoint 사이의 chunks가 DB에 들어가지만 manifest에는 안 박힐 수 있다. 그 파일은 다음 incremental에서 stale로 안 잡힐 수 있다(파일이 indexed Set엔 있지만 manifest entry는 없음). 코드상 그런 케이스가 getStaleFiles의 `if (!entry) continue;` 분기에 빠지는데, 그게 안전한지 (= "already indexed elsewhere, just record" 의도).

GPT 결과 수령 → 수정 → tsc/unit pass → 본 임베딩 (`./run.sh index:md`) → search smoke 10개 → verify md → B1c (full 안정화 + 비용 정산) → B1d (MCP 노출).

### B1b 본 임베딩 (GPT 리뷰 통과 후 실행)

env는 이미 셋업되어 있으므로:

```bash
./run.sh status                         # confirm md = not indexed yet
./run.sh index:md                       # ~50~75분, ~$0.35 추정
./run.sh status                         # md count / actual_dim 확인
./run.sh verify md                      # 무결성
./run.sh search:md "보편 학문" --limit 5
./run.sh search:md "피투성" --limit 5
./run.sh search:md "어쏠로지" --limit 5
./run.sh search:md "바네바 부시" --limit 5
./run.sh search:md "제프 베이조스" --limit 5
./run.sh search:md "andenken openclaw" --limit 5
./run.sh search:md "entwurf 시간축" --limit 5
./run.sh search:md "일일일생" --limit 5
./run.sh search:md "2026-05-11 andenken" --limit 5
./run.sh search:md "디지털가든 메타휴먼" --limit 5
```

검수 기준:

- Korean concept recall: notes / meta / botlog가 맞게 뜨는가
- person/work recall: bib + related notes가 연결되는가
- bilingual mixed query: Korean + English proper noun이 함께 살아남는가
- latency: OpenRouter 8B는 query 1회 200~600ms 예상 (sessions와 동일)
- cost: 실제 stats 출력으로 추정 vs 실측 비교

### B0 — qmd 흔적 제거 (단일 commit) — 완료

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

1. **B0** (qmd 흔적 제거) — 완료. commit `0831487`.
2. **B1a** — md 트랙 골격. 완료. commit pending (이 작업).
3. **B1b** — smoke index. ANDENKEN_MD_* env 셋업 후 `./run.sh index:md` 실행. 위 10개 대표 쿼리로 search:md 품질 점검.
4. **B1c** — full index 안정화. verify dim 4096d / row count / orphan / duplicate ID 검사. 비용 정산.
5. **B1d** — `knowledge_search({ source: "md" })` MCP/registerTool 노출 + agent-config `semantic-memory` 스킬에 md 트랙 안내.

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
