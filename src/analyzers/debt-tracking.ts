/**
 * Tech Debt Tracking & Change Pattern Analysis
 * Tracks technical debt burndown over git history, generates code age
 * heatmaps overlaying file age with complexity and ownership, and
 * identifies recurring change patterns such as logical coupling and churn.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectLanguage } from '../utils/languages.js';

const execFileAsync = promisify(execFile);

// ── Shared constants ────────────────────────────────────────────────────

const EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 15000 };
const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs,swift,kt,scala,c,cpp,h,hpp}';

const SENSITIVE_PATTERNS = [
  /TODO\b/i,
  /FIXME\b/i,
  /HACK\b/i,
  /XXX\b/i,
  /WORKAROUND\b/i,
];

// ── Git helper ──────────────────────────────────────────────────────────

/**
 * Execute a git command and return trimmed stdout.
 * Throws a descriptive error when the working directory is not a git repository.
 * @param args - Arguments to pass to git.
 * @param cwd - The working directory.
 * @returns The trimmed stdout string.
 */
async function gitExec(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { ...EXEC_OPTS, cwd });
    return stdout;
  } catch (error: unknown) {
    const err = error as Record<string, unknown>;
    if (err.stdout && typeof err.stdout === 'string') return err.stdout;
    if (err.stderr && String(err.stderr).includes('not a git repository')) {
      throw new Error('Not a git repository');
    }
    throw error;
  }
}

// ── 1. Tech Debt Burndown ───────────────────────────────────────────────

export interface DebtSnapshot {
  date: string;
  ref: string;
  metrics: {
    todos: number;
    longFunctions: number;
    largeFiles: number;
    anyTypes: number;
    eslintDisables: number;
    debugLogs: number;
    emptyBlocks: number;
  };
  totalDebt: number;
}

export interface DebtBurndownResult {
  snapshots: DebtSnapshot[];
  trend: 'increasing' | 'stable' | 'decreasing';
  trendPercent: number;
  currentDebt: number;
  worstModules: { path: string; debtScore: number; trend: string }[];
  summary: { timespan: string; snapshots: number; startDebt: number; endDebt: number; change: number };
  recommendations: string[];
}

/**
 * Count occurrences of a regex across all provided file contents.
 */
function countPattern(contents: Map<string, string>, pattern: RegExp): number {
  let count = 0;
  for (const content of contents.values()) {
    const matches = content.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Count functions longer than the given threshold in lines.
 */
function countLongFunctions(contents: Map<string, string>, threshold: number): number {
  let count = 0;
  for (const content of contents.values()) {
    const lines = content.split('\n');
    let braces = 0;
    let funcStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^(?:export\s+)?(?:async\s+)?(?:function|def|func|fn|pub\s+fn|public\s+\w+)\b/.test(trimmed)) {
        funcStart = i;
      }
      for (const ch of lines[i]) {
        if (ch === '{') braces++;
        if (ch === '}') {
          braces--;
          if (braces <= 0 && funcStart >= 0) {
            if (i - funcStart > threshold) count++;
            funcStart = -1;
            braces = 0;
          }
        }
      }
    }
  }
  return count;
}

/**
 * Count files exceeding a line threshold.
 */
function countLargeFiles(contents: Map<string, string>, threshold: number): number {
  let count = 0;
  for (const content of contents.values()) {
    if (content.split('\n').length > threshold) count++;
  }
  return count;
}

/**
 * Count empty catch/if/else blocks (code smell).
 */
