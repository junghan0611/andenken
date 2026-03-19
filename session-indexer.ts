/**
 * Session JSONL Indexer
 *
 * Extracts searchable chunks from session JSONL files.
 * Supports two runtimes:
 *
 * - pi:    ~/.pi/agent/sessions/--project--/*.jsonl
 *          type="message" + message.role
 *
 * - claude: ~/.claude/projects/-project/*.jsonl
 *           type="user" | type="assistant" (role merged into type)
 *
 * Chunks extracted:
 * - USER messages (what the user asked/instructed)
 * - Compaction summaries (session-level context)
 * - Assistant text responses (key conclusions)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

export type SessionSource = "pi" | "claude";

export interface SessionChunk {
  id: string; // unique: sessionFile:lineNumber
  text: string; // chunk text for embedding
  sessionFile: string; // path to JSONL file
  project: string; // extracted from session dir name
  lineNumber: number;
  timestamp: string; // ISO timestamp
  role: "user" | "compaction" | "assistant";
  source: SessionSource; // which runtime produced this session
  metadata: Record<string, string>;
}

// --- Pi format ---

interface PiJsonlMessage {
  type: string;
  timestamp?: number;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }> | string;
  };
  compaction?: {
    summary: string;
  };
}

// --- Claude Code format ---

interface ClaudeJsonlMessage {
  type: string; // "user" | "assistant" | "system" | "progress" | ...
  timestamp?: string; // ISO string (not epoch ms)
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }> | string;
  };
}

// --- Directory discovery ---

function getPiSessionsDir(): string {
  return path.join(process.env.HOME ?? "", ".pi", "agent", "sessions");
}

function getClaudeProjectsDir(): string {
  return path.join(process.env.HOME ?? "", ".claude", "projects");
}

/**
 * Find all JSONL session files from both runtimes
 */
export function findSessionFiles(baseDir?: string): string[] {
  if (baseDir) return scanDir(baseDir);

  return [
    ...scanDir(getPiSessionsDir()),
    ...scanClaudeDir(getClaudeProjectsDir()),
  ].sort();
}

/**
 * Find session files from a specific source only
 */
export function findSessionFilesBySource(source: SessionSource): string[] {
  if (source === "pi") return scanDir(getPiSessionsDir());
  return scanClaudeDir(getClaudeProjectsDir());
}

function scanDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const subdir of fs.readdirSync(dir)) {
    const subdirPath = path.join(dir, subdir);
    if (!fs.statSync(subdirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(subdirPath)) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(subdirPath, file));
      }
    }
  }
  return files;
}

function scanClaudeDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const subdir of fs.readdirSync(dir)) {
    const subdirPath = path.join(dir, subdir);
    if (!fs.statSync(subdirPath).isDirectory()) continue;
    // Top-level .jsonl files (main sessions)
    for (const file of fs.readdirSync(subdirPath)) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(subdirPath, file));
      }
    }
    // Also check UUID subdirs (session-id folders)
    for (const entry of fs.readdirSync(subdirPath)) {
      const entryPath = path.join(subdirPath, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      if (entry === "subagents") continue; // skip subagent sessions
      for (const file of fs.readdirSync(entryPath)) {
        if (file.endsWith(".jsonl")) {
          files.push(path.join(entryPath, file));
        }
      }
    }
  }
  return files;
}

// --- Project name extraction ---

/**
 * Extract project name from session directory path.
 *
 * Pi:    --home-junghan-repos-gh-agent-config-- → agent-config
 * Claude: -home-junghan-repos-gh-agent-config   → agent-config
 */
