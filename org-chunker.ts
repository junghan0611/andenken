/**
 * Org-mode Structure-Aware Chunker (Approach 3)
 *
 * Respects org heading hierarchy, Denote front matter, filetags,
 * GPTEL properties, and folder-based differentiation.
 *
 * Design informed by:
 * - John Kitchin emacs-rag-libsql (2-tier: headings + content)
 * - ELISA (paragraph-based, semantic merge)
 * - Org-roam semantic search (hierarchy preservation)
 * - embedding-config (folder-based chunk sizing, 2945 files verified)
 * - memex-kb RAG strategy docs (Korean-specific considerations)
 *
 * Key insight: "Org-mode is already designed for chunking" — ~120 lines.
 */

// --- Types ---

export interface DenoteMetadata {
  identifier: string; // YYYYMMDDTHHMMSS
  title: string; // Korean title from #+title
  filetags: string[]; // :tag1:tag2: parsed
  date: string; // [YYYY-MM-DD ...]
  folder: string; // notes, meta, bib, botlog, journal, llmlog, ...
  references: string[]; // citation keys from #+reference
  titlePrefix: string; // §, †, ‡, @, # or ""
  hasGptelProps: boolean;
}

export interface OrgHeading {
  level: number; // 1, 2, 3, ...
  title: string;
  tags: string[]; // :tag1:tag2: on heading line
  lineNumber: number;
  properties: Record<string, string>; // PROPERTY drawer
  isArchive: boolean; // :ARCHIVE: tag
  isLlmlog: boolean; // :LLMLOG: tag
}

export interface OrgChunk {
  id: string;
  text: string; // enriched text for embedding
  rawText: string; // original text
  filePath: string;
  folder: string;
  lineNumber: number;
  endLineNumber: number;
  chunkType: "heading" | "content"; // 2-tier: heading vs content
  metadata: DenoteMetadata;
  hierarchy: string; // "meta > 데이터로그 > 관련메타"
  heading?: OrgHeading;
}

// --- Folder-based chunk config (from embedding-config, verified on 2945 files) ---

const FOLDER_CHUNK_CONFIG: Record<string, { maxChars: number; overlap: number }> = {
  meta: { maxChars: 6000, overlap: 400 }, // 1500 tokens × 4
  bib: { maxChars: 4800, overlap: 300 }, // 1200 tokens
  notes: { maxChars: 4000, overlap: 300 }, // 1000 tokens
  journal: { maxChars: 3200, overlap: 200 }, // 800 tokens
  botlog: { maxChars: 4000, overlap: 300 },
  llmlog: { maxChars: 3200, overlap: 200 },
  office: { maxChars: 4000, overlap: 300 },
  default: { maxChars: 4000, overlap: 300 },
};

// --- Front matter parsing ---

export function parseDenoteFilename(filePath: string): Partial<DenoteMetadata> {
  const basename =
    filePath
      .split("/")
      .pop()
      ?.replace(/\.org$/, "") ?? "";

  // YYYYMMDDTHHMMSS--title__tag1_tag2
  const match = basename.match(
    /^(\d{8}T\d{6})--(.+?)(?:__(.+))?$/,
  );
  if (!match) return {};

  const identifier = match[1];
  const titleSlug = match[2];
  const tagsPart = match[3];
  const filetags = tagsPart ? tagsPart.split("_").filter(Boolean) : [];

  return { identifier, filetags, title: titleSlug };
}

