# pi-durable source probe (parked — #15)

API-0 evidence for making `pi-durable` the third session source
(`pi | claude | pi-durable`). **Parked by GLG on 2026-10-06** until GLG has used
durable directly; the contract here is a draft, not a decision. Coordinates and
the Q1–Q7 decision list live in
[#15](https://github.com/junghan0611/andenken/issues/15).

Nothing here is wired into `run.sh`, the build, or the index. No embedding was
paid for, `sessions.lance` was not touched, and the live coordinator DB was
never opened (not even read-only).

## What is here

| File | Role |
|---|---|
| `REPORT.md` | Full report to agent-config (Korean): measurements, the 9 places current code breaks, contract draft, Q1–Q7 |
| `andenken-docs-revision.diff` | Proposed `AGENTS.md` / `INVARIANT.md` §7.6 revision. **Not applied** — it states a contract GLG has not ruled on yet |
| `extract-durable.py` | Read-only prototype of the contract (stdlib only). Opens a **closed snapshot**, never a live DB |
| `sample/<bucket>/<dir>/session.sqlite` | Synthetic durable DB (faux provider, 9 scenarios), taken with `VACUUM INTO` — single file, journal mode `delete` |
| `q-entries.sql` | Entry + placing-submission join, for `sqlite3 -readonly` |
| `make-sample.mts`, `register.mjs`, `dist-to-src.mjs` | Generator for the sample. Needs the pinned durable source (`cd32f772` + overlay) at the oracle path hard-coded in `make-sample.mts` |

Checksums at the time of the report — the copies here are byte-identical to
the oracle scratch originals in `~/tmp/andenken-pi-durable-probe/`:

```
3d854178ce708c4a529514de365a64b1f8fa83fb20e47dc4b72f62995db12545  REPORT.md
39e59a523ba7d314284c53ab362776028bb15ef15f7748fb24552f0ceefdf2a4  andenken-docs-revision.diff
9a7599919dc60e18a40910d12a35b5ce78fe3823b1abe739061824ddfd1918ab  sample/f42d1f975f08a6e05e922e1f/1791249929607-1174a20d-0cd3-4545-8ef0-5ec537abdeb4/session.sqlite
```

## Re-checking on another machine

Works anywhere with `python3` and `sqlite3`; no andenken build, no network.

```bash
cd probes/pi-durable
sha256sum REPORT.md andenken-docs-revision.diff sample/*/*/session.sqlite
python3 -I extract-durable.py sample/*/*/session.sqlite                # census + emitted chunks
python3 -I extract-durable.py sample/*/*/session.sqlite --watermark 54 # incremental: ids > 54 only
sqlite3 -readonly sample/*/*/session.sqlite < q-entries.sql            # raw rows
git apply --check andenken-docs-revision.diff                          # from the repo root
```

Expected: `project: entwurf`, `bucketMatchesCwd: true`, `emitted: 18`
(8 GLG turns, 8 assistant turns to GLG, 1 compaction, 1 handoff); with
`--watermark 54`, `emitted: 8`.

Regenerating the sample is oracle-only (the pinned source is not on other
machines):

```bash
node --conditions=source --import ./register.mjs make-sample.mts <out-dir> [--live]
```

`--live` keeps the writer open (WAL not checkpointed) for snapshot-method
measurements; see REPORT §3.2.

## What was not measured

- `VACUUM INTO` duration at coordinator size (~8 MB DB + WAL).
- Real counts from the live coordinator (Q6 needs GLG's approval).
- Whether `replicate-corpus.sh` rollback actually happens (derived from the
  code, REPORT §3.4 item 7).
- Whether upstream moves `experimental/durable-sessions`.
