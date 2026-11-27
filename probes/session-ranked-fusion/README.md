# Ranked session fusion: offline dev replay

This opt-in fixture tests **candidate present, top-five miss**, not candidate acquisition. In the primary case, T is fourth in the frozen vector leg, absent from FTS, and sixth after the production session RRF pipeline. A–E are five separate chunks from one synthetic session; T is from another. The positive control adds T at fourth in FTS and expects it at fourth after fusion. The file names in `fixture.json` are identities only; no transcripts exist or are read.

The comparator loads the real compiled `retrieve`, applies the session source eligibility check, and calls the real compiled `orderRankedSessionHits` only if it exists in that build. It then takes the first five rows. It checks candidate-union membership, exact ID multiplicity, row/score identity, per-session order, and fill count. In paired mode the retriever bytes and pre-ordering outputs must also match across the two builds. This is not a CLI/Pi integration test; it does not invoke either surface, any provider, LanceDB, or the Sonnet holdout. It neither measures production miss frequency nor supplies a usability verdict.

## Replay

Use two **separate clean builds** with the pinned lockfile dependencies. The baseline is `90ee1841e1a96feb1cd5af77eec0aa3bfe61556b`; the variant is that same revision plus the separately delivered **product** patch. This proposal makes no product change and does not include the product patch. Build with `pnpm run build` in each tree (or use the separately delivered variant dist artifact). Do not reuse a dist directory containing files from the other build.

From the tree containing this proposed fixture, set `BASE_ROOT` and `VARIANT_ROOT` to the corresponding directories containing `dist/` and `package.json`, then run:

```sh
node probes/session-ranked-fusion/replay.mjs gate "$BASE_ROOT"      # expected exit 1: red
node probes/session-ranked-fusion/replay.mjs gate "$VARIANT_ROOT"   # expected exit 0: green
node probes/session-ranked-fusion/replay.mjs compare "$BASE_ROOT" "$VARIANT_ROOT"  # expected exit 0
```

Exit 1 is a measured gate miss, not a broken replay. Exit 2 is usage, load, or invariant failure; it does not count as red. `compare` succeeds only when the pinned reproduction matches both outcomes:

| Case | Baseline | Variant |
| --- | --- | --- |
| T in vector only | `ABCDET` → top `ABCDE` (T rank 6) | `ABCTDE` → top `ABCTD` (T rank 4) |
| T in both legs | top `ABCTD` (T rank 4) | top `ABCTD` (T rank 4) |

The script prints synthetic receipts to stdout. Do not track replay output, generated build/database artifacts, or local fixtures. The baseline red is intentional; do not attach this replay to the default green unit suite.
