/**
 * Test coverage parser. Reads lcov, istanbul JSON, and cobertura XML formats.
 * Maps coverage data to source files for "is this code tested?" queries.
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

export interface FileCoverage {
  file: string;
  lines: { total: number; covered: number; percentage: number };
  functions: { total: number; covered: number; percentage: number };
  branches: { total: number; covered: number; percentage: number };
  uncoveredLines: number[];
  uncoveredFunctions: string[];
}

export interface CoverageSummary {
  format: string;
  totalFiles: number;
  lines: { total: number; covered: number; percentage: number };
  functions: { total: number; covered: number; percentage: number };
  branches: { total: number; covered: number; percentage: number };
  files: FileCoverage[];
}

/**
 * Auto-detect and parse coverage from common file locations.
 * @param cwd
 */
export async function parseCoverage(cwd: string): Promise<CoverageSummary | null> {
  // Try common coverage file locations
  const candidates = [
    { path: 'coverage/lcov.info', parser: parseLcov },
    { path: 'coverage/coverage-final.json', parser: parseIstanbul },
    { path: 'coverage/cobertura-coverage.xml', parser: parseCobertura },
    { path: 'lcov.info', parser: parseLcov },
    { path: '.coverage/lcov.info', parser: parseLcov },
    { path: 'coverage.json', parser: parseIstanbul },
    { path: 'coverage/coverage-summary.json', parser: parseIstanbulSummary },
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate.path);
    try {
      await access(fullPath);
      const content = await readFile(fullPath, 'utf-8');
      return candidate.parser(content, cwd);
    } catch {
      continue;
    }
  }

  // Try glob for any lcov file
  const lcovFiles = await glob('**/lcov.info', { cwd, ignore: ['node_modules/**'], maxDepth: 3 });
  if (lcovFiles.length > 0) {
    const content = await readFile(path.join(cwd, lcovFiles[0]), 'utf-8');
    return parseLcov(content, cwd);
  }

  return null;
}

/**
 * Parse LCOV format (most common).
 * @param content
 * @param cwd
 */
function parseLcov(content: string, cwd: string): CoverageSummary {
  const files: FileCoverage[] = [];
  let currentFile: FileCoverage | null = null;
  const coveredLineSet = new Set<number>();
  const allLineSet = new Set<number>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('SF:')) {
      const filePath = trimmed.slice(3);
      const relPath = path.relative(cwd, filePath) || filePath;
      currentFile = {
        file: relPath,
        lines: { total: 0, covered: 0, percentage: 0 },
        functions: { total: 0, covered: 0, percentage: 0 },
        branches: { total: 0, covered: 0, percentage: 0 },
        uncoveredLines: [],
        uncoveredFunctions: [],
      };
      coveredLineSet.clear();
      allLineSet.clear();
    } else if (trimmed.startsWith('DA:') && currentFile) {
      const [lineNum, hits] = trimmed.slice(3).split(',').map(Number);
      allLineSet.add(lineNum);
      if (hits > 0) coveredLineSet.add(lineNum);
      else currentFile.uncoveredLines.push(lineNum);
    } else if (trimmed.startsWith('FNF:') && currentFile) {
      currentFile.functions.total = parseInt(trimmed.slice(4));
    } else if (trimmed.startsWith('FNH:') && currentFile) {
      currentFile.functions.covered = parseInt(trimmed.slice(4));
    } else if (trimmed.startsWith('FNDA:') && currentFile) {
      const [hits, name] = trimmed.slice(5).split(',');
      if (parseInt(hits) === 0 && name) {
        currentFile.uncoveredFunctions.push(name);
      }
    } else if (trimmed.startsWith('BRF:') && currentFile) {
      currentFile.branches.total = parseInt(trimmed.slice(4));
    } else if (trimmed.startsWith('BRH:') && currentFile) {
      currentFile.branches.covered = parseInt(trimmed.slice(4));
    } else if (trimmed === 'end_of_record' && currentFile) {
      currentFile.lines.total = allLineSet.size;
      currentFile.lines.covered = coveredLineSet.size;
      currentFile.lines.percentage =
        allLineSet.size > 0 ? Math.round((coveredLineSet.size / allLineSet.size) * 100) : 0;
      currentFile.functions.percentage =
        currentFile.functions.total > 0
          ? Math.round((currentFile.functions.covered / currentFile.functions.total) * 100)
          : 0;
      currentFile.branches.percentage =
        currentFile.branches.total > 0
          ? Math.round((currentFile.branches.covered / currentFile.branches.total) * 100)
          : 0;
      files.push(currentFile);
      currentFile = null;
    }
  }

  return buildSummary('lcov', files);
}

