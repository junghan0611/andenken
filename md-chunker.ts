/**
 * Markdown Chunker — public garden direct embedding
 *
 * Ports the spirit of OpenClaw's builtin memory chunking
 * (~/repos/3rd/openclaw/packages/memory-host-sdk/src/host/) onto the same
 * LanceDB backend used by the sessions track. This is the same pattern that
 * originally built the org track (OpenClaw core + LanceDB substitute for
 * sqlite); md is the next instance of the pattern over the exported public
 * garden Markdown.
 *
 * Design:
 * - Strip Hugo/Jekyll YAML/TOML frontmatter (the embed surface is the body).
 * - Split on H1/H2/H3 boundaries, then enforce a max chunk size with overlap.
 * - Preserve fenced code blocks (do not split inside ```...```).
 * - One chunk type — content. md does not have org's :ARCHIVE: / :LLMLOG:
 *   subtree semantics.
 * - Output shape matches what VectorStore.addChunks() expects, so md rides on
 *   the same store contract as sessions/org. Fields reused:
 *     sessionFile → md file path
 *     project     → md folder (notes / bib / meta / journal / botlog)
 *     lineNumber  → chunk start line in the source md
 *     timestamp   → file mtime ISO string (denote-id is in metadata)
 *     role        → "" (md has no role)
 *     source      → "md"
 *
 * Garden folder policy (first baseline):
 *   include: notes, bib, meta, journal, botlog
 *   exclude: images, talks, test, tmp (+ anything else under content/)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// --- Configuration ---

export const MD_SOURCE_LABEL = "md";

/**
 * Folders under the garden export root that get indexed.
 * Anything else is skipped at file-discovery time.
 */
export const INDEXABLE_MD_FOLDERS = new Set([
  "notes",
  "bib",
  "meta",
  "journal",
  "botlog",
]);

/**
 * Default chunk sizing (characters, not tokens). Sessions and org settled
 * around 3200–4000 chars per chunk for Qwen3-Embedding; md follows the same
 * envelope. Folder-specific overrides mirror org-chunker.ts where it makes
 * sense for the garden corpus.
 */
const FOLDER_CHUNK_CONFIG: Record<
  string,
  { maxChars: number; overlap: number }
> = {
  meta: { maxChars: 6000, overlap: 400 },
  bib: { maxChars: 4800, overlap: 300 },
  notes: { maxChars: 4000, overlap: 300 },
  journal: { maxChars: 3200, overlap: 200 },
  botlog: { maxChars: 4000, overlap: 300 },
  default: { maxChars: 4000, overlap: 300 },
};

/**
 * Hard guard. OpenClaw's enforceEmbeddingMaxInputTokens caps oversized
 * chunks before they reach the embedding API. We do the same in characters
 * here so the chunker never emits a chunk that will be rejected at embed
 * time. Qwen3-Embedding-8B accepts ~32K tokens; we cap chunks at ~12K chars
 * (~3K tokens) so even worst-case CJK byte expansion stays inside the model
 * limit and the BM25 surface stays meaningful.
 */
const HARD_MAX_CHARS = 12000;

/**
 * Minimum non-whitespace chunk body. Skips empty stub pages.
 */
const MIN_CHUNK_CHARS = 40;

/**
 * Frontmatter delimiter patterns. Hugo uses YAML (---), TOML (+++), or JSON
 * ({...}). We handle YAML and TOML; JSON frontmatter is rare in the garden
 * but the safe path is to just leave it in the body — embedding-wise it's
 * harmless noise.
 */
const YAML_FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const TOML_FRONTMATTER = /^\+\+\+\s*\n([\s\S]*?)\n\+\+\+\s*\n?/;

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
  /** Unique id: filePath#chunkIndex. Stable across re-runs given same file content. */
  id: string;
  /** Embedding input. Includes context prefix (title / hierarchy) + body. */
  text: string;
  /** Original chunk body without the context prefix. Kept for excerpt/readback. */
  rawText: string;
  /** Absolute md file path. */
  filePath: string;
  /** Garden folder name: notes / bib / meta / journal / botlog. */
  folder: string;
  /** 1-based line number in the source file where this chunk starts. */
  startLine: number;
  /** 1-based line number in the source file where this chunk ends. */
  endLine: number;
  /** 0-based index within the file. */
  chunkIndex: number;
  /** Heading path leading up to this chunk: ["H1 title", "H2 title", ...]. */
  hierarchy: string[];
  /** Frontmatter parsed at file open time. */
  frontmatter: MdFrontmatter;
  /** Denote identifier extracted from filename if present (YYYYMMDDTHHMMSS). */
  denoteId?: string;
  /** sha256 of rawText. Stable hash for dedup / change detection. */
  hash: string;
}

