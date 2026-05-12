/**
 * Markdown Chunker — public garden direct embedding
 *
 * Faithful port of OpenClaw's `chunkMarkdown` (see
 * `~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/internal.ts:362`)
 * onto the andenken LanceDB backend. Same pattern that built the org track
 * originally: OpenClaw memory core + LanceDB substitute for sqlite.
 *
 * Design choices (matched to GLG's 2026-05-12 directive):
 *
 * 1. **OpenClaw chunkMarkdown is the chunker.** Line-walk with a CJK-aware
 *    character budget, plus configurable overlap. Headings are **not**
 *    boundaries — gpt-5.5's first review pass showed our H2–H6 heading
 *    splitter was over-fragmenting the garden (p50 ~194 chars/chunk). The
 *    OpenClaw algorithm produces fewer, larger chunks that match the
 *    embedding model's natural input shape.
 *
 * 2. **CJK weighting.** `estimateStringChars` inflates each non-Latin code
 *    point (Hangul / CJK Unified / Hiragana / Katakana / …) so the chars
 *    budget reflects actual token count for Korean-first content. Without
 *    this a "1000 chars" budget would hold ~250 English tokens but ~1000
 *    Korean tokens — wrong for an 8K-input model.
 *
 * 3. **Body only — no per-chunk title prefix.** OpenClaw embeds the chunk
 *    text as-is; title/description/tags live in row metadata, not in the
 *    embedding input. This drops the 37.5% prefix overhead gpt-5.5 measured
 *    on the previous design while keeping retrieval signal in BM25/metadata.
 *
 * 4. **No recency decay for md.** Garden is not chronological — the value
 *    of `2021T19:07:00` notes is independent of mtime. `searchMd` sets
 *    `recencyHalfLifeDays: 0` so `applyRecencyDecay` short-circuits.
 *
 * 5. **role: "doc".** OpenClaw uses `source` for store routing; we keep
 *    `source: "md"` and tag `role: "doc"` so future union searches over
 *    sessions ∪ md can tell document chunks from session messages.
 *
 * Chunks are produced for the five baseline garden folders only
 * (notes / bib / meta / journal / botlog). images, talks, test, tmp are
 * excluded at file-discovery time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// --- Configuration ---

export const MD_SOURCE_LABEL = "md";
export const MD_ROLE_LABEL = "doc";

/**
 * CJK-aware char-per-token ratio. Same value OpenClaw uses
 * (`~/repos/3rd/openclaw/src/utils/cjk-chars.ts`).
 *
 * Latin text averages ~4 chars per token; CJK averages ~1 char per token.
 * `estimateStringChars` inflates CJK characters so a single
 * "chars / CHARS_PER_TOKEN_ESTIMATE" formula yields an accurate token
 * estimate for any script.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Folders under the garden export root that get indexed.
 */
export const INDEXABLE_MD_FOLDERS = new Set([
  "notes",
  "bib",
  "meta",
  "journal",
  "botlog",
]);

/**
 * Per-folder chunking budget, in **tokens** (not chars).
 *
 * Tokens × CHARS_PER_TOKEN_ESTIMATE = effective chars budget for the
 * line-walk. Because CJK chars are weighted as ~4 in `estimateStringChars`,
 * the actual char count of a Korean-heavy chunk is ~tokens, while an
 * English-heavy chunk is ~tokens × 4. Either way the embedding input stays
 * inside the 8K-token model limit with comfortable headroom.
 *
 * Numbers were chosen to land in a healthier chunks/file regime than the
 * heading-bounded predecessor (which produced ~26 chunks/file, p50 194c).
 * Targets: ~6–10 chunks/file at p50 800c+ on the garden corpus.
 */
const FOLDER_CHUNK_TOKENS: Record<
  string,
  { tokens: number; overlap: number }
