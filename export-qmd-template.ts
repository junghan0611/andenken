/**
 * memory-md template renderers — Stage 1 of issue #1.
 *
 * Pure functions: take parsed org data, return markdown strings.
 * No I/O, no policy. Policy lives in org-chunker.ts.
 *
 * The output shape follows the issue body's "Proposed memory-md template":
 * metadata is rendered into the markdown body (not YAML frontmatter) so qmd's
 * filepath/title/body/context indexing can see it.
 */

import type { DenoteMetadata, OrgChunk } from "./org-chunker.js";

export interface RenderOptions {
  publicUrlBase?: string;
}

export interface ContentPart {
  chunk: OrgChunk;
  partIndex: number; // 0-based
  partCount: number; // 1 when not split
}

const DENOTE_ID_RE = /^(\d{4})(\d{2})(\d{2})T\d{6}$/;

export function denoteIdToDate(identifier: string): string {
  const m = identifier.match(DENOTE_ID_RE);
  if (!m) return "unknown";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function buildPublicUrl(
  metadata: DenoteMetadata,
  publicUrlBase: string | undefined,
): string | undefined {
  if (!publicUrlBase) return undefined;
  const base = publicUrlBase.replace(/\/+$/, "");
  return `${base}/${metadata.folder}/${metadata.identifier}`;
}

function renderFileHeader(
  metadata: DenoteMetadata,
  filePath: string,
  publicUrlBase: string | undefined,
): string {
  const lines: string[] = [];
  const title = metadata.title || metadata.identifier || "(untitled)";
  lines.push(`# ${title}`);
  lines.push("");
  lines.push("Context:");
  lines.push(`- Source kind: org-note`);
  lines.push(`- Denote ID: ${metadata.identifier}`);
  lines.push(`- Folder: ${metadata.folder}`);
  lines.push(`- Time axis: ${denoteIdToDate(metadata.identifier)}`);
  lines.push(`- Filetags: ${metadata.filetags.join(", ")}`);
  const publicUrl = buildPublicUrl(metadata, publicUrlBase);
  if (publicUrl) lines.push(`- Public URL: ${publicUrl}`);
  lines.push(`- Original path: ${filePath}`);
  return lines.join("\n");
}

export function renderHeadingSection(part: ContentPart): string {
  const { chunk, partIndex, partCount } = part;
  // Single source of truth so the section title and the Context: Hierarchy
  // line always agree. A heading-less file produces chunks with empty
  // hierarchy; leaving the Context line blank breaks memory-md's invariant
  // that every section is self-describing for retrieval.
  const hierarchy = chunk.hierarchy || "(file body)";
  const partSuffix = partCount > 1 ? ` (part ${partIndex + 1}/${partCount})` : "";

  const lines: string[] = [];
  lines.push(`## ${hierarchy}${partSuffix}`);
  lines.push("");
  lines.push("Context:");
  lines.push(`- Hierarchy: ${hierarchy}`);
  const headingTags = chunk.heading?.tags ?? [];
  lines.push(`- Heading tags: ${headingTags.join(", ")}`);
  lines.push(`- Line: ${chunk.lineNumber}`);
  lines.push(`- Chunk type: content`);
  lines.push("");
  lines.push(chunk.rawText);
  return lines.join("\n");
}

/**
 * Group content chunks by their parent heading (lineNumber-keyed) so that
 * subChunkContent splits get a (part j+1/N) suffix while single-part headings
 * stay clean.
 */
export function groupContentChunks(chunks: OrgChunk[]): ContentPart[] {
  const contentChunks = chunks
    .filter((c) => c.chunkType === "content")
    .slice()
    .sort((a, b) => a.lineNumber - b.lineNumber);

  const groups = new Map<number, OrgChunk[]>();
  for (const c of contentChunks) {
    const key = c.heading?.lineNumber ?? -1;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  const parts: ContentPart[] = [];
  for (const c of contentChunks) {
    const key = c.heading?.lineNumber ?? -1;
    const siblings = groups.get(key)!;
    const partIndex = siblings.indexOf(c);
    parts.push({ chunk: c, partIndex, partCount: siblings.length });
  }
  return parts;
}

export function renderNoteFile(
  metadata: DenoteMetadata,
  chunks: OrgChunk[],
  filePath: string,
  opts: RenderOptions = {},
): string {
  const parts = groupContentChunks(chunks);
  const sections: string[] = [renderFileHeader(metadata, filePath, opts.publicUrlBase)];
  for (const part of parts) {
    sections.push(renderHeadingSection(part));
  }
  return sections.join("\n\n") + "\n";
}
