/**
 * PR Review Intelligence Analyzers
 * Provides structured review context, risk scoring, and breaking change
 * detection for pull request analysis.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { searchCode } from '../search/fast-search.js';

const execFileAsync = promisify(execFile);

const EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 30000 };

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ReviewContext {
  base: string;
  compare: string;
  summary: {
    totalCommits: number;
    totalFilesChanged: number;
    insertions: number;
    deletions: number;
    categories: Record<string, number>;
  };
  commits: { hash: string; message: string; author: string }[];
  changedFiles: {
    file: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    insertions: number;
    deletions: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    riskReasons: string[];
  }[];
  blastRadius: { file: string; dependents: string[] }[];
  reviewFocusAreas: string[];
}

export interface ReviewRiskScore {
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  dimensions: { name: string; score: number; weight: number; details: string }[];
  recommendations: string[];
}

export interface BreakingChange {
  file: string;
  line: number;
  type:
    | 'removed-export'
    | 'changed-signature'
    | 'removed-field'
    | 'changed-route'
    | 'changed-env'
    | 'changed-config';
  severity: 'warning' | 'error';
  description: string;
  before: string;
  after?: string;
}

export interface BreakingChangeResult {
  breakingChanges: BreakingChange[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    byType: Record<string, number>;
  };
  affectedConsumers: { file: string; usage: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a git command and return stdout. Returns empty string on failure.
 */
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { ...EXEC_OPTS, cwd });
    return stdout;
  } catch {
    return '';
  }
}

/** High-risk file path patterns. */
const SECURITY_PATTERNS = [
  /auth/i,
  /crypto/i,
  /secret/i,
  /password/i,
  /token/i,
  /session/i,
  /permission/i,
  /rbac/i,
  /acl/i,
];

const CONFIG_PATTERNS = [
  /\.env/,
  /config\./,
  /\.ya?ml$/,
  /\.toml$/,
  /\.ini$/,
  /\.conf$/,
  /docker-compose/,
  /Dockerfile/,
  /\.tf$/,
];

const MIGRATION_PATTERNS = [/migrat/i, /schema/i, /\.sql$/, /seed/i];

const TEST_PATTERNS = [/\.test\.|\.spec\.|__tests__|\/test\/|\/tests\/|\/spec\//];

/**
 * Classify a file path into a change category.
 */
function classifyFile(filePath: string): string {
  if (TEST_PATTERNS.some((p) => p.test(filePath))) return 'tests';
  if (CONFIG_PATTERNS.some((p) => p.test(filePath))) return 'config';
  if (MIGRATION_PATTERNS.some((p) => p.test(filePath))) return 'migrations';
  if (/\.md$|\.txt$|\.rst$|LICENSE|CHANGELOG/i.test(filePath)) return 'docs';
  if (/package\.json|Cargo\.toml|go\.mod|requirements\.txt|Gemfile/i.test(filePath)) return 'dependencies';
  return 'source';
}

/**
 * Classify a commit message into a change category.
 */
function classifyCommitMessage(message: string): string {
  const msg = message.toLowerCase();
  if (/\bfix\b|bug|patch|hotfix|issue/.test(msg)) return 'bugfix';
  if (/\bfeat\b|feature|add|new|implement|create|introduce/.test(msg)) return 'feature';
  if (/refactor|rename|restructure|clean|simplif/.test(msg)) return 'refactoring';
  if (/test|spec|coverage/.test(msg)) return 'tests';
  if (/config|ci|cd|build|deploy|docker|infra/.test(msg)) return 'config';
  if (/doc|readme|comment|changelog/.test(msg)) return 'docs';
  return 'other';
}

/**
 * Determine the risk level and reasons for a changed file.
 */
function assessFileRisk(
  filePath: string,
  insertions: number,
  deletions: number,
): { riskLevel: 'low' | 'medium' | 'high' | 'critical'; riskReasons: string[] } {
  const reasons: string[] = [];
  let level: 'low' | 'medium' | 'high' | 'critical' = 'low';

  // Security-sensitive files
  if (SECURITY_PATTERNS.some((p) => p.test(filePath))) {
    reasons.push('Security-sensitive file path');
    level = 'high';
  }

  // Config files
  if (CONFIG_PATTERNS.some((p) => p.test(filePath))) {
    reasons.push('Configuration file');
    if (level === 'low') level = 'medium';
  }

  // Migration / schema files
  if (MIGRATION_PATTERNS.some((p) => p.test(filePath))) {
    reasons.push('Database migration or schema file');
    level = 'critical';
  }

  // Public API surface (index files, route definitions)
  if (/index\.[jt]sx?$|routes?\.[jt]sx?$|api\//i.test(filePath)) {
    reasons.push('Public API surface');
    if (level === 'low') level = 'medium';
  }

  // Large change volume
  const totalLines = insertions + deletions;
  if (totalLines > 300) {
    reasons.push(`Large change volume (${totalLines} lines)`);
    if (level === 'low') level = 'medium';
    if (totalLines > 500) level = 'high';
  }

  // High deletion ratio (potential breaking)
  if (deletions > 0 && deletions > insertions * 2) {
    reasons.push('High deletion ratio — potential removals');
    if (level === 'low') level = 'medium';
  }

  return { riskLevel: level, riskReasons: reasons };
}

/**
 * Map a git status letter to a semantic status.
 */
function parseGitStatus(status: string): 'added' | 'modified' | 'deleted' | 'renamed' {
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'deleted';
  if (status.startsWith('R')) return 'renamed';
  return 'modified';
}

/**
 * Assign a letter grade based on a 0-100 risk score.
 */
function gradeFromScore(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score <= 20) return 'A';
  if (score <= 40) return 'B';
  if (score <= 60) return 'C';
  if (score <= 80) return 'D';
  return 'F';
}

