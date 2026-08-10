---
name: andenken-acceptance
description: "andenken acceptance workbench — answer 'what became better for the user?' after a retrieval change, in three separated layers: index/operator health, andenken retrieval behaviour, and a HUMAN usable/partial/not-improved verdict. Before/after evidence with confounding made explicit. Distinct from andenken-embed (index maintenance) and from ./run.sh golden (component gate). Triggers: 'acceptance', 'is retrieval better', '좋아졌나', '수용 판정', 'usable 판정', 'before/after 비교', 'acceptance report', '품질 검수'."
user_invocable: true
---

# andenken-acceptance — did this become usable?

`./run.sh golden` answers *did a retrieval component regress*. `andenken-embed`
answers *is the index maintained*. Neither answers the question a steward has to
answer after changing retrieval:

> what became better for the person using this?

That question has three layers, and this skill exists to keep them apart.

| layer | who answers | what it can conclude |
|---|---|---|
| **1 — index / operator health** | `./run.sh accept` (API 0) | whether the index is even caught up. A **prerequisite and a diagnosis**. Never acceptance. |
| **2 — andenken retrieval** | `./run.sh accept --retrieval` | rank of canonical evidence, document diversity, and an honest classification of *why* something was missed |
| **3 — harness / user usefulness** | **a human, running the real production tools** | the only layer that can say `usable` |

**A green diagnostics tally is not acceptance.** The report prints the verdict
slot *above* the tally on purpose, and the runner cannot fill it.

## Run it

```bash
cd ~/repos/gh/andenken

./run.sh accept                       # API 0 — health + stored-signal probes
./run.sh accept --retrieval           # + probes needing a paid query embedding
./run.sh accept --retrieval --save --label before-fusion-fix
# ... make the retrieval change ...
./run.sh accept --retrieval --save --label after-fusion-fix \
  --compare data/acceptance/<before>.json
```

- `--only <caseId>[,...]` one scenario · `--json` machine-readable ·
  `--strict` nonzero exit on fail/error · `--cases <file>` alternate pack.
- `--save` writes `data/acceptance/<stamp>--<label>.{json,md}`. `data/` is
  gitignored and private-session excerpts are redacted on save.

### Cost

Default is **API 0**: layer 1 is manifest/stat reading, and time-probe cases use
`--mode recent` (stored-signal scan, no embedding). `--retrieval` adds **one paid
query embedding per probe**, plus one more if the sessions→md fallback fires.
Fractions of a cent — but it is real, so it is opt-in and always labeled per
probe as `api-cost: none | paid-query-embedding`.

### Recall-log safety

Probes are genuine searches, so children run with
`ANDENKEN_DISABLE_RECALL_TRACKING=1` and the run **verifies** `recalls.jsonl` did
not grow. If `recallSuppression.verified` is ever `false`, acceptance traffic
leaked into the promotion evidence — stop and investigate before trusting any
recall statistic. Production callers never set that variable and keep logging.

## Reading the report

**Read §1.1 before §1.2, always.** A missing answer is three unrelated defects
wearing one coat, and only layer 1 tells them apart:

| verdict / miss | meaning | who fixes it |
|---|---|---|
| `stale-index` / `unindexed-source` | the index is behind the source | operator — `./run.sh sync:sessions` / `sync:md`, then re-run |
| `corpus-miss` → `honest-miss` | the source does not exist, and the window path was proven this run | nobody; this is an honest answer |
| `corpus-miss-candidate` → `honest-miss` | zero rows, but the window control did not prove the path | nobody yet — it is a candidate, not a finding |
| `ranking-miss` → `fail` | indexed, fresh, still absent | **retrieval** — the only one that is |
| `abstain` | not evaluable: unbound case, live append, **undecided index state**, unlabeled semantics | bind, label, or sync |
| `expired` | a volatile local binding aged out | rebind anchor and query together |

Freshness is decided by each track's own policy, not by a guess: **sessions** by
size growth (transcripts only append), **md** by the indexer's `payloadHash` —
equal byte size never proves an equal embedding payload, so acceptance recomputes
the hash locally (API 0) exactly as `classifySuspect()` does. A manifest entry
predating `payloadHash` is `unknown`, never `fresh`, and an `unknown` anchor can
never be reported as a ranking miss.

A time-probe's zero is only a corpus statement when the run's **window control**
proved the stored-signal path returns rows over a recent range. Otherwise the
zero is `corpus-miss-candidate`.

`honest-miss`, `abstain` and `expired` are deliberately **non-green and not
failures**. Do not sum them into either column.

### Scores

No score band is hard-coded. The report prints **formula and strategy** (stable
facts about the code) separately from the **observed range for that run**
(an observation, not a calibration). `calibratedConfidence: false`,
`crossTrackScoreComparison: false` — sessions and md are never sorted against
each other, only grouped and labeled.

### Before/after

Comparison refuses to invent a direction. It reports `not-comparable` — never
"improved" — whenever the two runs did not measure the same thing:

