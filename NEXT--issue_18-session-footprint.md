# NEXT — #18 session footprint

Issue: [andenken#18](https://github.com/junghan0611/andenken/issues/18) (open).
Branch: `issue/18-session-footprint`, based on `98d6fa41eee87d52d4b3a804917974eb208b160d`.
Updated: 2026-11-02. This is the branch handoff; leave main `NEXT.md` unchanged.
Issue #15 is the closed durable-snapshot integration, not this workstream.

# RAIL — Current position

- [x] **1. Recover intent and establish evidence** — historical investigation, two search calls, one corpus profile, model-source research and artifact cross-review complete.
- [x] **2. Define the first candidate boundary** — one selected DB only; opt-in control-v1, original-readback preservation, existing short-remainder protection and mandatory outbound safety holds. Broader semantic admission remains deferred.
- [ ] **3. Validate candidate rules and estimate net effects** — CURRENT: opt-in selector/plan code and safety revisions passed main review and synthetic revalidation; agree the one real API-0 plan scope. No real plan or candidate write yet.
- [ ] **4. Build and verify a candidate representation** — PAUSED: reviewed plan, code sign-off, disk budget, human paid-full gate and retrieval/readback acceptance required.
- [ ] **5. Rebuild, cut over and retire old representations** — PAUSED: scoped execution approval, human full-rebuild gate, preservation/rollback budget and publication approval required.

Position: evidence complete -> admission design -> bounded validation -> implementation/acceptance -> approved cutover. No production change has started.

# NOW

- **Stem:** preserve session originals while making the searchable session representation smaller and useful as decision evidence. Sessions only; md, OpenClaw and org are out of scope.
- **Current direction:** keep the existing Qwen3-Embedding-8B frame for this discussion. Model alternatives remain parked, not rejected. This does not adopt a smaller dimension or permanently fix 4096d. The user intends a full session re-embedding for this initiative; settle selection, source-integrity/readback and execution planning first.
- **Next:** agree and execute at most one reviewed real API-0 plan (JSONL corpus plus the existing admitted closed durable snapshot), with no retry and no paid calls. Local commit was requested; push was not. The safety revision addresses the reproduced chunk-boundary bypass with whole-message holds, reduces durable failures to fixed codes, guards canonical/non-symlink inputs, pins durable bytes before/after dry-run, and exposes invalid-JSON counts. Then agree one real API-0 plan run (JSONL plus the one existing admitted closed durable snapshot); neither that run nor a paid candidate build has happened. Scope: opt-in control-v1 L/N/D selector, legacy-default identity, original-eligibility-based short-remainder preservation, explicit sanitizer conflicts and mandatory sensitive-risk holds. No S/summary/dedup/compaction fixes or new short-turn admission. Then authorize at most one full API-0 source plan including existing closed durable B.1 coverage. No second reference DB; no paid build, cutover, publish or deletion yet. Private `candidate-v1-main-decisions.md` records the review decisions.
- **Source findings:** `ANDENKEN_DATA` changes DB and manifest paths together (`store.ts:165`), but a fresh non-force index bypasses the current force-only paid-full guard (`indexer.ts:505`). Candidate full work must retain that guard. Existing `rebuild-sessions-full.sh:139–154` deletes the active DB/manifests and must not be reused unchanged for this experiment.
- **Capacity preflight, 2026-11-02 13:47 KST:** filesystem metadata only: sessions directory allocated 9,284,018,176 B, apparent 9,280,475,397 B; root available 15,713,447,936 B. JSON manifests record 3108 JSONL files / 121739 chunks plus one durable file / 103 chunks; not a Lance row-count verification. Candidate coverage must account for admitted closed durable B.1 and report discovery differences, not silently attribute omissions to better selection. No Lance body/store or live SQLite was opened. Subsequent metadata-only comparisons found both session discovery/manifest sets equal (3108, both differences 0) and durable discovery/manifest sets equal (1, both differences 0). The inherited 333-entry garden-id count is not current-manifest evidence; unmanifested Lance rows remain unmeasured. Skill-body stripping needs invocation-name/argument preservation; summary reduction, canonical peer content and contextual short-turn grouping remain separate decisions. X10 notice lookalikes and X15 pasted skills are unresolved; no production filter is adopted.
- **Key policy questions:** distinguish actual human input from generated wrappers/summaries; distinguish answers to that input from worker-run conclusions; define canonical peer bodies and source coordinates without indexing every transport envelope twice.
- **Preserve:** the existing file admission (`size > 200 * 1024`, current filename/tmp/basename-dedup rules), full original human text and original-source lineage. Short approvals, rejections and stop requests need an explicit policy; the message-length floor is not the file-size floor.
- **Uncertainty:** role=user is not authenticated human origin; stop/end_turn is not proof of an answer to the human; toolUse does not prove a passage is worthless. Keep unknowns explicit. Never reattribute quoted text to the quoted speaker as a direct turn.
- **Scope:** branch publication remains `552efa0`. GLG subsequently chose preparation of ONE selected candidate. Phase 1 permits opt-in source changes and confirmed-synthetic tests, not default production behaviour changes, real-corpus body execution, real snapshot opens, paid rebuild, GC, SSH, dist rebuild/reload or automatic commit/push. The API-0 real plan and human-paid build remain separate gates.

## Dated-policy reconciliation comes first

Main `NEXT.md` contains useful historical admission work dated 2026-10-02, including injection/recipient categories and mixed human turns inside sibling sessions. Read it as evidence, not a current execution grant.

The November 2 request differs: sibling communication is a desired candidate class, and a full re-embedding is acceptable in principle after planning. Do not inherit October's blanket peer-drop rule, full-rebuild prohibition, delete/compact instructions or old approval as current policy. Do not exclude an entire sibling transcript merely because it started with an agent brief.

The old main-NEXT parked compaction-schema item is also historical context; the November static field-mismatch lead does not authorize fixing or indexing it now.

## Cross-repo contract — minimal source versioning first

[agent-config#32](https://github.com/junghan0611/agent-config/issues/32) owns source-custody policy. In its 2026-11-02 12:38 KST checkpoint, agent-config relayed the user's narrower v1: version the sessions folder, retain the existing `MANIFEST.sha256` format with its Git commit, recover the requested version in a separate reading location, and compare the retrieved file's actual SHA with that commit's ledger.

**Do not make signatures, keys, author authentication, a new garden-evidence protocol, or exact embedding-to-corpus-version equality v1 prerequisites.** Verifying retrieved source bytes does not prove that an embedding row was created from that exact version. Stronger provenance questions remain deferred; garden/native identity still belongs to Entwurf, not a duplicated registry here.

Andenken owns the compatibility side of its collection/replication/manifest/readback code, after the storage owner selects a concrete backend and both lanes agree a small test/change scope. Source code read on this branch shows two unresolved boundaries:

- `scripts/replicate-corpus.sh` rsyncs the entire corpus without excluding `.git`. `scripts/corpus-manifest.sh` walks `.git` and follows file targets while hashing/statting. Do not run either unchanged against a newly Git/annex-managed corpus. No backend migration or script repair has run.
- Excluding `.git` alone does not establish that annex symlinks resolve on the replica. Version recovery/materialization must also keep historical reading views out of ordinary gather/discovery and leave active originals untouched. Actual annex/LFS/thin-object behaviour is untested.

Keep registered-but-unmaterialized, genuinely missing and mismatched content distinct; do not add implicit network get or bypass the durable closed-snapshot/symlink boundary. Byte equality, availability, authorship and current permission remain different claims, without turning all of them into first-version implementation gates. Storage-backend selection does not block independent admission-policy design.

## Candidate admission table to resolve

| Class | Proposed searchable content | Preserve outside embedding / unresolved |
|---|---|---|
| Human dialogue | Original human input and answers actually attributable to that input | Generated injections, quotations and unknown origin must remain distinguishable; short turns may need contextual grouping rather than one vector each |
| Assistant work | Decision reasons, rejected alternatives, changed conditions, meaningful failure/recovery conclusions | Repeated progress, trial transcripts and operational dumps can return to originals; tool-use metadata alone cannot make the semantic decision |
| Peer communication | Actual questions, evidence, agreements/disagreements and corrections, with source references | Canonicalize proven duplicate bodies; keep routing/read receipts as metadata; approval/stop/scope changes are not disposable acknowledgements |
| Unknown | Explicitly undecided candidates, with counts and evidence state | Do not silently classify as human, valuable, worthless or safely removable |

These are proposals, not implemented filters. Admission changes and changing how messages are bundled/chunked are separate effects.

# EVIDENCE — closed November 2 measurements

ThinkPad, one approved read-only JSONL profile: 3108 admitted files, all stat-stable; 31 invalid JSON lines counted/skipped. API/DB/network calls and source/index writes: zero. Discovery retains inherited silent-skip limitations. Durable SQLite was not opened and is outside this denominator.

| Scenario | Chunks | Text chars | Change from baseline |
|---|---:|---:|---|
| Existing extractor | 121739 | 99868785 | Baseline; matches separate existing full estimate |
| Omit explicit toolUse/tool_use assistant text | 99313 | 94775890 | Rows -18.421%; chars -5.100% |
| Terminal-boundary/EOF heuristic | 99284 | 94762380 | Rows -18.445%; chars -5.113% |

The candidates do **not** implement the requested semantic admission policy. User-like text is 55.143% of baseline chars, not proof of direct human authorship. Observed isMeta/compact-summary record counts do not yet give their emitted text/chunk shares. The terminal heuristic relies on boundary/EOF inference for 217 retained chunks; EOF-only is not separately metered.

Raw logical vectors, **float32 assumption**, decimal GB:

| Same-denominator scenario | 4096d | 2048d | 1024d |
|---|---:|---:|---:|
| Existing rows | 1.995 | 0.997 | 0.499 |
| Explicit-tool-use exclusion candidate | 1.627 | 0.814 | 0.407 |

These are not physical 8.7G-store predictions. Text, FTS, codecs, deleted/retained data, snapshots, dependencies and transition copies are separate. A future physical comparison must distinguish a fresh same-4096d representation from dimension reduction.

Peer additions: **53693 gross candidate chunks**, including envelopes/possible duplication/unverified readback; short user-like additions: 3336. Neither is included in selected R1. Exact repeated-string occurrences are not duplicate-row counts or safe deletion amounts. Net selected size remains unresolved until canonical peer content and origin rules are adopted.

Two local session searches succeeded in 3.813s / 3.570s. This neither reproduces nor explains Oracle timeouts. Remote query embedding, local retrieval and caller deadlines remain separate possible stages.

## Evidence sources and receipts

Private host-local artifacts are pointers, not files to publish or copy into this branch:

- `~/.local/state/andenken/investigations/20261102-selection-estimate/RESULTS.md`: measured results, limitations and cross-review receipt.
- Same directory `README.md`, `profile.mts`, `profile.fixture.mts`, `fixture.log`, `report.json`: approved exact argv/imports, 36 synthetic checks and the single real-corpus result. Do not rerun to recover the same table.
- Same directory `SAMPLE-PLAN.md`, `sample-main.md`, and `sample-review.md`: six-source exploratory scope/bias, two coordinator windows and 12 peer windows (38097 peer-rendered chars); peer pre/post receipts match. Revised sample report SHA256 `3fc80344e0837d69120e98267d3b2554755993d3b5688b51ede759f2e1a67d32` (0600; 16009 bytes). Whole-corpus effects are not inferred from this sample.
- Sample findings: Pi native tool reasoning was already excluded in the observed case; Pi+ACP mixed tool traces and final answers inside ordinary assistant text; some CC tool-use and aborted text contained valuable decisions. Equal-length template candidates are not proven duplicates. A potentially sensitive ACP trace path is a private safety lead: do not copy values; current DB presence, historical provider transmission and current validity remain unverified.
- `admission-candidate-v1.md` and `admission-candidate-v1-addendum-A.md`: private proposal and producer-source corrections, not adopted code. Residual indistinguishable notice/model-text and pasted/generated-skill cases remain explicit.
- `sample-api-signature-check.md`: a subsequent approved metadata-only pass on F3/F4 found ACP api/provider on all 88 assistant messages and 179 lifecycle-marker text blocks. That marker is not a cryptographic signature; counts are neither vector-row savings nor whole-corpus coverage.
- Private dry-run v2: main reviewed source/guards/content-identity tests and artifact hashes; synthetic receipt: 28 PASS, 2 RESIDUAL, 0 FAIL. The approved one-time real run finished 13:15:32–13:15:37 KST, exit 0, no retry, held/error 0; source-state receipts match the earlier samples. No production path or indexing operation ran. Old-space setting: 1536 MiB; reported V8 heap limit: 1728 MiB, not an RSS cap or measurement.
- `select-dryrun-sample.json` SHA256 `567eb38814468b96ee1103a1396676509958423163b53a13ad5b5b27071a91b0`; main verified the hash and counters. `select-dryrun-result.md` SHA256 `3860b1d441beb22679329fa4b1cd9aa4b1b7cb50ea121d3e95284bf9046dbe44`; run log SHA256 `b487be10e9e81ff4fe548ea82bd38ac155979b674cf463cf9ee75b22e9576c41`. Same private directory; no source reread is needed.
- Measured file-specific alternatives: exact doorbells F1 1110→864 rows, F2 1172→734; lifecycle/tool-notice mode F3 134→116, F4 126→86 (87 under floor preservation). F5/F6 unchanged. More aggressive C strips two F4 skill wrappers: 71 rows (72 preserved). No corpus extrapolation or physical-space claim.
- All unexpectedDiff/unexplained/newly-emitted/noise/sanitize-drop counters are zero, but F4 L88 has 52 unselected characters that fall below the existing floor after cleanup. `floorPreserved` is hypothetical accounting, not adoption of standalone short vectors; these counters do not authenticate recipient or semantic value. The first production scope must protect against this silent-loss path.
- Report SHA256: `4c00e60f1c27a1ccf8065ec414d333f6ddc16fc24266e35e0336d471988599eb` (0600; 7525522 bytes). Agent-config independently checked artifact sums/matrices, not another corpus scan.
- Existing full-estimate receipt: `~/.pi/durable-background/1793581992484-2b71c88f.log` (30.408s; configured token-price estimate about $0.40, not billed usage).
- Single profile receipt: `~/.pi/durable-background/1793583428100-90aec1df.log` (59.243s; exit 0; approved source hashes stable).
- Model survey: `~/tmp/opus-embed-754cad-20261102/REPORT.md`, revised SHA256 `12f487dab3ca1fc27ab0b7bbb68a6ae6b1f4cf17333a151c8c3dce0b1d3477b1`. Model/provider availability, same-space compatibility and input-retention limits remain conditional; no model was adopted.
- Historical #18 storage evidence: main `NEXT.md` pause section and `~/.local/state/andenken/PAUSE--20261025.md`. Captured v4069 is not today's store. Outside the captured reference union is not certified garbage; the old strict synthetic experiment failed and its fresh control did not run.

# VERIFICATION AND GATES

- Before implementation: explicit admission truth table, attribution/unknown rules, canonical peer/source-coordinate handling and the treatment of short/quoted/generated input. Align readback with #32's minimal Git-version/ledger/actual-SHA v1; do not require stronger identity/signature protocols or exact embedding/source-version correspondence.
- Before a new sample or estimate: bounded source scope, fixed denominator/code/argv, no text leakage, changed/error/unsupported counts, and review. Existing aggregate flags cannot be converted into invented byte savings.
- Before adopting a candidate: recover real decisions/reasons and resolve originals; distinguish corpus gaps from ranking misses. Component/CLI health is not human usability acceptance or proof of native-tool parity.
- Before physical work: separate fresh-write effects, content selection and optional dimensions; estimate cost/time, normal/peak budget, retained generations and rollback. Adding a smaller DB without retiring an approved old representation can increase disk use.
- Before production: source-code sign-off, one writer, wrong-dimension preflight before paid calls, explicit preservation and execution approvals. Keep the interactive full-rebuild gate; willingness to rebuild is not permission to bypass it. Sessions DB, JSONL/durable manifests and corpus travel together only when publication is requested.
- Preserve `~/.local/state/andenken-issue16/20261015T221239/` (v3832), corpus originals, approved durable snapshots and prior investigation archives. No forced deleteUnverified, manual suspect-file deletion or live durable-store access.

# RECENT

- 2026-11-02: GLG requested a local commit after review. Main type check and confirmed-synthetic selection/sanitize/excerpt/window/durable suites passed, 14:29:34–14:30:01 KST; source hashes stayed fixed. Selection: 37 passed, 0 failed, X10 residual. Receipt: private `commit-check.CJKlVZ.log`, source receipt `commit-source.cBPFEx.sha256` in the investigation directory. No real-corpus plan, candidate DB creation, dist rebuild/reload or push.
- 2026-11-02: GLG paused policy adoption to review physical size benefit. Under the existing float32/4096d arithmetic, a hypothetical 20% row reduction saves about 0.37 GiB of uncompressed vectors, not 20% of the reported 8.7G directory. Historical current-base refs were about 2.22 GiB, excluding other storage; they are neither a fresh-DB size nor current reclaimability proof. Physical target unmeasured.
- 2026-11-02: observation-only corpus profile and artifact cross-review closed; production code, originals, DB, provider/model/dimensions unchanged.
- 2026-11-02: six-source reading, producer-format checks, synthetic counterexamples and one sample-only dry-run closed with the existing Opus. First policy adoption and code scope are next; no new worker, production change, DB write or wider rescan. Agent-config separately owns the narrowed source-version/ledger work.
- 2026-11-02: user requested the #18 branch/rail, then explicitly requested its commit/push and notification to the existing Opus. Main `NEXT.md` is intentionally untouched. Agent-config is preparing the related session-custody/integrity initiative; no corpus migration or rebuild has run here.
- Coordination: this lane owns routing; agent-config supports consumer requirements/cross-review. Existing peers are collaborators, not permission to start another worker or resume a retired session. Completion notifications for this initiative have one sender; do not repeat the already-delivered completion DM.

Before merging, promote durable outcomes and remove this disposable branch NEXT. Do not revive unrelated main-NEXT queues or parked experiments automatically.