// ---------------------------------------------------------------------------
// 1. generateReviewContext
// ---------------------------------------------------------------------------

/**
 * Generate a structured PR review context package.
 *
 * Collects changed files, commits, blast radius, risk levels, and focus areas
 * to give reviewers a comprehensive overview of a changeset.
 *
 * @param cwd - The working directory of the git repository.
 * @param base - The base ref (branch or commit) to compare against.
 * @param compare - The comparison ref. Defaults to `'HEAD'`.
 * @param options - Optional configuration.
 * @param options.maxBlastRadiusFiles - Maximum number of changed files to compute blast radius for (default 30).
 * @returns A structured review context object.
 */
export async function generateReviewContext(
  cwd: string,
  base: string,
  compare?: string,
  options?: { maxBlastRadiusFiles?: number },
): Promise<ReviewContext> {
  const comp = compare || 'HEAD';
  const maxBlast = options?.maxBlastRadiusFiles ?? 30;

  // Run git commands in parallel for efficiency
  const [nameStatusOut, numstatOut, logOut, shortstatOut] = await Promise.all([
    git(['diff', '--name-status', '--diff-filter=ACDMRT', `${base}...${comp}`], cwd),
    git(['diff', '--numstat', `${base}...${comp}`], cwd),
    git(['log', '--format=%H|%an|%s', `${base}...${comp}`], cwd),
    git(['diff', '--shortstat', `${base}...${comp}`], cwd),
  ]);

  // ---- Parse file statuses ----
  const statusMap = new Map<string, 'added' | 'modified' | 'deleted' | 'renamed'>();
  for (const line of nameStatusOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    const file = status.startsWith('R') ? parts[2] : parts[1];
    if (file) statusMap.set(file, parseGitStatus(status));
  }

  // ---- Parse numstat (insertions/deletions per file) ----
  const numstatMap = new Map<string, { insertions: number; deletions: number }>();
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue;
    const [ins, del, file] = line.split('\t');
    if (file) {
      numstatMap.set(file, {
        insertions: ins === '-' ? 0 : parseInt(ins, 10) || 0,
        deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
      });
    }
  }

  // ---- Parse shortstat for totals ----
  let totalInsertions = 0;
  let totalDeletions = 0;
  if (shortstatOut) {
    const insMatch = shortstatOut.match(/(\d+)\s+insertion/);
    const delMatch = shortstatOut.match(/(\d+)\s+deletion/);
    totalInsertions = insMatch ? parseInt(insMatch[1], 10) : 0;
    totalDeletions = delMatch ? parseInt(delMatch[1], 10) : 0;
  }

  // ---- Parse commits ----
  const commits: ReviewContext['commits'] = [];
  for (const line of logOut.split('\n')) {
    if (!line.trim()) continue;
    const [hash, author, ...messageParts] = line.split('|');
    if (hash) {
      commits.push({ hash: hash.slice(0, 8), message: messageParts.join('|'), author });
    }
  }

  // ---- Build changedFiles with risk assessment ----
  const changedFiles: ReviewContext['changedFiles'] = [];
  const allFiles = new Set([...statusMap.keys(), ...numstatMap.keys()]);

  for (const file of allFiles) {
    const status = statusMap.get(file) || 'modified';
    const stats = numstatMap.get(file) || { insertions: 0, deletions: 0 };
    const { riskLevel, riskReasons } = assessFileRisk(file, stats.insertions, stats.deletions);
    changedFiles.push({
      file,
      status,
      insertions: stats.insertions,
      deletions: stats.deletions,
      riskLevel,
      riskReasons,
    });
  }

  // Sort by risk level descending (critical > high > medium > low)
  const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  changedFiles.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);

  // ---- Categorize changes ----
  const categories: Record<string, number> = {};
  for (const file of changedFiles) {
    const cat = classifyFile(file.file);
    categories[cat] = (categories[cat] || 0) + 1;
  }
  for (const commit of commits) {
    const cat = classifyCommitMessage(commit.message);
    categories[cat] = (categories[cat] || 0) + 1;
  }

  // ---- Compute blast radius ----
  const blastRadius: ReviewContext['blastRadius'] = [];
  const sourceFiles = changedFiles
    .filter((f) => f.status !== 'deleted' && !TEST_PATTERNS.some((p) => p.test(f.file)))
    .slice(0, maxBlast);

  for (const { file } of sourceFiles) {
    const baseName = path.basename(file, path.extname(file));
    if (!baseName || baseName === 'index') continue;
    try {
      const results = await searchCode({
        cwd,
        pattern: baseName,
        isRegex: false,
        maxResults: 50,
      });
      const dependents = results
        .filter((r) => r.file !== file && /import|require|from/.test(r.text))
        .map((r) => r.file);
      const unique = [...new Set(dependents)];
      if (unique.length > 0) {
        blastRadius.push({ file, dependents: unique });
      }
    } catch {
      /* skip on search failure */
    }
  }

  // ---- Determine review focus areas ----
  const reviewFocusAreas: string[] = [];

  const criticalFiles = changedFiles.filter((f) => f.riskLevel === 'critical');
  if (criticalFiles.length > 0) {
    reviewFocusAreas.push(
      `CRITICAL: ${criticalFiles.length} critical-risk file(s) changed — ${criticalFiles.map((f) => f.file).join(', ')}`,
    );
  }

  const highRiskFiles = changedFiles.filter((f) => f.riskLevel === 'high');
  if (highRiskFiles.length > 0) {
    reviewFocusAreas.push(
      `HIGH RISK: ${highRiskFiles.length} high-risk file(s) — ${highRiskFiles.map((f) => f.file).join(', ')}`,
    );
  }

  const wideBlast = blastRadius.filter((b) => b.dependents.length > 5);
  if (wideBlast.length > 0) {
    reviewFocusAreas.push(
      `BLAST RADIUS: ${wideBlast.length} file(s) with >5 dependents — ${wideBlast.map((b) => `${b.file} (${b.dependents.length})`).join(', ')}`,
    );
  }

  const securityFiles = changedFiles.filter((f) =>
    f.riskReasons.some((r) => r.includes('Security')),
  );
  if (securityFiles.length > 0) {
    reviewFocusAreas.push(
      `SECURITY: Review security-sensitive changes in ${securityFiles.map((f) => f.file).join(', ')}`,
    );
  }

  const migrationFiles = changedFiles.filter((f) =>
    f.riskReasons.some((r) => r.includes('migration') || r.includes('schema')),
  );
  if (migrationFiles.length > 0) {
    reviewFocusAreas.push(
      `MIGRATIONS: Database schema changes detected in ${migrationFiles.map((f) => f.file).join(', ')}`,
    );
  }

  if (changedFiles.length > 0 && !changedFiles.some((f) => TEST_PATTERNS.some((p) => p.test(f.file)))) {
    reviewFocusAreas.push('TESTING: No test file changes detected — verify adequate test coverage');
  }

  return {
    base,
    compare: comp,
    summary: {
      totalCommits: commits.length,
      totalFilesChanged: changedFiles.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
      categories,
    },
    commits,
    changedFiles,
    blastRadius,
    reviewFocusAreas,
  };
}