// --- Public surface: file discovery ---

/**
 * Default garden root. Override via $ANDENKEN_MD_ROOT for tests / alt installs.
 */
export function getMdRoot(): string {
  return (
    process.env.ANDENKEN_MD_ROOT ??
    path.join(
      process.env.HOME ?? "",
      "repos",
      "gh",
      "notes",
      "content",
    )
  );
}

/**
 * Walk the garden root and return every indexable .md path, sorted.
 *
 * "Indexable" means: lives directly under one of INDEXABLE_MD_FOLDERS,
 * suffix `.md`, not the folder's `_index.md` / `index.md` shim. Symlinks are
 * not followed.
 */
export function findMdFiles(root?: string): string[] {
  const base = root ?? getMdRoot();
  const out: string[] = [];

  if (!fs.existsSync(base)) return out;
  let folders: string[];
  try {
    folders = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && INDEXABLE_MD_FOLDERS.has(d.name))
      .map((d) => d.name);
  } catch {
    return out;
  }
  folders.sort();

  for (const folder of folders) {
    const dir = path.join(base, folder);
    walk(dir, out);
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
    if (e.isSymbolicLink()) continue; // OpenClaw's followSymbolicLinks=false equivalent
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

/**
 * Extract folder name from an md file path. Falls back to "unknown" if the
 * path is not under a recognized garden folder.
 */
export function getMdFolder(filePath: string, root?: string): string {
  const base = (root ?? getMdRoot()).replace(/\/+$/, "");
  const rel = filePath.startsWith(base + "/")
    ? filePath.slice(base.length + 1)
    : filePath;
  const parts = rel.split("/");
  return parts.length > 0 ? parts[0] : "unknown";
}

/**
 * Parse a denote-id from the filename if present. Garden export keeps the
 * `YYYYMMDDTHHMMSS.md` naming, so this is mostly a free win.
 */
export function parseDenoteId(filePath: string): string | undefined {
  const base = path.basename(filePath, ".md");
  return /^\d{8}T\d{6}$/.test(base) ? base : undefined;
}

// --- Frontmatter parsing (lightweight) ---

/**
 * Parse the leading YAML or TOML frontmatter block. Returns the raw block,
 * the byte length to strip, and a typed `MdFrontmatter`. If no frontmatter
 * is present, returns offset 0 and an empty frontmatter.
 *
 * The parser is intentionally minimal — it handles the shape Hugo emits for
 * the garden (key: value, key: ["a", "b"], block scalars are flattened to
 * strings). It does NOT pull in a YAML dependency. Anything unrecognized
 * lands in `extra` as raw strings.
 */
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
    const eq = line.indexOf(":");
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
  }

  return { frontmatter: fm, bodyOffset: m[0].length };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function parseInlineList(raw: string): string[] {
  // Hugo writes `tags: ["a", "b", "c"]` or `tags: [a, b]` or `tags: a, b`.
  // We accept all three.
  const trimmed = raw.replace(/^\[|\]$/g, "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

// --- Core chunker ---

/**
 * Read an md file from disk and produce chunks. Returns [] for empty or
 * frontmatter-only files. Skips files that fall outside INDEXABLE_MD_FOLDERS
 * unless explicitly forced via `bypassFolderPolicy`.
 *
 * The returned chunks are ready to be passed to VectorStore.addChunks (after
 * the indexer attaches an embedding vector).
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
 * Pure form of `chunkMdFile` — operates on already-read content. Exposed so
 * tests can drive synthetic content without touching the filesystem.
 */
export function chunkMdContent(
  content: string,
  filePath: string,
  folder: string,
): MdChunk[] {
  const { frontmatter, bodyOffset } = parseFrontmatter(content);

  // Body starts at bodyOffset. We still want true source line numbers, so
  // compute the line offset for the body.
  const headLines = bodyOffset > 0
    ? content.slice(0, bodyOffset).split("\n").length - 1
    : 0;
  const body = content.slice(bodyOffset);
  const lines = body.split("\n");

  // Segment by code-block-aware heading boundaries.
  const segments = segmentByHeadings(lines, headLines + 1);

  // Apply size limits with overlap per segment, then concatenate.
  const cfg = FOLDER_CHUNK_CONFIG[folder] ?? FOLDER_CHUNK_CONFIG.default;
  const denoteId = parseDenoteId(filePath);

  const rawChunks: Array<{
    text: string;
    startLine: number;
    endLine: number;
    hierarchy: string[];
  }> = [];

  for (const seg of segments) {
    splitSegment(seg, cfg, rawChunks);
  }

  // Filter trivial chunks + apply hard guard.
  const out: MdChunk[] = [];
  let idx = 0;
  for (const rc of rawChunks) {
    const body = rc.text.trim();
    if (body.length < MIN_CHUNK_CHARS) continue;

    const slices = splitOversize(body, HARD_MAX_CHARS);
    for (const slice of slices) {
      const rawText = slice;
      const hash = sha256(rawText);
      const text = enrichText(rawText, frontmatter, rc.hierarchy);
      out.push({
        id: `${filePath}#${idx}`,
        text,
        rawText,
        filePath,
        folder,
        startLine: rc.startLine,
        endLine: rc.endLine,
        chunkIndex: idx,
        hierarchy: rc.hierarchy,
        frontmatter,
        denoteId,
        hash,
      });
      idx++;
    }
  }

  return out;
}

// --- Internals ---

interface RawSegment {
  text: string;
  startLine: number;
  endLine: number;
  hierarchy: string[];
}

/**
 * Walk lines of the body and produce heading-bounded segments.
 * Preserves fenced code blocks: heading-looking lines inside ```...``` do
 * not start a new segment.
 *
 * `headingLevelMin` (default 2) controls the boundary granularity. We split
 * on H2 by default — H1 in the garden is usually the page title and there's
 * only one of them, so it does not produce useful boundaries.
 */
function segmentByHeadings(
  lines: string[],
  bodyStartLine: number,
): RawSegment[] {
  const headingLevelMin = 2;
  const segments: RawSegment[] = [];
  let current: { lines: string[]; startLine: number; hierarchy: string[] } = {
    lines: [],
    startLine: bodyStartLine,
    hierarchy: [],
  };
  let inFence = false;
  let stack: string[] = [];

  const flush = (endLine: number) => {
    if (current.lines.length === 0) return;
    segments.push({
      text: current.lines.join("\n"),
      startLine: current.startLine,
      endLine,
      hierarchy: current.hierarchy.slice(),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = bodyStartLine + i;
    const fenced = isFenceLine(line);

    if (fenced) {
      inFence = !inFence;
      current.lines.push(line);
      continue;
    }
    if (inFence) {
      current.lines.push(line);
      continue;
    }

    const heading = parseHeading(line);
    if (heading && heading.level >= headingLevelMin) {
      flush(lineNo - 1);
      // Update hierarchy stack: pop deeper headings, push current.
      while (stack.length >= heading.level - 1) stack.pop();
      stack.push(heading.title);
      current = {
        lines: [line],
        startLine: lineNo,
        hierarchy: stack.slice(),
      };
      continue;
    }

    current.lines.push(line);
  }

  flush(bodyStartLine + lines.length - 1);
  return segments;
}

function isFenceLine(line: string): boolean {
  return /^\s{0,3}```/.test(line) || /^\s{0,3}~~~/.test(line);
}

interface ParsedHeading {
  level: number;
  title: string;
}

function parseHeading(line: string): ParsedHeading | null {
  const m = line.match(/^(#{1,6})\s+(.+?)\s*(\{[#\.\w-]+\})?\s*$/);
  if (!m) return null;
  return { level: m[1].length, title: m[2].trim() };
}

/**
 * Split a segment into chunks under `cfg.maxChars` with `cfg.overlap`.
 * Tries to break on blank-line boundaries; falls back to char boundary.
 */
function splitSegment(
  seg: RawSegment,
  cfg: { maxChars: number; overlap: number },
  acc: Array<{
    text: string;
    startLine: number;
    endLine: number;
    hierarchy: string[];
  }>,
): void {
  if (seg.text.length <= cfg.maxChars) {
    acc.push(seg);
    return;
  }

  // Split into paragraph-ish blocks first (blank-line separated).
  const lines = seg.text.split("\n");
  let buf: string[] = [];
  let bufChars = 0;
  let bufStartLine = seg.startLine;
  let lineNo = seg.startLine;

  const emit = (endLine: number) => {
    if (buf.length === 0) return;
    acc.push({
      text: buf.join("\n"),
      startLine: bufStartLine,
      endLine,
      hierarchy: seg.hierarchy.slice(),
    });
    // Overlap: re-prime buf with the last `overlap` chars worth of lines.
    if (cfg.overlap > 0) {
      let kept: string[] = [];
      let keptChars = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        const ln = buf[i];
        if (keptChars + ln.length + 1 > cfg.overlap) break;
        kept.unshift(ln);
        keptChars += ln.length + 1;
      }
      buf = kept;
      bufChars = keptChars;
      // Re-priming does not move bufStartLine — overlap is illustrative;
      // the chunk it appears in still owns the actual startLine going
      // forward. For simplicity, we treat bufStartLine of the next chunk
      // as `endLine - overlap-lines`.
      bufStartLine = Math.max(seg.startLine, endLine - kept.length + 1);
    } else {
      buf = [];
      bufChars = 0;
      bufStartLine = endLine + 1;
    }
  };

  for (const line of lines) {
    const adds = line.length + 1;
    if (bufChars + adds > cfg.maxChars && buf.length > 0) {
      emit(lineNo - 1);
    }
    if (buf.length === 0) bufStartLine = lineNo;
    buf.push(line);
    bufChars += adds;
    lineNo++;
  }
  if (buf.length > 0) emit(lineNo - 1);
}

/**
 * Last-resort splitter for a chunk that is still larger than the hard cap
 * after heading + size segmentation. Splits by raw character count.
 */
function splitOversize(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Prepend lightweight context (title / hierarchy / folder) to a chunk so the
 * embedding model has retrieval-relevant signal even when a body slice does
 * not name the document. Mirrors org-chunker.ts's enrichment style.
 */
function enrichText(
  rawText: string,
  fm: MdFrontmatter,
  hierarchy: string[],
): string {
  const lines: string[] = [];
  if (fm.title) lines.push(`Title: ${fm.title}`);
  if (fm.description) lines.push(`Description: ${fm.description}`);
  if (hierarchy.length > 0) lines.push(`Path: ${hierarchy.join(" > ")}`);
  if (fm.tags.length > 0) lines.push(`Tags: ${fm.tags.join(", ")}`);
  if (lines.length === 0) return rawText;
  return `${lines.join("\n")}\n\n${rawText}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// --- Adapter to VectorStore row shape ---

/**
 * Convert an `MdChunk` into the row shape `VectorStore.addChunks()` consumes.
 * The store schema is sessions-centric; we map md fields onto it so md rides
 * on the same store contract without a schema change.
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
    text: chunk.text,
    vector,
    sessionFile: chunk.filePath,
    project: chunk.folder,
    lineNumber: chunk.startLine,
    timestamp: fileMtimeIso,
    role: "",
    source: MD_SOURCE_LABEL,
    metadata: {
      hash: chunk.hash,
      endLine: String(chunk.endLine),
      chunkIndex: String(chunk.chunkIndex),
      ...(chunk.frontmatter.title ? { title: chunk.frontmatter.title } : {}),
      ...(chunk.frontmatter.description
        ? { description: chunk.frontmatter.description }
        : {}),
      ...(chunk.hierarchy.length > 0
        ? { hierarchy: chunk.hierarchy.join(" > ") }
        : {}),
      ...(chunk.frontmatter.tags.length > 0
        ? { tags: chunk.frontmatter.tags.join(",") }
        : {}),
      ...(chunk.denoteId ? { denoteId: chunk.denoteId } : {}),
    },
  };
}
