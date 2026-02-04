/**
 * Dead Code Detection
 * Finds unused exports, unreferenced symbols, and orphan files.
 */

import { searchCode, listFiles } from '../search/fast-search.js';
import { extractSymbols } from '../analyzers/symbols.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DeadCodeResult {
  unusedExports: { file: string; symbol: string; line: number; type: string }[];
  orphanFiles: { file: string; reason: string }[];
  summary: { totalUnusedExports: number; totalOrphanFiles: number; filesScanned: number };
}

function parseImportDetails(content: string): { from: string; names: string[] }[] {
  const results: { from: string; names: string[] }[] = [];
  // JS/TS imports
  const jsMatches = content.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g);
  for (const m of jsMatches) {
    const names = m[1]
      ? m[1]
          .split(',')
          .map((n) =>
            n
              .trim()
              .split(/\s+as\s+/)[0]
              .trim(),
          )
          .filter(Boolean)
      : m[2]
        ? [m[2]]
        : [];
    results.push({ from: m[3], names });
  }
  // Python imports
  const pyMatches = content.matchAll(/from\s+(\S+)\s+import\s+(.+)/g);
  for (const m of pyMatches) {
    results.push({
      from: m[1],
      names: m[2].split(',').map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      ),
    });
  }
  return results;
}

/**
 *
 * @param cwd
 * @param options
 * @param options.directory
 * @param options.fileGlob
 */
export async function detectDeadCode(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<DeadCodeResult> {
  const glob = options?.fileGlob || '**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,php}';
  const dir = path.resolve(cwd, options?.directory || '.');
  const files = await listFiles(dir, { glob });
  const sourceFiles = files.filter((f) => !/(test|spec|__test__|\.d\.ts)/i.test(f)).slice(0, 300);

  // Collect all exported symbols
  const allExports: { file: string; symbol: string; line: number; type: string }[] = [];
  const allImportedNames = new Set<string>();
  const importedModules = new Set<string>();

  for (const file of sourceFiles) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');

      // Get symbols and mark exported ones
      const symbols = await extractSymbols(absPath);
      const lines = content.split('\n');
      for (const sym of symbols) {
        const line = lines[sym.line - 1] || '';
        if (/^export\b/.test(line.trim()) || /\bexport\b/.test(line)) {
          allExports.push({ file, symbol: sym.name, line: sym.line, type: sym.kind });
        }
      }

      // Parse imports to build reference set
      const imports = parseImportDetails(content);
      for (const imp of imports) {
        importedModules.add(imp.from);
        for (const name of imp.names) allImportedNames.add(name);
      }
    } catch {
      /* skip */
    }
  }

  // Find unused exports
  const unusedExports: DeadCodeResult['unusedExports'] = [];
  for (const exp of allExports) {
    if (['main', 'default', 'index', 'app', 'handler', 'setup', 'init'].includes(exp.symbol.toLowerCase())) continue;
    if (/\/(index|main|app|server|cli)\.[^/]+$/.test(exp.file)) continue;

    if (!allImportedNames.has(exp.symbol)) {
      // Double-check with search
      try {
        const refs = await searchCode({ cwd: dir, pattern: exp.symbol, maxResults: 5 });
        const external = refs.filter((r) => r.file !== exp.file);
        if (external.length === 0) unusedExports.push(exp);
      } catch {
        unusedExports.push(exp);
      }
    }
  }

  // Find orphan files
  const orphanFiles: DeadCodeResult['orphanFiles'] = [];
  const normalizedImports = new Set([...importedModules].map((f) => f.replace(/^[./]+/, '').replace(/\.[^.]+$/, '')));
  for (const file of sourceFiles.slice(0, 200)) {
    if (/\/(index|main|app|server|cli|config)\.[^/]+$/.test(file)) continue;
    if (/(test|spec|\.config)/i.test(file)) continue;
    const normalized = file.replace(/^[./]+/, '').replace(/\.[^.]+$/, '');
    let isImported = false;
    for (const imp of normalizedImports) {
      if (imp.endsWith(path.basename(normalized)) || normalized.endsWith(imp)) {
        isImported = true;
        break;
      }
    }
    if (!isImported) orphanFiles.push({ file, reason: 'Not imported by any other file' });
  }

  return {
    unusedExports: unusedExports.slice(0, 100),
    orphanFiles: orphanFiles.slice(0, 50),
    summary: {
      totalUnusedExports: unusedExports.length,
      totalOrphanFiles: orphanFiles.length,
      filesScanned: sourceFiles.length,
    },
  };
}