/**
 * Parse Istanbul JSON coverage format.
 * @param content
 * @param cwd
 */
function parseIstanbul(content: string, cwd: string): CoverageSummary {
  const data = JSON.parse(content);
  const files: FileCoverage[] = [];

  for (const [filePath, coverage] of Object.entries(data) as [string, any][]) {
    const relPath = path.relative(cwd, filePath) || filePath;
    const statements = coverage.s || {};
    const functions = coverage.f || {};
    const branches = coverage.b || {};

    const stmtValues = Object.values(statements) as number[];
    const funcValues = Object.values(functions) as number[];
    const branchValues = Object.values(branches).flat() as number[];

    const uncoveredLines: number[] = [];
    if (coverage.statementMap) {
      for (const [key, count] of Object.entries(statements)) {
        if ((count as number) === 0 && coverage.statementMap[key]) {
          uncoveredLines.push(coverage.statementMap[key].start.line);
        }
      }
    }

    const uncoveredFunctions: string[] = [];
    if (coverage.fnMap) {
      for (const [key, count] of Object.entries(functions)) {
        if ((count as number) === 0 && coverage.fnMap[key]) {
          uncoveredFunctions.push(coverage.fnMap[key].name || `anonymous_${key}`);
        }
      }
    }

    files.push({
      file: relPath,
      lines: {
        total: stmtValues.length,
        covered: stmtValues.filter((v) => v > 0).length,
        percentage:
          stmtValues.length > 0 ? Math.round((stmtValues.filter((v) => v > 0).length / stmtValues.length) * 100) : 0,
      },
      functions: {
        total: funcValues.length,
        covered: funcValues.filter((v) => v > 0).length,
        percentage:
          funcValues.length > 0 ? Math.round((funcValues.filter((v) => v > 0).length / funcValues.length) * 100) : 0,
      },
      branches: {
        total: branchValues.length,
        covered: branchValues.filter((v) => v > 0).length,
        percentage:
          branchValues.length > 0
            ? Math.round((branchValues.filter((v) => v > 0).length / branchValues.length) * 100)
            : 0,
      },
      uncoveredLines,
      uncoveredFunctions,
    });
  }

  return buildSummary('istanbul', files);
}

/**
 * Parse Istanbul summary JSON format.
 * @param content
 * @param cwd
 */
function parseIstanbulSummary(content: string, cwd: string): CoverageSummary {
  const data = JSON.parse(content);
  const files: FileCoverage[] = [];

  for (const [filePath, coverage] of Object.entries(data) as [string, any][]) {
    if (filePath === 'total') continue;
    const relPath = path.relative(cwd, filePath) || filePath;
    files.push({
      file: relPath,
      lines: { total: coverage.lines.total, covered: coverage.lines.covered, percentage: coverage.lines.pct },
      functions: {
        total: coverage.functions.total,
        covered: coverage.functions.covered,
        percentage: coverage.functions.pct,
      },
      branches: {
        total: coverage.branches.total,
        covered: coverage.branches.covered,
        percentage: coverage.branches.pct,
      },
      uncoveredLines: [],
      uncoveredFunctions: [],
    });
  }

  return buildSummary('istanbul-summary', files);
}

