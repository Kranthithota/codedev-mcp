/**
 * Test Intelligence Analyzers
 *
 * Provides four complementary analyses for understanding test quality and coverage:
 * - analyzeTestGaps: Identify source files lacking test coverage
 * - analyzeTestImpact: Determine which tests to run for changed files
 * - analyzeTestHealth: Detect anti-patterns and score test suite quality
 * - buildTestCodeMapping: Build bidirectional source-to-test file mappings
 *
 * Uses fast-search utilities for efficient file scanning and import tracing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listFiles, searchCode } from '../search/fast-search.js';
import { parseCoverage } from './coverage.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/** Maximum number of files to scan to keep analysis performant on large codebases. */
const MAX_FILES = 500;

/** Git execution defaults. */
const GIT_EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 15000 };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Common source file extensions glob. */
const SOURCE_GLOB = '*.{ts,tsx,js,jsx,mts,mjs,py,java,go,rs,rb,php}';

/** Pattern to identify test files by path or name. */
const TEST_FILE_PATTERN = /(?:\.(?:test|spec)\.[^.]+$|__tests__[/\\]|[/\\]tests?[/\\]|[/\\]spec[/\\]|_test\.[^.]+$|_spec\.[^.]+$)/i;

/** Pattern to identify config / non-source files that should be excluded. */
const CONFIG_FILE_PATTERN = /(?:\.config\.|\.d\.ts$|\.json$|\.md$|\.yml$|\.yaml$|\.lock$|\.env|Makefile|Dockerfile)/i;

/**
 * Execute a git command and return stdout.
 * Returns null on failure rather than throwing so callers can degrade gracefully.
 */
async function gitExec(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { ...GIT_EXEC_OPTS, cwd });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Get the list of files changed according to git (uncommitted + staged).
 * Falls back to null if git is unavailable.
 */
async function getGitChangedFiles(cwd: string): Promise<string[] | null> {
  const output = await gitExec(['diff', '--name-only', 'HEAD'], cwd);
  if (output === null) return null;
  const stagedOutput = await gitExec(['diff', '--name-only', '--cached'], cwd);
  const files = new Set<string>();
  for (const line of (output + '\n' + (stagedOutput ?? '')).split('\n')) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }
  return [...files];
}

/**
 * Derive the base name of a source file without extension.
 * e.g. "src/utils/parser.ts" -> "parser"
 */
function baseName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * Check whether a file path looks like a test file.
 */
function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath);
}

/**
 * Extract exported symbol names from file content using regex heuristics.
 * Works for JS/TS (export function, export class, export const, export interface, export type, export enum).
 */
function extractExportedNames(content: string): string[] {
  const names: string[] = [];
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+enum\s+(\w+)/g,
    /export\s+default\s+(?:class|function)\s+(\w+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      names.push(match[1]);
    }
  }
  return [...new Set(names)];
}

/**
 * Parse import/require specifiers from file content.
 * Returns the raw module specifiers (e.g. "./utils/parser", "lodash").
 */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  // ES import: import ... from "specifier"
  const esImports = content.matchAll(/(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g);
  for (const m of esImports) specifiers.push(m[1]);
  // Dynamic import: import("specifier")
  const dynamicImports = content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  for (const m of dynamicImports) specifiers.push(m[1]);
  // CommonJS require: require("specifier")
  const requires = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  for (const m of requires) specifiers.push(m[1]);
  return specifiers;
}

/**
 * Check whether a test file's content references a given source file.
 * Resolves common relative import patterns.
 */