// ---------------------------------------------------------------------------
// 2. calculateReviewRiskScore
// ---------------------------------------------------------------------------

/**
 * Score a changeset across multiple risk dimensions, producing a weighted
 * overall risk score (0-100, higher = riskier) with a letter grade and
 * actionable recommendations.
 *
 * Dimensions:
 * - **complexityScore (20%)** — Average cyclomatic complexity of changed code.
 * - **testCoverageScore (25%)** — Percentage of changed source files with corresponding test changes.
 * - **blastRadiusScore (20%)** — Number of files that import changed files.
 * - **securityScore (20%)** — Count of security-sensitive patterns touched.
 * - **churnScore (15%)** — Recent modification frequency of changed files.
 *
 * @param cwd - The working directory of the git repository.
 * @param base - The base ref to compare against.
 * @param compare - The comparison ref. Defaults to `'HEAD'`.
 * @param options - Optional configuration.
 * @param options.churnDays - Number of days to look back for churn analysis (default 30).
 * @returns A structured risk score with dimensions and recommendations.
 */
export async function calculateReviewRiskScore(
  cwd: string,
  base: string,
  compare?: string,
  options?: { churnDays?: number },
): Promise<ReviewRiskScore> {
  const comp = compare || 'HEAD';
  const churnDays = options?.churnDays ?? 30;

  // Gather diff and file information in parallel
  const [diffOut, numstatOut, nameStatusOut] = await Promise.all([
    git(['diff', `${base}...${comp}`], cwd),
    git(['diff', '--numstat', `${base}...${comp}`], cwd),
    git(['diff', '--name-status', '--diff-filter=ACDMRT', `${base}...${comp}`], cwd),
  ]);

  // Parse changed files
  const changedFileSet = new Set<string>();
  for (const line of nameStatusOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const file = parts[0].startsWith('R') ? parts[2] : parts[1];
    if (file) changedFileSet.add(file);
  }
  const changedFiles = [...changedFileSet];

  // ---- 1. Complexity Score (20%) ----
  let complexityScore = 0;
  let complexityDetails = 'No code changes detected';
  try {
    const branchPatterns = [
      /\bif\b/g,
      /\belse\s+if\b/g,
      /\bwhile\b/g,
      /\bfor\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /&&/g,
      /\|\|/g,
      /\?[^.?:]/g,
    ];

    // Analyze only added/modified lines from the diff
    const addedLines = diffOut
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'));

    let totalBranches = 0;
    for (const line of addedLines) {
      for (const p of branchPatterns) {
        const m = line.match(p);
        if (m) totalBranches += m.length;
        // Reset regex lastIndex since they are global
        p.lastIndex = 0;
      }
    }

    // Normalize: rough baseline is 1 branch per 10 new lines is moderate
    const linesAdded = addedLines.length || 1;
    const branchDensity = totalBranches / linesAdded;
    // branchDensity of 0 = 0 score, 0.2+ = 100
    complexityScore = Math.min(100, Math.round(branchDensity * 500));
    complexityDetails = `${totalBranches} branch points in ${linesAdded} added lines (density: ${branchDensity.toFixed(3)})`;
  } catch {
    complexityDetails = 'Failed to compute complexity';
  }

  // ---- 2. Test Coverage Score (25%) — higher = riskier (no tests = risky) ----
  let testCoverageScore = 0;
  let testCoverageDetails = 'No source files changed';
  {
    const sourceFiles = changedFiles.filter(
      (f) => !TEST_PATTERNS.some((p) => p.test(f)) && /\.[jt]sx?$|\.py$|\.go$|\.rs$|\.java$|\.rb$|\.php$|\.cs$/.test(f),
    );
    const testFiles = changedFiles.filter((f) => TEST_PATTERNS.some((p) => p.test(f)));

    if (sourceFiles.length > 0) {
      // Check which source files have a corresponding test file change
      let coveredCount = 0;
      for (const src of sourceFiles) {
        const srcBase = path.basename(src, path.extname(src));
        const hasTest = testFiles.some((t) => {
          const tBase = path.basename(t, path.extname(t));
          return tBase.includes(srcBase);
        });
        if (hasTest) coveredCount++;
      }

      const coverageRatio = coveredCount / sourceFiles.length;
      // Invert: 100% coverage = 0 risk, 0% coverage = 100 risk
      testCoverageScore = Math.round((1 - coverageRatio) * 100);
      testCoverageDetails = `${coveredCount}/${sourceFiles.length} source files have corresponding test changes (${Math.round(coverageRatio * 100)}% covered)`;
    }
  }

  // ---- 3. Blast Radius Score (20%) ----
  let blastRadiusScore = 0;
  let blastRadiusDetails = 'No dependents found';
  {
    let totalDependents = 0;
    const filesToCheck = changedFiles
      .filter((f) => !TEST_PATTERNS.some((p) => p.test(f)))
      .slice(0, 20);

    for (const file of filesToCheck) {
      const baseName = path.basename(file, path.extname(file));
      if (!baseName || baseName === 'index') continue;
      try {
        const results = await searchCode({
          cwd,
          pattern: baseName,
          isRegex: false,
          maxResults: 50,
        });
        const deps = results.filter(
          (r) => r.file !== file && /import|require|from/.test(r.text),
        );
        totalDependents += new Set(deps.map((d) => d.file)).size;
      } catch {
        /* skip */
      }
    }

    // Normalize: 0 dependents = 0 risk, 50+ = 100
    blastRadiusScore = Math.min(100, Math.round((totalDependents / 50) * 100));
    blastRadiusDetails = `${totalDependents} dependent files across ${filesToCheck.length} changed files`;
  }

  // ---- 4. Security Score (20%) ----
  let securityScore = 0;
  let securityDetails = 'No security-sensitive patterns detected';
  {
    const secPatterns = [
      /auth/i,
      /crypto/i,
      /secret/i,
      /password/i,
      /token/i,
      /session/i,
      /sql/i,
      /\beval\b/i,
      /exec\b/i,
      /injection/i,
      /cors/i,
      /csrf/i,
      /sanitiz/i,
      /encrypt/i,
      /decrypt/i,
      /private.?key/i,
      /api.?key/i,
    ];

    let securityHits = 0;
    // Check file paths
    for (const file of changedFiles) {
      for (const p of secPatterns) {
        if (p.test(file)) {
          securityHits++;
          break;
        }
      }
    }

    // Check diff content for security-sensitive changes
    const diffLines = diffOut.split('\n').filter(
      (l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'),
    );
    for (const line of diffLines) {
      for (const p of secPatterns) {
        if (p.test(line)) {
          securityHits++;
          break;
        }
      }
    }

    // Normalize: 0 hits = 0 risk, 20+ = 100
    securityScore = Math.min(100, Math.round((securityHits / 20) * 100));
    securityDetails = `${securityHits} security-sensitive pattern matches in files and diff`;
  }

  // ---- 5. Churn Score (15%) ----
  let churnScore = 0;
  let churnDetails = 'No churn data available';
  {
    const since = `${churnDays}.days.ago`;
    let totalChurn = 0;
    const filesToCheck = changedFiles.slice(0, 20);

    for (const file of filesToCheck) {
      try {
        const logOut = await git(
          ['log', '--oneline', `--since=${since}`, '--', file],
          cwd,
        );
        const commitCount = logOut.split('\n').filter(Boolean).length;
        totalChurn += commitCount;
      } catch {
        /* skip */
      }
    }

    const avgChurn = filesToCheck.length > 0 ? totalChurn / filesToCheck.length : 0;
    // Normalize: 0 commits = 0 risk, avg 10+ commits = 100
    churnScore = Math.min(100, Math.round((avgChurn / 10) * 100));
    churnDetails = `Average ${avgChurn.toFixed(1)} commits per file in last ${churnDays} days (${totalChurn} total across ${filesToCheck.length} files)`;
  }

  // ---- Weighted overall score ----
  const dimensions = [
    { name: 'Complexity', score: complexityScore, weight: 0.2, details: complexityDetails },
    { name: 'Test Coverage Gap', score: testCoverageScore, weight: 0.25, details: testCoverageDetails },
    { name: 'Blast Radius', score: blastRadiusScore, weight: 0.2, details: blastRadiusDetails },
    { name: 'Security Sensitivity', score: securityScore, weight: 0.2, details: securityDetails },
    { name: 'Code Churn', score: churnScore, weight: 0.15, details: churnDetails },
  ];

  const overallScore = Math.round(
    dimensions.reduce((sum, d) => sum + d.score * d.weight, 0),
  );
  const grade = gradeFromScore(overallScore);

  // ---- Recommendations ----
  const recommendations: string[] = [];

  if (testCoverageScore > 60) {
    recommendations.push('Add or update tests for changed source files to improve coverage.');
  }
  if (complexityScore > 60) {
    recommendations.push('Consider breaking complex logic into smaller, well-named functions.');
  }
  if (blastRadiusScore > 60) {
    recommendations.push('Many files depend on the changed code — ensure backward compatibility or coordinate with consumers.');
  }
  if (securityScore > 40) {
    recommendations.push('Security-sensitive code is being modified — request a security-focused review.');
  }
  if (churnScore > 60) {
    recommendations.push('Frequently modified files detected — consider refactoring for stability.');
  }
  if (changedFiles.length > 30) {
    recommendations.push('Large PR with many files — consider splitting into smaller, focused PRs.');
  }
  if (recommendations.length === 0) {
    recommendations.push('This changeset appears low-risk. Standard review procedures apply.');
  }

  return {
    overallScore,
    grade,
    dimensions,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// 3. detectBreakingChanges
// ---------------------------------------------------------------------------

/**
 * Detect breaking changes in a changeset by analyzing diffs for removed
 * exports, changed function signatures, schema modifications, route changes,
 * environment variable changes, and config key changes.
 *
 * @param cwd - The working directory of the git repository.
 * @param base - The base ref to compare against.
 * @param compare - The comparison ref. Defaults to `'HEAD'`.
 * @param options - Optional configuration.
 * @param options.maxConsumers - Maximum number of affected consumers to search for per change (default 20).
 * @returns Breaking changes, summary, and affected consumers.
 */
export async function detectBreakingChanges(
  cwd: string,
  base: string,
  compare?: string,
  options?: { maxConsumers?: number },
): Promise<BreakingChangeResult> {
  const comp = compare || 'HEAD';
  const maxConsumers = options?.maxConsumers ?? 20;
  const breakingChanges: BreakingChange[] = [];
  const affectedConsumers: BreakingChangeResult['affectedConsumers'] = [];

  // Get the full diff
  const diffOut = await git(['diff', '-U3', `${base}...${comp}`], cwd);
  if (!diffOut) {
    return { breakingChanges: [], summary: { total: 0, errors: 0, warnings: 0, byType: {} }, affectedConsumers: [] };
  }

  // Parse diff into per-file sections
  const fileDiffs = parseDiffByFile(diffOut);

  for (const { file, hunks } of fileDiffs) {
    const ext = path.extname(file);
    const isSource = /\.[jt]sx?$|\.py$|\.go$|\.rs$|\.java$|\.rb$/.test(ext);
    const isSchema = MIGRATION_PATTERNS.some((p) => p.test(file));
    const isRoute = /route|endpoint|controller|api/i.test(file);
    const isEnv = /\.env|environment/i.test(file);
    const isConfig = CONFIG_PATTERNS.some((p) => p.test(file)) && !isEnv;

    for (const hunk of hunks) {
      // ---- Removed exports ----
      if (isSource) {
        detectRemovedExports(file, hunk, breakingChanges);
        detectChangedSignatures(file, hunk, breakingChanges);
      }

      // ---- Schema changes ----
      if (isSchema) {
        detectRemovedFields(file, hunk, breakingChanges);
      }

      // ---- Route changes ----
      if (isRoute) {
        detectChangedRoutes(file, hunk, breakingChanges);
      }

      // ---- Environment variable changes ----
      if (isEnv) {
        detectChangedEnvVars(file, hunk, breakingChanges);
      }

      // ---- Config changes ----
      if (isConfig) {
        detectChangedConfigKeys(file, hunk, breakingChanges);
      }
    }
  }

  // ---- Find affected consumers ----
  const searchedSymbols = new Set<string>();
  for (const bc of breakingChanges.slice(0, 20)) {
    // Extract the symbol name from the before string
    const symbolMatch = bc.before.match(
      /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def|fn|func)\s+(\w+)/,
    );
    const symbol = symbolMatch?.[1];
    if (!symbol || searchedSymbols.has(symbol)) continue;
    searchedSymbols.add(symbol);

    try {
      const results = await searchCode({
        cwd,
        pattern: symbol,
        wholeWord: true,
        maxResults: maxConsumers,
      });
      for (const r of results) {
        if (r.file !== bc.file && /import|require|from|use/.test(r.text)) {
          affectedConsumers.push({ file: r.file, usage: r.text.trim() });
        }
      }
    } catch {
      /* skip */
    }
  }

  // Deduplicate consumers
  const uniqueConsumers = new Map<string, { file: string; usage: string }>();
  for (const c of affectedConsumers) {
    const key = `${c.file}:${c.usage}`;
    if (!uniqueConsumers.has(key)) uniqueConsumers.set(key, c);
  }

  // ---- Build summary ----
  const byType: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const bc of breakingChanges) {
    byType[bc.type] = (byType[bc.type] || 0) + 1;
    if (bc.severity === 'error') errors++;
    else warnings++;
  }

  return {
    breakingChanges,
    summary: {
      total: breakingChanges.length,
      errors,
      warnings,
      byType,
    },
    affectedConsumers: [...uniqueConsumers.values()],
  };
}

// ---------------------------------------------------------------------------
// Diff parsing helpers for detectBreakingChanges
// ---------------------------------------------------------------------------

interface DiffHunk {
  startLine: number;
  removedLines: { line: number; text: string }[];
  addedLines: { line: number; text: string }[];
}

interface FileDiff {
  file: string;
  hunks: DiffHunk[];
}

/**
 * Parse a unified diff into per-file sections with structured hunks.
 */
function parseDiffByFile(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let currentFile = '';
  let currentHunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let removedLineNum = 0;
  let addedLineNum = 0;

  for (const line of diff.split('\n')) {
    // New file header
    if (line.startsWith('+++ b/')) {
      if (currentFile && currentHunks.length > 0) {
        files.push({ file: currentFile, hunks: currentHunks });
      }
      currentFile = line.slice(6);
      currentHunks = [];
      currentHunk = null;
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('diff --git')) continue;

    // Hunk header
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      currentHunk = {
        startLine: parseInt(hunkMatch[2], 10),
        removedLines: [],
        addedLines: [],
      };
      removedLineNum = parseInt(hunkMatch[1], 10);
      addedLineNum = parseInt(hunkMatch[2], 10);
      currentHunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('-')) {
      currentHunk.removedLines.push({ line: removedLineNum, text: line.slice(1) });
      removedLineNum++;
    } else if (line.startsWith('+')) {
      currentHunk.addedLines.push({ line: addedLineNum, text: line.slice(1) });
      addedLineNum++;
    } else {
      // Context line
      removedLineNum++;
      addedLineNum++;
    }
  }

  // Push last file
  if (currentFile && currentHunks.length > 0) {
    files.push({ file: currentFile, hunks: currentHunks });
  }

  return files;
}

