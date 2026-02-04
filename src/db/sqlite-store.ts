/**
 * SQLite-based persistent index for codebase data.
 * Uses sql.js (WASM) — zero native compilation, works everywhere.
 * Drop-in replacement for JsonStore with dramatically faster queries at scale.
 *
 * Storage: .codedev-mcp/index.sqlite in the project root.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stat as fsStat } from 'node:fs/promises';
import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';

interface IndexedFile {
  path: string;
  mtime: number;
  lines: number;
  language: string;
  size: number;
}

interface IndexedSymbol {
  name: string;
  type: string;
  file: string;
  line: number;
  exported: boolean;
}

const INDEX_DIR = '.codedev-mcp';
const INDEX_FILE = 'index.sqlite';
const SCHEMA_VERSION = 2;

/**
 * SQLite-backed persistent index for codebase data using sql.js WASM.
 */
export class SqliteStore {
  private dbPath: string;
  private db: SqlJsDatabase | null = null;
  private dirty = false;
  private SQL: SqlJsStatic | null = null;

  /**
   * Create a new SqliteStore instance.
   * @param cwd - The working directory for the database file.
   */
  constructor(cwd: string) {
    this.dbPath = path.join(cwd, INDEX_DIR, INDEX_FILE);
  }

  /**
   * Initialize sql.js WASM module.
   * @returns The initialized sql.js static instance.
   */
  private async initSqlJs(): Promise<SqlJsStatic> {
    if (this.SQL) return this.SQL;
    const initSqlJs = (await import('sql.js')).default;
    const sql = await initSqlJs();
    this.SQL = sql;
    return sql;
  }

  /**
   * Run a query with bind parameters.
   * Replaces db.run() which doesn't support params in all cases.
   * @param sql - The SQL query string.
   * @param params - Bind parameters for the query.
   * @returns An array of result rows.
   */
  private query(sql: string, params: unknown[] = []): unknown[][] {
    if (!this.db) return [];
    try {
      const db = this.db as unknown as {
        prepare(sql: string): { bind(params: unknown[]): void; step(): boolean; get(): unknown[]; free(): void };
      };
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows: unknown[][] = [];
      while (stmt.step()) {
        rows.push(stmt.get());
      }
      stmt.free();
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Create tables if they don't exist.
   */
  private createSchema(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime REAL NOT NULL,
        lines INTEGER NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS imports (
        file TEXT NOT NULL,
        import_path TEXT NOT NULL,
        PRIMARY KEY (file, import_path)
      )
    `);
    // Indices for fast lookups
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_imports_path ON imports(import_path)`);

    // Analytics schema
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        success INTEGER NOT NULL,
        cached INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_usage_tool ON usage_stats(tool)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_stats(timestamp)`);

    // Set schema version
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)`, [String(SCHEMA_VERSION)]);
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('updated', ?)`, [new Date().toISOString()]);
  }

  /**
   * Load existing database from disk. Returns false if none exists or version mismatch.
   * @returns True if the database was loaded successfully.
   */
  async load(): Promise<boolean> {
    try {
      const SQL = await this.initSqlJs();
      const data = await readFile(this.dbPath);
      this.db = new SQL.Database(data);

      // Check schema version
      const result = this.db.exec(`SELECT value FROM meta WHERE key = 'version'`);
      if (!result.length || !result[0].values.length) {
        this.db.close();
        this.db = null;
        return false;
      }
      const version = parseInt(result[0].values[0][0] as string, 10);
      if (version !== SCHEMA_VERSION) {
        this.db.close();
        this.db = null;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save database to disk.
   */
  async save(): Promise<void> {
    if (!this.db || !this.dirty) return;
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('updated', ?)`, [new Date().toISOString()]);
    const data = this.db.export();
    const dir = path.dirname(this.dbPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }

  /**
   * Initialize a new empty database.
   * @param _ - The working directory (unused, kept for interface compatibility).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(_: string): Promise<void> {
    const SQL = await this.initSqlJs();
    this.db = new SQL.Database();
    this.createSchema();
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('created', ?)`, [new Date().toISOString()]);
    this.dirty = true;
  }

  /**
   * Check if a file needs re-indexing (mtime changed).
   * @param filePath - The file path to check.
   * @returns True if the file needs re-indexing.
   */
  async needsReindex(filePath: string): Promise<boolean> {
    if (!this.db) return true;
    const rows = this.query('SELECT mtime FROM files WHERE path = ?', [filePath]);
    if (!rows.length) return true;
    const storedMtime = rows[0][0] as number;
    try {
      const s = await fsStat(filePath);
      return s.mtimeMs !== storedMtime;
    } catch {
      return true;
    }
  }

  /**
   * Update file entry in index.
   * @param file - The file entry to update.
   */
  updateFile(file: IndexedFile): void {
    if (!this.db) return;
    this.db.run(`INSERT OR REPLACE INTO files (path, mtime, lines, language, size) VALUES (?, ?, ?, ?, ?)`, [
      file.path,
      file.mtime,
      file.lines,
      file.language,
      file.size,
    ]);
    this.dirty = true;
  }