export function parseOrgFrontMatter(content: string, filePath: string): DenoteMetadata {
  const fromFilename = parseDenoteFilename(filePath);

  // Folder from path
  const parts = filePath.split("/");
  const orgIdx = parts.findIndex((p) => p === "org");
  const folder = orgIdx >= 0 && orgIdx + 1 < parts.length ? parts[orgIdx + 1] : "unknown";

  // Parse #+key: value lines (only at start, before first heading)
  const headerEnd = content.indexOf("\n*");
  const header = headerEnd > 0 ? content.slice(0, headerEnd) : content.slice(0, 2000);

  const get = (key: string): string => {
    const re = new RegExp(`^#\\+${key}:\\s*(.+)$`, "mi");
    const m = header.match(re);
    return m?.[1]?.trim() ?? "";
  };

  const title = get("title") || fromFilename.title || "";
  const date = get("date");
  const identifier = get("identifier") || fromFilename.identifier || "";

  // filetags: :tag1:tag2:
  const filetagsRaw = get("filetags");
  const filetags = filetagsRaw
    ? filetagsRaw
        .split(":")
        .filter((t) => t.length > 0)
    : fromFilename.filetags ?? [];

  // references: key1;key2
  const refRaw = get("reference");
  const references = refRaw ? refRaw.split(";").map((r) => r.trim()).filter(Boolean) : [];

  // Title prefix detection (§, †, ‡, @, #)
  const prefixMatch = title.match(/^([§†‡@#])/);
  const titlePrefix = prefixMatch?.[1] ?? "";

  // GPTEL properties
  const hasGptelProps = /^:GPTEL_MODEL:/m.test(header) || /^:GPTEL_BACKEND:/m.test(header);

  return {
    identifier,
    title,
    filetags,
    date,
    folder,
    references,
    titlePrefix,
    hasGptelProps,
  };
}

// --- Heading parser ---

export function parseOrgHeadings(content: string): OrgHeading[] {
  const lines = content.split("\n");
  const headings: OrgHeading[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match org headings: * Title :tag1:tag2:
    const match = line.match(/^(\*+)\s+(.+?)(?:\s+(:[a-zA-Z0-9_:]+:))?\s*$/);
    if (!match) continue;

    const level = match[1].length;
    const rawTitle = match[2].trim();
    const tagsStr = match[3] ?? "";
    const tags = tagsStr
      .split(":")
      .filter((t) => t.length > 0);

    // Parse PROPERTIES drawer if present
    const properties: Record<string, string> = {};
    if (i + 1 < lines.length && lines[i + 1].trim() === ":PROPERTIES:") {
      for (let j = i + 2; j < lines.length; j++) {
        const propLine = lines[j].trim();
        if (propLine === ":END:") break;
        const propMatch = propLine.match(/^:([A-Z_]+):\s*(.*)$/);
        if (propMatch) {
          properties[propMatch[1]] = propMatch[2];
        }
      }
    }

    headings.push({
      level,
      title: rawTitle,
      tags,
      lineNumber: i + 1,
      properties,
      isArchive: tags.includes("ARCHIVE"),
      isLlmlog: tags.includes("LLMLOG"),
    });
  }

  return headings;
}

// --- Hierarchy builder ---

function buildHierarchy(headings: OrgHeading[], currentIdx: number): string {
  const current = headings[currentIdx];
  const path: string[] = [current.title];

  for (let i = currentIdx - 1; i >= 0; i--) {
    if (headings[i].level < current.level) {
      path.unshift(headings[i].title);
      if (headings[i].level === 1) break;
    }
  }

  return path.join(" > ");
}

// --- Content extraction between headings ---

function extractContentBetween(
  lines: string[],
  startLine: number, // 0-indexed
  endLine: number, // 0-indexed, exclusive
): string {
  const relevant = lines.slice(startLine, endLine);

  // Skip PROPERTIES drawer
  const filtered: string[] = [];
  let inProperties = false;
  for (const line of relevant) {
    const trimmed = line.trim();
    if (trimmed === ":PROPERTIES:") {
      inProperties = true;
      continue;
    }
    if (trimmed === ":END:" && inProperties) {
      inProperties = false;
      continue;
    }
    if (inProperties) continue;

    // Skip org front-matter directives but keep block markers (semantic info)
    if (/^#\+(title|date|filetags|identifier|export|hugo|description|OPTIONS|STARTUP|reference)/i.test(trimmed)) continue;

    filtered.push(line);
  }

  return filtered.join("\n").trim();
}

// --- Enriched text for embedding ---

function buildEmbeddingText(
  content: string,
  metadata: DenoteMetadata,
  hierarchy: string,
  heading?: OrgHeading,
): string {
  const parts: string[] = [];

  // File-level context (compact)
  if (metadata.title) {
    parts.push(metadata.title);
  }
  if (metadata.filetags.length > 0) {
    parts.push(`[${metadata.filetags.join(", ")}]`);
  }

  // Hierarchy context
  if (hierarchy && hierarchy !== metadata.title) {
    parts.push(`> ${hierarchy}`);
  }

  // Heading tags (if different from filetags)
  if (heading?.tags.length && !heading.isArchive) {
    const extra = heading.tags.filter((t) => !metadata.filetags.includes(t.toLowerCase()));
    if (extra.length > 0) {
      parts.push(`(${extra.join(", ")})`);
    }
  }

  // Content
  if (content) {
    parts.push("");
    parts.push(content);
  }

  return parts.join("\n");
}

// --- Protected span detection ---
//
// Org blocks (src, quote, example, export, verse) and contiguous tables
// are atomic units — never split inside them.

interface ProtectedSpan {
  startLine: number;
  endLine: number; // inclusive
  kind: "src" | "quote" | "example" | "export" | "verse" | "block" | "table";
}

function findProtectedSpans(lines: string[]): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];

  // --- Org blocks ---
  let blockStart = -1;
  let blockKind: ProtectedSpan["kind"] = "block";
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim().toLowerCase();
    const beginMatch = trimmed.match(/^#\+begin_(src|quote|example|export|verse)\b/);
    if (beginMatch && blockStart === -1) {
      blockStart = i;
      blockKind = beginMatch[1] as ProtectedSpan["kind"];
    } else if (/^#\+begin_/.test(trimmed) && blockStart === -1) {
      // Other org blocks (ai, comment, etc.) — protect too
      blockStart = i;
      blockKind = "block";
    }
    if (/^#\+end_/.test(trimmed) && blockStart >= 0) {
      spans.push({ startLine: blockStart, endLine: i, kind: blockKind });
      blockStart = -1;
    }
  }

  // --- Contiguous tables ---
  let tableStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isTable = i < lines.length && /^\s*\|/.test(lines[i]);
    if (isTable && tableStart === -1) {
      tableStart = i;
    } else if (!isTable && tableStart >= 0) {
      // Only protect multi-line tables (single | line is not a table)
      if (i - tableStart >= 2) {
        spans.push({ startLine: tableStart, endLine: i - 1, kind: "table" });
      }
      tableStart = -1;
    }
  }

  return spans;
}

// --- Sub-chunking for long sections (org-aware break point scoring) ---
//
// Design: llmlog 20260416T135457
// - Protected spans (blocks + tables) are NEVER split — block integrity is absolute
// - Candidate break points scored by structural significance
// - Distance decay penalizes candidates far from target length
// - Search window: 0.60 ~ 1.25 × maxChars

function subChunkContent(
  text: string,
  maxChars: number,
  overlap: number,
): Array<{ text: string; offsetLines: number }> {
  if (text.length <= maxChars) {
    return [{ text, offsetLines: 0 }];
  }

  const lines = text.split("\n");
  const spans = findProtectedSpans(lines);

  // Build per-line protection lookup
  const inProtected: boolean[] = new Array(lines.length).fill(false);
  for (const span of spans) {
    for (let i = span.startLine; i <= span.endLine; i++) {
      inProtected[i] = true;
    }
  }

  // Cumulative char positions (charPos[i] = total chars up to line i, exclusive)
  const charPos: number[] = new Array(lines.length + 1);
  charPos[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    charPos[i + 1] = charPos[i] + lines[i].length + 1;
  }

  // Break point score — "break BEFORE line idx" score
  function breakScore(idx: number): number {
    if (idx <= 0 || idx >= lines.length) return 0;
    if (inProtected[idx] || inProtected[idx - 1]) return 0;

    const line = lines[idx].trim();
    const prev = lines[idx - 1].trim();
    const prevLower = prev.toLowerCase();

    // After block/table end (highest non-heading score)
    if (/^#\+end_(src|quote|example|export|verse)\b/i.test(prevLower)) return 95;
    if (/^#\+end_/i.test(prevLower)) return 85;
    // Before block start
    if (/^#\+begin_(src|quote|example|export|verse)\b/i.test(line.toLowerCase())) return 95;
    if (/^#\+begin_/i.test(line)) return 85;
    // Table boundary
    if (/^\|/.test(prev) && !/^\|/.test(line)) return 75;
    if (!/^\|/.test(prev) && /^\|/.test(line)) return 75;
    // Double blank line
    if (prev === "" && line === "") return 25;
    // Single blank line boundary
    if (prev === "" || line === "") return 18;
    // List item start
    if (/^[-+*] /.test(line) && !/^[-+*] /.test(prev)) return 14;
    // Any line
    return 1;
  }

  // --- Split loop ---
  const chunks: Array<{ text: string; offsetLines: number }> = [];
  let startIdx = 0;

  while (startIdx < lines.length) {
    const startCharPos = charPos[startIdx];
    const remainingChars = charPos[lines.length] - startCharPos;

    // If remaining fits in one chunk, take it all
    if (remainingChars <= maxChars) {
      chunks.push({ text: lines.slice(startIdx).join("\n"), offsetLines: startIdx });
      break;
    }

    // Target position and search window (0.60 ~ 1.25 × maxChars from start)
    const targetCharPos = startCharPos + maxChars;
    const windowMinChars = startCharPos + Math.floor(maxChars * 0.60);
    const windowMaxChars = startCharPos + Math.floor(maxChars * 1.25);
    const windowPenaltyRange = maxChars * 0.35;

    // Find line indices for window boundaries
    let windowMinLine = startIdx + 1;
    let windowMaxLine = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (charPos[i] >= windowMinChars) { windowMinLine = i; break; }
    }
    for (let i = windowMinLine; i <= lines.length; i++) {
      if (charPos[i] > windowMaxChars) { windowMaxLine = i; break; }
    }

    // Collect candidates with effective score
    let bestIdx = -1;
    let bestEffective = -Infinity;

    for (let i = windowMinLine; i <= windowMaxLine && i < lines.length; i++) {
      const score = breakScore(i);
      if (score <= 0) continue; // skip protected interiors

      const distancePenalty = Math.abs(charPos[i] - targetCharPos) / windowPenaltyRange * 40;
      const effective = score - distancePenalty;

      if (effective > bestEffective) {
        bestEffective = effective;
        bestIdx = i;
      }
    }

    // No valid candidate found — extend past window to first non-protected line
    if (bestIdx < 0) {
      for (let i = windowMaxLine; i < lines.length; i++) {
        if (!inProtected[i] && !inProtected[Math.max(0, i - 1)]) {
          bestIdx = i;
          break;
        }
      }
      // Absolute fallback: take everything remaining
      if (bestIdx < 0) {
        chunks.push({ text: lines.slice(startIdx).join("\n"), offsetLines: startIdx });
        break;
      }
    }

    chunks.push({
      text: lines.slice(startIdx, bestIdx).join("\n"),
      offsetLines: startIdx,
    });

    // Advance with overlap (but don't overlap into a protected region)
    let nextStart = bestIdx;
    if (overlap > 0 && bestIdx > startIdx) {
      let overlapChars = 0;
      for (let j = bestIdx - 1; j > startIdx && overlapChars < overlap; j--) {
        if (inProtected[j]) break;
        overlapChars += lines[j].length + 1;
        nextStart = j;
      }
    }
    startIdx = nextStart;
  }

  return chunks;
}

// --- Micro-heading merge ---
//
// Level 3+ headings with <700 chars and no protected blocks are noise
// when chunked independently. Merge consecutive siblings under the
// same parent into combined content chunks.
//
// Design: llmlog 20260416T135457

interface HeadingSegment {
  headingIdx: number;
  heading: OrgHeading;
  rawContent: string;
  startLine: number;
  endLine: number;
}

function buildHeadingSegments(
  headings: OrgHeading[],
  lines: string[],
): HeadingSegment[] {
  const segments: HeadingSegment[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.isArchive) continue;

    const startLine = h.lineNumber; // 1-indexed, used as 0-indexed array offset
    let endLine = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].lineNumber - 1;
        break;
      }
    }

    const rawContent = extractContentBetween(lines, startLine, endLine);
    segments.push({ headingIdx: i, heading: h, rawContent, startLine, endLine });
  }
  return segments;
}