/**
 * Detect removed or renamed exports in a diff hunk.
 */
function detectRemovedExports(file: string, hunk: DiffHunk, results: BreakingChange[]): void {
  const exportPattern = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+(\w+)/;

  const removedExports = new Map<string, { line: number; text: string }>();
  for (const rl of hunk.removedLines) {
    const match = rl.text.match(exportPattern);
    if (match) {
      removedExports.set(match[1], rl);
    }
  }

  // Also check for `export { name }` style
  for (const rl of hunk.removedLines) {
    const namedMatch = rl.text.match(/^\s*export\s*\{([^}]+)\}/);
    if (namedMatch) {
      for (const name of namedMatch[1].split(',')) {
        const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
        if (trimmed) removedExports.set(trimmed, rl);
      }
    }
  }

  const addedExports = new Set<string>();
  for (const al of hunk.addedLines) {
    const match = al.text.match(exportPattern);
    if (match) addedExports.add(match[1]);
    const namedMatch = al.text.match(/^\s*export\s*\{([^}]+)\}/);
    if (namedMatch) {
      for (const name of namedMatch[1].split(',')) {
        const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
        if (trimmed) addedExports.add(trimmed);
      }
    }
  }

  for (const [name, rl] of removedExports) {
    if (!addedExports.has(name)) {
      results.push({
        file,
        line: rl.line,
        type: 'removed-export',
        severity: 'error',
        description: `Exported symbol "${name}" was removed`,
        before: rl.text.trim(),
      });
    }
  }
}