> = {
  meta: { tokens: 1500, overlap: 150 },
  bib: { tokens: 1200, overlap: 120 },
  notes: { tokens: 1000, overlap: 100 },
  botlog: { tokens: 1000, overlap: 100 },
  journal: { tokens: 800, overlap: 80 },
  default: { tokens: 1000, overlap: 100 },
};

/**
 * Hard upper bound on chars in a single chunk after all splitting. Same
 * spirit as OpenClaw's `enforceEmbeddingMaxInputTokens`: keep oversized
 * chunks from ever reaching the embedding API. 12K chars under
 * worst-case CJK byte expansion stays inside Qwen3-Embedding-8B's 8K-token
 * input limit.
 */
const HARD_MAX_CHARS = 12000;

/**
 * Minimum chars in a single chunk's body. Drops thin chunks that contain
 * only whitespace, a heading line, or a stray frontmatter remnant. Tuned
 * up from 40 to 100 after the 2026-05-12 garden audit (gpt-5.4 entwurf
 * recommendation): 40 was admitting trivial chunks under the new
 * OpenClaw token-budget chunker.
 */
const MIN_CHUNK_CHARS = 100;

/**
 * Minimum sanitized body length for a file to be indexable at all.
 * Garden export injects a `description` + `[!abstract]` block into every
 * page, so strict frontmatter+body < 200 catches zero files in practice;
 * the real abstract-only stubs cluster around the sanitized 250-char mark.
 * Drop them before they reach the chunker — they produce one ~150 char
 * chunk and zero retrieval value.
 */
const MIN_FILE_BODY_CHARS = 250;

/**
 * Frontmatter tag values that opt a page out of indexing entirely.
 * Mirrors org's `noembed` / `tts` exclusion. Currently zero hits in the
 * garden export (per the 2026-05-12 audit) but kept as the supported
 * opt-out lever so garden authors can flag a page without code changes.
 */
const NOEMBED_TAGS = new Set(["noembed", "tts"]);

const YAML_FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const TOML_FRONTMATTER = /^\+\+\+\s*\n([\s\S]*?)\n\+\+\+\s*\n?/;

// --- CJK weighting (ported from OpenClaw src/utils/cjk-chars.ts) ---

/**
 * Matches CJK Unified Ideographs, CJK Extension A/B, CJK Compatibility
 * Ideographs, Hangul Syllables, Hiragana, Katakana, and other scripts that
 * typically tokenize at ~1 token per character.
 */
const NON_LATIN_RE =
  /[⺀-鿿ꀀ-꓿가-힯豈-﫿\u{20000}-\u{2FA1F}]/gu;

/** CJK Extension B+ high-surrogate range (U+D840–U+D87E). */
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

/**
 * Code-point length adjusted for CJK Extension B+ surrogate pairs. Each such
 * pair occupies 2 UTF-16 units but is 1 code point (and 1 NON_LATIN_RE
 * match), so we subtract the count.
 */
function countCodePoints(text: string, nonLatinCount: number): number {
  if (nonLatinCount === 0) return text.length;
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  return text.length - cjkSurrogates;
}

/**
 * Return an adjusted character length that accounts for non-Latin (CJK,
 * etc.) characters. Each non-Latin character is counted as
 * `CHARS_PER_TOKEN_ESTIMATE` chars so that the downstream
 * `chars / CHARS_PER_TOKEN_ESTIMATE` token estimate stays accurate.
 *
 * Pure ASCII/Latin text returns `text.length` unchanged.
 */
export function estimateStringChars(text: string): number {
  if (text.length === 0) return 0;
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  const codePointLength = countCodePoints(text, nonLatinCount);
  return (
    codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1)
  );
}

/**
 * Estimate tokens from a raw character count using the standard
 * chars-per-token ratio. For accurate counts from text, prefer
 * `estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE`.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}

// --- Types ---

export interface MdFrontmatter {
  title?: string;
  description?: string;
  date?: string;
  lastmod?: string;
  tags: string[];
  categories: string[];
  draft?: boolean;
  /** Pass-through for any other key. Kept as raw strings; we do not parse. */
  extra: Record<string, string>;
}