function isMicroHeading(seg: HeadingSegment): boolean {
  if (seg.heading.level < 3) return false;
  if (seg.rawContent.length >= 700) return false;
  // Check for protected blocks
  if (/^\s*#\+(begin_src|begin_quote|begin_example|begin_export|begin_verse)\b/mi.test(seg.rawContent)) return false;
  // Check for tables (2+ consecutive | lines)
  const tableLines = seg.rawContent.split("\n").filter(l => /^\s*\|/.test(l));
  if (tableLines.length >= 2) return false;
  return true;
}

function findParentHeading(headings: OrgHeading[], idx: number): number {
  const level = headings[idx].level;
  for (let i = idx - 1; i >= 0; i--) {
    if (headings[i].level < level) return i;
  }
  return -1;
}

interface MergedSegment {
  kind: "single" | "merged";
  segments: HeadingSegment[];
  parentHeadingIdx: number; // -1 if no parent
}

function mergeHeadingSegments(
  segments: HeadingSegment[],
  headings: OrgHeading[],
): MergedSegment[] {
  const result: MergedSegment[] = [];
  let i = 0;

  while (i < segments.length) {
    const seg = segments[i];

    if (!isMicroHeading(seg)) {
      result.push({ kind: "single", segments: [seg], parentHeadingIdx: findParentHeading(headings, seg.headingIdx) });
      i++;
      continue;
    }

    // Start collecting micro siblings
    const parentIdx = findParentHeading(headings, seg.headingIdx);
    const group: HeadingSegment[] = [seg];
    let groupChars = seg.rawContent.length;

    let j = i + 1;
    while (j < segments.length && group.length < 3) {
      const next = segments[j];
      if (!isMicroHeading(next)) break;
      // Must share same parent
      if (findParentHeading(headings, next.headingIdx) !== parentIdx) break;
      // Must be same level siblings (not nested)
      if (next.heading.level !== seg.heading.level) break;
      // Cumulative size check
      if (groupChars + next.rawContent.length > 1200) break;
      group.push(next);
      groupChars += next.rawContent.length;
      j++;
    }

    if (group.length > 1) {
      result.push({ kind: "merged", segments: group, parentHeadingIdx: parentIdx });
    } else {
      result.push({ kind: "single", segments: [seg], parentHeadingIdx: parentIdx });
    }
    i = j;
  }

  return result;
}

// --- Main chunker ---

export function chunkOrgFile(
  content: string,
  filePath: string,
): OrgChunk[] {
  const metadata = parseOrgFrontMatter(content, filePath);
  const headings = parseOrgHeadings(content);
  const lines = content.split("\n");
  const chunks: OrgChunk[] = [];

  const folderConfig = FOLDER_CHUNK_CONFIG[metadata.folder] ?? FOLDER_CHUNK_CONFIG.default;

  // Skip empty or very small files
  if (content.length < 50) return [];

  // Pre-compute micro-heading merge groups (needed for both tiers)
  const segments = headings.length > 0 ? buildHeadingSegments(headings, lines) : [];
  const merged = headings.length > 0 ? mergeHeadingSegments(segments, headings) : [];
  const mergedHeadingLines = new Set<number>();
  for (const group of merged) {
    if (group.kind === "merged") {
      for (const seg of group.segments) {
        mergedHeadingLines.add(seg.heading.lineNumber);
      }
    }
  }

  // --- Tier 1: Heading chunks (for fast structural search) ---

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.isArchive) continue; // Skip :ARCHIVE: headings
    if (mergedHeadingLines.has(h.lineNumber)) continue; // Skip merged micro-headings

    const hierarchy = buildHierarchy(headings, i);
    const headingText = buildEmbeddingText(
      "", // No content — heading only
      metadata,
      hierarchy,
      h,
    );

    if (headingText.length < 40) continue; // skip tiny heading-only chunks (noise for embeddings)

    chunks.push({
      id: `${filePath}:h${h.lineNumber}`,
      text: headingText,
      rawText: h.title,
      filePath,
      folder: metadata.folder,
      lineNumber: h.lineNumber,
      endLineNumber: h.lineNumber,
      chunkType: "heading",
      metadata,
      hierarchy,
      heading: h,
    });
  }

  // --- Tier 2: Content chunks (for deep search) ---

  if (headings.length === 0) {
    // No headings — chunk entire file
    const text = extractContentBetween(lines, 0, lines.length);
    if (text.length < 30) return chunks;

    const subChunks = subChunkContent(text, folderConfig.maxChars, folderConfig.overlap);
    for (let i = 0; i < subChunks.length; i++) {
      const enriched = buildEmbeddingText(subChunks[i].text, metadata, "", undefined);
      chunks.push({
        id: `${filePath}:c${i}`,
        text: enriched,
        rawText: subChunks[i].text,
        filePath,
        folder: metadata.folder,
        lineNumber: subChunks[i].offsetLines + 1,
        endLineNumber: subChunks[i].offsetLines + subChunks[i].text.split("\n").length,
        chunkType: "content",
        metadata,
        hierarchy: "",
      });
    }
    return chunks;
  }

  // Chunk content under each heading (with micro-heading merge)
  for (const group of merged) {
    if (group.kind === "merged") {
      // Merged micro-headings: combine content with compressed titles
      const titles = group.segments.map(s => s.heading.title);
      const combinedRaw = group.segments.map(s => s.rawContent).join("\n\n");
      if (combinedRaw.length < 30) continue;

      const firstSeg = group.segments[0];
      const lastSeg = group.segments[group.segments.length - 1];
      // Use parent heading for hierarchy if available
      const hierIdx = group.parentHeadingIdx >= 0 ? group.parentHeadingIdx : firstSeg.headingIdx;
      const hierarchy = buildHierarchy(headings, hierIdx);
      const parentHeading = group.parentHeadingIdx >= 0 ? headings[group.parentHeadingIdx] : firstSeg.heading;

      // Prepend compressed sub-heading titles
      const titleLine = `[${titles.join(" / ")}]`;
      const mergedContent = `${titleLine}\n${combinedRaw}`;

      const subChunks = subChunkContent(mergedContent, folderConfig.maxChars, folderConfig.overlap);
      for (let j = 0; j < subChunks.length; j++) {
        const enriched = buildEmbeddingText(subChunks[j].text, metadata, hierarchy, parentHeading);
        chunks.push({
          id: `${filePath}:c${firstSeg.heading.lineNumber}:m${j}`,
          text: enriched,
          rawText: subChunks[j].text,
          filePath,
          folder: metadata.folder,
          lineNumber: firstSeg.heading.lineNumber,
          endLineNumber: lastSeg.heading.lineNumber + (lastSeg.rawContent.split("\n").length),
          chunkType: "content",
          metadata,
          hierarchy,
          heading: parentHeading,
        });
      }

    } else {
      // Single heading — process as before
      const seg = group.segments[0];
      const h = seg.heading;
      if (seg.rawContent.length < 30) continue;

      const hierarchy = buildHierarchy(headings, seg.headingIdx);
      const subChunks = subChunkContent(seg.rawContent, folderConfig.maxChars, folderConfig.overlap);

      for (let j = 0; j < subChunks.length; j++) {
        const enriched = buildEmbeddingText(subChunks[j].text, metadata, hierarchy, h);
        chunks.push({
          id: `${filePath}:c${h.lineNumber}:${j}`,
          text: enriched,
          rawText: subChunks[j].text,
          filePath,
          folder: metadata.folder,
          lineNumber: h.lineNumber + subChunks[j].offsetLines,
          endLineNumber: h.lineNumber + subChunks[j].offsetLines + subChunks[j].text.split("\n").length,
          chunkType: "content",
          metadata,
          hierarchy,
          heading: h,
        });
      }
    }
  }

  return chunks;
}

// --- File discovery ---

import * as fsSync from "node:fs";
import * as pathMod from "node:path";

export function findOrgFiles(orgDir?: string): string[] {

  const dir = orgDir ?? pathMod.join(process.env.HOME ?? "", "sync", "org");
  if (!fsSync.existsSync(dir)) return [];

  const files: string[] = [];
  const SKIP_DIRS = new Set([".git", "node_modules", ".agent-shell", "setup", "archives"]);

  function walk(d: string) {
    const entries = fsSync.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(pathMod.join(d, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".org")) {
        files.push(pathMod.join(d, entry.name));
      }
    }
  }

  walk(dir);
  return files.sort();
}
