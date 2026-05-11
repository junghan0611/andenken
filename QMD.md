# QMD Garden Retrieval

This document records the qmd track for GLG's public digital garden.

Goal: find and publish the best local model and configuration recipe for searching
`~/repos/gh/notes/content` — a Korean-first, bilingual, citation-heavy digital
garden exported as Markdown.

This is not the org-mode source track and not the sessions embedding track. It is
a practical qmd layer over the already exported public garden Markdown.

## Why qmd first

The public garden Markdown is the surface that can be used immediately:

- already exported from org-mode
- public-facing shape is close to what agents and readers see
- small enough for local iteration (`~2,218` Markdown files, `~27 MB` payload)
- split into meaningful folders: `notes`, `bib`, `meta`, `journal`, `botlog`

The org source remains richer, but its doctor/chunker warnings should not block a
usable public-garden search layer.

## Model stack

qmd uses three local GGUF models through `node-llama-cpp`.

| Role | qmd default | Garden baseline | Reason |
|---|---|---|---|
| Embedding | `embeddinggemma-300M-Q8_0` | `Qwen3-Embedding-0.6B-Q8_0` | GLG's garden is Korean/CJK + English proper nouns + citation metadata. The qmd default is small and English-oriented. |
| Reranker | `Qwen3-Reranker-0.6B-Q8_0` | keep default | Small, local, integrated with qmd's rerank pipeline. |
| Query expansion | `qmd-query-expansion-1.7B-q4_k_m` | keep default | qmd's `query` mode depends on expansion + hybrid retrieval. |

Pinned embedding model:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Changing the embedding model requires re-embedding the collection. Vectors from
different embedding models are not compatible.

## Serving contract on NixOS thinkpad

qmd is not Ollama, vLLM, or OpenRouter. It loads local GGUF models inside the
qmd/node process via `node-llama-cpp`.

On the thinkpad AMD 780M iGPU, qmd should run through Vulkan:

```bash
export QMD_LLAMA_GPU=vulkan
export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

NixOS provides the required shared libraries through `nix-ld`:

```nix
programs.nix-ld.libraries = with pkgs; [
  stdenv.cc.cc.lib
  vulkan-loader
];
```

Verified device:

```text
vulkan [ "AMD Radeon 780M Graphics (RADV PHOENIX)" ]
GPU: vulkan (offloading: yes)
VRAM: ~16.4 GB free / 17.5 GB total
```

Important trap: if qmd/node-llama-cpp runs once without the `LD_LIBRARY_PATH`
shim, it can create a CPU-only fallback build cache under:

```text
~/repos/3rd/qmd/node_modules/node-llama-cpp/llama/localBuilds
```

That cache can take precedence over the Vulkan prebuilt addon. Remove it before
baseline embedding.

## Operator surface

Use the repository wrapper, not raw qmd, for garden work:

```bash
./run.sh qmd:garden env
./run.sh qmd:garden preflight
./run.sh qmd:garden bootstrap --only meta
./run.sh qmd:garden bootstrap --only meta --execute
./run.sh qmd:garden embed -c garden-meta
./run.sh qmd:garden query "보편 학문" -c garden-meta -n 5
```

The wrapper pins:

- `QMD_EMBED_MODEL=Qwen3-Embedding-0.6B-Q8_0`
- `QMD_LLAMA_GPU=vulkan`
- `LD_LIBRARY_PATH=$NIX_LD_LIBRARY_PATH...`
- local build cache cleanup before embed

Entry points:

| Command | Purpose |
|---|---|
| `./run.sh qmd:garden preflight` | Verify env, clear stale local builds, probe Vulkan, show qmd status. |
| `./run.sh qmd:garden bootstrap` | Print collection/context registration commands. |
| `./run.sh qmd:garden bootstrap --execute` | Register qmd collections and contexts. |
| `./run.sh qmd:garden embed ...` | Run qmd embed with pinned model/runtime. |
| `./run.sh qmd:garden query/search/vsearch ...` | Compare full qmd query, lexical BM25, and vector-only modes. |
| `./run.sh qmd:garden mcp-http --daemon` | Start qmd MCP HTTP server with the same runtime contract. |
| `./run.sh qmd:garden raw ...` | Escape hatch for any qmd command under the pinned env. |

## Garden collections

Initial full layout:

| Collection | Source | Retrieval role |
|---|---|---|
| `garden-notes` | `~/repos/gh/notes/content/notes` | Concept notes: universalism, being, authology, long-lived ideas. |
| `garden-bib` | `~/repos/gh/notes/content/bib` | Bibliography, people, works, citation anchors. |
| `garden-meta` | `~/repos/gh/notes/content/meta` | Site structure, tags, garden operations, vocabulary anchors. |
| `garden-journal` | `~/repos/gh/notes/content/journal` | Time axis: dates, daily traces, work flow. |
| `garden-botlog` | `~/repos/gh/notes/content/botlog` | Public agent-authored synthesis and architecture reflections. |

Excluded from the first baseline:

- `images` symlink
- `talks`
- `test`
- `tmp`
- `~/.cache/andenken-qmd` org export

## Small-scale experiment before full garden

Do not embed the full public garden first. Use a small, representative test
surface to tune the model and settings.

Recommended order:

1. **Preflight** — verify Vulkan and pinned model env.
2. **`garden-meta` smoke** — register and embed only `meta` first.
3. **Small mixed sample** — optional curated sample from `notes`, `bib`,
   `botlog`, `journal`, and `meta`.
4. **Mode comparison** — compare lexical, vector-only, and full qmd query.
5. **Full 5 collections** — only after model/settings are acceptable.

### Retrieval modes to compare

| Mode | Command | What it tests |
|---|---|---|
| Lexical | `qmd search "보편 학문"` | BM25 / exact keyword behavior. No model quality dependency. |
| Vector | `qmd vsearch "보편 학문"` | Embedding model quality. This is where Qwen3-Embedding matters. |
| Full query | `qmd query "보편 학문"` | Query expansion + hybrid + rerank. This is the agent-facing mode. |

### Representative queries

Use queries that reflect the garden's actual shape:

```text
보편 학문
피투성
어쏠로지
바네바 부시
제프 베이조스
qmd 연결고리
andenken openclaw
entwurf 시간축
일일일생
2026-05-11 andenken
```

Evaluate:

- Do Korean concept queries surface the right `notes` / `meta` / `botlog` pages?
- Do person/work queries surface `bib` plus related notes?
- Does `journal` help time-axis queries without dominating everything?
- Do bilingual queries survive Korean + English proper noun mixing?
- Does full `query` improve over `search` and `vsearch`, or does expansion drift?

## Known qmd quirk

`qmd status` currently prints default model URLs in the "Models" section, even
when `QMD_EMBED_MODEL` is set. The actual embed path uses the environment
override. Trust the wrapper env and embed command, not the status display, for
model selection.

## Current next step

Current active step lives in `NEXT.md`.

As of 2026-05-11: run `garden-meta` smoke embed first, measure model download /
GPU speed / result quality, then decide whether to register all five garden
collections.