function countEmptyBlocks(contents: Map<string, string>): number {
  let count = 0;
  const pattern = /(?:catch|if|else)\s*(?:\([^)]*\))?\s*\{\s*\}/g;
  for (const content of contents.values()) {
    const matches = content.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Build a DebtSnapshot from the provided file contents at a given ref and date.
 */
function buildSnapshot(contents: Map<string, string>, ref: string, date: string): DebtSnapshot {
  const metrics = {
    todos: countPattern(contents, /\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/gi),
    longFunctions: countLongFunctions(contents, 50),
    largeFiles: countLargeFiles(contents, 500),
    anyTypes: countPattern(contents, /:\s*any\b/g),
    eslintDisables: countPattern(contents, /eslint-disable/g),
    debugLogs: countPattern(contents, /console\.(log|debug|warn|info)\b/g),
    emptyBlocks: countEmptyBlocks(contents),
  };
  const totalDebt =
    metrics.todos * 1 +
    metrics.longFunctions * 3 +
    metrics.largeFiles * 2 +
    metrics.anyTypes * 2 +
    metrics.eslintDisables * 1 +
    metrics.debugLogs * 1 +
    metrics.emptyBlocks * 2;

  return { date, ref, metrics, totalDebt };
}

/**
 * Compute per-module (top-level directory) debt scores from file contents.
 */
function computeModuleScores(
  contents: Map<string, string>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [file, content] of contents.entries()) {
    const module = file.split('/')[0] || file;
    const lines = content.split('\n');
    let debt = 0;
    debt += (content.match(/\b(TODO|FIXME|HACK|XXX)\b/gi) || []).length;
    debt += (content.match(/:\s*any\b/g) || []).length * 2;
    debt += (content.match(/eslint-disable/g) || []).length;
    debt += (content.match(/console\.(log|debug)\b/g) || []).length;
    if (lines.length > 500) debt += 2;
    scores.set(module, (scores.get(module) || 0) + debt);
  }
  return scores;
}

/**
 * Estimate historical debt from git log activity and diff stats.
 * Rather than checking out old commits, we sample monthly refs from `git log`
 * and use diff stats against HEAD to extrapolate debt trajectory.
 */
async function estimateHistoricalSnapshots(
  cwd: string,
  currentDebt: number,
  months: number,
): Promise<DebtSnapshot[]> {
  const snapshots: DebtSnapshot[] = [];

  // Get monthly commit refs by sampling the first commit of each month
  for (let m = months; m >= 1; m--) {
    try {
      const sinceDate = `${m} months ago`;
      const untilDate = `${m - 1} months ago`;

      // Get a representative commit from this month
      const refOutput = await gitExec(
        ['log', '--format=%H|%aI', `--since=${sinceDate}`, `--until=${untilDate}`, '--reverse', '-1'],
        cwd,
      );
      const refLine = refOutput.trim();
      if (!refLine) continue;

      const [ref, date] = refLine.split('|');
      if (!ref || !date) continue;

      // Use diff --stat to estimate how much code changed since that ref
      const diffOutput = await gitExec(['diff', '--stat', '--numstat', ref, 'HEAD'], cwd);
      const numstatLines = diffOutput
        .split('\n')
        .filter((l) => /^\d+\t\d+\t/.test(l));

      let addedLines = 0;
      let removedLines = 0;
      for (const line of numstatLines) {
        const parts = line.split('\t');
        addedLines += parseInt(parts[0], 10) || 0;
        removedLines += parseInt(parts[1], 10) || 0;
      }

      // Count debt-related commits in this period
      let debtCommits = 0;
      try {
        const debtLog = await gitExec(
          [
            'log',
            '--oneline',
            `--since=${sinceDate}`,
            `--until=${untilDate}`,
            '--grep=TODO\\|FIXME\\|HACK\\|debt\\|cleanup\\|refactor',
            '--regexp-ignore-case',
          ],
          cwd,
        );
        debtCommits = debtLog.split('\n').filter(Boolean).length;
      } catch {
        /* ignore */
      }

      // Estimate debt at this point: scale current debt by the inverse of code change ratio
      // More code added = likely more debt was added; removals = potential debt reduction
      const netChange = addedLines - removedLines;
      const changeRatio = netChange > 0 ? Math.min(netChange / 5000, 0.5) : Math.max(netChange / 5000, -0.3);
      const estimatedDebt = Math.max(0, Math.round(currentDebt * (1 - changeRatio) - debtCommits * 2));

      snapshots.push({
        date: date.split('T')[0],
        ref: ref.slice(0, 8),
        metrics: {
          todos: 0,
          longFunctions: 0,
          largeFiles: 0,
          anyTypes: 0,
          eslintDisables: 0,
          debugLogs: 0,
          emptyBlocks: 0,
        },
        totalDebt: estimatedDebt,
      });
    } catch {
      /* skip months with no data */
    }
  }

  return snapshots;
}

