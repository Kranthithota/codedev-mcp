/**
 * Performance & Runtime Pattern Analyzers
 * Detects N+1 queries, async anti-patterns, bundle composition issues,
 * and memory leak patterns through static analysis.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectLanguage } from '../utils/languages.js';

// ── N+1 Query Detection ─────────────────────────────────────────────────

export interface NPlusOnePattern {
  file: string;
  line: number;
  ormMethod: string;
  loopType: string;
  context: string;
  suggestion: string;
  severity: 'warning' | 'error';
}

export interface NPlusOneResult {
  patterns: NPlusOnePattern[];
  summary: { total: number; byOrm: Record<string, number> };
  recommendations: string[];
}

/** ORM methods that indicate single-record queries prone to N+1 issues. */
const ORM_QUERY_PATTERNS: {
  orm: string;
  pattern: RegExp;
  suggestion: string;
}[] = [
  // Prisma
  { orm: 'prisma', pattern: /\.findUnique\s*\(/, suggestion: 'Use findMany() with an IN clause or include relations for eager loading' },
  { orm: 'prisma', pattern: /\.findFirst\s*\(/, suggestion: 'Use findMany() with a where clause to batch queries' },
  // TypeORM
  { orm: 'typeorm', pattern: /getRepository\s*\([^)]*\)\s*\.find(?:One|ByIds?)?\s*\(/, suggestion: 'Use QueryBuilder with joins or load relations eagerly via find({ relations: [...] })' },
  { orm: 'typeorm', pattern: /\.findOne\s*\(/, suggestion: 'Batch into a single find() with where: In([...ids])' },
  // Sequelize
  { orm: 'sequelize', pattern: /\.findOne\s*\(/, suggestion: 'Use findAll() with where: { id: ids } for batch loading' },
  { orm: 'sequelize', pattern: /\.findByPk\s*\(/, suggestion: 'Use findAll() with where: { id: ids } for batch loading' },
  // Django
  { orm: 'django', pattern: /objects\.get\s*\(/, suggestion: 'Use objects.filter(id__in=ids) or select_related()/prefetch_related()' },
  { orm: 'django', pattern: /objects\.filter\s*\([^)]*\)\s*\.first\s*\(/, suggestion: 'Use objects.filter() with prefetch_related() outside the loop' },
  // ActiveRecord (Ruby on Rails)
  { orm: 'activerecord', pattern: /\.find\s*\(\s*\w/, suggestion: 'Use .where(id: ids) or .includes() for eager loading' },
  { orm: 'activerecord', pattern: /\.find_by\s*\(/, suggestion: 'Use .where() with batch conditions or .includes() for eager loading' },
  // Raw SQL in loops
  { orm: 'raw-sql', pattern: /(?:query|execute|exec|raw)\s*\(\s*[`'"](?:SELECT|INSERT|UPDATE|DELETE)/i, suggestion: 'Batch raw SQL queries using IN clauses or JOINs instead of per-item queries' },
];

/** Patterns that indicate a loop context. */
const LOOP_PATTERNS: { type: string; pattern: RegExp }[] = [
  { type: 'for', pattern: /^\s*for\s*\(/ },
  { type: 'for...of', pattern: /^\s*for\s*\(\s*(?:const|let|var)\s+\w+\s+of\b/ },
  { type: 'for...in', pattern: /^\s*for\s*\(\s*(?:const|let|var)\s+\w+\s+in\b/ },
  { type: 'while', pattern: /^\s*while\s*\(/ },
  { type: 'forEach', pattern: /\.forEach\s*\(/ },
  { type: 'map', pattern: /\.map\s*\(/ },
  { type: 'flatMap', pattern: /\.flatMap\s*\(/ },
  { type: 'for (python)', pattern: /^\s*for\s+\w+\s+in\s+/ },
  { type: 'each (ruby)', pattern: /\.each\s+do\b/ },
];

/**
 * Detect N+1 query patterns in ORM usage across the codebase.
 * Scans source files for ORM single-record query methods that appear inside
 * loop constructs, which typically indicate N+1 performance problems.
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @param options.fileGlob - Custom glob pattern for files to scan.
 * @returns N+1 query detection results with patterns and recommendations.
 */
export async function detectNPlusOneQueries(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<NPlusOneResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const glob = options?.fileGlob || '*.{ts,tsx,js,jsx,py,rb,java,go,rs,php,cs}';
  const files = await listFiles(dir, { glob, type: 'file' });
  const sourceFiles = files.slice(0, 300);

  const patterns: NPlusOnePattern[] = [];
  const byOrm: Record<string, number> = {};

  for (const file of sourceFiles) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');

      // Track loop context: store indices of lines that are inside loops
      const loopStack: { type: string; startLine: number; depth: number }[] = [];
      let braceDepth = 0;
      let indentBasedLoop: { type: string; startLine: number; indent: number } | null = null;
      const lang = detectLanguage(file);
      const isPython = lang === 'python';
      const isRuby = lang === 'ruby';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

        // Detect loop starts
        for (const lp of LOOP_PATTERNS) {
          if (lp.pattern.test(line)) {
            if (isPython || isRuby) {
              const indent = line.length - line.trimStart().length;
              indentBasedLoop = { type: lp.type, startLine: i, indent };
            } else {
              loopStack.push({ type: lp.type, startLine: i, depth: braceDepth });
            }
            break;
          }
        }

        // Track brace depth for C-like languages
        if (!isPython && !isRuby) {
          for (const ch of line) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
              braceDepth--;
              // Pop loops that ended
              while (loopStack.length > 0 && loopStack[loopStack.length - 1].depth >= braceDepth) {
                loopStack.pop();
              }
            }
          }
        }

        // For indent-based languages, detect when loop ends
        if (indentBasedLoop) {
          const currentIndent = line.length - line.trimStart().length;
          if (trimmed.length > 0 && currentIndent <= indentBasedLoop.indent && i > indentBasedLoop.startLine) {
            indentBasedLoop = null;
          }
        }

        const inLoop = loopStack.length > 0 || indentBasedLoop !== null;
        if (!inLoop) continue;

        // Check each ORM pattern inside loop context
        for (const ormPattern of ORM_QUERY_PATTERNS) {
          if (ormPattern.pattern.test(line)) {
            const loopType = indentBasedLoop?.type || loopStack[loopStack.length - 1]?.type || 'loop';

            patterns.push({
              file,
              line: i + 1,
              ormMethod: ormPattern.orm,
              loopType,
              context: trimmed.slice(0, 120),
              suggestion: ormPattern.suggestion,
              severity: ormPattern.orm === 'raw-sql' ? 'error' : 'warning',
            });

            byOrm[ormPattern.orm] = (byOrm[ormPattern.orm] || 0) + 1;
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  const recommendations: string[] = [];
  if (patterns.length > 0) {
    recommendations.push('Replace individual queries in loops with batch queries using findMany(), IN clauses, or eager loading.');
    recommendations.push('Use ORM relation loading (include/joins/prefetch) to fetch related data in a single query.');
    if (byOrm['raw-sql']) {
      recommendations.push('Convert raw SQL loops to batch queries with IN (...) clauses or JOINs.');
    }
  }
  if (patterns.length > 10) {
    recommendations.push('Consider adding a query count middleware/interceptor to detect N+1 patterns at runtime.');
  }

  return {
    patterns: patterns.slice(0, 200),
    summary: { total: patterns.length, byOrm },
    recommendations,
  };
}

// ── Async Anti-Pattern Detection ────────────────────────────────────────

export interface AsyncAntiPattern {
  file: string;
  line: number;
  pattern: string;
  severity: 'info' | 'warning' | 'error';
  description: string;
  suggestion: string;
  code: string;
}

export interface AsyncPatternResult {
  antiPatterns: AsyncAntiPattern[];
  summary: { total: number; byPattern: Record<string, number>; bySeverity: Record<string, number> };
  score: number;
  recommendations: string[];
}

/** Definitions for async anti-pattern detectors. */
const ASYNC_PATTERN_DEFS: {
  name: string;
  pattern: RegExp;
  severity: AsyncAntiPattern['severity'];
  description: string;
  suggestion: string;
  /** Extra check: if provided, the line must also match this secondary pattern for context. */
  contextPattern?: RegExp;
}[] = [
  // Sequential awaits that could be parallelized
  {
    name: 'sequential-await',
    pattern: /^\s*(?:const|let|var)\s+\w+\s*=\s*await\s+/,
    severity: 'warning',
    description: 'Sequential await statements that may be parallelizable',
    suggestion: 'If these operations are independent, use Promise.all([...]) for parallel execution',
  },
  // .then() without .catch()
  {
    name: 'uncaught-promise',
    pattern: /\.then\s*\([^)]*\)\s*(?:;|\s*$)/,
    severity: 'warning',
    description: 'Promise .then() without a .catch() handler',
    suggestion: 'Add .catch() or use try/catch with await to handle promise rejections',
  },
  // Dangling promise (async call without await)
  {
    name: 'dangling-promise',
    pattern: /^\s*(?!return\b)(?!await\b)(?!const\b)(?!let\b)(?!var\b)(?!export\b)(?!throw\b)\w+(?:\.\w+)*\s*\([^)]*\)\s*;/,
    severity: 'info',
    description: 'Function call result not awaited or stored - may be a dangling promise',
    suggestion: 'Add await or void operator if intentionally fire-and-forget',
  },
  // addEventListener without removeEventListener
  {
    name: 'event-listener-leak',
    pattern: /\.addEventListener\s*\(/,
    severity: 'warning',
    description: 'Event listener added - ensure corresponding removeEventListener exists',
    suggestion: 'Store listener reference and call removeEventListener in cleanup/dispose',
  },
  // setInterval without clearInterval
  {
    name: 'interval-leak',
    pattern: /setInterval\s*\(/,
    severity: 'warning',
    description: 'setInterval without guaranteed clearInterval',
    suggestion: 'Store interval ID and clear in cleanup: const id = setInterval(...); clearInterval(id)',
  },
  // Callback/promise mixing
  {
    name: 'callback-promise-mix',
    pattern: /new\s+Promise\s*\(\s*(?:(?:async\s+)?\([^)]*\)\s*=>|function)/,
    severity: 'info',
    description: 'Manual Promise constructor - possible callback/promise mixing',
    suggestion: 'Use util.promisify() or async/await instead of wrapping callbacks in new Promise()',
  },
  // await inside a loop without batching
  {
    name: 'await-in-loop',
    pattern: /await\s+/,
    severity: 'warning',
    description: 'await inside a loop - sequential execution that may be parallelizable',
    suggestion: 'Collect promises and use Promise.all() or Promise.allSettled() for batch execution',
    contextPattern: /^\s*(?:for|while)\b/,
  },
];

/**
 * Analyze async/await and promise patterns in the codebase to find anti-patterns.
 * Detects sequential awaits, missing error handling, callback/promise mixing,
 * dangling promises, and potential memory leaks from timers and event listeners.
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @param options.fileGlob - Custom glob pattern for files to scan.
 * @returns Analysis results including anti-patterns, score, and recommendations.
 */
export async function analyzeAsyncPatterns(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<AsyncPatternResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const glob = options?.fileGlob || '*.{ts,tsx,js,jsx,mjs,cjs}';
  const files = await listFiles(dir, { glob, type: 'file' });
  const sourceFiles = files.slice(0, 300);

  const antiPatterns: AsyncAntiPattern[] = [];
  const byPattern: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  let totalAsyncFiles = 0;
  let filesWithIssues = 0;

  for (const file of sourceFiles) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');

      // Only process files with async patterns
      if (!/\b(?:async|await|Promise|\.then)\b/.test(content)) continue;
      totalAsyncFiles++;

      const lines = content.split('\n');
      let fileHasIssue = false;

      // Track context for loop detection
      let inLoop = false;
      let loopDepth = 0;
      let braceDepth = 0;
      const loopBraceStart: number[] = [];

      // Track sequential awaits
      let consecutiveAwaitCount = 0;
      let lastAwaitLine = -1;

      // Track addEventListener/removeEventListener balance
      const addListenerFiles = new Set<string>();
      const removeListenerFiles = new Set<string>();

      // Track setInterval/clearInterval balance
      let hasSetInterval = false;
      let hasClearInterval = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        // Track loop context
        if (/^\s*(?:for|while)\s*\(/.test(line)) {
          inLoop = true;
          loopDepth++;
          loopBraceStart.push(braceDepth);
        }

        for (const ch of line) {
          if (ch === '{') braceDepth++;
          if (ch === '}') {
            braceDepth--;
            if (loopBraceStart.length > 0 && braceDepth <= loopBraceStart[loopBraceStart.length - 1]) {
              loopBraceStart.pop();
              loopDepth--;
              if (loopDepth <= 0) {
                inLoop = false;
                loopDepth = 0;
              }
            }
          }
        }

        // Track event listeners
        if (/\.addEventListener\s*\(/.test(line)) addListenerFiles.add(file);
        if (/\.removeEventListener\s*\(/.test(line)) removeListenerFiles.add(file);

        // Track intervals
        if (/setInterval\s*\(/.test(line)) hasSetInterval = true;
        if (/clearInterval\s*\(/.test(line)) hasClearInterval = true;

        // Detect sequential awaits
        if (/^\s*(?:const|let|var)\s+\w+\s*=\s*await\s+/.test(line)) {
          if (lastAwaitLine === i - 1 || lastAwaitLine === i - 2) {
            consecutiveAwaitCount++;
          } else {
            consecutiveAwaitCount = 1;
          }
          lastAwaitLine = i;

          if (consecutiveAwaitCount >= 2) {
            const existing = antiPatterns.find(
              (ap) => ap.file === file && ap.pattern === 'sequential-await' && ap.line === i,
            );
            if (!existing) {
              antiPatterns.push({
                file,
                line: i + 1,
                pattern: 'sequential-await',
                severity: 'warning',
                description: `${consecutiveAwaitCount + 1} sequential await statements detected`,
                suggestion: 'If independent, use: const [a, b] = await Promise.all([fn1(), fn2()])',
                code: trimmed.slice(0, 120),
              });
              byPattern['sequential-await'] = (byPattern['sequential-await'] || 0) + 1;
              bySeverity['warning'] = (bySeverity['warning'] || 0) + 1;
              fileHasIssue = true;
            }
          }
        } else {
          if (!/^\s*$/.test(line)) {
            consecutiveAwaitCount = 0;
          }
        }

        // .then() without .catch()
        if (/\.then\s*\(/.test(line) && !/\.catch\s*\(/.test(line) && !/\.finally\s*\(/.test(line)) {
          // Look ahead a few lines for chained .catch()
          const nextLines = lines.slice(i + 1, i + 4).join(' ');
          if (!/\.catch\s*\(/.test(nextLines)) {
            antiPatterns.push({
              file,
              line: i + 1,
              pattern: 'uncaught-promise',
              severity: 'warning',
              description: 'Promise .then() without a .catch() handler',
              suggestion: 'Add .catch() or use try/catch with await',
              code: trimmed.slice(0, 120),
            });
            byPattern['uncaught-promise'] = (byPattern['uncaught-promise'] || 0) + 1;
            bySeverity['warning'] = (bySeverity['warning'] || 0) + 1;
            fileHasIssue = true;
          }
        }

        // await inside a loop
        if (inLoop && /\bawait\s+/.test(line)) {
          antiPatterns.push({
            file,
            line: i + 1,
            pattern: 'await-in-loop',
            severity: 'warning',
            description: 'await inside a loop causes sequential execution',
            suggestion: 'Collect promises into an array and use Promise.all() or Promise.allSettled()',
            code: trimmed.slice(0, 120),
          });
          byPattern['await-in-loop'] = (byPattern['await-in-loop'] || 0) + 1;
          bySeverity['warning'] = (bySeverity['warning'] || 0) + 1;
          fileHasIssue = true;
        }

        // new Promise() constructor (callback/promise mixing)
        if (/new\s+Promise\s*\(/.test(line)) {
          antiPatterns.push({
            file,
            line: i + 1,
            pattern: 'callback-promise-mix',
            severity: 'info',
            description: 'Manual Promise constructor - potential callback/promise mixing',
            suggestion: 'Use util.promisify() or async/await instead of new Promise()',
            code: trimmed.slice(0, 120),
          });
          byPattern['callback-promise-mix'] = (byPattern['callback-promise-mix'] || 0) + 1;
          bySeverity['info'] = (bySeverity['info'] || 0) + 1;
          fileHasIssue = true;
        }
      }

      // File-level checks for event listener and interval leaks
      if (addListenerFiles.has(file) && !removeListenerFiles.has(file)) {
        // Search for addEventListener lines
        const addResults = await searchCode({
          cwd: dir,
          pattern: 'addEventListener',
          fileGlob: file,
          maxResults: 5,
        });
        for (const r of addResults) {
          antiPatterns.push({
            file,
            line: r.line,
            pattern: 'event-listener-leak',
            severity: 'warning',
            description: 'addEventListener without corresponding removeEventListener in this file',
            suggestion: 'Store the listener reference and call removeEventListener in cleanup',
            code: r.text.trim().slice(0, 120),
          });
          byPattern['event-listener-leak'] = (byPattern['event-listener-leak'] || 0) + 1;
          bySeverity['warning'] = (bySeverity['warning'] || 0) + 1;
          fileHasIssue = true;
        }
      }

      if (hasSetInterval && !hasClearInterval) {
        const intervalResults = await searchCode({
          cwd: dir,
          pattern: 'setInterval',
          fileGlob: file,
          maxResults: 5,
        });
        for (const r of intervalResults) {
          antiPatterns.push({
            file,
            line: r.line,
            pattern: 'interval-leak',
            severity: 'warning',
            description: 'setInterval without clearInterval in this file',
            suggestion: 'Store interval ID and clear it in cleanup/unmount',
            code: r.text.trim().slice(0, 120),
          });
          byPattern['interval-leak'] = (byPattern['interval-leak'] || 0) + 1;
          bySeverity['warning'] = (bySeverity['warning'] || 0) + 1;
          fileHasIssue = true;
        }
      }

      if (fileHasIssue) filesWithIssues++;
    } catch {
      /* skip unreadable files */
    }
  }

  // Calculate score: 0-100 where higher is better
  const issueWeight = { info: 0.5, warning: 2, error: 5 };
  const totalWeight = antiPatterns.reduce(
    (sum, ap) => sum + (issueWeight[ap.severity] || 1),
    0,
  );
  const maxPenalty = Math.max(totalAsyncFiles * 5, 50);
  const score = Math.max(0, Math.round(100 - (totalWeight / maxPenalty) * 100));

  const recommendations: string[] = [];
  if (byPattern['sequential-await']) {
    recommendations.push('Use Promise.all() or Promise.allSettled() to parallelize independent async operations.');
  }
  if (byPattern['uncaught-promise']) {
    recommendations.push('Ensure all promise chains have .catch() handlers or use try/catch with await.');
  }
  if (byPattern['await-in-loop']) {
    recommendations.push('Replace sequential await-in-loop with Promise.all() over a mapped array of promises.');
  }
  if (byPattern['event-listener-leak'] || byPattern['interval-leak']) {
    recommendations.push('Ensure all event listeners and intervals are cleaned up in component unmount/dispose.');
  }
  if (byPattern['callback-promise-mix']) {
    recommendations.push('Prefer util.promisify() or async/await over manual Promise constructors.');
  }

  return {
    antiPatterns: antiPatterns.slice(0, 300),
    summary: { total: antiPatterns.length, byPattern, bySeverity },
    score,
    recommendations,
  };
}

// ── Bundle Composition Analysis ─────────────────────────────────────────

export interface BundleDependency {
  name: string;
  version: string;
  estimatedSize: string;
  importedBy: string[];
  treeShakelable: boolean;
  suggestion?: string;
}

export interface BundleAnalysisResult {
  dependencies: BundleDependency[];
  treeShakingOpportunities: { file: string; line: number; current: string; suggestion: string }[];
  dynamicImportCandidates: { file: string; dependency: string; reason: string }[];
  duplicatePackages: { name: string; versions: string[] }[];
  summary: { totalDeps: number; largeDeps: number; treeShakeOps: number; duplicates: number; estimatedTotalSize: string };
  recommendations: string[];
}

/** Known large dependencies with estimated bundle sizes (KB) and lighter alternatives. */
const KNOWN_LARGE_DEPS: Record<string, { sizeKB: number; treeShakeable: boolean; alternative?: string }> = {
  'moment': { sizeKB: 290, treeShakeable: false, alternative: 'date-fns (tree-shakeable) or dayjs (2KB)' },
  'lodash': { sizeKB: 530, treeShakeable: false, alternative: 'lodash-es (tree-shakeable) or individual lodash/* packages' },
  'aws-sdk': { sizeKB: 7500, treeShakeable: false, alternative: '@aws-sdk/* v3 modular packages' },
  'firebase': { sizeKB: 600, treeShakeable: false, alternative: 'firebase/app + only needed firebase/* modules' },
  'antd': { sizeKB: 1200, treeShakeable: true, alternative: 'Import individual antd components: import Button from "antd/es/button"' },
  '@mui/material': { sizeKB: 800, treeShakeable: true, alternative: 'Import directly: import Button from "@mui/material/Button"' },
  'core-js': { sizeKB: 500, treeShakeable: true, alternative: 'Use browserslist for targeted polyfills' },
  'rxjs': { sizeKB: 350, treeShakeable: true },
  'three': { sizeKB: 600, treeShakeable: true },
  'd3': { sizeKB: 270, treeShakeable: false, alternative: 'Import individual d3 modules: d3-selection, d3-scale, etc.' },
  'chart.js': { sizeKB: 200, treeShakeable: true },
  'highlight.js': { sizeKB: 800, treeShakeable: false, alternative: 'Import only needed languages: highlight.js/lib/languages/*' },
  'xlsx': { sizeKB: 800, treeShakeable: false },
  'pdf-lib': { sizeKB: 400, treeShakeable: false },
  'crypto-js': { sizeKB: 150, treeShakeable: false, alternative: 'Use native Web Crypto API' },
  'axios': { sizeKB: 45, treeShakeable: false, alternative: 'Native fetch() API' },
  'underscore': { sizeKB: 55, treeShakeable: false, alternative: 'Native array/object methods or lodash-es' },
  'jquery': { sizeKB: 90, treeShakeable: false, alternative: 'Native DOM APIs or a lightweight alternative' },
  'bluebird': { sizeKB: 80, treeShakeable: false, alternative: 'Native Promise (built-in since ES2015)' },
  'request': { sizeKB: 200, treeShakeable: false, alternative: 'node-fetch or native fetch() (Node 18+)' },
};

/** Patterns indicating non-tree-shakeable (namespace/default) imports. */
const TREE_SHAKE_PATTERNS: {
  pattern: RegExp;
  depName: string;
  suggestion: string;
}[] = [
  { pattern: /import\s+_\s+from\s+['"]lodash['"]/, depName: 'lodash', suggestion: "import { map } from 'lodash-es'" },
  { pattern: /import\s+\*\s+as\s+_\s+from\s+['"]lodash['"]/, depName: 'lodash', suggestion: "import { map } from 'lodash-es'" },
  { pattern: /import\s+lodash\s+from\s+['"]lodash['"]/, depName: 'lodash', suggestion: "import { map } from 'lodash-es'" },
  { pattern: /(?:const|let|var)\s+_\s*=\s*require\s*\(\s*['"]lodash['"]\s*\)/, depName: 'lodash', suggestion: "import { map } from 'lodash-es'" },
  { pattern: /import\s+moment\s+from\s+['"]moment['"]/, depName: 'moment', suggestion: "import { format } from 'date-fns' or import dayjs from 'dayjs'" },
  { pattern: /import\s+\*\s+as\s+d3\s+from\s+['"]d3['"]/, depName: 'd3', suggestion: "import { select } from 'd3-selection'" },
  { pattern: /import\s+d3\s+from\s+['"]d3['"]/, depName: 'd3', suggestion: "import { select } from 'd3-selection'" },
  { pattern: /import\s+\*\s+as\s+\w+\s+from\s+['"]rxjs['"]/, depName: 'rxjs', suggestion: "import { Observable } from 'rxjs'" },
  { pattern: /import\s+\*\s+as\s+AWS\s+from\s+['"]aws-sdk['"]/, depName: 'aws-sdk', suggestion: "import { S3 } from '@aws-sdk/client-s3'" },
  { pattern: /(?:const|let|var)\s+AWS\s*=\s*require\s*\(\s*['"]aws-sdk['"]\s*\)/, depName: 'aws-sdk', suggestion: "import { S3 } from '@aws-sdk/client-s3'" },
  { pattern: /import\s+['"]highlight\.js['"]/, depName: 'highlight.js', suggestion: "import hljs from 'highlight.js/lib/core' and register only needed languages" },
];

/**
 * Analyze JavaScript/TypeScript bundle composition to identify optimization opportunities.
 * Examines package.json dependencies, detects large packages, finds tree-shaking
 * opportunities, suggests dynamic import candidates, and checks for duplicate packages.
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @returns Bundle analysis results with dependencies, opportunities, and recommendations.
 */
export async function analyzeBundleComposition(
  cwd: string,
  options?: { directory?: string },
): Promise<BundleAnalysisResult> {
  const dir = path.resolve(cwd, options?.directory || '.');

  const dependencies: BundleDependency[] = [];
  const treeShakingOpportunities: BundleAnalysisResult['treeShakingOpportunities'] = [];
  const dynamicImportCandidates: BundleAnalysisResult['dynamicImportCandidates'] = [];
  const duplicatePackages: BundleAnalysisResult['duplicatePackages'] = [];
  const recommendations: string[] = [];

  // 1. Read package.json
  let pkgDeps: Record<string, string> = {};
  let devDeps: Record<string, string> = {};
  try {
    const pkgContent = await readFile(path.join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent);
    pkgDeps = pkg.dependencies || {};
    devDeps = pkg.devDependencies || {};
  } catch {
    return {
      dependencies: [],
      treeShakingOpportunities: [],
      dynamicImportCandidates: [],
      duplicatePackages: [],
      summary: { totalDeps: 0, largeDeps: 0, treeShakeOps: 0, duplicates: 0, estimatedTotalSize: '0 KB' },
      recommendations: ['No package.json found in the target directory.'],
    };
  }

  const allDeps = { ...pkgDeps, ...devDeps };

  // 2. Scan source files for import references
  const importMap: Record<string, string[]> = {}; // dep name -> files that import it
  const files = await listFiles(dir, { glob: '*.{ts,tsx,js,jsx,mjs,cjs}', type: 'file' });
  const sourceFiles = files.filter((f) => !/(node_modules|dist|build|\.d\.ts)/i.test(f)).slice(0, 300);

  for (const file of sourceFiles) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Match import/require statements
        const importMatch = line.match(/(?:import\s+.*?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/);
        if (importMatch) {
          const moduleName = importMatch[1];
          // Extract package name (handle scoped packages)
          const pkgName = moduleName.startsWith('@')
            ? moduleName.split('/').slice(0, 2).join('/')
            : moduleName.split('/')[0];

          if (allDeps[pkgName]) {
            if (!importMap[pkgName]) importMap[pkgName] = [];
            if (!importMap[pkgName].includes(file)) {
              importMap[pkgName].push(file);
            }
          }
        }

        // Check for tree-shaking opportunities
        for (const tsp of TREE_SHAKE_PATTERNS) {
          if (tsp.pattern.test(line)) {
            treeShakingOpportunities.push({
              file,
              line: i + 1,
              current: line.trim().slice(0, 120),
              suggestion: tsp.suggestion,
            });
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  // 3. Build dependency list with size estimates
  let totalSizeKB = 0;
  let largeDepsCount = 0;

  for (const [name, version] of Object.entries(pkgDeps)) {
    const known = KNOWN_LARGE_DEPS[name];
    let estimatedSizeKB = 0;
    let treeShakelable = false;

    if (known) {
      estimatedSizeKB = known.sizeKB;
      treeShakelable = known.treeShakeable;
    } else {
      // Try to read from node_modules for a rough size estimate
      try {
        const nmPkgPath = path.join(dir, 'node_modules', name, 'package.json');
        const nmContent = await readFile(nmPkgPath, 'utf-8');
        const nmPkg = JSON.parse(nmContent);
        // Check if package has module/es field (tree-shakeable indicator)
        treeShakelable = !!(nmPkg.module || nmPkg.exports || nmPkg['jsnext:main']);
        // Use unpacked size if available, otherwise estimate at 30KB
        if (nmPkg.dist?.unpackedSize) {
          estimatedSizeKB = Math.round(nmPkg.dist.unpackedSize / 1024);
        } else {
          estimatedSizeKB = 30; // conservative default
        }
      } catch {
        estimatedSizeKB = 30;
      }
    }

    totalSizeKB += estimatedSizeKB;
    if (estimatedSizeKB > 100) largeDepsCount++;

    const dep: BundleDependency = {
      name,
      version: version.replace(/^[\^~>=<]+/, ''),
      estimatedSize: estimatedSizeKB >= 1024 ? `${(estimatedSizeKB / 1024).toFixed(1)} MB` : `${estimatedSizeKB} KB`,
      importedBy: importMap[name] || [],
      treeShakelable: treeShakelable,
      suggestion: known?.alternative,
    };

    dependencies.push(dep);
  }

  // Sort by estimated size descending
  dependencies.sort((a, b) => {
    const sizeA = parseEstimatedSize(a.estimatedSize);
    const sizeB = parseEstimatedSize(b.estimatedSize);
    return sizeB - sizeA;
  });

  // 4. Detect dynamic import candidates (large deps used in few files)
  for (const dep of dependencies) {
    const sizeKB = parseEstimatedSize(dep.estimatedSize);
    if (sizeKB > 100 && dep.importedBy.length <= 2 && dep.importedBy.length > 0) {
      dynamicImportCandidates.push({
        file: dep.importedBy[0],
        dependency: dep.name,
        reason: `Large dependency (${dep.estimatedSize}) used in only ${dep.importedBy.length} file(s) - candidate for lazy loading`,
      });
    }
  }

  // 5. Check for duplicate package versions in lockfile
  try {
    const lockContent = await readFile(path.join(dir, 'package-lock.json'), 'utf-8');
    const lockData = JSON.parse(lockContent);
    const packages = lockData.packages || {};
    const versionMap: Record<string, Set<string>> = {};

    for (const [pkgPath, info] of Object.entries(packages)) {
      if (!pkgPath || pkgPath === '') continue;
      const d = info as Record<string, unknown>;
      const name = pkgPath.replace(/^node_modules\//, '').replace(/.*node_modules\//, '');
      const version = d.version as string;
      if (name && version) {
        if (!versionMap[name]) versionMap[name] = new Set();
        versionMap[name].add(version);
      }
    }

    for (const [name, versions] of Object.entries(versionMap)) {
      if (versions.size > 1) {
        duplicatePackages.push({ name, versions: Array.from(versions) });
      }
    }
  } catch {
    // Try yarn.lock briefly
    try {
      const yarnContent = await readFile(path.join(dir, 'yarn.lock'), 'utf-8');
      const versionMap: Record<string, Set<string>> = {};
      const regex = /^"?(@?[^@\s"]+)@[^":\n]+[":]?\s*\n\s+version\s+"([^"]+)"/gm;
      let match;
      while ((match = regex.exec(yarnContent)) !== null) {
        const name = match[1];
        const version = match[2];
        if (!versionMap[name]) versionMap[name] = new Set();
        versionMap[name].add(version);
      }
      for (const [name, versions] of Object.entries(versionMap)) {
        if (versions.size > 1) {
          duplicatePackages.push({ name, versions: Array.from(versions) });
        }
      }
    } catch {
      /* no lockfile */
    }
  }

  // 6. Build recommendations
  if (largeDepsCount > 0) {
    recommendations.push(`Found ${largeDepsCount} large dependencies (>100KB) - review for lighter alternatives.`);
  }
  if (treeShakingOpportunities.length > 0) {
    recommendations.push(`${treeShakingOpportunities.length} tree-shaking opportunities found - switch to named imports.`);
  }
  if (dynamicImportCandidates.length > 0) {
    recommendations.push(`${dynamicImportCandidates.length} candidates for dynamic import() to reduce initial bundle size.`);
  }
  if (duplicatePackages.length > 0) {
    recommendations.push(`${duplicatePackages.length} packages have multiple versions installed - consider deduplication.`);
  }
  const unusedDeps = Object.keys(pkgDeps).filter((d) => !importMap[d]);
  if (unusedDeps.length > 0) {
    recommendations.push(`Potentially unused dependencies: ${unusedDeps.slice(0, 10).join(', ')}`);
  }

  const estimatedTotalSize =
    totalSizeKB >= 1024 ? `${(totalSizeKB / 1024).toFixed(1)} MB` : `${totalSizeKB} KB`;

  return {
    dependencies: dependencies.slice(0, 100),
    treeShakingOpportunities: treeShakingOpportunities.slice(0, 50),
    dynamicImportCandidates: dynamicImportCandidates.slice(0, 30),
    duplicatePackages: duplicatePackages.slice(0, 50),
    summary: {
      totalDeps: Object.keys(pkgDeps).length,
      largeDeps: largeDepsCount,
      treeShakeOps: treeShakingOpportunities.length,
      duplicates: duplicatePackages.length,
      estimatedTotalSize,
    },
    recommendations,
  };
}

/**
 * Parse an estimated size string back to KB for comparison.
 * @param sizeStr - A size string like "290 KB" or "1.2 MB".
 * @returns The size in KB.
 */
function parseEstimatedSize(sizeStr: string): number {
  const match = sizeStr.match(/([\d.]+)\s*(KB|MB)/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  return match[2] === 'MB' ? value * 1024 : value;
}

// ── Memory Leak Pattern Detection ───────────────────────────────────────

export interface MemoryLeakPattern {
  file: string;
  line: number;
  type: 'unbounded-collection' | 'event-listener-leak' | 'timer-leak' | 'unclosed-resource' | 'closure-capture';
  severity: 'info' | 'warning' | 'error';
  description: string;
  code: string;
  suggestion: string;
}

export interface MemoryLeakResult {
  patterns: MemoryLeakPattern[];
  summary: { total: number; byType: Record<string, number>; bySeverity: Record<string, number> };
  score: number;
  recommendations: string[];
}

/** Definitions for memory leak pattern detectors. */
const MEMORY_LEAK_DEFS: {
  type: MemoryLeakPattern['type'];
  pattern: RegExp;
  severity: MemoryLeakPattern['severity'];
  description: string;
  suggestion: string;
  /** If provided, the file should NOT contain this pattern (indicates proper cleanup). */
  cleanupPattern?: RegExp;
}[] = [
  // Unbounded collections - push without clear/splice/shift
  {
    type: 'unbounded-collection',
    pattern: /\.push\s*\(/,
    severity: 'info',
    description: 'Array .push() detected - verify collection is bounded or periodically cleared',
    suggestion: 'Add size limits, use ring buffers, or periodically clear with .splice(0) or .length = 0',
  },
  {
    type: 'unbounded-collection',
    pattern: /\.set\s*\(/,
    severity: 'info',
    description: 'Map/Set .set()/.add() detected - verify collection is bounded',
    suggestion: 'Add size limits with eviction policy (LRU cache), or use WeakMap/WeakSet for object keys',
  },
  // Event listener leaks
  {
    type: 'event-listener-leak',
    pattern: /\.addEventListener\s*\(/,
    severity: 'warning',
    description: 'addEventListener without matching removeEventListener',
    suggestion: 'Store listener reference, call removeEventListener in cleanup/dispose/unmount',
    cleanupPattern: /\.removeEventListener\s*\(/,
  },
  {
    type: 'event-listener-leak',
    pattern: /\.on\s*\(\s*['"][^'"]+['"]/,
    severity: 'info',
    description: 'Event emitter .on() listener - ensure cleanup with .off() or .removeListener()',
    suggestion: 'Use .once() for one-time listeners or call .off()/.removeListener() in cleanup',
    cleanupPattern: /\.(?:off|removeListener|removeAllListeners)\s*\(/,
  },
  // Timer leaks
  {
    type: 'timer-leak',
    pattern: /setInterval\s*\(/,
    severity: 'warning',
    description: 'setInterval without clearInterval',
    suggestion: 'Store interval ID and call clearInterval in cleanup/dispose/unmount',
    cleanupPattern: /clearInterval\s*\(/,
  },
  {
    type: 'timer-leak',
    pattern: /setTimeout\s*\(/,
    severity: 'info',
    description: 'setTimeout that may need cleanup on component/module disposal',
    suggestion: 'Store timeout ID and call clearTimeout in cleanup if the context may be destroyed',
    cleanupPattern: /clearTimeout\s*\(/,
  },
  // Unclosed resources
  {
    type: 'unclosed-resource',
    pattern: /createReadStream\s*\(/,
    severity: 'warning',
    description: 'Stream created - ensure it is properly closed/destroyed',
    suggestion: 'Use pipeline(), stream.destroy(), or wrap in a try/finally to ensure cleanup',
    cleanupPattern: /\.destroy\s*\(|\.close\s*\(|pipeline\s*\(/,
  },
  {
    type: 'unclosed-resource',
    pattern: /createWriteStream\s*\(/,
    severity: 'warning',
    description: 'Write stream created - ensure it is properly closed',
    suggestion: 'Call stream.end() or stream.destroy() in cleanup, or use pipeline()',
    cleanupPattern: /\.end\s*\(|\.destroy\s*\(|pipeline\s*\(/,
  },
  {
    type: 'unclosed-resource',
    pattern: /(?:createConnection|createPool|connect)\s*\(/,
    severity: 'error',
    description: 'Database/network connection opened - ensure proper closing',
    suggestion: 'Use connection pooling with proper shutdown, or try/finally with connection.close()',
    cleanupPattern: /\.close\s*\(|\.end\s*\(|\.destroy\s*\(|\.release\s*\(/,
  },
  {
    type: 'unclosed-resource',
    pattern: /(?:open|openSync)\s*\(/,
    severity: 'warning',
    description: 'File handle opened - ensure it is closed',
    suggestion: 'Use fs.promises with try/finally, or the using/Symbol.dispose pattern',
    cleanupPattern: /\.close\s*\(|closeSync\s*\(/,
  },
  // Closure captures
  {
    type: 'closure-capture',
    pattern: /(?:module|global|window)\.\w+\s*=\s*(?:function|\([^)]*\)\s*=>)/,
    severity: 'warning',
    description: 'Function assigned to global/module scope may capture large closure context',
    suggestion: 'Minimize closure scope, avoid capturing large objects in long-lived closures',
  },
];

/**
 * Detect common memory leak patterns through static analysis of the codebase.
 * Identifies growing unbounded collections, event listener leaks, timer leaks,
 * unclosed resources (streams, connections, file handles), and closure captures.
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @param options.fileGlob - Custom glob pattern for files to scan.
 * @returns Memory leak detection results with patterns, score, and recommendations.
 */
export async function detectMemoryLeakPatterns(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<MemoryLeakResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const glob = options?.fileGlob || '*.{ts,tsx,js,jsx,mjs,cjs,py,java,go,rs}';
  const files = await listFiles(dir, { glob, type: 'file' });
  const sourceFiles = files.filter((f) => !/(node_modules|dist|build|\.d\.ts|\.test\.|\.spec\.)/i.test(f)).slice(0, 300);

  const patterns: MemoryLeakPattern[] = [];
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let totalFilesScanned = 0;

  for (const file of sourceFiles) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');
      totalFilesScanned++;

      for (const leakDef of MEMORY_LEAK_DEFS) {
        // If there is a cleanup pattern and the file contains it, skip (it handles cleanup)
        if (leakDef.cleanupPattern && leakDef.cleanupPattern.test(content)) continue;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // Skip comments
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

          if (leakDef.pattern.test(line)) {
            // For unbounded-collection, refine: only flag if it looks like a module-level or class-level collection
            if (leakDef.type === 'unbounded-collection') {
              // Check if the push/set is on a variable that looks module-scoped or a property
              if (/^\s*(?:const|let|var)\s/.test(line)) continue; // inline declaration with push is fine
              // Only flag if this looks like it's in a handler/function that could be called repeatedly
              const surroundingContext = lines.slice(Math.max(0, i - 10), i).join('\n');
              const isInHandler = /(?:function|=>|handler|listener|callback|middleware|on\w+)\b/.test(surroundingContext);
              if (!isInHandler) continue;
            }

            patterns.push({
              file,
              line: i + 1,
              type: leakDef.type,
              severity: leakDef.severity,
              description: leakDef.description,
              code: trimmed.slice(0, 120),
              suggestion: leakDef.suggestion,
            });

            byType[leakDef.type] = (byType[leakDef.type] || 0) + 1;
            bySeverity[leakDef.severity] = (bySeverity[leakDef.severity] || 0) + 1;

            // Only report first occurrence per pattern per file to reduce noise
            break;
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  // Calculate score: 0-100 (higher = fewer leaks)
  const issueWeight: Record<string, number> = { info: 0.5, warning: 2, error: 5 };
  const totalWeight = patterns.reduce(
    (sum, p) => sum + (issueWeight[p.severity] || 1),
    0,
  );
  const maxPenalty = Math.max(totalFilesScanned * 3, 30);
  const score = Math.max(0, Math.round(100 - (totalWeight / maxPenalty) * 100));

  const recommendations: string[] = [];
  if (byType['event-listener-leak']) {
    recommendations.push('Add removeEventListener/removeListener calls in cleanup functions for all event listeners.');
  }
  if (byType['timer-leak']) {
    recommendations.push('Store timer IDs from setInterval/setTimeout and clear them in dispose/unmount handlers.');
  }
  if (byType['unclosed-resource']) {
    recommendations.push('Use try/finally or the Disposable pattern to ensure streams, connections, and file handles are closed.');
  }
  if (byType['unbounded-collection']) {
    recommendations.push('Add size limits or eviction policies to caches and collections that grow over time. Consider WeakMap/WeakSet for object keys.');
  }
  if (byType['closure-capture']) {
    recommendations.push('Minimize variables captured in closures assigned to long-lived scopes. Nullify references when no longer needed.');
  }
  if (patterns.length === 0) {
    recommendations.push('No obvious memory leak patterns detected. Consider runtime profiling with --inspect for verification.');
  }

  return {
    patterns: patterns.slice(0, 200),
    summary: { total: patterns.length, byType, bySeverity },
    score,
    recommendations,
  };
}