export interface MdChunk {
  /** Unique id: filePath#chunkIndex. Stable across re-runs of the same file content. */
  id: string;
  /**
   * FTS-side text. Title + Tags + body, so LanceDB BM25 over the `text`
   * column can recover hits keyed by frontmatter title or tags even when
   * the body does not repeat them. gpt-5.5 review (2026-05-12) caught
   * that the previous "body only" design lost title/tag retrieval
   * because metadata is not in the FTS index path.
   *
   * NOT used for embedding. Vectors are computed from `embeddingInput`
   * (body only) so paid-remote token cost is not inflated by the prefix
   * and the embedding remains a clean semantic representation of the body.
   */
  text: string;
  /**
   * Vector-side text. **Body only** — exactly what OpenClaw's
   * `chunkMarkdown` would emit. The indexer feeds this to
   * `provider.embedDocumentBatch`.
   */
  embeddingInput: string;
  /** Same as embeddingInput. Kept for excerpt/display readback. */
  rawText: string;
  filePath: string;
  /** Garden folder: notes / bib / meta / journal / botlog. */
  folder: string;
  /** 1-based start line in the source file (post frontmatter offset). */
  startLine: number;
  /** 1-based end line in the source file. */
  endLine: number;
  /** 0-based chunk index within the file. */
  chunkIndex: number;
  /** Frontmatter parsed once at file open. */
  frontmatter: MdFrontmatter;
  /** Denote identifier from filename (YYYYMMDDTHHMMSS) if present. */
  denoteId?: string;
  /** sha256(rawText). Stable hash for dedup / change detection. */
  hash: string;
}

// --- Public surface: file discovery ---

export function getMdRoot(): string {
  return (
    process.env.ANDENKEN_MD_ROOT ??
    path.join(process.env.HOME ?? "", "repos", "gh", "notes", "content")
  );
}

/**
 * Walk the garden root and return every indexable .md path, sorted.
 * Symlinks are not followed. `_index.md` / `index.md` shims are skipped.
 */
export function findMdFiles(root?: string): string[] {
  const base = root ?? getMdRoot();
  const out: string[] = [];

  if (!fs.existsSync(base)) return out;
  let folders: string[];
  try {
    folders = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && INDEXABLE_MD_FOLDERS.has(d.name))
      .map((d) => d.name);
  } catch {
    return out;
  }
  folders.sort();

  for (const folder of folders) {
    walk(path.join(base, folder), out);
  }

  out.sort();
  return out;
}

function walk(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name === "_index.md" || e.name === "index.md") continue;
    acc.push(full);
  }
}

export function getMdFolder(filePath: string, root?: string): string {
  const base = (root ?? getMdRoot()).replace(/\/+$/, "");
  const rel = filePath.startsWith(base + "/")
    ? filePath.slice(base.length + 1)
    : filePath;
  const parts = rel.split("/");
  return parts.length > 0 ? parts[0] : "unknown";
}

export function parseDenoteId(filePath: string): string | undefined {
  const base = path.basename(filePath, ".md");
  return /^\d{8}T\d{6}$/.test(base) ? base : undefined;
}

// --- Frontmatter parsing ---

