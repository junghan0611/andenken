/**
 * LanceDB Vector Store
 *
 * Wraps LanceDB for session chunk storage and retrieval.
 * Patterns from OpenClaw extensions/memory-lancedb:
 * - Lazy init with promise dedup
 * - Dummy data → delete for table creation
 * - L2 distance → similarity: 1/(1+distance)
 */

import type * as LanceDB from "@lancedb/lancedb";
import * as path from "node:path";
import * as fs from "node:fs";
import type { SessionSource } from "./session-indexer.js";

// Lazy import to avoid startup cost
let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null =
  null;
const loadLanceDB = async (): Promise<typeof import("@lancedb/lancedb")> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  return await lancedbImportPromise;
};

export interface SearchResult {
  id: string;
  text: string;
  sessionFile: string;
  project: string;
  lineNumber: number;
  timestamp: string;
  role: string;
  source: string; // "pi" | "claude" | "" (org)
  metadata: Record<string, string>;
  score: number;
}

const TABLE_NAME = "session_chunks";

/**
 * Default data directory for LanceDB indexes.
 * ANDENKEN_DATA env var overrides (e.g. for tests or alternate installs).
 * Falls back to ~/repos/gh/andenken/data/ (standard install location).
 */
export function getDataDir(): string {
  if (process.env.ANDENKEN_DATA) return process.env.ANDENKEN_DATA;
  return path.join(process.env.HOME ?? "", "repos", "gh", "andenken", "data");
}

export function getSessionsDbPath(): string {
  return path.join(getDataDir(), "sessions.lance");
}

export function getOrgDbPath(): string {
  return path.join(getDataDir(), "org.lance");
}