/**
 * Detect changed function signatures (parameter count changes).
 */
function detectChangedSignatures(file: string, hunk: DiffHunk, results: BreakingChange[]): void {
  const funcPattern = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;
  const methodPattern = /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)/;

  const removedFuncs = new Map<string, { line: number; text: string; params: string[] }>();
  for (const rl of hunk.removedLines) {
    for (const pat of [funcPattern, methodPattern]) {
      const match = rl.text.match(pat);
      if (match) {
        const params = match[2].trim()
          ? match[2].split(',').map((p) => p.trim())
          : [];
        removedFuncs.set(match[1], { line: rl.line, text: rl.text.trim(), params });
        break;
      }
    }
  }

  for (const al of hunk.addedLines) {
    for (const pat of [funcPattern, methodPattern]) {
      const match = al.text.match(pat);
      if (match) {
        const name = match[1];
        const removed = removedFuncs.get(name);
        if (removed) {
          const newParams = match[2].trim()
            ? match[2].split(',').map((p) => p.trim())
            : [];
          // Check if parameter count decreased (breaking) or types changed significantly
          if (newParams.length < removed.params.length) {
            results.push({
              file,
              line: al.line,
              type: 'changed-signature',
              severity: 'error',
              description: `Function "${name}" signature changed: parameter count reduced from ${removed.params.length} to ${newParams.length}`,
              before: removed.text,
              after: al.text.trim(),
            });
          } else if (newParams.length !== removed.params.length) {
            results.push({
              file,
              line: al.line,
              type: 'changed-signature',
              severity: 'warning',
              description: `Function "${name}" signature changed: parameter count changed from ${removed.params.length} to ${newParams.length}`,
              before: removed.text,
              after: al.text.trim(),
            });
          }
          removedFuncs.delete(name);
        }
        break;
      }
    }
  }
}

