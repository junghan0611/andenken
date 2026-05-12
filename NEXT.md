# NEXT — andenken

> 정체성 / 비교표 / 변화 기록 / 운영 신호 / 역할 분담은 [ROADMAP.md](./ROADMAP.md).
> 이 파일은 **andenken 담당자가 지금 진행 중인 단 하나의 다음 항목**만 잡는다.
> 완료된 긴 히스토리는 ROADMAP.md / commit log로 보낸다.

## Next — B1c: md embedding production hardening

**단 하나의 현재 우선순위:** md 임베딩을 실제 agent-facing knowledge axis로 안정화한다.
Org semantic 강화보다 md 고도화가 먼저다. Org는 production disabled / upstream R&D로
분리되어 있고, 지금 담당자의 역할은 agents가 당장 쓸 수 있는 `md.lance`를 로컬과
Oracle 양쪽에서 믿고 쓰게 만드는 것이다.

### Current state (2026-05-12)

Issue #8 is closed. qmd path retired, md direct embedding track implemented.

Completed commits:

| commit | meaning |
|---|---|
| `0831487` | B0 — retire qmd path; split org from agent-facing surface |
| `b431bf7` | B1a — scaffold md track over public garden Markdown |
| `db99aa2` | B1a-rev1 — port OpenClaw `chunkMarkdown`, CJK weighting, decay off, preset fix |
| `6d5ad90` | B1a-rev2 — embedding/FTS split, short CJK fallback, garden audit sanitizers |

Measured baseline before full index:

```text
./run.sh estimate:md
files to index: 2210
chunks: ~10,119
avg chunks/file: 4.6
estimated tokens: ~9.56M
estimated cost: ~$0.0956
```

GLG started the first paid full md index:

```bash
ANDENKEN_ALLOW_PAID_FULL_REBUILD=1 ./run.sh index:md
```

Expected outputs:

```text
data/md.lance/
data/md-manifest.json
```

### Definition of done for B1c

Do not move back to org work until these are true.

1. **Local full index completed**
   - `./run.sh status` shows MD indexed with actual dim `4096d`.
   - `./run.sh verify md` passes.
   - Manifest and DB agree well enough for incremental sync (`md-manifest.json` present, no obvious ghost/orphan issue).

2. **Search smoke passed**

   Run and inspect at least these queries:

   ```bash
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

   Record failures as md quality follow-up, not as org work.

3. **pi extension / live surface aligned**
   - `index.ts` should initialize and report sessions + md, not sessions + org.
   - `knowledge_search` / fallback policy should use md as the production knowledge axis.
   - `pnpm run build` updates `dist/index.js` because pi loads `./dist/index.js` from the package.
   - Expected status direction after restart: `🧠 <sessions> sessions + 📝 <md> md chunks`.

4. **agent-config handoff aligned**
   - agent-config docs/skill surface describe sessions + md, org disabled.
   - `agent-config/run.sh` can delegate `estimate:md`, `index:md`, `sync:md`, `verify` to andenken.
   - GLG decides commit timing; no automatic commit/push by the agent.

5. **Oracle enablement prepared**
   - Preferred path: rsync the completed local `data/md.lance/` and `data/md-manifest.json` to Oracle to avoid paying for a second full embedding run.
   - Use the tracked surface, not an ad-hoc command:

     ```bash
     ./run.sh sync:md:oracle --dry-run
     ./run.sh sync:md:oracle              # rsync + remote status/verify md (API 0)
     ./run.sh sync:md:oracle --smoke      # optional one remote search:md query
     ```

   - GLG has updated Oracle `ANDENKEN_MD_*` env (`openrouter`, `qwen/qwen3-embedding-8b`, `4096d`) for query-time embeddings.
   - If rsync is not viable, only then run paid indexing on Oracle after `./run.sh estimate:md` and explicit GLG confirmation.

### Deferred md quality follow-ups

These are **not** the active item until B1c is done and real retrieval data says they matter:

- English→Korean parallel paragraph collapse.
- Book ToC dump removal (`## 목차` + page-number-heavy patterns).
- Heading-only shell skip.
- Golden query set for md search quality regression.

### Non-goal right now

- Do not reopen org semantic cleanup just because doctor has WARNs.
- Do not bring qmd / local GGUF rerank / query-expansion stack back.
- Do not add a new backend surface; keep embedding → LanceDB → hybrid retrieve.