/**
 * Track tech debt metrics over git history.
 *
 * Performs a full scan of the current codebase to build an accurate debt snapshot
 * at HEAD, then samples git history at monthly intervals for the past 12 months
 * (or a custom range) to estimate debt trajectory. Uses `git log` and `git diff`
 * stats rather than checking out old commits for efficiency.
 *
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.directory - Subdirectory to focus analysis on.
 * @param options.months - Number of months of history to analyze (default 12).
 * @param options.fileGlob - Glob pattern for files to include.
 * @returns The debt burndown result with snapshots, trend, and recommendations.
 */
export async function trackTechDebtBurndown(
  cwd: string,
  options?: { directory?: string; months?: number; fileGlob?: string },
): Promise<DebtBurndownResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const months = options?.months ?? 12;
  const glob = options?.fileGlob || SOURCE_GLOB;

  // 1. Full scan at HEAD
  const files = await listFiles(dir, { glob });
  const contents = new Map<string, string>();
  for (const file of files.slice(0, 500)) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');
      contents.set(file, content);
    } catch {
      /* skip unreadable files */
    }
  }

  const headSnapshot = buildSnapshot(contents, 'HEAD', new Date().toISOString().split('T')[0]);

  // 2. Estimate historical snapshots using git log/diff
  const historicalSnapshots = await estimateHistoricalSnapshots(dir, headSnapshot.totalDebt, months);

  // 3. Combine and sort snapshots chronologically
  const allSnapshots = [...historicalSnapshots, headSnapshot].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  // 4. Calculate trend
  const startDebt = allSnapshots[0]?.totalDebt ?? 0;
  const endDebt = headSnapshot.totalDebt;
  const change = endDebt - startDebt;
  const trendPercent = startDebt > 0 ? Math.round((change / startDebt) * 100) : 0;
  const trend: DebtBurndownResult['trend'] =
    trendPercent > 10 ? 'increasing' : trendPercent < -10 ? 'decreasing' : 'stable';

  // 5. Find worst modules
  const moduleScores = computeModuleScores(contents);
  const worstModules = Array.from(moduleScores.entries())
    .map(([modulePath, debtScore]) => ({
      path: modulePath,
      debtScore,
      trend: debtScore > 10 ? 'high' : debtScore > 5 ? 'moderate' : 'low',
    }))
    .sort((a, b) => b.debtScore - a.debtScore)
    .slice(0, 10);

  // 6. Generate recommendations
  const recommendations: string[] = [];
  const { metrics } = headSnapshot;
  if (metrics.todos > 20) {
    recommendations.push(`Address ${metrics.todos} TODO/FIXME comments - consider creating tickets for each.`);
  }
  if (metrics.longFunctions > 5) {
    recommendations.push(
      `Refactor ${metrics.longFunctions} functions exceeding 50 lines to improve readability.`,
    );
  }
  if (metrics.anyTypes > 10) {
    recommendations.push(
      `Replace ${metrics.anyTypes} usages of 'any' type with proper type definitions.`,
    );
  }
  if (metrics.eslintDisables > 5) {
    recommendations.push(
      `Review ${metrics.eslintDisables} eslint-disable comments and fix underlying issues.`,
    );
  }
  if (metrics.largeFiles > 3) {
    recommendations.push(
      `Break up ${metrics.largeFiles} files exceeding 500 lines into smaller modules.`,
    );
  }
  if (metrics.debugLogs > 10) {
    recommendations.push(
      `Remove or replace ${metrics.debugLogs} console.log/debug statements with proper logging.`,
    );
  }
  if (metrics.emptyBlocks > 3) {
    recommendations.push(
      `Fill or remove ${metrics.emptyBlocks} empty catch/if/else blocks that silently swallow errors.`,
    );
  }
  if (trend === 'increasing') {
    recommendations.push('Tech debt is trending upward - consider dedicating a sprint to debt reduction.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Codebase technical debt levels are healthy. Continue regular maintenance.');
  }

  const startDate = allSnapshots[0]?.date ?? 'unknown';
  const endDate = allSnapshots[allSnapshots.length - 1]?.date ?? 'unknown';

  return {
    snapshots: allSnapshots,
    trend,
    trendPercent,
    currentDebt: endDebt,
    worstModules,
    summary: {
      timespan: `${startDate} to ${endDate}`,
      snapshots: allSnapshots.length,
      startDebt,
      endDebt,
      change,
    },
    recommendations,
  };
}

// ── 2. Code Age Heatmap ─────────────────────────────────────────────────

