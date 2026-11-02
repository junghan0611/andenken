# NEXT — #18 session footprint

Issue: [andenken#18](https://github.com/junghan0611/andenken/issues/18) (open).
Branch: `issue/18-session-footprint`, based on `98d6fa41eee87d52d4b3a804917974eb208b160d`.
Updated: 2026-11-02. This is the branch handoff; leave main `NEXT.md` unchanged.
Issue #15 is the closed durable-snapshot integration, not this workstream.

# RAIL — Current position

- [x] **1. Recover intent and establish evidence** — historical investigation, two search calls, one corpus profile, model-source research and artifact cross-review complete.
- [ ] **2. Define admission and original-readback contracts** — CURRENT: reconcile dated policies; draft a decision table for human dialogue, peer communication, work traces and unknown origins.
- [ ] **3. Validate selection on bounded cases and estimate net effects** — PAUSED: selection criteria and any new source-reading/execution scope need approval.
- [ ] **4. Implement and verify a candidate representation** — PAUSED: policy adoption, code sign-off, retrieval/readback acceptance and physical/peak-storage experiment plan required.
- [ ] **5. Rebuild, cut over and retire old representations** — PAUSED: scoped execution approval, human full-rebuild gate, preservation/rollback budget and publication approval required.

Position: evidence complete -> admission design -> bounded validation -> implementation/acceptance -> approved cutover. No production change has started.

# NOW

- **Stem:** preserve session originals while making the searchable session representation smaller and useful as decision evidence. Sessions only; md, OpenClaw and org are out of scope.
- **Current direction:** keep the existing Qwen3-Embedding-8B frame for this discussion. Model alternatives remain parked, not rejected. This does not adopt a smaller dimension or permanently fix 4096d. The user intends a full session re-embedding for this initiative; settle selection, source-integrity/readback and execution planning first.
- **Next:** draft the admission decision table from existing code, receipts and dated policies. Separate record origin, answer-to-input attribution, semantic usefulness and embedding-unit construction. Have the user adopt criteria before implementation or additional sampling.
- **Key policy questions:** distinguish actual human input from generated wrappers/summaries; distinguish answers to that input from worker-run conclusions; define canonical peer bodies and source coordinates without indexing every transport envelope twice.
- **Preserve:** the existing file admission (`size > 200 * 1024`, current filename/tmp/basename-dedup rules), full original human text and original-source lineage. Short approvals, rejections and stop requests need an explicit policy; the message-length floor is not the file-size floor.
- **Uncertainty:** role=user is not authenticated human origin; stop/end_turn is not proof of an answer to the human; toolUse does not prove a passage is worthless. Keep unknowns explicit. Never reattribute quoted text to the quoted speaker as a direct turn.
- **No scope expansion:** branch/NEXT commit and push are now explicitly requested. This is not an immediate new corpus scan, parser fix, vector conversion, dimension/model change, paid rebuild, GC, SSH or deployment approval.

## Dated-policy reconciliation comes first

Main `NEXT.md` contains useful historical admission work dated 2026-10-02, including injection/recipient categories and mixed human turns inside sibling sessions. Read it as evidence, not a current execution grant.

The November 2 request differs: sibling communication is a desired candidate class, and a full re-embedding is acceptable in principle after planning. Do not inherit October's blanket peer-drop rule, full-rebuild prohibition, delete/compact instructions or old approval as current policy. Do not exclude an entire sibling transcript merely because it started with an agent brief.

The old main-NEXT parked compaction-schema item is also historical context; the November static field-mismatch lead does not authorize fixing or indexing it now.

## Cross-repo contract — source custody, integrity and provenance

The user is preparing session-file management and integrity work in agent-config; git-annex support is reported available through nixos-config. Agent-config owns that investigation and its issue linkage. Do not initialize annex/LFS, import session files into Git, create its issue or change the corpus from this branch. This workstream is #18, not #15.

Andenken's side is the join from a lightweight search hit to a specific preserved source and readable context. Proposed contract questions:

- Which immutable source revision/content key and indexed range does the citation identify, and which owner-produced integrity receipt can the reader check?
- Byte integrity means matching a declared source version. It does not authenticate authorship, prove that a garden ID written in a commit is genuine, or make a passage true/current/adopted.
- Entwurf owns the garden/native-session identity join. Establish origin/attestation and its trust anchor with that owner; do not infer identity from filenames or treat a plain commit-body ID as a signature.
- Appending legitimate turns creates a newer source revision. A mismatch against latest-file bytes is not automatically tampering; check the cited version/range rather than silently substituting another one.
- Reading must distinguish verified integrity, unknown/unverifiable status and an actual mismatch. Concrete fields and failure behaviour remain design work, not implemented guarantees. Integrity and source availability are separate from semantic usefulness and current permission.

Annex/LFS or a checksum manifest can participate in byte custody; selecting one does not by itself solve identity, attestation or evidence admissibility. Preserve this dependency when designing admission, readback and the eventual full re-embedding.

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
- Report SHA256: `4c00e60f1c27a1ccf8065ec414d333f6ddc16fc24266e35e0336d471988599eb` (0600; 7525522 bytes). Agent-config independently checked artifact sums/matrices, not another corpus scan.
- Existing full-estimate receipt: `~/.pi/durable-background/1793581992484-2b71c88f.log` (30.408s; configured token-price estimate about $0.40, not billed usage).
- Single profile receipt: `~/.pi/durable-background/1793583428100-90aec1df.log` (59.243s; exit 0; approved source hashes stable).
- Model survey: `~/tmp/opus-embed-754cad-20261102/REPORT.md`, revised SHA256 `12f487dab3ca1fc27ab0b7bbb68a6ae6b1f4cf17333a151c8c3dce0b1d3477b1`. Model/provider availability, same-space compatibility and input-retention limits remain conditional; no model was adopted.
- Historical #18 storage evidence: main `NEXT.md` pause section and `~/.local/state/andenken/PAUSE--20261025.md`. Captured v4069 is not today's store. Outside the captured reference union is not certified garbage; the old strict synthetic experiment failed and its fresh control did not run.

# VERIFICATION AND GATES

- Before implementation: explicit admission truth table, attribution/unknown rules, canonical peer/source-coordinate and integrity-status contracts, and the treatment of short/quoted/generated input.
- Before a new sample or estimate: bounded source scope, fixed denominator/code/argv, no text leakage, changed/error/unsupported counts, and review. Existing aggregate flags cannot be converted into invented byte savings.
- Before adopting a candidate: recover real decisions/reasons and resolve originals; distinguish corpus gaps from ranking misses. Component/CLI health is not human usability acceptance or proof of native-tool parity.
- Before physical work: separate fresh-write effects, content selection and optional dimensions; estimate cost/time, normal/peak budget, retained generations and rollback. Adding a smaller DB without retiring an approved old representation can increase disk use.
- Before production: source-code sign-off, one writer, wrong-dimension preflight before paid calls, explicit preservation and execution approvals. Keep the interactive full-rebuild gate; willingness to rebuild is not permission to bypass it. Sessions DB, JSONL/durable manifests and corpus travel together only when publication is requested.
- Preserve `~/.local/state/andenken-issue16/20261015T221239/` (v3832), corpus originals, approved durable snapshots and prior investigation archives. No forced deleteUnverified, manual suspect-file deletion or live durable-store access.

# RECENT

- 2026-11-02: observation-only corpus profile and artifact cross-review closed; production code, originals, DB, provider/model/dimensions unchanged.
- 2026-11-02: user requested the #18 branch/rail, then explicitly requested its commit/push and notification to the existing Opus. Main `NEXT.md` is intentionally untouched. Agent-config is preparing the related session-custody/integrity initiative; no corpus migration or rebuild has run here.
- Coordination: this lane owns routing; agent-config supports consumer requirements/cross-review. Existing peers are collaborators, not permission to start another worker or resume a retired session. Completion notifications for this initiative have one sender; do not repeat the already-delivered completion DM.

Before merging, promote durable outcomes and remove this disposable branch NEXT. Do not revive unrelated main-NEXT queues or parked experiments automatically.