export class VectorStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private dbPath: string;
  private vectorDim: number;

  constructor(dbPath?: string, vectorDim: number = 2560) {
    this.dbPath = dbPath ?? getSessionsDbPath();
    this.vectorDim = vectorDim;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);

    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
  }

  /**
   * Create table with dummy data then delete — OpenClaw pattern
   */
  private async createTable(): Promise<void> {
    if (!this.db) throw new Error("DB not connected");

    const dummyVector = Array.from({ length: this.vectorDim }).fill(
      0,
    ) as number[];
    this.table = await this.db.createTable(
      TABLE_NAME,
      [
        {
          id: "__schema__",
          text: "",
          vector: dummyVector,
          sessionFile: "",
          project: "",
          lineNumber: 0,
          timestamp: "",
          role: "",
          source: "",
          metadata: "{}",
        },
      ],
      { mode: "overwrite" },
    );
    await this.table.delete('id = "__schema__"');
  }

  async init(): Promise<void> {
    await this.ensureInitialized();
  }

  async ensureTable(): Promise<void> {
    await this.ensureInitialized();
    if (!this.table) {
      await this.createTable();
    }
  }

  /**
   * Delete all chunks for a specific file.
   * Used by WriteBuffer to pre-clean before batched inserts.
   */
  async deleteByFile(filePath: string): Promise<void> {
    await this.ensureTable();
    if (!this.table) return;
    try {
      await this.table.delete(`\`sessionFile\` = '${filePath.replace(/'/g, "''")}'`);
    } catch {
      // Table might be empty or filter syntax issue — safe to ignore
    }
  }

  /**
   * Add chunks with their embeddings.
   * Safe: deletes existing chunks for the same file before inserting,
   * preventing duplicates on re-indexing.
   * Used by index.ts (pi extension) where single-file batches are common.
   */
  async addChunks(
    chunks: Array<{
      id: string;
      text: string;
      vector: number[];
      sessionFile: string;
      project: string;
      lineNumber: number;
      timestamp: string;
      role: string;
      source?: string;
      metadata: Record<string, string>;
    }>,
  ): Promise<void> {
    await this.ensureTable();
    if (chunks.length === 0) return;

    // Delete existing chunks for this file (prevent duplicates)
    const file = chunks[0].sessionFile;
    if (file) {
      await this.deleteByFile(file);
    }

    await this.addChunksRaw(chunks);
  }

  /**
   * Add chunks without deleting existing ones.
   * Used by WriteBuffer after explicit pre-deletion.
   */
  async addChunksRaw(
    chunks: Array<{
      id: string;
      text: string;
      vector: number[];
      sessionFile: string;
      project: string;
      lineNumber: number;
      timestamp: string;
      role: string;
      source?: string;
      metadata: Record<string, string>;
    }>,
  ): Promise<void> {
    await this.ensureTable();
    if (chunks.length === 0) return;

    const rows = chunks.map((c) => ({
      id: c.id,
      text: c.text,
      vector: c.vector,
      sessionFile: c.sessionFile,
      project: c.project,
      lineNumber: c.lineNumber,
      timestamp: c.timestamp,
      role: c.role,
      source: c.source ?? "",
      metadata: JSON.stringify(c.metadata),
    }));

    await this.table!.add(rows);
  }

  /**
   * Vector similarity search
   * L2 distance → similarity: 1/(1+distance) — OpenClaw pattern
   */
  async search(
    queryVector: number[],
    limit: number = 10,
    minScore: number = 0.1,
    sourceFilter?: SessionSource,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();
    if (!this.table) return [];

    let results;
    try {
      let query = this.table.vectorSearch(queryVector);
      if (sourceFilter) query = query.where(`source = '${sourceFilter}'`);
      results = await query.limit(limit).toArray();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Dimension mismatch: index built with different provider
      if (msg.includes("vector column") || msg.includes("dimension")) {
        process.stderr.write(
          `⚠ Vector dimension mismatch (query=${queryVector.length}d, db=${this.dbPath}): ${msg.slice(0, 120)}. Falling back to FTS only.\n`,
        );
        return [];
      }
      throw err;
    }

    return results
      .map((r) => ({
        id: r.id as string,
        text: r.text as string,
        sessionFile: r.sessionFile as string,
        project: r.project as string,
        lineNumber: r.lineNumber as number,
        timestamp: r.timestamp as string,
        role: r.role as string,
        source: (r.source as string) ?? "",
        metadata: JSON.parse(r.metadata as string),
        score: r._distance != null ? 1 / (1 + (r._distance as number)) : 0,
      }))
      .filter((r) => r.score >= minScore);
  }

  /**
   * Full-text search (BM25-style via LanceDB FTS)
   * Uses query().fullTextSearch() — not search() which requires embedding functions
   */
  async fullTextSearch(
    query: string,
    limit: number = 10,
    sourceFilter?: SessionSource,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();
    if (!this.table) return [];

    try {
      let lanceQuery = this.table
        .query()
        .fullTextSearch(query);
      if (sourceFilter) lanceQuery = lanceQuery.where(`source = '${sourceFilter}'`);
      const results = await lanceQuery
        .select([
          "id",
          "text",
          "sessionFile",
          "project",
          "lineNumber",
          "timestamp",
          "role",
          "source",
          "metadata",
        ])
        .limit(limit)
        .toArray();

      return results.map((r, i) => ({
        id: r.id as string,
        text: r.text as string,
        sessionFile: r.sessionFile as string,
        project: r.project as string,
        lineNumber: r.lineNumber as number,
        timestamp: r.timestamp as string,
        role: r.role as string,
        source: (r.source as string) ?? "",
        metadata: JSON.parse(r.metadata as string),
        score: r._score != null ? (r._score as number) : 1 / (i + 1), // rank-based fallback
      }));
    } catch {
      // FTS index might not exist yet
      return [];
    }
  }

  /**
   * Substring search via LanceDB `contains(text, '<term>')` filter.
   *
   * Acts as a CJK safety net: LanceDB's FTS (tantivy-based) can return
   * 0 results for very short Korean/CJK tokens (1–2 chars) that the
   * tokenizer drops or splits below match threshold. openclaw uses the
   * same idea (`text LIKE '%term%'` substringTerms branch in
   * planKeywordSearch). LIKE here goes through LanceDB's `contains()`.
   *
   * Score is rank-based — these results are merged into the FTS bucket
   * upstream and re-ranked by the hybrid retriever; raw scores from
   * substring search are not directly comparable to FTS BM25 scores.
   */
  async substringSearch(
    term: string,
    limit: number = 10,
    sourceFilter?: SessionSource,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();
    if (!this.table) return [];
    if (!term) return [];
    // Escape single quotes for SQL string literal
    const safe = term.replace(/'/g, "''");
    try {
      const where = sourceFilter
        ? `contains(text, '${safe}') AND source = '${sourceFilter}'`
        : `contains(text, '${safe}')`;
      const results = await this.table
        .query()
        .where(where)
        .select([
          "id",
          "text",
          "sessionFile",
          "project",
          "lineNumber",
          "timestamp",
          "role",
          "source",
          "metadata",
        ])
        .limit(limit)
        .toArray();

      return results.map((r, i) => ({
        id: r.id as string,
        text: r.text as string,
        sessionFile: r.sessionFile as string,
        project: r.project as string,
        lineNumber: r.lineNumber as number,
        timestamp: r.timestamp as string,
        role: r.role as string,
        source: (r.source as string) ?? "",
        metadata: JSON.parse(r.metadata as string),
        score: 1 / (i + 1), // rank-based; not comparable to BM25
      }));
    } catch {
      return [];
    }
  }

  /**
   * Create FTS index on text column
   */
  async createFtsIndex(): Promise<void> {
    await this.ensureInitialized();
    if (!this.table) return;
    const lancedb = await loadLanceDB();
    try {
      await this.table.createIndex("text", {
        config: lancedb.Index.fts(),
      });
    } catch {
      // Index might already exist
    }
  }

  /**
   * Get all indexed file paths (for incremental indexing)
   * Uses SQL-based distinct query to avoid loading all rows
   */
  async getIndexedFiles(): Promise<Set<string>> {
    await this.ensureInitialized();
    if (!this.table) return new Set();

    try {
      // LanceDB query with explicit large limit to get all unique files
      const count = await this.table.countRows();
      const results = await this.table
        .query()
        .select(["sessionFile"])
        .limit(count)
        .toArray();

      return new Set(results.map((r) => r.sessionFile as string));
    } catch {
      return new Set();
    }
  }

  /**
   * @deprecated Use getIndexedFiles() instead
   */
  async getIndexedSessionFiles(): Promise<Set<string>> {
    return this.getIndexedFiles();
  }

  /**
   * Get total count of indexed chunks
   */
  async getCount(): Promise<number> {
    await this.ensureInitialized();
    if (!this.table) return 0;
    return await this.table.countRows();
  }

  /**
   * Actual vector dimension of the stored table, read by sampling one row.
   * Returns null if table is empty or unreadable. Use this for status/diagnostics
   * so the displayed dim reflects the DB truth, not the configured provider.
   */
  async getActualVectorDim(): Promise<number | null> {
    await this.ensureInitialized();
    if (!this.table) return null;
    try {
      const rows = await this.table.query().limit(1).toArray();
      if (rows.length === 0) return null;
      const v = rows[0].vector;
      if (Array.isArray(v)) return v.length;
      if (v && typeof v.length === "number") return v.length;
      return null;
    } catch {
      return null;
    }
  }

  /** Configured vector dimension passed to the constructor. */
  get configuredDim(): number {
    return this.vectorDim;
  }

  /**
   * Cross-track safety guard for the QUERY path.
   *
   * Returns `{ ok: true }` when the table is empty (nothing to corrupt) or
   * when the actual stored dim matches the configured dim. Returns
   * `{ ok: false, reason }` otherwise. Callers in the search/fallback paths
   * should `await store.checkCompatibleDim()` before issuing `search()` /
   * `fullTextSearch()` against a store that might have been built with a
   * different provider.
   *
   * This NEVER throws. The query path is user-facing — surface the
   * mismatch as a diagnostic and skip the affected corpus instead of
   * killing the whole search.
   */
  async checkCompatibleDim(): Promise<{ ok: boolean; reason?: string; actual?: number; configured?: number }> {
    try {
      const actual = await this.getActualVectorDim();
      if (actual === null) return { ok: true, configured: this.vectorDim };
      if (actual === this.vectorDim) return { ok: true, actual, configured: this.vectorDim };
      return {
        ok: false,
        actual,
        configured: this.vectorDim,
        reason: `dim mismatch: ${this.dbPath} stored=${actual}d, configured=${this.vectorDim}d`,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `dim check failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      };
    }
  }

  /**
   * Cross-track safety guard for the WRITE/INDEX path.
   *
   * Same comparison as `checkCompatibleDim` but THROWS on mismatch. Indexers
   * MUST call this once after `init()` and before any `add()` / `upsert()` so
   * a wrong provider never corrupts the LanceDB schema. An empty table
   * (actual === null) is allowed to pass — that's a fresh DB about to be
   * filled with the configured dim.
   */
  async assertCompatibleDim(): Promise<void> {
    const check = await this.checkCompatibleDim();
    if (!check.ok) {
      throw new Error(
        `Refusing to write to ${this.dbPath}: ${check.reason} — ` +
        `this would corrupt the index. Run rebuild or check provider config.`,
      );
    }
  }

  /**
   * Drop all data and recreate
   */
  async reset(): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("DB not connected");

    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      await this.db.dropTable(TABLE_NAME);
    }
    this.table = null;
    this.initPromise = null;
    await this.createTable();
  }

  async close(): Promise<void> {
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}