export interface FileAge {
  file: string;
  lastModified: string;
  ageMonths: number;
  lastAuthor: string;
  totalAuthors: number;
  complexity: number;
  lines: number;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface CodeAgeHeatmapResult {
  files: FileAge[];
  hotspots: FileAge[];
  summary: { totalFiles: number; avgAge: number; oldestFile: string; riskiest: string; criticalCount: number };
  ageDistribution: { range: string; count: number }[];
  recommendations: string[];
}

/**
 * Count branching constructs in source code as a rough complexity metric.
 */
function countBranches(content: string): number {
  const patterns = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\bwhile\b/g,
    /\bfor\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /&&/g,
    /\|\|/g,
    /\?[^.?:]/g,
    /\bswitch\b/g,
    /\belif\b/g,
    /\bmatch\b/g,
  ];
  let count = 0;
  for (const p of patterns) {
    const m = content.match(p);
    if (m) count += m.length;
  }
  return count;
}

/**
 * Determine risk level from a numeric risk score.
 */
function riskLevel(score: number): FileAge['riskLevel'] {
  if (score >= 80) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/**
 * Generate a code age heatmap overlaying file age with complexity and ownership.
 *
 * For each source file, retrieves the last modification date and author list from
 * git history, computes a rough complexity score (branch count), and calculates a
 * risk score: files that are old, complex, and have few active owners are highest risk.
 * Results are limited to 200 files for performance.
 *
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.directory - Subdirectory to focus analysis on.
 * @param options.fileGlob - Glob pattern for files to include.
 * @param options.maxFiles - Maximum number of files to analyze (default 200).
 * @returns The heatmap result with file ages, hotspots, and recommendations.
 */
export async function generateCodeAgeHeatmap(
  cwd: string,
  options?: { directory?: string; fileGlob?: string; maxFiles?: number },
): Promise<CodeAgeHeatmapResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const glob = options?.fileGlob || SOURCE_GLOB;
  const maxFiles = options?.maxFiles ?? 200;
  const now = Date.now();

  const allFiles = await listFiles(dir, { glob });

  // Prioritize files by directory depth (shallower = more important) then take up to maxFiles
  const sortedFiles = allFiles
    .slice(0, 1000)
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, maxFiles);

  const fileAges: FileAge[] = [];

  // Process files in batches to avoid overwhelming git
  const BATCH_SIZE = 20;
  for (let i = 0; i < sortedFiles.length; i += BATCH_SIZE) {
    const batch = sortedFiles.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (file) => {
      try {
        const absPath = path.resolve(dir, file);
        const content = await readFile(absPath, 'utf-8');
        const lineCount = content.split('\n').length;

        // Get last modification date
        let lastModified = new Date().toISOString();
        let lastAuthor = 'unknown';
        try {
          const dateOutput = await gitExec(
            ['log', '-1', '--format=%aI|%aN', '--', file],
            dir,
          );
          const parts = dateOutput.trim().split('|');
          if (parts[0]) lastModified = parts[0];
          if (parts[1]) lastAuthor = parts[1];
        } catch {
          /* use defaults */
        }

        // Get total distinct authors
        let totalAuthors = 1;
        try {
          const authorsOutput = await gitExec(
            ['log', '--format=%aN', '--', file],
            dir,
          );
          const authorSet = new Set(authorsOutput.split('\n').filter(Boolean));
          totalAuthors = Math.max(1, authorSet.size);
        } catch {
          /* use default */
        }

        const ageMs = now - new Date(lastModified).getTime();
        const ageMonths = Math.max(0, Math.round(ageMs / (1000 * 60 * 60 * 24 * 30.44)));
        const complexity = countBranches(content);

        // Risk = age * complexity * (1 / owners), normalized to 0-100
        const rawRisk = (ageMonths / 12) * (complexity / 50) * (1 / totalAuthors) * 100;
        const riskScore = Math.min(100, Math.round(rawRisk));

        return {
          file,
          lastModified: lastModified.split('T')[0],
          ageMonths,
          lastAuthor,
          totalAuthors,
          complexity,
          lines: lineCount,
          riskScore,
          riskLevel: riskLevel(riskScore),
        } as FileAge;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) fileAges.push(r);
    }
  }

  fileAges.sort((a, b) => b.riskScore - a.riskScore);

  const hotspots = fileAges.filter((f) => f.riskLevel === 'critical' || f.riskLevel === 'high');

  // Compute summary
  const ages = fileAges.map((f) => f.ageMonths);
  const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
  const oldestFile = fileAges.reduce((oldest, f) => (f.ageMonths > (oldest?.ageMonths ?? 0) ? f : oldest), fileAges[0]);
  const riskiest = fileAges[0];
  const criticalCount = fileAges.filter((f) => f.riskLevel === 'critical').length;

  // Compute age distribution
  const buckets = [
    { range: '< 1 month', count: 0 },
    { range: '1-3 months', count: 0 },
    { range: '3-6 months', count: 0 },
    { range: '6-12 months', count: 0 },
    { range: '1-2 years', count: 0 },
    { range: '> 2 years', count: 0 },
  ];
  for (const f of fileAges) {
    if (f.ageMonths < 1) buckets[0].count++;
    else if (f.ageMonths <= 3) buckets[1].count++;
    else if (f.ageMonths <= 6) buckets[2].count++;
    else if (f.ageMonths <= 12) buckets[3].count++;
    else if (f.ageMonths <= 24) buckets[4].count++;
    else buckets[5].count++;
  }

  // Generate recommendations
  const recommendations: string[] = [];
  if (criticalCount > 0) {
    recommendations.push(
      `${criticalCount} files are at critical risk - old, complex, and with few owners. Prioritize review.`,
    );
  }
  if (hotspots.length > 5) {
    recommendations.push(
      `${hotspots.length} high-risk hotspots detected. Consider assigning code owners to critical files.`,
    );
  }
  const singleOwnerCritical = fileAges.filter((f) => f.totalAuthors === 1 && f.riskLevel !== 'low');
  if (singleOwnerCritical.length > 0) {
    recommendations.push(
      `${singleOwnerCritical.length} non-trivial files have a single author - bus factor risk.`,
    );
  }
  const staleFiles = fileAges.filter((f) => f.ageMonths > 24);
  if (staleFiles.length > 0) {
    recommendations.push(
      `${staleFiles.length} files haven't been modified in over 2 years. Review for relevance.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Code age distribution looks healthy across the codebase.');
  }

  return {
    files: fileAges,
    hotspots: hotspots.slice(0, 20),
    summary: {
      totalFiles: fileAges.length,
      avgAge,
      oldestFile: oldestFile?.file ?? 'N/A',
      riskiest: riskiest?.file ?? 'N/A',
      criticalCount,
    },
    ageDistribution: buckets,
    recommendations,
  };
}

// ── 3. Change Pattern Analysis ──────────────────────────────────────────

export interface ChangePattern {
  type: 'logical-coupling' | 'churn-hotspot' | 'revert-pattern' | 'fix-after-change';
  files: string[];
  frequency: number;
  description: string;
  significance: 'low' | 'medium' | 'high';
}

export interface ChangePatternResult {
  patterns: ChangePattern[];
  churnHotspots: { file: string; changes: number; authors: number; lastChanged: string }[];
  logicalCouplings: { files: [string, string]; coChangeCount: number; confidence: number }[];
  summary: { totalPatterns: number; hotspots: number; couplings: number };
  recommendations: string[];
}

/**
 * Parse git log --name-only output into commit entries with associated file lists.
 */
function parseNameOnlyLog(output: string): { hash: string; message: string; date: string; files: string[] }[] {
  const entries: { hash: string; message: string; date: string; files: string[] }[] = [];
  const blocks = output.split('\n\n');

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;

    const headerMatch = lines[0].match(/^([a-f0-9]+)\|(.+)\|(.+)$/);
    if (!headerMatch) continue;

    const files = lines
      .slice(1)
      .filter((f) => f.trim() && !f.startsWith('|') && !/^[a-f0-9]+\|/.test(f));

    entries.push({
      hash: headerMatch[1],
      message: headerMatch[2],
      date: headerMatch[3],
      files,
    });
  }

  return entries;
}

/**
 * Detect logical coupling: pairs of files that frequently change together.
 */
function detectLogicalCouplings(
  commits: { files: string[] }[],
  minCoChanges: number,
): ChangePatternResult['logicalCouplings'] {
  const pairCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();

  for (const commit of commits) {
    const sourceFiles = commit.files.filter(
      (f) =>
        !/(node_modules|dist|build|\.lock|\.map|\.min\.)/.test(f) &&
        /\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|cs|c|cpp|h|hpp|swift|kt|scala)$/.test(f),
    );

    for (const file of sourceFiles) {
      fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
    }

    // Generate pairs (limit per commit to avoid combinatorial explosion)
    const limited = sourceFiles.slice(0, 15);
    for (let i = 0; i < limited.length; i++) {
      for (let j = i + 1; j < limited.length; j++) {
        const key = [limited[i], limited[j]].sort().join('||');
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  const couplings: ChangePatternResult['logicalCouplings'] = [];
  for (const [key, count] of pairCounts.entries()) {
    if (count >= minCoChanges) {
      const [fileA, fileB] = key.split('||');
      const maxSingle = Math.max(fileCounts.get(fileA) || 1, fileCounts.get(fileB) || 1);
      const confidence = Math.round((count / maxSingle) * 100) / 100;

      if (confidence >= 0.3) {
        couplings.push({
          files: [fileA, fileB] as [string, string],
          coChangeCount: count,
          confidence,
        });
      }
    }
  }

  return couplings.sort((a, b) => b.coChangeCount - a.coChangeCount).slice(0, 20);
}

/**
 * Detect churn hotspots: files changed most frequently in a recent window.
 */
function detectChurnHotspots(
  commits: { date: string; files: string[] }[],
): ChangePatternResult['churnHotspots'] {
  const fileMeta = new Map<string, { changes: number; authors: Set<string>; lastChanged: string }>();

  for (const commit of commits) {
    for (const file of commit.files) {
      if (/(node_modules|dist|build|\.lock|\.map|\.min\.)/.test(file)) continue;
      if (!/\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|cs|c|cpp|h|hpp|swift|kt|scala)$/.test(file)) continue;

      if (!fileMeta.has(file)) {
        fileMeta.set(file, { changes: 0, authors: new Set(), lastChanged: commit.date });
      }
      const meta = fileMeta.get(file)!;
      meta.changes++;
      if (commit.date > meta.lastChanged) meta.lastChanged = commit.date;
    }
  }

  return Array.from(fileMeta.entries())
    .map(([file, meta]) => ({
      file,
      changes: meta.changes,
      authors: meta.authors.size || 1,
      lastChanged: meta.lastChanged.split('T')[0],
    }))
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 20);
}

/**
 * Detect revert patterns: commits whose messages indicate reverts.
 */
function detectRevertPatterns(
  commits: { hash: string; message: string; files: string[] }[],
): ChangePattern[] {
  const patterns: ChangePattern[] = [];
  const revertPattern = /\b(revert|rollback|undo)\b/i;

  for (const commit of commits) {
    if (revertPattern.test(commit.message) && commit.files.length > 0) {
      patterns.push({
        type: 'revert-pattern',
        files: commit.files.slice(0, 5),
        frequency: 1,
        description: `Revert detected: "${commit.message.slice(0, 80)}"`,
        significance: commit.files.length > 3 ? 'high' : 'medium',
      });
    }
  }

  return patterns;
}

/**
 * Detect fix-after-change patterns: commits where a fix quickly follows a change
 * to the same files (within 3 commits).
 */
function detectFixAfterChange(
  commits: { hash: string; message: string; files: string[] }[],
): ChangePattern[] {
  const patterns: ChangePattern[] = [];
  const fixPattern = /\b(fix|bugfix|hotfix|patch|repair)\b/i;
  const fileFixCounts = new Map<string, number>();

  for (let i = 0; i < commits.length; i++) {
    if (!fixPattern.test(commits[i].message)) continue;

    // Look back up to 3 commits for the original change
    for (let j = i + 1; j < Math.min(i + 4, commits.length); j++) {
      if (fixPattern.test(commits[j].message)) continue;

      const commonFiles = commits[i].files.filter((f) => commits[j].files.includes(f));
      if (commonFiles.length > 0) {
        for (const file of commonFiles) {
          fileFixCounts.set(file, (fileFixCounts.get(file) || 0) + 1);
        }
      }
    }
  }

  // Report files that frequently get fixed after changes
  const frequentFixes = Array.from(fileFixCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a);

  for (const [file, count] of frequentFixes.slice(0, 10)) {
    patterns.push({
      type: 'fix-after-change',
      files: [file],
      frequency: count,
      description: `"${file}" had ${count} fix commits shortly after changes - may be fragile.`,
      significance: count >= 5 ? 'high' : count >= 3 ? 'medium' : 'low',
    });
  }

  return patterns;
}

/**
 * Analyze recurring change patterns in the repository's git history.
 *
 * Identifies four types of patterns:
 * - **Logical coupling**: File pairs that frequently change together in the same commits.
 * - **Churn hotspots**: Files changed most frequently in the last 90 days (or custom window).
 * - **Revert patterns**: Commits that revert or roll back previous changes.
 * - **Fix-after-change**: Files where changes are often followed by bug-fix commits.
 *
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.days - Number of days of history to analyze (default 90).
 * @param options.maxCommits - Maximum number of commits to process (default 500).
 * @param options.minCoChanges - Minimum co-change count for logical coupling (default 3).
 * @returns The change pattern analysis result with patterns, hotspots, couplings, and recommendations.
 */
export async function analyzeChangePatterns(
  cwd: string,
  options?: { days?: number; maxCommits?: number; minCoChanges?: number },
): Promise<ChangePatternResult> {
  const days = options?.days ?? 90;
  const maxCommits = options?.maxCommits ?? 500;
  const minCoChanges = options?.minCoChanges ?? 3;

  // Get commit log with file names
  const logOutput = await gitExec(
    [
      'log',
      `--max-count=${maxCommits}`,
      `--since=${days} days ago`,
      '--format=%H|%s|%aI',
      '--name-only',
    ],
    cwd,
  );

  const commits = parseNameOnlyLog(logOutput);

  // Detect all pattern types
  const logicalCouplings = detectLogicalCouplings(commits, minCoChanges);
  const churnHotspots = detectChurnHotspots(commits);
  const revertPatterns = detectRevertPatterns(commits);
  const fixAfterChange = detectFixAfterChange(commits);

  // Build coupling ChangePattern entries
  const couplingPatterns: ChangePattern[] = logicalCouplings.slice(0, 10).map((c) => ({
    type: 'logical-coupling' as const,
    files: [...c.files],
    frequency: c.coChangeCount,
    description: `${c.files[0]} and ${c.files[1]} changed together ${c.coChangeCount} times (confidence: ${c.confidence}).`,
    significance: c.coChangeCount >= 10 ? 'high' : c.coChangeCount >= 5 ? 'medium' : 'low',
  }));

  // Build churn ChangePattern entries
  const churnPatterns: ChangePattern[] = churnHotspots.slice(0, 10).map((h) => ({
    type: 'churn-hotspot' as const,
    files: [h.file],
    frequency: h.changes,
    description: `${h.file} changed ${h.changes} times in the last ${days} days.`,
    significance: h.changes >= 20 ? 'high' : h.changes >= 10 ? 'medium' : 'low',
  }));

  const allPatterns = [...couplingPatterns, ...churnPatterns, ...revertPatterns, ...fixAfterChange];
  allPatterns.sort((a, b) => {
    const sigOrder = { high: 0, medium: 1, low: 2 };
    return sigOrder[a.significance] - sigOrder[b.significance] || b.frequency - a.frequency;
  });

  // Generate recommendations
  const recommendations: string[] = [];
  const highChurn = churnHotspots.filter((h) => h.changes >= 15);
  if (highChurn.length > 0) {
    recommendations.push(
      `${highChurn.length} files have very high churn (15+ changes). Consider stabilizing their interfaces.`,
    );
  }
  const strongCouplings = logicalCouplings.filter((c) => c.confidence >= 0.7);
  if (strongCouplings.length > 0) {
    recommendations.push(
      `${strongCouplings.length} file pairs are strongly coupled (>70% confidence). Consider merging or abstracting shared logic.`,
    );
  }
  if (revertPatterns.length > 2) {
    recommendations.push(
      `${revertPatterns.length} revert commits detected. Improve testing and review before merging.`,
    );
  }
  if (fixAfterChange.length > 0) {
    recommendations.push(
      `${fixAfterChange.length} files frequently need fixes after changes. Add targeted tests to reduce regression.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Change patterns look healthy. No significant coupling or churn issues found.');
  }

  return {
    patterns: allPatterns,
    churnHotspots,
    logicalCouplings,
    summary: {
      totalPatterns: allPatterns.length,
      hotspots: churnHotspots.filter((h) => h.changes >= 10).length,
      couplings: logicalCouplings.length,
    },
    recommendations,
  };
}
