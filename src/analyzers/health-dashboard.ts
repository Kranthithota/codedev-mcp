/**
 * Health Dashboard Analyzer
 *
 * Combines multiple health signals (code quality, tests, security, dependencies,
 * documentation, git activity, CI/CD, and tech debt) into a unified dashboard
 * with per-dimension scores, grades, findings, and recommendations.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A single dimension (category) of the health dashboard. */
export interface HealthDimension {
  name: string;
  /** 0-100 numeric score. */
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  findings: string[];
  recommendations: string[];
}

/** Aggregate dashboard returned by {@link generateHealthDashboard}. */
export interface HealthDashboard {
  overallScore: number;
  overallGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  dimensions: HealthDimension[];
  topRisks: string[];
  quickWins: string[];
  stats: {
    totalFiles: number;
    totalCodeFiles: number;
    totalLines: number;
    languages: Record<string, number>;
    testRatio: string;
    docCoverage: string;
    lastCommitDaysAgo: number;
    contributors: number;
  };
}

/** Options for {@link generateHealthDashboard}. */
export interface HealthDashboardOptions {
  /** Subdirectory to analyse (relative to cwd). */
  directory?: string;
  /** Max source files to sample for per-file metrics (default 500). */
  maxFiles?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Standard code-file extensions grouped by language. */
const LANG_EXTENSIONS: Record<string, string[]> = {
  TypeScript: ['.ts', '.tsx'],
  JavaScript: ['.js', '.jsx', '.mjs', '.cjs'],
  Python: ['.py'],
  Java: ['.java'],
  Go: ['.go'],
  Rust: ['.rs'],
  Ruby: ['.rb'],
  PHP: ['.php'],
  'C#': ['.cs'],
  C: ['.c', '.h'],
  'C++': ['.cpp', '.cxx', '.cc', '.hpp'],
  Swift: ['.swift'],
  Kotlin: ['.kt', '.kts'],
  Scala: ['.scala'],
  Shell: ['.sh', '.bash', '.zsh'],
  HTML: ['.html', '.htm'],
  CSS: ['.css', '.scss', '.sass', '.less'],
  SQL: ['.sql'],
};

/** Build an extension -> language lookup. */
const EXT_TO_LANG: Record<string, string> = {};
for (const [lang, exts] of Object.entries(LANG_EXTENSIONS)) {
  for (const ext of exts) {
    EXT_TO_LANG[ext] = lang;
  }
}

/** Glob that matches common source code files. */
const CODE_GLOB = '*.{ts,tsx,js,jsx,mjs,cjs,py,java,go,rs,rb,php,cs,c,h,cpp,cxx,cc,hpp,swift,kt,kts,scala,sh,bash}';

/** Glob matching common test file patterns. */
const TEST_PATTERNS = [
  '*.test.*',
  '*.spec.*',
  '*_test.*',
  '*_spec.*',
  'test_*.*',
];

/** CI config file paths to probe for. */
const CI_CONFIG_FILES = [
  '.github/workflows',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  '.circleci/config.yml',
  '.travis.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'cloudbuild.yaml',
  'cloudbuild.yml',
  '.buildkite/pipeline.yml',
  'appveyor.yml',
];

/** Max buffer for child-process calls. */
const EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 15_000 };

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Convert a numeric score (0-100) to a letter grade.
 *
 * @param score - The numeric score.
 * @returns A letter grade from A to F.
 */
function toGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Clamp a value between 0 and 100.
 *
 * @param n - The value to clamp.
 * @returns The clamped value.
 */
function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Safely run a git command. Returns stdout on success, empty string on failure.
 *
 * @param args - Git command arguments.
 * @param cwd  - Working directory.
 * @returns Stdout from git, or empty string if the command fails.
 */
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { ...EXEC_OPTS, cwd });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Count occurrences of a pattern in a string.
 *
 * @param text    - Source text to search.
 * @param pattern - Regular expression (should have global flag).
 * @returns The number of matches.
 */
