/**
 * Change impact analysis.
 * Given changed files/functions, find all affected callers, dependents, and tests.
 * Builds on dependency_graph + git + symbol search.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { searchCode } from '../search/fast-search.js';
import { logger } from '../utils/logger.js';

export interface ChangedSymbol {
  name: string;
  file: string;
  changeType: 'added' | 'modified' | 'removed' | 'renamed';
  oldName?: string;
}

export interface ImpactResult {
  changedFiles: string[];
  changedSymbols: ChangedSymbol[];
  affectedFiles: string[];
  affectedSymbols: { symbol: string; file: string; line: number; reason: string }[];
  affectedTests: string[];
  breakingChanges: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
}

/**
 * Parse a git diff to extract changed symbols.
 * @param diff
 */
export function parseDiffForSymbols(diff: string): ChangedSymbol[] {
  const symbols: ChangedSymbol[] = [];
  let currentFile = '';

  const funcPatterns = [
    /^[-+]\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^[-+]\s*(?:export\s+)?class\s+(\w+)/,
    /^[-+]\s*(?:export\s+)?interface\s+(\w+)/,
    /^[-+]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    /^[-+]\s*def\s+(\w+)/,
    /^[-+]\s*func\s+(\w+)/,
  ];

  for (const line of diff.split('\n')) {
    // Track current file
    const fileMatch = line.match(/^(?:\+\+\+|---)\s+[ab]\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Track added/removed function definitions
    if (line.startsWith('+') || line.startsWith('-')) {
      for (const pattern of funcPatterns) {
        const match = line.match(pattern);
        if (match) {
          const changeType = line.startsWith('+') ? 'added' : 'removed';
          const existing = symbols.find((s) => s.name === match[1] && s.file === currentFile);
          if (existing) {
            existing.changeType = 'modified';
          } else {
            symbols.push({ name: match[1], file: currentFile, changeType });
          }
        }
      }
    }
  }

  // Check for renames (removed + added with different names in same file)
  const removed = symbols.filter((s) => s.changeType === 'removed');
  const added = symbols.filter((s) => s.changeType === 'added');
  for (const r of removed) {
    const match = added.find((a) => a.file === r.file);
    if (match) {
      match.changeType = 'renamed';
      match.oldName = r.name;
      symbols.splice(symbols.indexOf(r), 1);
    }
  }

  return symbols;
}

/**
 * Analyze the impact of changes on the codebase.
 * @param cwd
 * @param changedFiles
 * @param diff
 */
export async function analyzeImpact(cwd: string, changedFiles: string[], diff?: string): Promise<ImpactResult> {
  const changedSymbols = diff ? parseDiffForSymbols(diff) : [];
  const affectedFiles = new Set<string>();
  const affectedSymbols: { symbol: string; file: string; line: number; reason: string }[] = [];
  const affectedTests = new Set<string>();
  const breakingChanges: string[] = [];

  // 1. Find files that import changed files
  for (const changedFile of changedFiles) {
    const baseName = path.basename(changedFile, path.extname(changedFile));
    try {
      const importers = await searchCode({
        cwd,
        pattern: baseName,
        isRegex: false,
        maxResults: 100,
      });

      for (const result of importers) {
        if (result.file !== changedFile && /import|require|from|use|include/.test(result.text)) {
          affectedFiles.add(result.file);

          // Check if it's a test file
          if (/\.(?:test|spec)\.|__tests__|\/test\/|\/tests\/|\/spec\//.test(result.file)) {
            affectedTests.add(result.file);
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed search for file imports: ${changedFile}`, { error });
    }
  }

  // 2. Find references to changed symbols
  for (const symbol of changedSymbols) {
    try {
      const refs = await searchCode({
        cwd,
        pattern: symbol.name,
        wholeWord: true,
        maxResults: 100,
      });

      for (const ref of refs) {
        if (ref.file !== symbol.file) {
          affectedFiles.add(ref.file);
          affectedSymbols.push({
            symbol: symbol.name,
            file: ref.file,
            line: ref.line,
            reason: `Uses ${symbol.changeType} symbol "${symbol.name}" from ${symbol.file}`,
          });

          if (/\.(?:test|spec)\.|__tests__|\/test\/|\/tests\/|\/spec\//.test(ref.file)) {
            affectedTests.add(ref.file);
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed reference search for symbol ${symbol.name}`, { error });
    }

    // 3. Check for breaking changes
    if (symbol.changeType === 'removed') {
      breakingChanges.push(`Removed: ${symbol.name} from ${symbol.file}`);
    }
    if (symbol.changeType === 'renamed') {
      breakingChanges.push(`Renamed: ${symbol.oldName} → ${symbol.name} in ${symbol.file}`);
    }
  }

  // 4. Find test files for changed files via naming conventions
  for (const changedFile of changedFiles) {
    const base = path.basename(changedFile, path.extname(changedFile));
    const ext = path.extname(changedFile);
    const testPatterns = [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}_test${ext}`, `test_${base}${ext}`];

    for (const tp of testPatterns) {
      try {
        const results = await searchCode({
          cwd,
          pattern: tp,
          isRegex: false,
          maxResults: 5,
        });
        for (const r of results) affectedTests.add(r.file);
      } catch (error) {
        logger.debug(`Failed to search for test pattern: ${tp}`, { error });
      }
    }
  }

  // 5. Calculate risk level
  let riskLevel: ImpactResult['riskLevel'] = 'low';
  if (breakingChanges.length > 0) riskLevel = 'critical';
  else if (affectedFiles.size > 20) riskLevel = 'high';
  else if (affectedFiles.size > 5 || changedSymbols.length > 3) riskLevel = 'medium';

  // 6. Build summary
  const summary = [
    `${changedFiles.length} files changed, ${changedSymbols.length} symbols modified`,
    `${affectedFiles.size} dependent files affected`,
    `${affectedTests.size} test files need re-running`,
    breakingChanges.length > 0 ? `⚠️ ${breakingChanges.length} breaking changes detected` : '',
    `Risk level: ${riskLevel.toUpperCase()}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    changedFiles,
    changedSymbols,
    affectedFiles: [...affectedFiles],
    affectedSymbols,
    affectedTests: [...affectedTests],
    breakingChanges,
    riskLevel,
    summary,
  };
}

/**
 * Categorize changes as refactor/bugfix/feature/breaking.
 * @param diff
 */
export function categorizeChanges(diff: string): {
  category: string;
  confidence: number;
  indicators: string[];
} {
  const indicators: string[] = [];
  let refactorScore = 0;
  let bugfixScore = 0;
  let featureScore = 0;
  let breakingScore = 0;

  const lines = diff.split('\n');
  const addedLines = lines.filter((l) => l.startsWith('+')).length;
  const removedLines = lines.filter((l) => l.startsWith('-')).length;

  // Balanced add/remove suggests refactor
  if (
    addedLines > 0 &&
    removedLines > 0 &&
    Math.abs(addedLines - removedLines) < Math.max(addedLines, removedLines) * 0.3
  ) {
    refactorScore += 3;
    indicators.push('Balanced additions/removals');
  }

  // Mostly additions suggest feature
  if (addedLines > removedLines * 3) {
    featureScore += 3;
    indicators.push('Mostly new code');
  }

  // Bug-related keywords
  if (/fix|bug|patch|hotfix|issue|error|crash|null|undefined|NaN/i.test(diff)) {
    bugfixScore += 2;
    indicators.push('Bug-fix keywords present');
  }

  // Feature keywords
  if (/feat|feature|add|new|implement|create|introduce/i.test(diff)) {
    featureScore += 2;
    indicators.push('Feature keywords present');
  }

  // Breaking change indicators
  if (/BREAKING|removed|deprecated|renamed/i.test(diff)) {
    breakingScore += 3;
    indicators.push('Breaking change keywords');
  }

  // Determine category
  const scores = { refactor: refactorScore, bugfix: bugfixScore, feature: featureScore, breaking: breakingScore };
  const maxCategory = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const total = Object.values(scores).reduce((a, b) => a + b, 0);

  return {
    category: maxCategory[0],
    confidence: total > 0 ? Math.round((maxCategory[1] / total) * 100) : 0,
    indicators,
  };
}