export function extractProjectName(sessionFile: string): string {
  // Walk up to find the project directory
  const parts = sessionFile.split("/");
  let dirName: string;

  if (sessionFile.includes("/.claude/projects/")) {
    // Claude: ~/.claude/projects/-home-junghan-repos-gh-X/...
    const projIdx = parts.indexOf("projects");
    dirName = parts[projIdx + 1] ?? "unknown";
  } else if (sessionFile.includes("/.pi/agent/sessions/")) {
    // Pi: ~/.pi/agent/sessions/--home-junghan-repos-gh-X--/...
    const sessIdx = parts.indexOf("sessions");
    dirName = parts[sessIdx + 1] ?? "unknown";
  } else {
    dirName = path.basename(path.dirname(sessionFile));
  }

  // Normalize: strip leading/trailing hyphens, extract last path segment
  const cleaned = dirName.replace(/^-+|-+$/g, "");
  for (const prefix of [
    "home-junghan-repos-gh-",
    "home-junghan-repos-work-",
    "home-junghan-repos-3rd-",
    "home-junghan-",
  ]) {
    if (cleaned.startsWith(prefix)) {
      return cleaned.slice(prefix.length) || "home";
    }
  }
  return cleaned || "unknown";
}

/**
 * Detect which runtime produced this session file
 */
export function detectSource(sessionFile: string): SessionSource {
  if (sessionFile.includes("/.claude/")) return "claude";
  return "pi";
}

// --- Chunk extraction ---

/**
 * Extract chunks from a single session JSONL file.
 * Auto-detects pi vs claude format.
 */
export async function extractSessionChunks(
  sessionFile: string,
): Promise<SessionChunk[]> {
  const chunks: SessionChunk[] = [];
  const project = extractProjectName(sessionFile);
  const source = detectSource(sessionFile);

  const fileStream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const chunk =
      source === "claude"
        ? parseClaudeLine(parsed as ClaudeJsonlMessage, sessionFile, project, lineNumber)
        : parsePiLine(parsed as PiJsonlMessage, sessionFile, project, lineNumber);

    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

function parsePiLine(
  parsed: PiJsonlMessage,
  sessionFile: string,
  project: string,
  lineNumber: number,
): SessionChunk | null {
  const timestamp = parsed.timestamp
    ? new Date(parsed.timestamp).toISOString()
    : "";

  // Compaction summaries
  if (parsed.type === "compaction" && parsed.compaction?.summary) {
    return {
      id: `${sessionFile}:${lineNumber}`,
      text: parsed.compaction.summary,
      sessionFile,
      project,
      lineNumber,
      timestamp,
      role: "compaction",
      source: "pi",
      metadata: { type: "compaction" },
    };
  }

  if (parsed.type !== "message" || !parsed.message) return null;

  const { role, content } = parsed.message;
  return parseMessageContent(
    role,
    content,
    sessionFile,
    project,
    lineNumber,
    timestamp,
    "pi",
  );
}

function parseClaudeLine(
  parsed: ClaudeJsonlMessage,
  sessionFile: string,
  project: string,
  lineNumber: number,
): SessionChunk | null {
  const { type } = parsed;

  // Claude Code: type IS the role ("user", "assistant")
  if (type !== "user" && type !== "assistant") return null;
  if (!parsed.message) return null;

  const timestamp = parsed.timestamp ?? "";
  const { content } = parsed.message;

  return parseMessageContent(
    type,
    content,
    sessionFile,
    project,
    lineNumber,
    timestamp,
    "claude",
  );
}

function parseMessageContent(
  role: string,
  content: Array<{ type: string; text?: string }> | string | undefined,
  sessionFile: string,
  project: string,
  lineNumber: number,
  timestamp: string,
  source: SessionSource,
): SessionChunk | null {
  if (!content) return null;
  const text = extractTextContent(content);

  if (role === "user" && text && text.length > 20) {
    return {
      id: `${sessionFile}:${lineNumber}`,
      text: truncateText(text, 2000),
      sessionFile,
      project,
      lineNumber,
      timestamp,
      role: "user",
      source,
      metadata: { type: "user_message" },
    };
  }

  if (role === "assistant" && text && text.length > 100) {
    return {
      id: `${sessionFile}:${lineNumber}`,
      text: truncateText(text, 2000),
      sessionFile,
      project,
      lineNumber,
      timestamp,
      role: "assistant",
      source,
      metadata: { type: "assistant_response" },
    };
  }

  return null;
}

// --- Helpers ---

function extractTextContent(
  content: Array<{ type: string; text?: string }> | string,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

// --- Legacy exports (backward compat with agent-config) ---

export function getSessionsBaseDir(): string {
  return getPiSessionsDir();
}