function countMatches(text: string, pattern: RegExp): number {
  const m = text.match(pattern);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Dimension analysers (each returns a HealthDimension)
// ---------------------------------------------------------------------------

/**
 * Analyse code quality metrics: file count, LOC, average complexity.
 * Complexity is approximated by counting branching keywords per function body.
 */
async function analyseCodeQuality(
  cwd: string,
  codeFiles: string[],
  fileContents: Map<string, string>,
): Promise<HealthDimension> {
  const findings: string[] = [];
  const recommendations: string[] = [];

  // Compute per-function complexity across sampled files
  const complexityValues: number[] = [];
  const branchPattern = /\b(if|else|for|while|switch|catch)\b|&&|\|\|/g;

  for (const file of codeFiles) {
    const content = fileContents.get(file);
    if (!content) continue;

    // Rough function-body extraction via brace matching
    const funcStarts = [
      ...content.matchAll(/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(|(?:async\s+)?(?:def|fn)\s+\w+|\w+\s*\([^)]*\)\s*\{)/g),
    ];

    if (funcStarts.length === 0) {
      // Treat the whole file as one unit
      complexityValues.push(countMatches(content, branchPattern));
      continue;
    }

    for (const m of funcStarts) {
      const start = m.index ?? 0;
      // Walk forward to find matching closing brace (limited window)
      let braces = 0;
      let opened = false;
      let end = start;
      for (let i = start; i < content.length && i < start + 5000; i++) {
        if (content[i] === '{') { braces++; opened = true; }
        if (content[i] === '}') braces--;
        if (opened && braces <= 0) { end = i; break; }
      }
      const body = content.slice(start, end + 1);
      complexityValues.push(countMatches(body, branchPattern));
    }
  }

  const avgComplexity =
    complexityValues.length > 0
      ? complexityValues.reduce((a, b) => a + b, 0) / complexityValues.length
      : 0;

  findings.push(`Average function complexity: ${avgComplexity.toFixed(1)} branch points`);
  findings.push(`Sampled ${codeFiles.length} code files`);

  // Scoring: avg complexity 0 => 100, >=15 => 0
  let score = clamp(100 - (avgComplexity / 15) * 100);

  if (avgComplexity > 10) {
    recommendations.push('Refactor high-complexity functions (>10 branch points) into smaller units');
  }
  if (avgComplexity > 5) {
    recommendations.push('Consider extracting nested conditionals into guard clauses or helper functions');
  }
  if (codeFiles.length === 0) {
    findings.push('No source code files found');
    score = 0;
  }

  return { name: 'Code Quality', score, grade: toGrade(score), findings, recommendations };
}

/**
 * Analyse test health: test file ratio, coverage artefact presence.
 */
async function analyseTestHealth(
  cwd: string,
  allFiles: string[],
  codeFiles: string[],
): Promise<HealthDimension> {
  const findings: string[] = [];
  const recommendations: string[] = [];

  // Count test files
  const testFiles = allFiles.filter((f) => {
    const base = path.basename(f);
    return (
      TEST_PATTERNS.some((p) => {
        const stem = p.replace('*', '');
        return base.includes(stem.replace('.*', ''));
      }) ||
      f.includes('__tests__') ||
      f.includes('/test/') ||
      f.includes('/tests/')
    );
  });

  const sourceCount = Math.max(1, codeFiles.length - testFiles.length);
  const testRatio = testFiles.length / sourceCount;

  findings.push(`${testFiles.length} test files for ${sourceCount} source files (ratio ${testRatio.toFixed(2)})`);

  // Check for coverage artefacts
  const coverageExists =
    existsSync(path.join(cwd, 'coverage')) ||
    existsSync(path.join(cwd, '.nyc_output')) ||
    existsSync(path.join(cwd, 'htmlcov')) ||
    existsSync(path.join(cwd, 'lcov.info'));

  if (coverageExists) {
    findings.push('Coverage data artefacts found');
  } else {
    findings.push('No coverage data found');
    recommendations.push('Configure code coverage collection and add it to CI');
  }

  // Score: ratio >= 0.8 => 100, 0 => 0. Bonus 10 for coverage artefacts.
  let score = clamp(Math.min(testRatio / 0.8, 1) * 90 + (coverageExists ? 10 : 0));

  if (testFiles.length === 0) {
    recommendations.push('Add unit tests to improve project reliability');
    score = 0;
  } else if (testRatio < 0.3) {
    recommendations.push('Increase test coverage -- aim for at least one test file per source module');
  }

  return { name: 'Test Health', score, grade: toGrade(score), findings, recommendations };
}

/**
 * Analyse security posture: hardcoded secrets, eval usage, SQL injection patterns.
 */
async function analyseSecurityPosture(
  cwd: string,
  codeFiles: string[],
  fileContents: Map<string, string>,
): Promise<HealthDimension> {
  const findings: string[] = [];
  const recommendations: string[] = [];

  const secretPattern =
    /(?:password|secret|api_key|apikey|token|private_key|access_key|auth_token|client_secret)\s*[:=]\s*['"]\S{8,}['"]/gi;
  const evalPattern = /\beval\s*\(/g;
  const sqlInjPattern =
    /(?:query|execute|exec|raw)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER).*?\$\{|%s|%d|\+\s*\w/gi;

  let secretCount = 0;
  let evalCount = 0;
  let sqlInjCount = 0;

  for (const file of codeFiles) {
    const content = fileContents.get(file);
    if (!content) continue;

    secretCount += countMatches(content, secretPattern);
    evalCount += countMatches(content, evalPattern);
    sqlInjCount += countMatches(content, sqlInjPattern);
  }

  findings.push(`Hardcoded secret patterns: ${secretCount}`);
  findings.push(`eval() usages: ${evalCount}`);
  findings.push(`Potential SQL injection patterns: ${sqlInjCount}`);

  const totalIssues = secretCount * 3 + evalCount * 2 + sqlInjCount * 3;
  // Score: 0 issues => 100, >=20 weighted issues => 0
  const score = clamp(100 - (totalIssues / 20) * 100);

  if (secretCount > 0) {
    recommendations.push('Move hardcoded secrets to environment variables or a secrets manager');
  }
  if (evalCount > 0) {
    recommendations.push('Replace eval() with safer alternatives (JSON.parse, new Map, etc.)');
  }
  if (sqlInjCount > 0) {
    recommendations.push('Use parameterised queries or an ORM to prevent SQL injection');
  }
  if (totalIssues === 0) {
    findings.push('No common security anti-patterns detected');
  }

  return { name: 'Security Posture', score, grade: toGrade(score), findings, recommendations };
}

/**
 * Analyse dependency health: dep count, lockfile presence.
 */
async function analyseDependencyHealth(cwd: string): Promise<HealthDimension> {
  const findings: string[] = [];
  const recommendations: string[] = [];
  let depCount = 0;
  let devDepCount = 0;
  let hasLockfile = false;

  // Parse package.json
  try {
    const raw = await readFile(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    depCount = Object.keys(pkg.dependencies || {}).length;
    devDepCount = Object.keys(pkg.devDependencies || {}).length;
    findings.push(`${depCount} production dependencies, ${devDepCount} dev dependencies`);
  } catch {
    findings.push('No package.json found (or unreadable)');
  }

  // Lockfile check
  const lockfiles = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Pipfile.lock',
    'poetry.lock',
    'Cargo.lock',
    'go.sum',
  ];
  for (const lf of lockfiles) {
    if (existsSync(path.join(cwd, lf))) {
      hasLockfile = true;
      findings.push(`Lockfile found: ${lf}`);
      break;
    }
  }
  if (!hasLockfile) {
    findings.push('No lockfile found');
    recommendations.push('Commit a lockfile to ensure reproducible builds');
  }

  const totalDeps = depCount + devDepCount;
  // Score: 0 deps => 100, penalise heavily for missing lockfile, lightly for excessive deps
  let score = 100;
  if (!hasLockfile) score -= 30;
  if (totalDeps > 100) {
    score -= Math.min(30, Math.round(((totalDeps - 100) / 200) * 30));
    recommendations.push('Consider auditing dependencies to reduce bundle size and attack surface');
  }
  if (totalDeps > 50 && totalDeps <= 100) {
    score -= 5;
  }

  score = clamp(score);
  return { name: 'Dependency Health', score, grade: toGrade(score), findings, recommendations };
}

/**
 * Analyse documentation: README presence, JSDoc / docstring coverage.
 */
async function analyseDocumentation(
  cwd: string,
  codeFiles: string[],
  fileContents: Map<string, string>,
): Promise<HealthDimension> {
  const findings: string[] = [];
  const recommendations: string[] = [];

  // README check
  const hasReadme =
    existsSync(path.join(cwd, 'README.md')) ||
    existsSync(path.join(cwd, 'readme.md')) ||
    existsSync(path.join(cwd, 'README.rst')) ||
    existsSync(path.join(cwd, 'README'));

  if (hasReadme) {
    findings.push('README file found');
  } else {
    findings.push('No README file found');
    recommendations.push('Add a README with project overview, setup instructions, and usage examples');
  }

  // Count files with documentation (JSDoc, docstrings, ///-style doc comments)
  const docPattern = /\/\*\*[\s\S]*?\*\/|"""\s*[\s\S]*?"""|'''\s*[\s\S]*?'''|\/\/\/ /;
  let filesWithDocs = 0;

  for (const file of codeFiles) {
    const content = fileContents.get(file);
    if (content && docPattern.test(content)) {
      filesWithDocs++;
    }
  }

  const docRatio = codeFiles.length > 0 ? filesWithDocs / codeFiles.length : 0;
  findings.push(`${filesWithDocs}/${codeFiles.length} files contain doc comments (${(docRatio * 100).toFixed(0)}%)`);

  // Score
  let score = 0;
  score += hasReadme ? 30 : 0;
  score += clamp(docRatio * 100) * 0.7;
  score = clamp(score);

  if (docRatio < 0.3) {
    recommendations.push('Add JSDoc / docstring comments to exported functions and classes');
  }

  return { name: 'Documentation', score, grade: toGrade(score), findings, recommendations };
}

/**
 * Analyse git health: recent commit frequency, contributor count, branch count.
 */
async function analyseGitHealth(cwd: string): Promise<{
  dimension: HealthDimension;
  lastCommitDaysAgo: number;
  contributors: number;
}> {
  const findings: string[] = [];
  const recommendations: string[] = [];
  let lastCommitDaysAgo = -1;
  let contributors = 0;
  let recentCommitCount = 0;
  let branchCount = 0;

  // Recent commits (last 30 days)
  const logOutput = await git(['log', '--oneline', '--since=30.days.ago'], cwd);
  recentCommitCount = logOutput.split('\n').filter(Boolean).length;
  findings.push(`${recentCommitCount} commits in the last 30 days`);

  // Last commit age
  const lastCommitDate = await git(['log', '-1', '--format=%ai'], cwd);
  if (lastCommitDate.trim()) {
    const daysAgo = Math.round(
      (Date.now() - new Date(lastCommitDate.trim()).getTime()) / (1000 * 60 * 60 * 24),
    );
    lastCommitDaysAgo = daysAgo;
    findings.push(`Last commit: ${daysAgo} day(s) ago`);
  } else {
    findings.push('No git history found');
  }

  // Contributors
  const shortlog = await git(['shortlog', '-sn', '--all'], cwd);
  contributors = shortlog.split('\n').filter(Boolean).length;
  findings.push(`${contributors} contributor(s)`);

  // Branches
  const branches = await git(['branch', '-a', '--format=%(refname:short)'], cwd);
  branchCount = branches.split('\n').filter(Boolean).length;
  findings.push(`${branchCount} branch(es)`);

  // Score
  let score = 100;
  if (lastCommitDaysAgo > 180) {
    score -= 40;
    recommendations.push('Repository appears inactive -- consider archiving or resuming development');
  } else if (lastCommitDaysAgo > 90) {
    score -= 20;
    recommendations.push('Repository has had no recent activity -- review whether maintenance is needed');
  }
  if (recentCommitCount === 0 && lastCommitDaysAgo >= 0) score -= 20;
  if (contributors === 0) score -= 20;
  if (contributors === 1) {
    score -= 5;
    recommendations.push('Single contributor -- consider bus-factor risk');
  }
  if (branchCount > 30) {
    score -= 10;
    recommendations.push('Many branches detected -- consider cleaning up stale branches');
  }

  score = clamp(score);

  return {
    dimension: { name: 'Git Health', score, grade: toGrade(score), findings, recommendations },
    lastCommitDaysAgo: Math.max(0, lastCommitDaysAgo),
    contributors,
  };
}

/**
 * Analyse CI/CD configuration presence.
 */
async function analyseCICD(cwd: string): Promise<HealthDimension> {
  const findings: string[] = [];
  const recommendations: string[] = [];
  const found: string[] = [];

  for (const ciPath of CI_CONFIG_FILES) {
    const full = path.join(cwd, ciPath);
    if (existsSync(full)) {
      found.push(ciPath);
    }
  }

  // Also check for workflow files inside .github/workflows
  if (existsSync(path.join(cwd, '.github', 'workflows'))) {
    try {
      const wfFiles = await listFiles(path.join(cwd, '.github', 'workflows'), {
        glob: '*.{yml,yaml}',
        type: 'file',
      });
      if (wfFiles.length > 0 && !found.includes('.github/workflows')) {
        found.push('.github/workflows');
      }
      findings.push(`${wfFiles.length} GitHub Actions workflow file(s)`);
    } catch {
      /* skip */
    }
  }

  if (found.length > 0) {
    findings.push(`CI/CD configs found: ${found.join(', ')}`);
  } else {
    findings.push('No CI/CD configuration detected');
    recommendations.push('Set up a CI pipeline (GitHub Actions, GitLab CI, etc.) for automated testing');
  }

  const score = clamp(found.length > 0 ? 100 : 0);
  return { name: 'CI/CD', score, grade: toGrade(score), findings, recommendations };
}

/**
 * Analyse tech debt indicators: TODOs, long functions, large files, debug logs.
 */
async function analyseTechDebt(
  cwd: string,
  codeFiles: string[],
  fileContents: Map<string, string>,
): Promise<HealthDimension> {
  const findings: string[] = [];
  const recommendations: string[] = [];

  let todoCount = 0;
  let longFunctionCount = 0;
  let largeFileCount = 0;
  let debugLogCount = 0;

  const todoPattern = /\b(?:TODO|FIXME|HACK|XXX|TEMP)\b/g;
  const debugPattern = /\bconsole\.(log|debug|info)\s*\(|print\s*\(|System\.out\.print/g;

  for (const file of codeFiles) {
    const content = fileContents.get(file);
    if (!content) continue;

    const lines = content.split('\n');

    // TODOs
    todoCount += countMatches(content, todoPattern);

    // Debug logs (skip test files)
    const base = path.basename(file);
    const isTest =
      base.includes('.test.') || base.includes('.spec.') || base.includes('_test.') || file.includes('__tests__');
    if (!isTest) {
      debugLogCount += countMatches(content, debugPattern);
    }

    // Large files (>500 lines)
    if (lines.length > 500) largeFileCount++;

    // Long functions (>50 lines) -- approximate via brace-counting
    let funcLineCount = 0;
    let braces = 0;
    let inFunc = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !inFunc &&
        (/\bfunction\b/.test(trimmed) || /=>\s*\{/.test(trimmed) || /\)\s*\{/.test(trimmed))
      ) {
        inFunc = true;
        funcLineCount = 0;
      }
      if (inFunc) {
        funcLineCount++;
        for (const ch of line) {
          if (ch === '{') braces++;
          if (ch === '}') braces--;
        }
        if (braces <= 0 && funcLineCount > 0) {
          if (funcLineCount > 50) longFunctionCount++;
          inFunc = false;
          funcLineCount = 0;
          braces = 0;
        }
      }
    }
  }

  findings.push(`TODO/FIXME/HACK comments: ${todoCount}`);
  findings.push(`Functions >50 lines: ${longFunctionCount}`);
  findings.push(`Files >500 lines: ${largeFileCount}`);
  findings.push(`Debug log statements (non-test): ${debugLogCount}`);

  // Weighted issues
  const weighted = todoCount * 0.5 + longFunctionCount * 2 + largeFileCount * 1.5 + debugLogCount * 0.3;
  const score = clamp(100 - (weighted / 40) * 100);

  if (todoCount > 10) recommendations.push('Triage and resolve accumulated TODO/FIXME comments');
  if (longFunctionCount > 5) recommendations.push('Break long functions (>50 lines) into smaller, focused units');
  if (largeFileCount > 3) recommendations.push('Split large files (>500 lines) into smaller modules');
  if (debugLogCount > 10) recommendations.push('Remove or replace debug log statements with a proper logger');

  return { name: 'Tech Debt', score, grade: toGrade(score), findings, recommendations };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a unified health dashboard for a codebase.
 *
 * Combines eight analysis dimensions into an aggregate report with scores,
 * grades, top risks, quick wins, and summary statistics.
 *
 * @param cwd     - Root directory of the project.
 * @param options - Optional configuration (subdirectory, sample limit).
 * @returns A {@link HealthDashboard} with per-dimension and aggregate results.
 */
export async function generateHealthDashboard(
  cwd: string,
  options?: HealthDashboardOptions,
): Promise<HealthDashboard> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const maxFiles = options?.maxFiles ?? 500;

  // -----------------------------------------------------------------------
  // 1. Collect files
  // -----------------------------------------------------------------------
  let allFiles: string[];
  try {
    allFiles = await listFiles(dir, { type: 'file' });
  } catch {
    allFiles = [];
  }

  // Identify code files and compute language distribution
  const codeFiles: string[] = [];
  const languages: Record<string, number> = {};
  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (lang) {
      codeFiles.push(f);
      languages[lang] = (languages[lang] || 0) + 1;
    }
  }

  // -----------------------------------------------------------------------
  // 2. Read file contents (sampled)
  // -----------------------------------------------------------------------
  const sampled = codeFiles.slice(0, maxFiles);
  const fileContents = new Map<string, string>();
  let totalLines = 0;

  await Promise.all(
    sampled.map(async (file) => {
      try {
        const content = await readFile(path.join(dir, file), 'utf-8');
        fileContents.set(file, content);
        totalLines += content.split('\n').length;
      } catch {
        /* skip unreadable files */
      }
    }),
  );

  // -----------------------------------------------------------------------
  // 3. Run all dimension analyses in parallel
  // -----------------------------------------------------------------------
  const [
    codeQuality,
    testHealth,
    security,
    depHealth,
    docs,
    gitResult,
    cicd,
    techDebt,
  ] = await Promise.all([
    analyseCodeQuality(dir, sampled, fileContents),
    analyseTestHealth(dir, allFiles, codeFiles),
    analyseSecurityPosture(dir, sampled, fileContents),
    analyseDependencyHealth(dir),
    analyseDocumentation(dir, sampled, fileContents),
    analyseGitHealth(dir),
    analyseCICD(dir),
    analyseTechDebt(dir, sampled, fileContents),
  ]);

  const dimensions: HealthDimension[] = [
    codeQuality,
    testHealth,
    security,
    depHealth,
    docs,
    gitResult.dimension,
    cicd,
    techDebt,
  ];

  // -----------------------------------------------------------------------
  // 4. Compute weighted overall score
  // -----------------------------------------------------------------------
  const weights: Record<string, number> = {
    'Code Quality': 0.20,
    'Test Health': 0.15,
    'Security Posture': 0.20,
    'Dependency Health': 0.10,
    'Documentation': 0.05,
    'Git Health': 0.10,
    'CI/CD': 0.10,
    'Tech Debt': 0.10,
  };

  let overallScore = 0;
  for (const dim of dimensions) {
    overallScore += dim.score * (weights[dim.name] ?? 0.125);
  }
  overallScore = clamp(overallScore);
  const overallGrade = toGrade(overallScore);

  // -----------------------------------------------------------------------
  // 5. Derive top risks and quick wins
  // -----------------------------------------------------------------------
  // Top risks: dimensions with lowest scores
  const sorted = [...dimensions].sort((a, b) => a.score - b.score);
  const topRisks: string[] = sorted
    .filter((d) => d.score < 70)
    .slice(0, 5)
    .map((d) => `${d.name} (${d.grade}, score ${d.score}): ${d.findings[0] || 'Issues detected'}`);

  // Quick wins: first recommendation from each low-scoring dimension
  const quickWins: string[] = sorted
    .filter((d) => d.recommendations.length > 0 && d.score < 80)
    .slice(0, 5)
    .map((d) => `[${d.name}] ${d.recommendations[0]}`);

  // -----------------------------------------------------------------------
  // 6. Compute stats
  // -----------------------------------------------------------------------
  // Test ratio
  const testFileCount = allFiles.filter((f) => {
    const base = path.basename(f);
    return (
      base.includes('.test.') ||
      base.includes('.spec.') ||
      base.includes('_test.') ||
      base.includes('_spec.') ||
      f.includes('__tests__') ||
      f.includes('/test/') ||
      f.includes('/tests/')
    );
  }).length;
  const sourceOnly = Math.max(1, codeFiles.length - testFileCount);
  const testRatio = `${testFileCount}:${sourceOnly}`;

  // Doc coverage string
  const docPattern = /\/\*\*[\s\S]*?\*\/|"""\s*[\s\S]*?"""|'''\s*[\s\S]*?'''|\/\/\/ /;
  let docsCount = 0;
  for (const [, content] of fileContents) {
    if (docPattern.test(content)) docsCount++;
  }
  const docCoverage =
    sampled.length > 0 ? `${((docsCount / sampled.length) * 100).toFixed(0)}%` : '0%';

  const stats: HealthDashboard['stats'] = {
    totalFiles: allFiles.length,
    totalCodeFiles: codeFiles.length,
    totalLines,
    languages,
    testRatio,
    docCoverage,
    lastCommitDaysAgo: gitResult.lastCommitDaysAgo,
    contributors: gitResult.contributors,
  };

  return {
    overallScore,
    overallGrade,
    dimensions,
    topRisks,
    quickWins,
    stats,
  };
}