  /**
   * Update symbols for a file (replaces all).
   * @param filePath - The file path whose symbols are being updated.
   * @param symbols - The new symbols for the file.
   */
  updateSymbols(filePath: string, symbols: IndexedSymbol[]): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM symbols WHERE file = ?`, [filePath]);
    for (const s of symbols) {
      this.db.run(`INSERT INTO symbols (name, type, file, line, exported) VALUES (?, ?, ?, ?, ?)`, [
        s.name,
        s.type,
        s.file,
        s.line,
        s.exported ? 1 : 0,
      ]);
    }
    this.dirty = true;
  }

  /**
   * Update imports for a file.
   * @param filePath - The file path whose imports are being updated.
   * @param imports - The new import paths for the file.
   */
  updateImports(filePath: string, imports: string[]): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM imports WHERE file = ?`, [filePath]);
    for (const imp of imports) {
      this.db.run(`INSERT INTO imports (file, import_path) VALUES (?, ?)`, [filePath, imp]);
    }
    this.dirty = true;
  }

  /**
   * Query symbols by name pattern.
   * @param pattern - Pattern to match symbol names (uses SQL LIKE).
   * @param type - Optional symbol type filter.
   * @returns Matching symbols.
   */
  findSymbols(pattern: string, type?: string): IndexedSymbol[] {
    if (!this.db) return [];
    let sql = 'SELECT name, type, file, line, exported FROM symbols WHERE name LIKE ?';
    const params: unknown[] = [`%${pattern}%`];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    const rows = this.query(sql, params);
    return rows.map((row) => ({
      name: row[0] as string,
      type: row[1] as string,
      file: row[2] as string,
      line: row[3] as number,
      exported: (row[4] as number) === 1,
    }));
  }

  /**
   * Get all files in index.
   * @returns All indexed files.
   */
  getFiles(): IndexedFile[] {
    const rows = this.query('SELECT path, mtime, lines, language, size FROM files');
    return rows.map((row) => ({
      path: row[0] as string,
      mtime: row[1] as number,
      lines: row[2] as number,
      language: row[3] as string,
      size: row[4] as number,
    }));
  }

  /**
   * Get imports for a file.
   * @param filePath - The file path to look up.
   * @returns The import paths for the file.
   */
  getImports(filePath: string): string[] {
    const rows = this.query('SELECT import_path FROM imports WHERE file = ?', [filePath]);
    return rows.map((row) => row[0] as string);
  }

  /**
   * Get importers of a file (reverse lookup).
   * @param filePath - The file path to find importers for.
   * @returns Files that import the given file.
   */
  getImporters(filePath: string): string[] {
    const baseName = path.basename(filePath, path.extname(filePath));
    const rows = this.query('SELECT DISTINCT file FROM imports WHERE import_path LIKE ?', [`%${baseName}%`]);
    return rows.map((row) => row[0] as string);
  }

  /**
   * Remove a file from the index.
   * @param filePath - The file path to remove.
   */
  removeFile(filePath: string): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM files WHERE path = ?`, [filePath]);
    this.db.run(`DELETE FROM symbols WHERE file = ?`, [filePath]);
    this.db.run(`DELETE FROM imports WHERE file = ?`, [filePath]);
    this.dirty = true;
  }

  /**
   * Get index stats.
   * @returns Stats object or null if no database loaded.
   */
  stats(): { files: number; symbols: number; imports: number; updated: string; engine: string } | null {
    if (!this.db) return null;
    const files = this.query('SELECT COUNT(*) FROM files');
    const symbols = this.query('SELECT COUNT(*) FROM symbols');
    const imports = this.query('SELECT COUNT(DISTINCT file) FROM imports');
    const updated = this.query("SELECT value FROM meta WHERE key = 'updated'");
    return {
      files: (files[0]?.[0] as number) || 0,
      symbols: (symbols[0]?.[0] as number) || 0,
      imports: (imports[0]?.[0] as number) || 0,
      updated: (updated[0]?.[0] as string) || '',
      engine: 'sqlite (sql.js WASM)',
    };
  }

  /**
   * Close the database.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Log tool usage to DB.
   * @param tool - Tool name.
   * @param duration - Duration in milliseconds.
   * @param success - Whether the operation succeeded.
   * @param cached - Whether the result was cached.
   */
  logUsage(tool: string, duration: number, success: boolean, cached: boolean): void {
    if (!this.db) return;
    this.db.run(`INSERT INTO usage_stats (tool, timestamp, duration, success, cached) VALUES (?, ?, ?, ?, ?)`, [
      tool,
      Date.now(),
      duration,
      success ? 1 : 0,
      cached ? 1 : 0,
    ]);
    this.dirty = true;
  }

  /**
   * Get usage stats.
   * @returns Aggregated usage statistics per tool.
   */
  getUsageStats(): { tool: string; count: number; errorCount: number; avgDuration: number }[] {
    const rows = this.query(`
      SELECT
        tool,
        COUNT(*) as count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errorCount,
        AVG(duration) as avgDuration
      FROM usage_stats
      GROUP BY tool
      ORDER BY count DESC
    `);

    return rows.map((r) => ({
      tool: r[0] as string,
      count: r[1] as number,
      errorCount: r[2] as number,
      avgDuration: Math.round(r[3] as number),
    }));
  }
}
