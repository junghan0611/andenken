# NEXT — #18 session footprint

Issue: [andenken#18](https://github.com/junghan0611/andenken/issues/18) (open).
Branch: `issue/18-session-footprint`. Preceding selection/plan commit: `bb54009`; earlier published checkpoint: `552efa0`.
Updated: 2026-11-02. Branch handoff only; leave main `NEXT.md` unchanged. Remove this file before merging after promoting durable outcomes.

# RAIL — Current position

- [x] **1. Recover intent and establish evidence** — source/model research, one corpus profile and bounded samples.
- [x] **2. Define the first candidate boundary** — control-v1, preserved originals, existing short-remainder protection, sensitive-risk holds; broader semantic selection deferred.
- [x] **3. Validate and estimate** — synthetic checks plus one full API-0 plan at bb54009.
- [ ] **4. Build and verify candidate usability** — CURRENT: candidate built at 17:20:42 KST; main independently verified size/integrity. Representative search/readback acceptance remains; no further execution tonight.
- [ ] **5. Approve cutover/publication/retirement** — PAUSED: human acceptance and explicit approvals; no default writer-policy mixing, automatic swap, Oracle push or deletion.

# NOW

- **Next session:** agree a small set of real decision-recovery queries, then verify candidate search and original readback before considering operational adoption. Paid query scope and a human usable verdict remain explicit. Check legacy-writer policy compatibility before any cutover. Keep both DBs unchanged tonight; no new query/build, swap, replication or deletion.
- **Candidate:** `~/.local/state/andenken/candidates/20261102-control-v1/`. `candidate-receipt.json` is built/attempt 2; `sessions.lance`, JSONL/durable manifests and `s0-held.json` travel together if publication is later requested.
- **Current production:** unchanged, about 8.65 GiB. The candidate is NOT live and has not freed space: both copies remain. No original session, backup or index generation was removed.
- **Policy:** opt-in control-v1 removes known ACP lifecycle blocks, strict standalone tool/permission notice grammar and exact V2 CC doorbells. Default legacy extraction is unchanged. Preserve nonempty remnants of originally eligible messages, even below the old floor; do not admit previously ineligible short turns. Sanitizer conflicts and high-signal sensitive-risk matches are held explicitly.
- **Deferred:** skill invocation/body rules, CC isMeta/command stripping, summary reduction, canonical peer admission/dedup and contextual short-turn grouping. X10 (model text identical to a notice) remains a classification assumption. role=user is not human authentication; stop/end_turn is not a recipient proof; tool_use/aborted text may be valuable.
- **Model:** existing Qwen3-Embedding-8B/4096d frame retained for this experiment. Neither smaller dimensions nor another model was adopted.
- **Ownership:** existing Opus `20261015T214249-583c57` owns the recovery implementation/experience report; main `20261015T113054-877f91` coordinates and verifies; agent-config `20261007T104525-12d0ca` owns source custody. No new worker, model switch or separate peer coordination lane is authorized.
- **Git scope:** GLG requested this branch's source/tests/docs commit and push before leaving. This does not publish the private candidate, source corpus or investigation artifacts. No dist rebuild/reload, DB cutover or cleanup is included.

# Measured result — not a prediction

Main's independent API-0 measurement: private `candidate-measure-main-final.json`, SHA256 `f306ab4d2820314c49b7c863387aa8945e2c4a7e1d97d58fff245ec26feb2292`.

| Check | Result |
|---|---:|
| Candidate rows / unique ids | 114889 / 114889 |
| Sources | Claude 89990; Pi 24796; pi-durable 103 |
| Vector dimension / FTS | 4096 / present |
| S0 detectable hits in stored chunks | 0; not proof of complete sensitive-content removal |
| JSONL manifest / DB rows | 3108 files, 114786 chunks / 114786 |
| Durable manifest / DB rows | 103 / 103 |
| Candidate sessions.lance allocated | 2045784064 B, about 1.905 GiB |
| Original sessions.lance allocated | 9284018176 B, about 8.646 GiB; directory metadata only |

The candidate is about 77.96% smaller than the old directory. This is NOT a measured selection-only effect or certified reclaimable space: the comparison mixes fresh writing, history/storage layout, selection and other representation differences. No second unselected full DB was built, per GLG's instruction. Both source manifests and original file forms were preserved.

Logical selection from the single full API-0 plan:
- JSONL legacy 121739 rows → control 114830 (−6909, 5.675%). S0 holds 44 chunks in five messages → sendable 114786; existing closed durable B.1 adds 103 = 114889.
- Eight short remainders preserved. 31 invalid JSON lines skipped as in legacy; refused/changed/errors zero. S0 kinds are credential-shaped risk matches, not validity checks; no values are emitted.
- Selection alone saves about 108 MiB of uncompressed float32 vector arithmetic. Raw candidate vector+text arithmetic was 1.882 GiB, excluding FTS/metadata/versions/temporaries. Do not relabel the 78% physical comparison as semantic compression.

# Runtime and overnight-operation experience

| | First attempt | Resume attempt 2 |
|---|---|---|
| Active time | 29m55s | 45m25s |
| Result | partial / provider-timeout | built / exit 0 |
| Stored/reused | 52288 stored | 52288 reused + 62498 new + 103 durable |
| Provider calls | 1794 | 2171; zero retries/failures |
| Estimated input cost | $0.169 | $0.215 |

Total active run about 75m20s; wall 15:35–17:20 about 105m26s includes about 30 minutes of human/implementation interruption. Approximate total cost $0.384, not an invoice. This is one measured workload/provider period, not a future completion guarantee.

- Resume preflight reconciled stored ids/text hashes with source extraction, reused 1300 complete files, adopted/discarded zero, and archived the first receipt/manifest/ledger byte-for-byte. Main verified all three archive hashes.
- Attempt 2 used affinity 0–7, API concurrency 4, configured timeout 120s. Calls of up to 64 texts: p50 3.3s, p90 10.0s, p99 27.8s, max 63.3s. The maximum does NOT prove failure with a 60s setting: code clears the abort timer after response headers, before body decoding. A strict whole-call/body deadline is an unimplemented follow-up, not a new execution grant.
- Transient timeout/429/5xx/network has bounded retry/backoff with one shared pause. Recovery mechanisms were tested synthetically; this real resumed attempt had zero retries. Do not claim real 429/5xx recovery was observed.
- Long outages/exhausted budget, permanent 4xx, source/dimension/S0/space failures remain hard stops. SIGKILL/OOM may leave a stale lock; no automatic reclaim. A stopped run needs an explicit `--resume` and human TTY `yes`; fully unattended crash restart is NOT implemented.
- Existing interactive paid gate remains. GPU embedding is remote; taskset limits the builder and descendants to eight logical CPUs. Candidate 5-GiB stop threshold and root-free 8-GiB reserve are checks, not filesystem quotas.
- Operational commands and measured limits are in README's **Candidate build — unattended runs and resume** and `./run.sh` help. No timer/cron was added.

# Before any operational adoption

1. Real decision-recovery/search/readback acceptance; distinguish missing corpus evidence from ranking failure. Do not set a human usable verdict automatically or claim native tool parity from CLI checks.
2. All future production writers must use the adopted selection/S0 policy. Current legacy sync, index:sessions and old pi `/memory` processes do NOT learn this policy from a candidate receipt. Do not point them at the candidate. Runtime reload/version coordination and manifest pairing precede cutover.
3. Keep paid-first-full, authority/dimension and writer-lock gates. Existing production `indexSessions` fresh/non-force gating and authority gaps were read in code; do not assume candidate-specific protection repaired them.
4. Do not reuse the old destructive `rebuild-sessions-full.sh` for a preserved-candidate run: it removes relative `data/` regardless of ANDENKEN_DATA. No second full write is currently requested.
5. Cutover, Oracle publication and retirement/rollback budget each require explicit approval. No forced deleteUnverified, manual suspect-file deletion, automatic old-generation cleanup or live durable-store access.

# Source custody — agent-config #32

The minimum contract remains Git version + existing MANIFEST.sha256 ledger + recovered file's actual SHA. Do not require keys/signatures, a new identity protocol or exact embedding/source-version equality as v1 prerequisites. Garden/native identity belongs to Entwurf.

Agent-config's inherited 14:41 KST receipt reports Git/git-annex preparation inside `~/repos/gh/session`, private empty `junghan0611/session` origin, tracked/content objects zero, no original add/conversion/checkout/commit/push. Changes were `.git` plus root `.gitattributes`, `.gitignore`, `AGENTS.md`, README; ledger/DEVICES hashes and original file forms unchanged. Main read the new corpus AGENTS. No completed annex custody is inferred from preparation.

- Existing `replicate-corpus.sh` copies the whole root without a .git exclude; `corpus-manifest.sh` walks .git and follows targets. Do not run them unchanged against the prepared corpus. No compatibility repair/migration has run here.
- Any future annex conversion, symlink/pointer materialization, gather or source-version change must be coordinated before readback/continuation. No implicit annex get, symlink/refusal bypass or automatic source rewrite.
- Metadata-only discovery comparisons found JSONL discovery/manifest sets both 3108, and durable sets both 1, with both directional differences zero. The inherited August count of 333 garden-id manifest entries is NOT current evidence; actual unmanifested Lance rows remain unmeasured.

# Receipts and preservation

Private D: `~/.local/state/andenken/investigations/20261102-selection-estimate/` (do not publish/copy original payloads).
- `candidate-plan-control-v1.json`, SHA256 `7675a4cf9361c723a83dca5a14a59b07d1623d8f3bfc235d503d1d922b5cf943`; `candidate-plan-result.md`; input plan was complete in 36 seconds.
- Final main measurement above; Opus's `candidate-measure-control-v1.json`; target `candidate-receipt.json`, `attempts/attempt-01-*`, both manifests and S0 ledger.
- `candidate-build-pane.1rpmyd.log` / `candidate-build-exit.txt` = first run exit 4; `candidate-resume-pane.a2.log` / `candidate-resume-exit.a2.txt` = resume exit 0. Finished tmux panes `andenken-candidate` and `andenken-candidate-resume` are retained.
- `resume-test-receipt-v1.txt`, `resume-phase.patch`, `run-resume-candidate.sh`; earlier source checkpoints and negative-fixture receipts remain. Model survey and retired structural scenarios are leads/evidence, not adopted production policy.
- Preserve fixed backup `~/.local/state/andenken-issue16/20261015T221239/` (v3832), approved closed durable snapshots, originals and every prior investigation archive. `~/.local/state/andenken/PAUSE--20261025.md` owns the historical v4069/failed synthetic investigation: outside a captured reference union is not certified garbage. Do not auto-resume it.

# RECENT

- 2026-11-02: candidate built, then main independently remeasured integrity/size and verified first-attempt archive hashes. GLG received completion DM 898 exactly once; agent-config received the completion/source-boundary receipt. No DB publication, production swap, cleanup or new search embedding followed. GLG subsequently requested a source/tests/docs commit and push, with acceptance parked for the next session.