- `schemaVersion` · `casePackDigest` · `config(model+dim)` · `measuredSurface` differ;
- the **corpus/index generation moved**, so a delta is unattributable (we cannot
  cheaply separate stable source-corpus identity from index-generation identity,
  and correctness beats permissiveness);
- either side is `skipped` / `abstain` / `expired` / `error` / **`honest-miss`** —
  "not measured" is not "worse", and a source disappearing is not an improvement.

An **unchanged retrieval source digest** is a run-level caution: the delta is
corpus drift or noise, not your change working. Any change to the result digest
**resets a recorded human verdict to unset**.

## Layer 3 — the part this skill cannot automate

Automated CLI diagnostics cannot close acceptance. Probes measure `cli:*`; the pi
extension still carries inline retrieval paths (`knowledge_search` calls
`retrieve()` directly rather than `searchMdCore()`), so CLI results do **not**
prove the pi tool surface. The report says so as `productionPathParity: unproven`.

So the steward runs the real tools once, in the actual harness, on the same
scenarios:

1. `session_search` / `knowledge_search` (pi), or the `semantic-memory` skill,
   or the emacs wrapper — whatever the workflow actually uses.
2. Ask the scenario's own question in natural language, **not** by title.
3. Answer each sentence below, per scenario.

### Acceptance sentences

- A natural-language, no-title query puts the canonical room in **top 3**, and I
  could **choose or reject it from the first screen**.
- An explore query's top 5 has **≥3 unique documents** and **≥2 semantically
  useful** ones including the canonical. Diversity of irrelevant documents does
  not qualify.
- Repeated chunks of one document do not obscure the first screen; **track and an
  openable source path are visible**.
- `stale` / `unindexed` / `source-missing` / `abstain` was distinguished **before**
  anyone blamed ranking.
- "After" took **at least one fewer step** than "before": one fewer re-query, one
  fewer exact-title search, or one fewer extra file opened.

### Recording the verdict

Fill, per scenario: `verdict` (`usable` / `partial` / `not-improved`),
`oneLessStep` (`re-query` / `exact-title-search` / `extra-file-open` / `none`),
and a `reason` — **required** for `partial` and `not-improved`. Then the run-level
verdict and a one-line *what changed in the actual workflow*.

Edit them into the saved `.md`/`.json`, or record them in the steward's own note.
The runner deliberately has no `--verdict` flag: a verdict typed as a CLI
argument in the same breath as the measurement is not a judgment.

**Verdicts earned on the production tools belong to that surface.** Record them
in `data/acceptance/l3-evidence.json` (gitignored) with
`measuredSurface: "pi-tools"`. The report renders them in §0.1 and states plainly
that they are **not** bound to the CLI run's result digest and **not** counted in
its diagnostics — a verdict earned on one surface cannot be inherited by another.

## Cases live in data, not in code

`acceptance-cases.json` (committed) holds intent, query, and expected **evidence
type**. Adding a case never requires editing `acceptance.ts`.

`acceptance-cases.local.json` (**gitignored**) holds volatile bindings — session
UUIDs, machine paths — merged over the committed pack by case id and probe id.
Keep every UUID and absolute path on that side; a fixture test fails the build if
one reaches the committed pack.

Case types drive the grading:

| type | rule |
|---|---|
| `lookup` | canonical evidence within `rankThreshold`. One document dominating is a **warning**, not a failure — a narrow lookup legitimately returns one document. |
| `explore` | numeric guardrails (`minUniqueDocs`, `maxChunksPerDoc`) are **necessary and not sufficient**. Without human-labeled `helpfulNeighbors` the automated verdict is capped below `pass`; a `knownDistractor` ahead of canonical is at most partial. |
| `time-probe` | grades only recoverable anchors inside a caller-supplied ISO window, or an honest miss. **Never counts toward user acceptance.** |

Label `helpfulNeighbors` / `knownDistractors` **from an observed run you read**.
A guessed label makes the case grade itself. Leave a document unlabeled when it
was useful context but not a candidate answer — mislabeling it either way
corrupts the grade.

A probe may declare `forbiddenQueryTokens`: the canonical title and subtitle
wording its query must not contain. A query that repeats the title measures
string overlap, not retrieval, so a rank-1 hit under those conditions proves
nothing. A fixture test fails the build if the wording reappears.

## Boundaries

- Never claims timeline fidelity. A score is not a date; a day with no
  retrievable session is an honest miss, never an empty day. KST coordinates,
  event identity, and source status belong to the harness `timeline` skill.
- Never writes to LanceDB or any manifest. Read-only apart from its own report.
- Never treats private session text as garden knowledge — every row carries a
  visibility label.
- Index maintenance is **not** here → `andenken-embed`. Component regression is
  **not** here → `./run.sh golden`.

SSOT is `run.sh` + `acceptance.ts` + `INVARIANT.md`. If behaviour and this file
disagree, the code wins.
