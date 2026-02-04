/**
 * Type Flow Analysis
 * Tracks where a type/interface is defined, imported, used as parameter, returned, etc.
 */

import { searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface TypeUsage {
  file: string;
  line: number;
  kind: 'definition' | 'import' | 'parameter' | 'return-type' | 'variable' | 'extends' | 'generic' | 'field';
  context: string;
}

export interface TypeFlowResult {
  typeName: string;
  definition?: { file: string; line: number; code: string };
  usages: TypeUsage[];
  flowSummary: {
    definedIn: string;
    importedBy: string[];
    usedAsParam: string[];
    usedAsReturn: string[];
    extendedBy: string[];
    totalUsages: number;
  };
}

/**
 *
 * @param cwd
 * @param typeName
 * @param options
 * @param options.directory
 */
export async function analyzeTypeFlow(
  cwd: string,
  typeName: string,
  options?: { directory?: string },
): Promise<TypeFlowResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const usages: TypeUsage[] = [];
  let definition: TypeFlowResult['definition'] | undefined;

  const results = await searchCode({ cwd: dir, pattern: `\\b${typeName}\\b`, isRegex: true, maxResults: 500 });
  const filesWithType = [...new Set(results.map((r) => r.file))];

  for (const file of filesWithType.slice(0, 200)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      const lines = content.split('\n');
      const re = new RegExp(`\\b${typeName}\\b`);

      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const t = lines[i].trim();
        const ln = i + 1;

        if (new RegExp(`^(export\\s+)?(interface|type|class|enum|struct)\\s+${typeName}\\b`).test(t)) {
          definition = { file, line: ln, code: t };
          usages.push({ file, line: ln, kind: 'definition', context: t });
        } else if (/^(import|from|use|using)\s/.test(t)) {
          usages.push({ file, line: ln, kind: 'import', context: t });
        } else if (new RegExp(`(extends|implements).*\\b${typeName}\\b`).test(t)) {
          usages.push({ file, line: ln, kind: 'extends', context: t });
        } else if (new RegExp(`<[^>]*\\b${typeName}\\b`).test(t)) {
          usages.push({ file, line: ln, kind: 'generic', context: t });
        } else if (new RegExp(`\\)\\s*:.*${typeName}|->\\s*${typeName}`).test(t)) {
          usages.push({ file, line: ln, kind: 'return-type', context: t });
        } else if (new RegExp(`\\(.*:.*${typeName}`).test(t) && /function|def |func |fn /.test(t)) {
          usages.push({ file, line: ln, kind: 'parameter', context: t });
        } else if (new RegExp(`:\\s*${typeName}`).test(t)) {
          usages.push({ file, line: ln, kind: 'variable', context: t });
        }
      }
    } catch (error) {
      logger.debug(`Failed to analyze type flow in file: ${file}`, { error });
    }
  }

  return {
    typeName,
    definition,
    usages: usages.slice(0, 200),
    flowSummary: {
      definedIn: definition?.file || 'not found',
      importedBy: [...new Set(usages.filter((u) => u.kind === 'import').map((u) => u.file))],
      usedAsParam: [...new Set(usages.filter((u) => u.kind === 'parameter').map((u) => u.file))],
      usedAsReturn: [...new Set(usages.filter((u) => u.kind === 'return-type').map((u) => u.file))],
      extendedBy: [...new Set(usages.filter((u) => u.kind === 'extends').map((u) => u.file))],
      totalUsages: usages.length,
    },
  };
}