/**
 * Parse Cobertura XML format (basic parser).
 * @param content
 * @param cwd
 */
function parseCobertura(content: string, cwd: string): CoverageSummary {
  const files: FileCoverage[] = [];

  // Simple XML parsing for cobertura
  const classRegex = /<class[^>]+filename="([^"]+)"[^>]+line-rate="([^"]+)"[^>]+branch-rate="([^"]+)"/g;
  let match;

  while ((match = classRegex.exec(content)) !== null) {
    const [, filename, lineRate, branchRate] = match;
    const relPath = path.relative(cwd, filename) || filename;
    const linePct = Math.round(parseFloat(lineRate) * 100);
    const branchPct = Math.round(parseFloat(branchRate) * 100);

    files.push({
      file: relPath,
      lines: { total: 0, covered: 0, percentage: linePct },
      functions: { total: 0, covered: 0, percentage: 0 },
      branches: { total: 0, covered: 0, percentage: branchPct },
      uncoveredLines: [],
      uncoveredFunctions: [],
    });
  }

  return buildSummary('cobertura', files);
}

/**
 * Build summary from parsed file coverage data.
 * @param format
 * @param files
 */
function buildSummary(format: string, files: FileCoverage[]): CoverageSummary {
  const totals = files.reduce(
    (acc, f) => ({
      linesTotal: acc.linesTotal + f.lines.total,
      linesCovered: acc.linesCovered + f.lines.covered,
      funcsTotal: acc.funcsTotal + f.functions.total,
      funcsCovered: acc.funcsCovered + f.functions.covered,
      branchesTotal: acc.branchesTotal + f.branches.total,
      branchesCovered: acc.branchesCovered + f.branches.covered,
    }),
    { linesTotal: 0, linesCovered: 0, funcsTotal: 0, funcsCovered: 0, branchesTotal: 0, branchesCovered: 0 },
  );

  return {
    format,
    totalFiles: files.length,
    lines: {
      total: totals.linesTotal,
      covered: totals.linesCovered,
      percentage: totals.linesTotal > 0 ? Math.round((totals.linesCovered / totals.linesTotal) * 100) : 0,
    },
    functions: {
      total: totals.funcsTotal,
      covered: totals.funcsCovered,
      percentage: totals.funcsTotal > 0 ? Math.round((totals.funcsCovered / totals.funcsTotal) * 100) : 0,
    },
    branches: {
      total: totals.branchesTotal,
      covered: totals.branchesCovered,
      percentage: totals.branchesTotal > 0 ? Math.round((totals.branchesCovered / totals.branchesTotal) * 100) : 0,
    },
    files: files.sort((a, b) => a.lines.percentage - b.lines.percentage), // Worst-covered first
  };
}

/**
 * Get coverage for a specific file.
 * @param summary
 * @param filePath
 */
export function getFileCoverage(summary: CoverageSummary, filePath: string): FileCoverage | null {
  return (
    summary.files.find((f) => f.file === filePath || f.file.endsWith(filePath) || filePath.endsWith(f.file)) || null
  );
}

/**
 * Find untested files (no coverage data or 0% coverage).
 * @param summary
 */
export function getUntestedFiles(summary: CoverageSummary): string[] {
  return summary.files.filter((f) => f.lines.percentage === 0).map((f) => f.file);
}

/**
 * Detect test file locations via naming conventions.
 * @param cwd
 */
export async function findTestFiles(cwd: string): Promise<string[]> {
  const patterns = [
    '**/*.test.*',
    '**/*.spec.*',
    '**/*_test.*',
    '**/*_spec.*',
    '**/test_*.*',
    '**/spec_*.*',
    'tests/**/*',
    'test/**/*',
    '__tests__/**/*',
    'spec/**/*',
  ];

  const results: string[] = [];
  for (const pattern of patterns) {
    const files = await glob(pattern, { cwd, ignore: ['node_modules/**', 'dist/**', 'build/**'] });
    results.push(...files);
  }

  return [...new Set(results)];
}
