# Synthetic fixtures — selection gates and a disposable sessions store

Two API-0 tools for reviewing what the sessions track keeps, drops, splits and
stores, without touching a real session, the corpus, a production store or a
paid provider.

| File | What it is |
|------|------------|
| `selection-gates.test.ts` | Characterization suite. For each production gate that keeps text out of the embedding input, a case that is excluded and a positive control that differs in one variable. Separately: where splitting **fragments** text (every character survives) and where text is **literally lost** (whitespace at seams, non-text blocks, stripped prefixes). JSONL (pi, Claude Code) and a closed pi-durable snapshot built in the test. |
| `scripts/synthetic-fixture.ts` | Builds one disposable sessions store from synthetic input with the production extractors, provider and `VectorStore` used as libraries, then proves a read-only consumer left it unchanged. |
| `synthetic-fixture.test.ts` | Suite for the builder, mock mode only. |

## Boundaries

- **Not an operational runner.** No `sync:sessions` / `candidate:*` path, no
  sessions writer lock, no TTY, no `~/.env.local`, no fallback endpoint.
  Nothing is written outside the fresh root it creates.
- **Root.** `mkdtemp` under the OS temp dir, mode 0700, no symlink in its path,
  not under `$HOME` or the repo. The builder re-executes itself with an
  environment built from nothing: `HOME=<root>/home`,
  `ANDENKEN_ENV_MODE=process-only`, `ANDENKEN_DATA=<root>/data`, one
  `ANDENKEN_SESSION_PROFILE`. Any other `ANDENKEN_*` variable, a
  credential-named variable or a preset endpoint refuses.
- **Synthetic only.** Built-in input is generated in the root. Freeze input is
  admitted only under device `synth`, project `--synthetic-…--`, a native
  UUIDv7 filename. Everything outside `corpus/` in a freeze (answer keys, task
  lists) is barred from the root by content hash.
- **Embedding.** Default: an in-process mock Ollama on a random loopback port
  (API 0). `--native --ack-synthetic-only` uses the profile's own loopback
  endpoint (no override), and the provider proves the runtime digest before its
  first request. There is no other rail.
- **Receipts are portable.** `out/receipt.json` and every exported list carry
  root-relative paths only; the builder refuses to write a receipt containing
  the root, the repo or `$HOME`. Stored row ids stay absolute inside the root,
  exactly as the production writer stores them; `out/ROWS.tsv` carries the
  corpus-relative `rel_id` with line number (`:<line>`, durable `:e<entry>`,
  split parts `#<n>`), never text.

## Usage

```bash
./run.sh test:fixture-gates                # selection-gates.test.ts
./run.sh test:fixture                      # type fence + synthetic-fixture.test.ts
./run.sh fixture:synthetic                 # built-in synthetic input, mock
./run.sh fixture:synthetic --input freeze \
  --freeze-dir <abs> --freeze-sha256 <hex> --aggregate <hex> \
  --plan <abs> --plan-sha256 <hex> --expect-send <n> --expect-held <n>
# opt-in, local runtime, synthetic input only:
./run.sh fixture:synthetic … --native --ack-synthetic-only
```

### Freeze input (exact corpus)

All checks run before any product module is imported, in this order:

1. `freeze.json` sha256, plan sha256, and `freeze.fixtures` equal to `--aggregate`.
2. Strict walk of the freeze dir: a symlink, special file or hardlink refuses.
3. Aggregate recomputed: every file except `freeze.json`, sorted by relative
   path, sha256 over the concatenated `${rel}\0${sha256}\n` lines.
4. Every `corpus/` file inside the synthetic allowlist; count equal to
   `freeze.sessions`.
5. Plan: `kind` andenken-candidate-plan, policy control-v1, the profile;
   `corpusPin` recomputed (sorted `rel\tsize\tsha256` lines joined by `\n`);
   each `perFile` sha256/size; totals and the per-file sum equal to
   `--expect-send` / `--expect-held`; `sources` hashes equal to this checkout.
6. Only the allowlisted JSONL are copied (exclusive create, 0600, nlink 1,
   re-hashed), relative layout preserved.

After extraction, per-file and total send/held must equal the plan and the
expectation. After the consumer, every original freeze file and the plan are
re-hashed.

### Verifying a consumer

```bash
bash <root>/out/verify.sh   # before the consumer
# … consumer reads <root>/data/sessions.lance …
bash <root>/out/verify.sh   # after: must print the same OK line
```

`verify.sh` checks `INPUTS.sha256`, `STORE.sha256`, the store file set and the
absence of symlinks. It is read-only.

## Limits

- Mock vectors depend only on text length: a mock run proves plumbing, not
  retrieval quality.
- The plan's KST window rule is not re-applied; coverage rests on the freeze's
  plan selection and per-file count equality.
- The dependency record hashes top-level non-test `.ts` files, `package.json`
  and `pnpm-lock.yaml`, and names the LanceDB version; it does not hash
  `node_modules`.
- A refusal after the root exists leaves that root in place; remove it by the
  exact `root:` path the builder printed.
- `selection-gates.test.ts` characterizes current behaviour. A failing case
  means a gate changed: review the change, do not edit the case to match.
