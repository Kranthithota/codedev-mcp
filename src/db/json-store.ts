/**
 * JSON-file persistent index for codebase data.
 * Fallback for environments where better-sqlite3 can't compile.
 * Stores indexed symbols, files, and imports for fast repeated queries.
 */

import { readFile, writeFile, mkdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

interface IndexedFile {
  path: string;
  mtime: number;
  lines: number;
  language: string;
  size: number;
}

interface IndexedSymbol {
  name: string;
  type: string; // function, class, interface, etc.
  file: string;
  line: number;
  exported: boolean;
}

interface IndexedImport {
  file: string;
  imports: string[];
}

interface PersistentIndex {
  version: number;
  created: string;
  updated: string;
  cwd: string;
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
}

const INDEX_VERSION = 1;
const INDEX_DIR = '.codedev-mcp';
const INDEX_FILE = 'index.json';

/**
 *
 */
export class JsonStore {
  private indexPath: string;
  private index: PersistentIndex | null = null;
  private dirty = false;

  /**
   *
   * @param cwd
   */
  constructor(cwd: string) {
    this.indexPath = path.join(cwd, INDEX_DIR, INDEX_FILE);
  }

  /**
   * Load index from disk. Returns false if no index exists.
   */
  async load(): Promise<boolean> {
    try {
      const data = await readFile(this.indexPath, 'utf-8');
      this.index = JSON.parse(data) as PersistentIndex;
      if (this.index.version !== INDEX_VERSION) {
        this.index = null;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save index to disk.
   */
  async save(): Promise<void> {
    if (!this.index || !this.dirty) return;
    this.index.updated = new Date().toISOString();
    const dir = path.dirname(this.indexPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(this.index), 'utf-8');
    this.dirty = false;
  }

  /**
   * Initialize a new empty index.
   * @param cwd
   */
  init(cwd: string): void {
    this.index = {
      version: INDEX_VERSION,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      cwd,
      files: [],
      symbols: [],
      imports: [],
    };
    this.dirty = true;
  }

  /**
   * Check if a file needs re-indexing (mtime changed).
   * @param filePath
   */
  async needsReindex(filePath: string): Promise<boolean> {
    if (!this.index) return true;
    const existing = this.index.files.find((f) => f.path === filePath);
    if (!existing) return true;
    try {
      const s = await fsStat(filePath);
      return s.mtimeMs !== existing.mtime;
    } catch {
      return true;
    }
  }

  /**
   * Update file entry in index.
   * @param file
   */
  updateFile(file: IndexedFile): void {
    if (!this.index) return;
    const idx = this.index.files.findIndex((f) => f.path === file.path);
    if (idx >= 0) this.index.files[idx] = file;
    else this.index.files.push(file);
    this.dirty = true;
  }

  /**
   * Update symbols for a file.
   * @param filePath
   * @param symbols
   */
  updateSymbols(filePath: string, symbols: IndexedSymbol[]): void {
    if (!this.index) return;
    this.index.symbols = this.index.symbols.filter((s) => s.file !== filePath);
    this.index.symbols.push(...symbols);
    this.dirty = true;
  }

  /**
   * Update imports for a file.
   * @param filePath
   * @param imports
   */
  updateImports(filePath: string, imports: string[]): void {
    if (!this.index) return;
    const idx = this.index.imports.findIndex((i) => i.file === filePath);
    const entry = { file: filePath, imports };
    if (idx >= 0) this.index.imports[idx] = entry;
    else this.index.imports.push(entry);
    this.dirty = true;
  }

  /**
   * Query symbols by name pattern.
   * @param pattern
   * @param type
   */
  findSymbols(pattern: string, type?: string): IndexedSymbol[] {
    if (!this.index) return [];
    const regex = new RegExp(pattern, 'i');
    return this.index.symbols.filter((s) => {
      if (type && s.type !== type) return false;
      return regex.test(s.name);
    });
  }

  /**
   * Get all files in index.
   */
  getFiles(): IndexedFile[] {
    return this.index?.files || [];
  }

  /**
   * Get imports for a file.
   * @param filePath
   */
  getImports(filePath: string): string[] {
    return this.index?.imports.find((i) => i.file === filePath)?.imports || [];
  }

  /**
   * Get importers of a file (reverse lookup).
   * @param filePath
   */
  getImporters(filePath: string): string[] {
    if (!this.index) return [];
    const baseName = path.basename(filePath, path.extname(filePath));
    return this.index.imports.filter((i) => i.imports.some((imp) => imp.includes(baseName))).map((i) => i.file);
  }

  /**
   * Remove a file from the index.
   * @param filePath
   */
  removeFile(filePath: string): void {
    if (!this.index) return;
    this.index.files = this.index.files.filter((f) => f.path !== filePath);
    this.index.symbols = this.index.symbols.filter((s) => s.file !== filePath);
    this.index.imports = this.index.imports.filter((i) => i.file !== filePath);
    this.dirty = true;
  }

  /**
   * Get index stats.
   */
  stats(): { files: number; symbols: number; imports: number; updated: string } | null {
    if (!this.index) return null;
    return {
      files: this.index.files.length,
      symbols: this.index.symbols.length,
      imports: this.index.imports.length,
      updated: this.index.updated,
    };
  }
}