/**
 * Detect removed database columns or fields from schema files.
 */
function detectRemovedFields(file: string, hunk: DiffHunk, results: BreakingChange[]): void {
  // SQL column patterns
  const columnPattern = /^\s*(?:ALTER\s+TABLE\s+\w+\s+DROP\s+(?:COLUMN\s+)?(\w+))/i;
  const fieldPattern = /^\s*["']?(\w+)["']?\s*[:=]\s*|^\s*(\w+)\s+(?:TEXT|INTEGER|VARCHAR|BOOLEAN|INT|BIGINT|UUID|TIMESTAMP|JSONB?|FLOAT|DOUBLE|DECIMAL)/i;

  for (const rl of hunk.removedLines) {
    const dropMatch = rl.text.match(columnPattern);
    if (dropMatch) {
      results.push({
        file,
        line: rl.line,
        type: 'removed-field',
        severity: 'error',
        description: `Database column "${dropMatch[1]}" is being dropped`,
        before: rl.text.trim(),
      });
      continue;
    }

    const fieldMatch = rl.text.match(fieldPattern);
    if (fieldMatch) {
      const fieldName = fieldMatch[1] || fieldMatch[2];
      // Verify it was actually removed, not just modified
      const wasReAdded = hunk.addedLines.some((al) => {
        const m = al.text.match(fieldPattern);
        return m && (m[1] === fieldName || m[2] === fieldName);
      });
      if (!wasReAdded && fieldName) {
        results.push({
          file,
          line: rl.line,
          type: 'removed-field',
          severity: 'warning',
          description: `Field "${fieldName}" appears to have been removed from schema`,
          before: rl.text.trim(),
        });
      }
    }
  }
}

/**
 * Detect changed API routes.
 */
function detectChangedRoutes(file: string, hunk: DiffHunk, results: BreakingChange[]): void {
  const routePattern = /(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/i;
  const decoratorPattern = /@(?:Get|Post|Put|Patch|Delete|Route|RequestMapping)\s*\(\s*['"`]([^'"`]+)['"`]/i;

  const removedRoutes = new Map<string, { line: number; text: string }>();

  for (const rl of hunk.removedLines) {
    const routeMatch = rl.text.match(routePattern);
    if (routeMatch) {
      removedRoutes.set(`${routeMatch[1].toLowerCase()}:${routeMatch[2]}`, rl);
      continue;
    }
    const decMatch = rl.text.match(decoratorPattern);
    if (decMatch) {
      removedRoutes.set(decMatch[1], rl);
    }
  }

  const addedRoutes = new Set<string>();
  for (const al of hunk.addedLines) {
    const routeMatch = al.text.match(routePattern);
    if (routeMatch) {
      addedRoutes.add(`${routeMatch[1].toLowerCase()}:${routeMatch[2]}`);
      continue;
    }
    const decMatch = al.text.match(decoratorPattern);
    if (decMatch) {
      addedRoutes.add(decMatch[1]);
    }
  }

  for (const [route, rl] of removedRoutes) {
    if (!addedRoutes.has(route)) {
      results.push({
        file,
        line: rl.line,
        type: 'changed-route',
        severity: 'error',
        description: `API route "${route}" was removed or changed`,
        before: rl.text.trim(),
      });
    }
  }
}

/**
 * Detect changed environment variable names.
 */
function detectChangedEnvVars(file: string, hunk: DiffHunk, results: BreakingChange[]): void {
  const envPattern = /^([A-Z][A-Z0-9_]{2,})\s*=/;

  const removedVars = new Map<string, { line: number; text: string }>();
  for (const rl of hunk.removedLines) {
    const match = rl.text.match(envPattern);
    if (match) {
      removedVars.set(match[1], rl);
    }
  }

  const addedVars = new Set<string>();
  for (const al of hunk.addedLines) {
    const match = al.text.match(envPattern);
    if (match) addedVars.add(match[1]);
  }

  for (const [varName, rl] of removedVars) {
    if (!addedVars.has(varName)) {
      results.push({
        file,
        line: rl.line,
        type: 'changed-env',
        severity: 'error',
        description: `Environment variable "${varName}" was removed`,
        before: rl.text.trim(),
      });
    }
  }
}

/**
 * Detect changed config keys in configuration files.
 */
function detectChangedConfigKeys(file: string, hunk: DiffHunk, results: BreakingChange[]): void {
  // JSON/YAML key patterns
  const jsonKeyPattern = /^\s*["'](\w[\w.-]*)["']\s*:/;
  const yamlKeyPattern = /^(\w[\w.-]*):\s/;

  const removedKeys = new Map<string, { line: number; text: string }>();
  for (const rl of hunk.removedLines) {
    const jsonMatch = rl.text.match(jsonKeyPattern);
    const yamlMatch = rl.text.match(yamlKeyPattern);
    const match = jsonMatch || yamlMatch;
    if (match) {
      removedKeys.set(match[1], rl);
    }
  }

  const addedKeys = new Set<string>();
  for (const al of hunk.addedLines) {
    const jsonMatch = al.text.match(jsonKeyPattern);
    const yamlMatch = al.text.match(yamlKeyPattern);
    const match = jsonMatch || yamlMatch;
    if (match) addedKeys.add(match[1]);
  }

  for (const [key, rl] of removedKeys) {
    if (!addedKeys.has(key)) {
      results.push({
        file,
        line: rl.line,
        type: 'changed-config',
        severity: 'warning',
        description: `Config key "${key}" was removed`,
        before: rl.text.trim(),
      });
    }
  }
}