function testImportsSource(testContent: string, sourceFile: string, testFile: string): boolean {
  const specifiers = extractImportSpecifiers(testContent);
  const sourceBase = baseName(sourceFile);
  const sourceDir = path.dirname(sourceFile);
  const testDir = path.dirname(testFile);

  for (const spec of specifiers) {
    // Direct basename match
    if (spec.includes(sourceBase)) {
      // Verify directory relationship makes sense
      const resolvedFromTest = path.resolve(testDir, spec);
      const normalizedSource = path.resolve(sourceDir, sourceBase);
      // Remove extension for comparison
      const resolvedNoExt = resolvedFromTest.replace(/\.[^.]+$/, '');
      const sourceNoExt = normalizedSource.replace(/\.[^.]+$/, '');
      if (resolvedNoExt === sourceNoExt || spec.endsWith(sourceBase) || spec.endsWith(sourceFile)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. analyzeTestGaps
// ---------------------------------------------------------------------------

/** Represents a single source file and its test coverage status. */
export interface TestGap {
  /** Path to the source file (relative to cwd). */
  sourceFile: string;
  /** Whether at least one corresponding test file was found. */
  hasTestFile: boolean;
  /** Paths of test files that reference this source file. */
  testFiles: string[];
  /** Exported symbols for which no test reference was found. */
  untestedExports: string[];
  /** Line-level coverage percentage from coverage data, if available. */
  coveragePercent?: number;
  /** Risk level: high = no tests at all, medium = partial, low = well-tested. */
  riskLevel: 'low' | 'medium' | 'high';
}

/** Aggregated result from analyzeTestGaps. */
export interface TestGapResult {
  /** Individual gap entries for every scanned source file. */
  gaps: TestGap[];
  /** High-level summary statistics. */
  summary: {
    totalSourceFiles: number;
    filesWithTests: number;
    filesWithoutTests: number;
    coverageAvailable: boolean;
    overallCoverage?: number;
  };
  /** Actionable recommendations based on the analysis. */
  recommendations: string[];
}

/** Options for analyzeTestGaps. */
export interface TestGapOptions {
  /** Only analyze these files instead of all source files. */
  changedFiles?: string[];
  /** Glob pattern for source files. Defaults to common source extensions. */
  fileGlob?: string;
  /** Whether to attempt to load coverage data. Defaults to true. */
  includeCoverage?: boolean;
}

/**
 * Identify source files that lack adequate test coverage.
 *
 * For each source file the analyzer:
 * 1. Searches for matching test files by naming convention
 * 2. Verifies test files actually import the source module
 * 3. Checks exported symbols against test file content
 * 4. Optionally incorporates line-level coverage data
 *
 * @param cwd - Project root directory
 * @param options - Optional configuration
 * @returns Analysis result with gaps, summary, and recommendations
 */
export async function analyzeTestGaps(
  cwd: string,
  options?: TestGapOptions,
): Promise<TestGapResult> {
  const gaps: TestGap[] = [];
  const includeCoverage = options?.includeCoverage !== false;

  // 1. Determine which source files to analyze
  let sourceFiles: string[];
  if (options?.changedFiles && options.changedFiles.length > 0) {
    sourceFiles = options.changedFiles.filter(
      (f) => !isTestFile(f) && !CONFIG_FILE_PATTERN.test(f),
    );
  } else {
    // Use git changed files first, fallback to full scan
    const gitChanged = await getGitChangedFiles(cwd);
    if (gitChanged && gitChanged.length > 0) {
      sourceFiles = gitChanged.filter(
        (f) => !isTestFile(f) && !CONFIG_FILE_PATTERN.test(f),
      );
    } else {
      const glob = options?.fileGlob || SOURCE_GLOB;
      const allFiles = await listFiles(cwd, { glob, type: 'file' });
      sourceFiles = allFiles
        .filter((f) => !isTestFile(f) && !CONFIG_FILE_PATTERN.test(f))
        .slice(0, MAX_FILES);
    }
  }

  // 2. Load all test files in the project
  const allTestFiles = await findAllTestFiles(cwd);

  // 3. Load coverage data if requested
  let coverageData: Awaited<ReturnType<typeof parseCoverage>> = null;
  if (includeCoverage) {
    try {
      coverageData = await parseCoverage(cwd);
    } catch (err) {
      logger.debug('Failed to load coverage data', { error: err });
    }
  }

  // 4. Build a lookup of test file content (lazy, cached)
  const testContentCache = new Map<string, string>();

  async function getTestContent(testFile: string): Promise<string> {
    if (testContentCache.has(testFile)) return testContentCache.get(testFile)!;
    try {
      const content = await readFile(path.resolve(cwd, testFile), 'utf-8');
      testContentCache.set(testFile, content);
      return content;
    } catch {
      testContentCache.set(testFile, '');
      return '';
    }
  }

  // 5. Analyze each source file
  for (const sourceFile of sourceFiles) {
    const base = baseName(sourceFile);
    const ext = path.extname(sourceFile);
    const dir = path.dirname(sourceFile);

    // Find candidate test files by naming convention
    const candidatePatterns = [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      `${base}_test${ext}`,
      `${base}_spec${ext}`,
      `test_${base}${ext}`,
      `spec_${base}${ext}`,
    ];

    const matchedTests: string[] = [];

    // Check by naming convention
    for (const testFile of allTestFiles) {
      const testBase = path.basename(testFile);
      if (candidatePatterns.includes(testBase)) {
        matchedTests.push(testFile);
        continue;
      }
      // Check __tests__ directory within same parent
      if (
        testFile.includes('__tests__') &&
        testFile.includes(base) &&
        path.dirname(testFile).includes(dir)
      ) {
        matchedTests.push(testFile);
        continue;
      }
      // Check tests/ directory with same base name
      if (
        (testFile.startsWith('tests/') || testFile.startsWith('test/')) &&
        testFile.includes(base)
      ) {
        matchedTests.push(testFile);
      }
    }

    // Verify each candidate actually imports the source
    const confirmedTests: string[] = [];
    for (const testFile of matchedTests) {
      const testContent = await getTestContent(testFile);
      if (testContent && testImportsSource(testContent, sourceFile, testFile)) {
        confirmedTests.push(testFile);
      }
    }

    // If no confirmed tests by import, keep name-matched ones as likely matches
    const effectiveTests = confirmedTests.length > 0 ? confirmedTests : matchedTests;

    // Read source to find exported symbols
    let untestedExports: string[] = [];
    try {
      const sourceContent = await readFile(path.resolve(cwd, sourceFile), 'utf-8');
      const exportedNames = extractExportedNames(sourceContent);

      if (exportedNames.length > 0 && effectiveTests.length > 0) {
        // Check which exports appear in test files
        const allTestContent = (
          await Promise.all(effectiveTests.map((t) => getTestContent(t)))
        ).join('\n');

        untestedExports = exportedNames.filter(
          (name) => !allTestContent.includes(name),
        );
      } else if (exportedNames.length > 0 && effectiveTests.length === 0) {
        untestedExports = exportedNames;
      }
    } catch {
      // Source file unreadable, skip export analysis
    }

    // Look up coverage
    let coveragePercent: number | undefined;
    if (coverageData) {
      const fileCov = coverageData.files.find(
        (f) =>
          f.file === sourceFile ||
          f.file.endsWith(sourceFile) ||
          sourceFile.endsWith(f.file),
      );
      if (fileCov) {
        coveragePercent = fileCov.lines.percentage;
      }
    }

    // Determine risk level
    let riskLevel: TestGap['riskLevel'];
    if (effectiveTests.length === 0) {
      riskLevel = 'high';
    } else if (
      untestedExports.length > 0 ||
      (coveragePercent !== undefined && coveragePercent < 50)
    ) {
      riskLevel = 'medium';
    } else {
      riskLevel = 'low';
    }

    gaps.push({
      sourceFile,
      hasTestFile: effectiveTests.length > 0,
      testFiles: effectiveTests,
      untestedExports,
      coveragePercent,
      riskLevel,
    });
  }

  // 6. Build summary
  const filesWithTests = gaps.filter((g) => g.hasTestFile).length;
  const filesWithoutTests = gaps.filter((g) => !g.hasTestFile).length;
  const coverageAvailable = coverageData !== null;
  const overallCoverage = coverageData?.lines.percentage;

  // 7. Generate recommendations
  const recommendations: string[] = [];
  const highRiskFiles = gaps.filter((g) => g.riskLevel === 'high');
  if (highRiskFiles.length > 0) {
    const top = highRiskFiles.slice(0, 5).map((g) => g.sourceFile);
    recommendations.push(
      `Add tests for ${highRiskFiles.length} untested file(s). Priority: ${top.join(', ')}`,
    );
  }
  const mediumRiskFiles = gaps.filter((g) => g.riskLevel === 'medium');
  if (mediumRiskFiles.length > 0) {
    recommendations.push(
      `Improve test coverage for ${mediumRiskFiles.length} partially-tested file(s).`,
    );
  }
  if (filesWithoutTests > filesWithTests) {
    recommendations.push(
      'Fewer than half of source files have tests. Consider adding a test coverage threshold to CI.',
    );
  }
  if (!coverageAvailable) {
    recommendations.push(
      'No coverage data found. Set up coverage reporting (e.g. Istanbul/c8) for deeper analysis.',
    );
  }
  if (overallCoverage !== undefined && overallCoverage < 60) {
    recommendations.push(
      `Overall line coverage is ${overallCoverage}%. Aim for at least 80% on critical paths.`,
    );
  }

  return {
    gaps: gaps.sort((a, b) => {
      const riskOrder = { high: 0, medium: 1, low: 2 };
      return riskOrder[a.riskLevel] - riskOrder[b.riskLevel];
    }),
    summary: {
      totalSourceFiles: sourceFiles.length,
      filesWithTests,
      filesWithoutTests,
      coverageAvailable,
      overallCoverage,
    },
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// 2. analyzeTestImpact
// ---------------------------------------------------------------------------

/** Impact info for a single changed file. */
export interface TestImpact {
  /** The changed file path. */
  changedFile: string;
  /** Test files that directly import or reference this file. */
  directTests: string[];
  /** Test files that transitively depend on this file (through intermediaries). */
  transitiveTests: string[];
  /** Suggested CLI command to run the relevant tests. */
  suggestedTestCommand?: string;
}

/** Aggregated test impact result. */
export interface TestImpactResult {
  /** Per-file impact breakdowns. */
  impacts: TestImpact[];
  /** De-duplicated, prioritized list of all tests to run. */
  allTestsToRun: string[];
  /** Total number of test files in the project. */
  totalTestFiles: number;
  /** Estimated scope of the change relative to the full test suite. */
  estimatedScope: 'minimal' | 'moderate' | 'broad' | 'full';
}

/**
 * Determine which tests should run based on a set of changed files.
 *
 * Strategy:
 * 1. For each changed file, find test files that directly import it
 * 2. Build a one-hop reverse import graph to find transitive dependents
 * 3. Check naming conventions for co-located tests
 * 4. Prioritize: direct tests first, then transitive, then convention-matched
 *
 * @param cwd - Project root directory
 * @param changedFiles - List of changed file paths (relative to cwd)
 * @returns Prioritized list of tests to run and scope estimate
 */
export async function analyzeTestImpact(
  cwd: string,
  changedFiles: string[],
): Promise<TestImpactResult> {
  const allTestFiles = await findAllTestFiles(cwd);
  const impacts: TestImpact[] = [];
  const allDirectTests = new Set<string>();
  const allTransitiveTests = new Set<string>();

  for (const changedFile of changedFiles) {
    const directTests = new Set<string>();
    const transitiveTests = new Set<string>();
    const base = baseName(changedFile);

    // 1. Find test files that directly import the changed file
    try {
      const importResults = await searchCode({
        cwd,
        pattern: base,
        fileGlob: `*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}`,
        isRegex: false,
        maxResults: 100,
      });

      for (const result of importResults) {
        if (
          isTestFile(result.file) &&
          /import|require|from/.test(result.text)
        ) {
          directTests.add(result.file);
        }
      }
    } catch (err) {
      logger.debug(`Import search failed for ${changedFile}`, { error: err });
    }

    // 2. Also match by naming convention (co-located tests)
    for (const testFile of allTestFiles) {
      const testBase = path.basename(testFile, path.extname(testFile))
        .replace(/\.(test|spec)$/, '')
        .replace(/_(test|spec)$/, '')
        .replace(/^(test_|spec_)/, '');
      if (testBase === base) {
        directTests.add(testFile);
      }
    }

    // 3. Find files that import the changed file (non-test intermediaries)
    const intermediaries: string[] = [];
    try {
      const dependents = await searchCode({
        cwd,
        pattern: base,
        isRegex: false,
        maxResults: 100,
      });

      for (const dep of dependents) {
        if (
          dep.file !== changedFile &&
          !isTestFile(dep.file) &&
          /import|require|from/.test(dep.text)
        ) {
          intermediaries.push(dep.file);
        }
      }
    } catch (err) {
      logger.debug(`Dependency search failed for ${changedFile}`, { error: err });
    }

    // 4. Find test files that import any intermediary (transitive impact)
    for (const intermediary of intermediaries.slice(0, 20)) {
      const intBase = baseName(intermediary);
      try {
        const transResults = await searchCode({
          cwd,
          pattern: intBase,
          fileGlob: `*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}`,
          isRegex: false,
          maxResults: 50,
        });

        for (const result of transResults) {
          if (
            isTestFile(result.file) &&
            !directTests.has(result.file) &&
            /import|require|from/.test(result.text)
          ) {
            transitiveTests.add(result.file);
          }
        }
      } catch {
        // Transitive search is best-effort
      }
    }

    // Build suggested command
    const allTests = [...directTests, ...transitiveTests];
    let suggestedTestCommand: string | undefined;
    if (allTests.length > 0 && allTests.length <= 10) {
      suggestedTestCommand = `npx jest ${allTests.join(' ')}`;
    } else if (allTests.length > 10) {
      suggestedTestCommand = `npx jest --changedSince=HEAD~1`;
    }

    impacts.push({
      changedFile,
      directTests: [...directTests],
      transitiveTests: [...transitiveTests],
      suggestedTestCommand,
    });

    for (const t of directTests) allDirectTests.add(t);
    for (const t of transitiveTests) allTransitiveTests.add(t);
  }

  // Deduplicate and prioritize: direct first, then transitive-only
  const allTestsToRun = [
    ...allDirectTests,
    ...[...allTransitiveTests].filter((t) => !allDirectTests.has(t)),
  ];

  // Estimate scope
  let estimatedScope: TestImpactResult['estimatedScope'];
  const ratio = allTestFiles.length > 0
    ? allTestsToRun.length / allTestFiles.length
    : 0;

  if (ratio === 0) {
    estimatedScope = 'minimal';
  } else if (ratio <= 0.2) {
    estimatedScope = 'minimal';
  } else if (ratio <= 0.5) {
    estimatedScope = 'moderate';
  } else if (ratio <= 0.8) {
    estimatedScope = 'broad';
  } else {
    estimatedScope = 'full';
  }

  return {
    impacts,
    allTestsToRun,
    totalTestFiles: allTestFiles.length,
    estimatedScope,
  };
}

// ---------------------------------------------------------------------------
// 3. analyzeTestHealth
// ---------------------------------------------------------------------------

/** A detected anti-pattern in a test file. */
export interface TestAntiPattern {
  /** Path to the test file. */
  file: string;
  /** Line number where the pattern was detected. */
  line: number;
  /** Machine-readable pattern identifier. */
  pattern: string;
  /** Severity level. */
  severity: 'info' | 'warning' | 'error';
  /** Human-readable description of the issue. */
  description: string;
  /** Suggested fix. */
  suggestion: string;
}

/** Result of test health analysis. */
export interface TestHealthResult {
  /** Number of test files analyzed. */
  totalTestFiles: number;
  /** Total number of test cases (it/test calls) detected. */
  totalTestCases: number;
  /** All detected anti-patterns. */
  antiPatterns: TestAntiPattern[];
  /** Overall health score from 0 (poor) to 100 (excellent). */
  healthScore: number;
  /** Letter grade derived from healthScore. */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Breakdown of anti-patterns by category and severity. */
  summary: {
    byPattern: Record<string, number>;
    bySeverity: Record<string, number>;
  };
}

/** Options for analyzeTestHealth. */
export interface TestHealthOptions {
  /** Glob pattern for test files. */
  fileGlob?: string;
  /** Maximum test files to analyze. Defaults to MAX_FILES. */
  maxFiles?: number;
}

/** Anti-pattern detection rules. */
interface AntiPatternRule {
  id: string;
  pattern: RegExp;
  severity: TestAntiPattern['severity'];
  description: string;
  suggestion: string;
}

const ANTI_PATTERN_RULES: AntiPatternRule[] = [
  {
    id: 'setTimeout-in-test',
    pattern: /\bsetTimeout\s*\(/,
    severity: 'warning',
    description: 'setTimeout used in test - may cause flaky tests or slow execution.',
    suggestion: 'Use fake timers (jest.useFakeTimers) or async/await patterns instead.',
  },
  {
    id: 'setInterval-in-test',
    pattern: /\bsetInterval\s*\(/,
    severity: 'warning',
    description: 'setInterval used in test - likely causes flakiness or leaks.',
    suggestion: 'Use fake timers or polling utilities with bounded retries.',
  },
  {
    id: 'hardcoded-date',
    pattern: /new Date\s*\(\s*['"](?:20\d{2}|19\d{2})/,
    severity: 'info',
    description: 'Hardcoded date in test - may break due to timezone or clock drift.',
    suggestion: 'Use date mocking (jest.setSystemTime) or relative dates.',
  },
  {
    id: 'network-fetch-unmocked',
    pattern: /\b(?:fetch|axios|http\.get|https\.get|request)\s*\(/,
    severity: 'warning',
    description: 'Potential unmocked network call detected.',
    suggestion: 'Use nock, msw, or jest.mock to mock HTTP calls in tests.',
  },
  {
    id: 'any-type-assertion',
    pattern: /as\s+any\b/,
    severity: 'info',
    description: '"as any" type assertion weakens type safety in tests.',
    suggestion: 'Use proper typing or create typed test fixtures.',
  },
  {
    id: 'test-without-assertion',
    pattern: /(?:it|test)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[^}]*\}\s*\)/,
    severity: 'error',
    description: 'Test case appears to have no assertions.',
    suggestion: 'Add expect() calls or assertion library checks to validate behavior.',
  },
  {
    id: 'console-log-in-test',
    pattern: /\bconsole\.log\s*\(/,
    severity: 'info',
    description: 'console.log left in test file - likely debugging artifact.',
    suggestion: 'Remove console.log or use a proper test logger.',
  },
  {
    id: 'skip-or-only',
    pattern: /\b(?:describe|it|test)\.(?:skip|only)\s*\(/,
    severity: 'warning',
    description: 'Skipped or focused test detected (.skip/.only).',
    suggestion: 'Remove .skip/.only before merging to ensure full suite runs.',
  },
  {
    id: 'sleep-in-test',
    pattern: /\bawait\s+(?:sleep|delay|new\s+Promise\s*\(\s*(?:resolve|r)\s*=>\s*setTimeout)/,
    severity: 'warning',
    description: 'Explicit sleep/delay in test - slows suite and may be flaky.',
    suggestion: 'Use waitFor, polling assertions, or fake timers instead of sleeping.',
  },
  {
    id: 'magic-number',
    pattern: /expect\s*\([^)]+\)\s*\.(?:toBe|toEqual)\s*\(\s*\d{3,}\s*\)/,
    severity: 'info',
    description: 'Magic number in assertion - reduces readability.',
    suggestion: 'Extract expected values to named constants for clarity.',
  },
];

/**
 * Analyze the quality and health of the project's test suite.
 *
 * Scans all test files for common anti-patterns, counts test cases,
 * checks for proper describe/it nesting and cleanup hooks, then
 * computes an overall health score and letter grade.
 *
 * @param cwd - Project root directory
 * @param options - Optional configuration
 * @returns Health analysis with anti-patterns, score, and summary
 */
export async function analyzeTestHealth(
  cwd: string,
  options?: TestHealthOptions,
): Promise<TestHealthResult> {
  const maxFiles = options?.maxFiles ?? MAX_FILES;
  const testFiles = await findAllTestFiles(cwd);
  const filesToAnalyze = testFiles.slice(0, maxFiles);
  const antiPatterns: TestAntiPattern[] = [];
  let totalTestCases = 0;
  let totalDescribeBlocks = 0;
  let filesWithCleanup = 0;
  let filesWithMocks = 0;
  let longTestFiles = 0;

  for (const testFile of filesToAnalyze) {
    let content: string;
    try {
      content = await readFile(path.resolve(cwd, testFile), 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    // Count test cases
    const testCaseMatches = content.match(/\b(?:it|test)\s*\(\s*['"]/g);
    if (testCaseMatches) totalTestCases += testCaseMatches.length;

    // Count describe blocks
    const describeMatches = content.match(/\bdescribe\s*\(\s*['"]/g);
    if (describeMatches) totalDescribeBlocks += describeMatches.length;

    // Detect cleanup hooks
    if (/\b(?:beforeEach|afterEach|beforeAll|afterAll)\s*\(/.test(content)) {
      filesWithCleanup++;
    }

    // Detect mock usage
    if (
      /\b(?:jest\.mock|vi\.mock|sinon\.|nock\(|jest\.spyOn|vi\.spyOn|mock\(|stub\()/.test(content)
    ) {
      filesWithMocks++;
    }

    // Check for long test files
    if (lines.length > 500) {
      longTestFiles++;
      antiPatterns.push({
        file: testFile,
        line: 1,
        pattern: 'long-test-file',
        severity: 'warning',
        description: `Test file has ${lines.length} lines (>500). Large test files are harder to maintain.`,
        suggestion: 'Split into smaller, focused test files organized by feature or module.',
      });
    }

    // Run anti-pattern detection rules line by line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment lines
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;

      for (const rule of ANTI_PATTERN_RULES) {
        if (rule.pattern.test(line)) {
          antiPatterns.push({
            file: testFile,
            line: i + 1,
            pattern: rule.id,
            severity: rule.severity,
            description: rule.description,
            suggestion: rule.suggestion,
          });
        }
      }
    }
  }

  // Build summary counts
  const byPattern: Record<string, number> = {};
  const bySeverity: Record<string, number> = { info: 0, warning: 0, error: 0 };
  for (const ap of antiPatterns) {
    byPattern[ap.pattern] = (byPattern[ap.pattern] || 0) + 1;
    bySeverity[ap.severity]++;
  }

  // Calculate health score (0-100)
  // Start at 100 and deduct for issues
  let score = 100;

  // Deduct for anti-patterns (weighted by severity)
  const errorPenalty = bySeverity.error * 5;
  const warningPenalty = bySeverity.warning * 2;
  const infoPenalty = bySeverity.info * 0.5;
  score -= Math.min(40, errorPenalty + warningPenalty + infoPenalty);

  // Bonus for positive patterns
  if (filesToAnalyze.length > 0) {
    const cleanupRatio = filesWithCleanup / filesToAnalyze.length;
    const mockRatio = filesWithMocks / filesToAnalyze.length;
    const describeRatio = totalDescribeBlocks > 0 ? Math.min(1, totalDescribeBlocks / totalTestCases) : 0;

    // Reward good practices (up to +15)
    score += Math.round(cleanupRatio * 5);
    score += Math.round(mockRatio * 5);
    score += Math.round(describeRatio * 5);
  }

  // Penalty for no tests at all
  if (totalTestCases === 0 && filesToAnalyze.length > 0) {
    score -= 30;
  }

  // Penalty for high ratio of long test files
  if (filesToAnalyze.length > 0) {
    const longFileRatio = longTestFiles / filesToAnalyze.length;
    score -= Math.round(longFileRatio * 10);
  }

  // Clamp to 0-100
  const healthScore = Math.max(0, Math.min(100, Math.round(score)));

  // Determine grade
  let grade: TestHealthResult['grade'];
  if (healthScore >= 90) grade = 'A';
  else if (healthScore >= 80) grade = 'B';
  else if (healthScore >= 70) grade = 'C';
  else if (healthScore >= 60) grade = 'D';
  else grade = 'F';

  return {
    totalTestFiles: filesToAnalyze.length,
    totalTestCases,
    antiPatterns,
    healthScore,
    grade,
    summary: { byPattern, bySeverity },
  };
}

// ---------------------------------------------------------------------------
// 4. buildTestCodeMapping
// ---------------------------------------------------------------------------

/** A mapping between a source file and its test files. */
export interface TestCodeMap {
  /** Path to the source file. */
  sourceFile: string;
  /** Paths to matched test files. */
  testFiles: string[];
  /** Confidence level of the mapping. */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable explanation of why this mapping was made. */
  matchReason: string;
}

/** Result of buildTestCodeMapping. */
export interface TestCodeMappingResult {
  /** All source-to-test mappings found. */
  mappings: TestCodeMap[];
  /** Test files with no corresponding source file. */
  orphanTests: string[];
  /** Source files with no corresponding test file. */
  untestedFiles: string[];
  /** Summary statistics. */
  summary: {
    totalSource: number;
    totalTests: number;
    mapped: number;
    orphans: number;
    untested: number;
  };
}

/** Options for buildTestCodeMapping. */
export interface TestCodeMappingOptions {
  /** Glob pattern for source files. */
  fileGlob?: string;
  /** Whether to verify mappings by checking imports. Defaults to true. */
  verifyImports?: boolean;
}

/**
 * Build a bidirectional mapping between source files and their test files.
 *
 * Uses three strategies (in order of confidence):
 * 1. Import analysis: test file imports the source file (high confidence)
 * 2. Naming convention: test file name matches source file name (medium confidence)
 * 3. Directory structure: test file in __tests__ or tests/ adjacent to source (low confidence)
 *
 * Also identifies orphan tests (no matching source) and untested source files.
 *
 * @param cwd - Project root directory
 * @param options - Optional configuration
 * @returns Bidirectional mapping with orphan and untested file lists
 */
export async function buildTestCodeMapping(
  cwd: string,
  options?: TestCodeMappingOptions,
): Promise<TestCodeMappingResult> {
  const verifyImports = options?.verifyImports !== false;
  const sourceGlob = options?.fileGlob || SOURCE_GLOB;

  // 1. Gather all source and test files
  const allFiles = await listFiles(cwd, { glob: sourceGlob, type: 'file' });
  const sourceFiles = allFiles
    .filter((f) => !isTestFile(f) && !CONFIG_FILE_PATTERN.test(f))
    .slice(0, MAX_FILES);
  const testFiles = await findAllTestFiles(cwd);

  const mappings: TestCodeMap[] = [];
  const mappedTestFiles = new Set<string>();

  // 2. For each source file, find matching tests
  for (const sourceFile of sourceFiles) {
    const base = baseName(sourceFile);
    const ext = path.extname(sourceFile);
    const dir = path.dirname(sourceFile);
    const matchedTests: { file: string; confidence: TestCodeMap['confidence']; reason: string }[] = [];

    for (const testFile of testFiles) {
      const testBaseFull = path.basename(testFile, path.extname(testFile));
      // Strip test/spec suffixes to get the underlying module name
      const testModuleName = testBaseFull
        .replace(/\.(test|spec)$/, '')
        .replace(/_(test|spec)$/, '')
        .replace(/^(test_|spec_)/, '');

      // Strategy 1: Exact name match
      if (testModuleName === base) {
        // Check directory proximity for confidence
        const testDir = path.dirname(testFile);
        const inSameDir = testDir === dir;
        const inAdjacentTestDir =
          testDir === path.join(dir, '__tests__') ||
          testDir === path.join(dir, 'tests') ||
          testDir === path.join(dir, 'test');

        if (inSameDir || inAdjacentTestDir) {
          matchedTests.push({
            file: testFile,
            confidence: 'high',
            reason: `Name match + co-located (${inSameDir ? 'same directory' : 'adjacent test directory'})`,
          });
        } else {
          matchedTests.push({
            file: testFile,
            confidence: 'medium',
            reason: `Name match: ${testBaseFull}${ext} corresponds to ${base}${ext}`,
          });
        }
        continue;
      }

      // Strategy 2: __tests__ directory with same-name file
      if (
        testFile.includes('__tests__') &&
        testBaseFull.includes(base) &&
        testFile.includes(dir.split(path.sep)[0] || '')
      ) {
        matchedTests.push({
          file: testFile,
          confidence: 'medium',
          reason: `Found in __tests__ directory with matching name`,
        });
      }
    }

    // Strategy 3: Verify via import analysis (upgrade confidence)
    if (verifyImports && matchedTests.length > 0) {
      for (const matched of matchedTests) {
        try {
          const testContent = await readFile(path.resolve(cwd, matched.file), 'utf-8');
          if (testImportsSource(testContent, sourceFile, matched.file)) {
            matched.confidence = 'high';
            matched.reason = `Import verified: test file imports ${sourceFile}`;
          }
        } catch {
          // Keep existing confidence
        }
      }
    }

    if (matchedTests.length > 0) {
      // Pick the highest confidence as the overall mapping confidence
      const confidenceOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
      matchedTests.sort(
        (a, b) => confidenceOrder[b.confidence] - confidenceOrder[a.confidence],
      );
      const topConfidence = matchedTests[0].confidence;
      const reasons = [...new Set(matchedTests.map((m) => m.reason))];

      mappings.push({
        sourceFile,
        testFiles: matchedTests.map((m) => m.file),
        confidence: topConfidence,
        matchReason: reasons.join('; '),
      });

      for (const m of matchedTests) mappedTestFiles.add(m.file);
    }
  }

  // 3. Identify orphan tests and untested files
  const orphanTests = testFiles.filter((t) => !mappedTestFiles.has(t));
  const testedSources = new Set(mappings.map((m) => m.sourceFile));
  const untestedFiles = sourceFiles.filter((s) => !testedSources.has(s));

  return {
    mappings,
    orphanTests,
    untestedFiles,
    summary: {
      totalSource: sourceFiles.length,
      totalTests: testFiles.length,
      mapped: mappings.length,
      orphans: orphanTests.length,
      untested: untestedFiles.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: shared test file finder
// ---------------------------------------------------------------------------

/**
 * Find all test files in the project using listing + naming conventions.
 * Results are cached per cwd within a single analysis session.
 */
const _testFileCache = new Map<string, string[]>();

async function findAllTestFiles(cwd: string): Promise<string[]> {
  if (_testFileCache.has(cwd)) return _testFileCache.get(cwd)!;

  const testFiles = new Set<string>();

  // Search for common test file patterns
  const testGlobs = [
    '*.test.{ts,tsx,js,jsx,mts,mjs}',
    '*.spec.{ts,tsx,js,jsx,mts,mjs}',
    '*_test.{ts,tsx,js,jsx,mts,mjs}',
    '*_spec.{ts,tsx,js,jsx,mts,mjs}',
  ];

  for (const glob of testGlobs) {
    try {
      const files = await listFiles(cwd, { glob, type: 'file' });
      for (const f of files) testFiles.add(f);
    } catch {
      // Glob may fail in certain environments
    }
  }

  // Also check __tests__ and tests/ directories
  try {
    const testDirFiles = await listFiles(cwd, {
      glob: SOURCE_GLOB,
      type: 'file',
    });
    for (const f of testDirFiles) {
      if (isTestFile(f)) testFiles.add(f);
    }
  } catch {
    // Best-effort
  }

  const result = [...testFiles].slice(0, MAX_FILES);
  _testFileCache.set(cwd, result);
  return result;
}