export function parseFrontmatter(content: string): {
  frontmatter: MdFrontmatter;
  bodyOffset: number;
} {
  const empty: MdFrontmatter = { tags: [], categories: [], extra: {} };
  const m = content.match(YAML_FRONTMATTER) ?? content.match(TOML_FRONTMATTER);
  if (!m) return { frontmatter: empty, bodyOffset: 0 };

  const block = m[1];
  const fm: MdFrontmatter = { tags: [], categories: [], extra: {} };

  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.startsWith("#")) continue;
    // Hugo YAML uses `key: value`, TOML uses `key = "value"`. Accept both.
    let eq = line.indexOf(":");
    let assignIsEquals = false;
    const tomlEq = line.indexOf("=");
    if ((eq < 0 || (tomlEq >= 0 && tomlEq < eq)) && tomlEq > 0) {
      eq = tomlEq;
      assignIsEquals = true;
    }
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const valueRaw = line.slice(eq + 1).trim();
    const value = stripQuotes(valueRaw);

    switch (key) {
      case "title":
        fm.title = value;
        break;
      case "description":
        fm.description = value;
        break;
      case "date":
        fm.date = value;
        break;
      case "lastmod":
        fm.lastmod = value;
        break;
      case "tags":
        fm.tags = parseInlineList(valueRaw);
        break;
      case "categories":
        fm.categories = parseInlineList(valueRaw);
        break;
      case "draft":
        fm.draft = value === "true";
        break;
      default:
        fm.extra[key] = value;
    }
    void assignIsEquals; // reserved for future TOML-specific casts
  }

  return { frontmatter: fm, bodyOffset: m[0].length };
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    (s[0] === '"' || s[0] === "'") &&
    s[s.length - 1] === s[0]
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.replace(/^\[|\]$/g, "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

// --- Core chunker ---

/**
 * Read an md file from disk and produce chunks. Returns [] for empty,
 * frontmatter-only, or excluded-folder files.
 */
export function chunkMdFile(
  filePath: string,
  opts: { root?: string; bypassFolderPolicy?: boolean } = {},
): MdChunk[] {
  const folder = getMdFolder(filePath, opts.root);
  if (!opts.bypassFolderPolicy && !INDEXABLE_MD_FOLDERS.has(folder)) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  return chunkMdContent(content, filePath, folder);
}

/**
 * Pure form of `chunkMdFile`. Operates on already-read content so tests can
 * drive synthetic input without touching the filesystem.
 */
export function chunkMdContent(
  content: string,
  filePath: string,
  folder: string,
): MdChunk[] {
  const { frontmatter, bodyOffset } = parseFrontmatter(content);

  // Opt-out tags: `noembed` / `tts` skip the file entirely. Mirrors org's
  // exclusion semantics so a garden author has a one-line lever to keep a
  // page out of retrieval.
  if (frontmatter.tags.some((t) => NOEMBED_TAGS.has(t.toLowerCase()))) {
    return [];
  }

  // Body starts at bodyOffset; compute the line offset so chunk line
  // numbers reference the original source file (frontmatter included).
  const headLines =
    bodyOffset > 0 ? content.slice(0, bodyOffset).split("\n").length - 1 : 0;
  const rawBody = content.slice(bodyOffset);
  if (!rawBody.trim()) return [];

  // Garden-specific sanitization. Order matters: strip the bibliography
  // tail BEFORE the MIN_FILE_BODY_CHARS check so a tail-heavy file can
  // still be dropped if the actual content is too thin.
  const body = stripBibliographyTail(rawBody);
  if (body.trim().length < MIN_FILE_BODY_CHARS) return [];

  const cfg = FOLDER_CHUNK_TOKENS[folder] ?? FOLDER_CHUNK_TOKENS.default;
  const raw = chunkMarkdownOpenclaw(body, cfg);

  const denoteId = parseDenoteId(filePath);
  const out: MdChunk[] = [];
  let idx = 0;
  for (const rc of raw) {
    const trimmed = rc.text.trim();
    if (trimmed.length < MIN_CHUNK_CHARS) continue;

    for (const slice of splitOversizeChars(rc.text, HARD_MAX_CHARS)) {
      out.push({
        id: `${filePath}#${idx}`,
        text: buildFtsText(slice, frontmatter),
        embeddingInput: slice,
        rawText: slice,
        filePath,
        folder,
        startLine: rc.startLine + headLines,
        endLine: rc.endLine + headLines,
        chunkIndex: idx,
        frontmatter,
        denoteId,
        hash: sha256(slice),
      });
      idx++;
    }
  }
  return out;
}

// --- Garden-specific sanitization ---

/**
 * Strip the trailing bibliography/citations block when it lives in the
 * latter half of the file. Garden export emits a `## CITATIONS` (or
 * `## BIBLIOGRAPHY`, or `## REFERENCES`) heading followed by citeproc
 * HTML anchors and CSL entries. For journal entries in particular, the
 * tail can be 30+ anchors that dominate BM25 with citation keys nobody
 * queries for, while inflating embedding cost.
 *
 * Rule (conservative, per 2026-05-12 garden audit):
 *   - find the first matching tail heading at line index >= 50% of body
 *   - strip from that line to EOF
 *
 * The 50% gate protects bib pages whose primary content IS a bibliography
 * block placed near the top — we never strip those because the heading
 * appears in the first half.
 */
export function stripBibliographyTail(body: string): string {
  if (body.length < 200) return body;
  // Match any of the tail headings as the *start* of a line. We use a
  // multiline regex with a global flag so we can iterate all occurrences
  // and pick the *earliest* one — once we find the first tail heading we
  // can strip from there.
  const TAIL_RE =
    /(?:^|\n)(##\s+(CITATIONS|BIBLIOGRAPHY|REFERENCES|RELATED-NOTES)\b)/gim;
  let m: RegExpExecArray | null;
  let firstTailIdx = -1;
  while ((m = TAIL_RE.exec(body)) !== null) {
    // m.index points to the newline (or position 0); add 1 to step past
    // the newline so the strip cut lands at the start of the heading line.
    const pos = m.index + (body[m.index] === "\n" ? 1 : 0);
    if (firstTailIdx === -1 || pos < firstTailIdx) firstTailIdx = pos;
  }
  if (firstTailIdx === -1) return body;
  // Only strip when the tail starts past the 50% char mark of the body.
  // bib pages that lead with BIBLIOGRAPHY (the actual content) are
  // preserved — their tail heading sits in the first half.
  if (firstTailIdx < body.length * 0.5) return body;
  // Keep everything up to (not including) the tail heading; trim trailing
  // whitespace so the chunker's line-walk doesn't emit an empty trailer.
  return body.slice(0, firstTailIdx).replace(/\s+$/, "\n");
}

/**
 * FTS-side enrichment. Prepends `Title:` and `Tags:` lines (Hugo
 * `description` is intentionally omitted — the garden export injects a
 * formulaic abstract that does not improve retrieval). Falls back to the
 * raw body when no title/tags exist.
 *
 * Only the `text` field uses this; `embeddingInput` stays body-only so
 * vector embeddings reflect document semantics, not metadata.
 */
function buildFtsText(body: string, fm: MdFrontmatter): string {
  const parts: string[] = [];
  if (fm.title) parts.push(`Title: ${fm.title}`);
  if (fm.tags.length > 0) parts.push(`Tags: ${fm.tags.join(", ")}`);
  if (parts.length === 0) return body;
  return parts.join("\n") + "\n\n" + body;
}

// --- OpenClaw chunkMarkdown port ---
//
// Faithful port of OpenClaw's chunkMarkdown:
//   ~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/internal.ts:362
//
// Differences from the original:
//   - Output uses our `{ text, startLine, endLine }` shape (no embeddingInput
//     wrapper; we feed strings into VLLMProvider.embedDocumentBatch directly).
//   - Returns intermediate `RawChunk` records that `chunkMdContent` then
//     wraps with hash / id / metadata.
//
// Everything else — line walk, CJK-aware budget, surrogate-safe fine split,
// overlap carry — is identical to OpenClaw.

interface RawChunk {
  text: string;
  startLine: number;
  endLine: number;
}

function chunkMarkdownOpenclaw(
  content: string,
  chunking: { tokens: number; overlap: number },
): RawChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, chunking.tokens * CHARS_PER_TOKEN_ESTIMATE);
  const overlapChars = Math.max(0, chunking.overlap * CHARS_PER_TOKEN_ESTIMATE);
  const chunks: RawChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    chunks.push({
      text: current.map((e) => e.line).join("\n"),
      startLine: first.lineNo,
      endLine: last.lineNo,
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) continue;
      acc += estimateStringChars(entry.line) + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = acc;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      // Latin-friendly slice first; if the result is still over budget when
      // measured with CJK weighting, fine-split at the token boundary
      // (surrogate-pair safe for CJK Extension B+).
      for (let start = 0; start < line.length; start += maxChars) {
        const coarse = line.slice(start, start + maxChars);
        if (estimateStringChars(coarse) > maxChars) {
          const fineStep = Math.max(1, chunking.tokens);
          for (let j = 0; j < coarse.length; ) {
            let end = Math.min(j + fineStep, coarse.length);
            if (end < coarse.length) {
              const code = coarse.charCodeAt(end - 1);
              if (code >= 0xd800 && code <= 0xdbff) {
                end += 1; // include the low surrogate
              }
            }
            segments.push(coarse.slice(j, end));
            j = end;
          }
        } else {
          segments.push(coarse);
        }
      }
    }
    for (const segment of segments) {
      const lineSize = estimateStringChars(segment) + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

/**
 * Last-resort splitter for a chunk whose char count exceeds HARD_MAX_CHARS
 * even after the OpenClaw budget walk. Splits by raw char count. Should be
 * a no-op for almost every garden chunk.
 */
function splitOversizeChars(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// --- Adapter to VectorStore row shape ---

/**
 * Convert an `MdChunk` into the row shape `VectorStore.addChunks()` consumes.
 * The store schema is sessions-centric; md fields map onto it as follows:
 *
 *     sessionFile → md file path
 *     project     → md folder (notes/bib/meta/journal/botlog)
 *     lineNumber  → chunk start line
 *     timestamp   → file mtime ISO (denote-id lives in metadata)
 *     role        → "doc"  (distinguishable from session "user"/"assistant"/"compaction")
 *     source      → "md"
 *
 * Title / description / tags / hierarchy live in `metadata` so they're
 * searchable via the metadata side without inflating the embedded text.
 */
export function mdChunkToStoreRow(
  chunk: MdChunk,
  vector: number[],
  fileMtimeIso: string,
): {
  id: string;
  text: string;
  vector: number[];
  sessionFile: string;
  project: string;
  lineNumber: number;
  timestamp: string;
  role: string;
  source: string;
  metadata: Record<string, string>;
} {
  return {
    id: chunk.id,
    // chunk.text is the FTS-side enriched string (Title + Tags + body).
    // chunk.embeddingInput is the body-only input the indexer passed to
    // `provider.embedDocumentBatch` to produce `vector`. The store row
    // therefore carries both signals: vector reflects body semantics,
    // FTS over `text` recovers title/tag hits.
    text: chunk.text,
    vector,
    sessionFile: chunk.filePath,
    project: chunk.folder,
    lineNumber: chunk.startLine,
    timestamp: fileMtimeIso,
    role: MD_ROLE_LABEL,
    source: MD_SOURCE_LABEL,
    metadata: {
      hash: chunk.hash,
      endLine: String(chunk.endLine),
      chunkIndex: String(chunk.chunkIndex),
      ...(chunk.frontmatter.title ? { title: chunk.frontmatter.title } : {}),
      ...(chunk.frontmatter.description
        ? { description: chunk.frontmatter.description }
        : {}),
      ...(chunk.frontmatter.tags.length > 0
        ? { tags: chunk.frontmatter.tags.join(",") }
        : {}),
      ...(chunk.denoteId ? { denoteId: chunk.denoteId } : {}),
    },
  };
}
