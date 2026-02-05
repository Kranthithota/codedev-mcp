/**
 * Documentation Intelligence Analyzers
 * Detects stale docs, measures doc coverage, generates changelogs,
 * and extracts API documentation from source code.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { detectLanguage } from '../utils/languages.js';

const execFileAsync = promisify(execFile);

/** Default exec options for child processes. */
const EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 15000 };

// ── Doc Staleness Types ─────────────────────────────────────────────────

/** A single stale documentation issue. */
export interface StaleDoc {
  docFile: string;
  issue: string;
  severity: 'info' | 'warning' | 'error';
  referencedItem: string;
  details: string;
}

/** Result of documentation staleness detection. */
export interface DocStalenessResult {
  staleItems: StaleDoc[];
  docFiles: { file: string; lastModified: string; referencesChecked: number; staleReferences: number }[];
  summary: { totalDocs: number; totalReferences: number; staleReferences: number; freshnessScore: number };
  recommendations: string[];
}

// ── Doc Coverage Types ──────────────────────────────────────────────────

/** An undocumented public export. */
export interface UndocumentedItem {
  file: string;
  line: number;
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'constant' | 'method';
  exported: boolean;
}

/** Result of documentation coverage measurement. */
export interface DocCoverageResult {
  undocumented: UndocumentedItem[];
  coverage: { documented: number; undocumented: number; percentage: number };
  projectDocs: { file: string; exists: boolean }[];
  fileScores: { file: string; exports: number; documented: number; percentage: number }[];
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  recommendations: string[];
}

// ── Changelog Types ─────────────────────────────────────────────────────

/** A single parsed changelog entry from git history. */
export interface ChangelogEntry {
  hash: string;
  type: string;
  scope?: string;
  description: string;
  breaking: boolean;
  author: string;
  date: string;
  files: string[];
}

/** Structured changelog result from git history analysis. */
export interface ChangelogResult {
  fromRef: string;
  toRef: string;
  entries: ChangelogEntry[];
  sections: { title: string; entries: ChangelogEntry[] }[];
  breakingChanges: ChangelogEntry[];
  markdown: string;
  summary: { total: number; features: number; fixes: number; breaking: number };
}

// ── API Doc Types ───────────────────────────────────────────────────────

/** A detected REST API endpoint. */
export interface APIEndpoint {
  method: string;
  path: string;
  file: string;
  line: number;
  handler: string;
  params?: { name: string; type: string; description?: string }[];
  responseType?: string;
  description?: string;
  middleware?: string[];
}

/** Result of API documentation extraction. */
export interface APIDocResult {
  endpoints: APIEndpoint[];
  exportedFunctions: { name: string; file: string; line: number; signature: string; jsdoc?: string }[];
  exportedTypes: { name: string; file: string; line: number; definition: string }[];
  markdown: string;
  summary: { endpoints: number; functions: number; types: number; documented: number };
}

// ── Helper: safe git exec ───────────────────────────────────────────────

/**
 * Execute a git command and return stdout.
 *
 * @param args - Git command arguments.
 * @param cwd - Working directory.
 * @returns The stdout output string.
 * @throws If the directory is not a git repository or the command fails.
 */
async function gitExec(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { ...EXEC_OPTS, cwd });
    return stdout;
  } catch (error: unknown) {
    const err = error as Record<string, unknown>;
    if (err.stderr && String(err.stderr).includes('not a git repository')) {
      throw new Error('Not a git repository');
    }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  1. detectDocStaleness
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compare documentation against the code it references to detect stale content.
 *
 * Finds all markdown files, extracts code references (file paths, function
 * names, class names), checks if referenced items still exist, and uses
 * git history to find docs not updated since referenced code changed.
 *
 * @param cwd - Root directory of the codebase.
 * @param options - Optional configuration.
 * @param options.maxDocs - Maximum markdown files to scan (default 100).
 * @param options.checkGitHistory - Whether to use git log for freshness (default true).
 * @returns Staleness analysis with stale items, per-file stats, and recommendations.
 */
export async function detectDocStaleness(
  cwd: string,
  options?: {
    maxDocs?: number;
    checkGitHistory?: boolean;
  },
): Promise<DocStalenessResult> {
  const maxDocs = options?.maxDocs ?? 100;
  const checkGit = options?.checkGitHistory !== false;

  // Find all markdown files
  const mdFiles = await listFiles(cwd, { glob: '*.{md,mdx,rst}', type: 'file' });
  const docsToCheck = mdFiles.slice(0, maxDocs);

  // Get all source files for reference checking
  const allFiles = await listFiles(cwd, { type: 'file' });
  const sourceFiles = allFiles.filter((f) => {
    const lang = detectLanguage(f);
    return lang !== 'unknown' && lang !== 'markdown' && lang !== 'text' && lang !== 'rst';
  });
  const sourceFileSet = new Set(sourceFiles);
  const sourceBasenames = new Set(sourceFiles.map((f) => path.basename(f)));

  // Collect all exported symbols from source for reference checking
  const symbolSet = await collectExportedSymbols(cwd, sourceFiles.slice(0, 300));

  const staleItems: StaleDoc[] = [];
  const docFileStats: DocStalenessResult['docFiles'] = [];

  // Check if git is available
  let isGitRepo = false;
  if (checkGit) {
    try {
      await gitExec(['rev-parse', '--git-dir'], cwd);
      isGitRepo = true;
    } catch { /* not a git repo */ }
  }

  // Load package.json scripts for README cross-check
  let pkgScripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    pkgScripts = pkg.scripts || {};
  } catch { /* no package.json */ }

  for (const docFile of docsToCheck) {
    let content: string;
    try {
      content = await readFile(path.join(cwd, docFile), 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    let referencesChecked = 0;
    let staleReferences = 0;
    let lastModified = '';

    // Get last modified date from git
    if (isGitRepo) {
      try {
        const logOutput = await gitExec(
          ['log', '-1', '--format=%ai', '--', docFile],
          cwd,
        );
        lastModified = logOutput.trim().split(' ')[0] || '';
      } catch { /* skip */ }
    }

    // Extract and check file path references
    const fileRefs = extractFileReferences(content);
    for (const ref of fileRefs) {
      referencesChecked++;
      const refNormalized = ref.replace(/^\.\//, '');

      // Check if the referenced file exists
      if (!sourceFileSet.has(refNormalized) && !sourceBasenames.has(path.basename(refNormalized))) {
        // Verify it truly does not exist
        const fullPath = path.join(cwd, refNormalized);
        if (!existsSync(fullPath)) {
          staleReferences++;
          staleItems.push({
            docFile,
            issue: 'Referenced file does not exist',
            severity: 'error',
            referencedItem: ref,
            details: `File "${ref}" referenced in ${docFile} was not found in the codebase.`,
          });
        }
      } else if (isGitRepo && lastModified) {
        // Check if referenced code was modified after the doc
        try {
          const codeLog = await gitExec(
            ['log', '-1', '--format=%ai', '--', refNormalized],
            cwd,
          );
          const codeModified = codeLog.trim().split(' ')[0] || '';
          if (codeModified && codeModified > lastModified) {
            staleReferences++;
            staleItems.push({
              docFile,
              issue: 'Documentation may be outdated',
              severity: 'warning',
              referencedItem: ref,
              details: `Code "${ref}" was modified on ${codeModified} but documentation was last updated on ${lastModified}.`,
            });
          }
        } catch { /* skip git errors */ }
      }
    }

    // Extract and check symbol references (function names, class names)
    const symbolRefs = extractSymbolReferences(content);
    for (const ref of symbolRefs) {
      referencesChecked++;
      if (!symbolSet.has(ref)) {
        // Might be a false positive; check with search
        try {
          const results = await searchCode({
            cwd,
            pattern: ref,
            maxResults: 1,
            fileGlob: '*.{ts,tsx,js,jsx,py,go,rs,java}',
          });
          if (results.length === 0) {
            staleReferences++;
            staleItems.push({
              docFile,
              issue: 'Referenced symbol not found in codebase',
              severity: 'warning',
              referencedItem: ref,
              details: `Symbol "${ref}" referenced in ${docFile} could not be found in source code.`,
            });
          }
        } catch { /* skip search errors */ }
      }
    }

    // Check README commands against package.json scripts
    if (docFile.toLowerCase().includes('readme') && Object.keys(pkgScripts).length > 0) {
      const commandRefs = extractCommandReferences(content);
      for (const cmd of commandRefs) {
        referencesChecked++;
        // Check if "npm run <script>" or "yarn <script>" references a valid script
        const scriptMatch = cmd.match(/(?:npm\s+run|yarn|pnpm)\s+(\S+)/);
        if (scriptMatch && !pkgScripts[scriptMatch[1]]) {
          staleReferences++;
          staleItems.push({
            docFile,
            issue: 'Referenced script not found in package.json',
            severity: 'error',
            referencedItem: cmd,
            details: `Command "${cmd}" references script "${scriptMatch[1]}" which is not defined in package.json.`,
          });
        }
      }
    }

    docFileStats.push({
      file: docFile,
      lastModified,
      referencesChecked,
      staleReferences,
    });
  }

  // Calculate freshness score (0-100)
  const totalRefs = docFileStats.reduce((s, d) => s + d.referencesChecked, 0);
  const totalStale = docFileStats.reduce((s, d) => s + d.staleReferences, 0);
  const freshnessScore = totalRefs > 0 ? Math.round(((totalRefs - totalStale) / totalRefs) * 100) : 100;

  // Generate recommendations
  const recommendations = generateStalenessRecommendations(staleItems, docFileStats, freshnessScore);

  return {
    staleItems: staleItems.slice(0, 100),
    docFiles: docFileStats,
    summary: {
      totalDocs: docsToCheck.length,
      totalReferences: totalRefs,
      staleReferences: totalStale,
      freshnessScore,
    },
    recommendations,
  };
}

/**
 * Extract file path references from markdown content.
 * Matches backtick code spans, markdown links, and inline file path patterns.
 *
 * @param content - Markdown content to scan.
 * @returns Array of referenced file paths.
 */
function extractFileReferences(content: string): string[] {
  const refs = new Set<string>();

  // Backtick code spans with file extensions
  const backtickPattern = /`([^`]+\.\w{1,10})`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickPattern.exec(content)) !== null) {
    const ref = match[1].trim();
    // Filter out URLs, commands, and version strings
    if (!ref.includes('://') && !ref.startsWith('-') && !ref.includes(' ') && ref.includes('/') || ref.includes('.')) {
      // Must look like a file path with a real extension
      if (/\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|json|yaml|yml|toml|md|sh|sql|css|html|vue|svelte)$/.test(ref)) {
        refs.add(ref);
      }
    }
  }

  // Markdown links to local files
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = linkPattern.exec(content)) !== null) {
    const href = match[2].trim();
    if (!href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
      refs.add(href.split('#')[0]); // Remove anchor
    }
  }

  return [...refs].filter(Boolean);
}

/**
 * Extract symbol references (function names, class names) from markdown.
 * Looks for backtick-wrapped identifiers that look like code symbols.
 *
 * @param content - Markdown content to scan.
 * @returns Array of symbol names.
 */
function extractSymbolReferences(content: string): string[] {
  const refs = new Set<string>();

  // Backtick-wrapped identifiers (PascalCase or camelCase, with optional parens)
  const symbolPattern = /`([A-Z][a-zA-Z0-9]+(?:\(\))?)`|`([a-z][a-zA-Z0-9]+\(\))`/g;
  let match: RegExpExecArray | null;
  while ((match = symbolPattern.exec(content)) !== null) {
    const sym = (match[1] || match[2]).replace(/\(\)$/, '');
    // Must be at least 3 characters and not a common word
    if (sym.length >= 3 && !/^(The|This|That|Some|Any|All|Not|And|But|For|With|From|Into)$/.test(sym)) {
      refs.add(sym);
    }
  }

  return [...refs];
}

/**
 * Extract shell command references from markdown code blocks.
 *
 * @param content - Markdown content to scan.
 * @returns Array of command strings.
 */
function extractCommandReferences(content: string): string[] {
  const commands: string[] = [];

  // Fenced code blocks with shell/bash
  const blockPattern = /```(?:sh|bash|shell|console|terminal)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(content)) !== null) {
    const lines = match[1].split('\n');
    for (const line of lines) {
      const trimmed = line.replace(/^\$\s*/, '').trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
        commands.push(trimmed);
      }
    }
  }

  // Inline backtick commands with npm/yarn/pnpm
  const inlinePattern = /`((?:npm|yarn|pnpm)\s+(?:run\s+)?\S+)`/g;
  while ((match = inlinePattern.exec(content)) !== null) {
    commands.push(match[1]);
  }

  return commands;
}

/**
 * Collect exported symbol names from source files.
 *
 * @param cwd - Root directory.
 * @param files - Source files to scan.
 * @returns Set of exported symbol names.
 */
async function collectExportedSymbols(cwd: string, files: string[]): Promise<Set<string>> {
  const symbols = new Set<string>();

  const exportPatterns: RegExp[] = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:default\s+)?class\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+enum\s+(\w+)/g,
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm,
    /^(?:pub\s+)?struct\s+(\w+)/gm,
    /^class\s+(\w+)/gm,
    /^def\s+(\w+)/gm,
    /^func\s+(\w+)/gm,
  ];

  for (const file of files) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf-8');
      for (const pattern of exportPatterns) {
        const re = new RegExp(pattern.source, pattern.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          symbols.add(m[1]);
        }
      }
    } catch { /* skip */ }
  }

  return symbols;
}

/**
 * Generate recommendations based on staleness analysis.
 *
 * @param staleItems - Array of stale documentation items.
 * @param docFiles - Per-file statistics.
 * @param freshnessScore - Overall freshness score (0-100).
 * @returns Array of recommendation strings.
 */
function generateStalenessRecommendations(
  staleItems: StaleDoc[],
  docFiles: DocStalenessResult['docFiles'],
  freshnessScore: number,
): string[] {
  const recs: string[] = [];

  const errorCount = staleItems.filter((s) => s.severity === 'error').length;
  const warningCount = staleItems.filter((s) => s.severity === 'warning').length;

  if (errorCount > 0) {
    recs.push(`Fix ${errorCount} broken reference(s) in documentation -- these point to files or symbols that no longer exist.`);
  }

  if (warningCount > 0) {
    recs.push(`Review ${warningCount} documentation file(s) that may be outdated -- referenced code has changed since the docs were last updated.`);
  }

  if (freshnessScore < 50) {
    recs.push('Documentation freshness is critically low. Consider a documentation audit to bring docs up to date with the codebase.');
  } else if (freshnessScore < 75) {
    recs.push('Documentation freshness is below average. Prioritize updating docs for recently changed code.');
  }

  const neverUpdated = docFiles.filter((d) => !d.lastModified);
  if (neverUpdated.length > 0) {
    recs.push(`${neverUpdated.length} documentation file(s) have no git history -- they may have been added without tracking.`);
  }

  if (recs.length === 0) {
    recs.push('Documentation appears to be in good shape. Continue to review docs when making code changes.');
  }

  return recs;
}

// ═══════════════════════════════════════════════════════════════════════
//  2. measureDocCoverage
// ═══════════════════════════════════════════════════════════════════════

/**
 * Measure documentation coverage across the codebase.
 *
 * Scans public exports in source files for JSDoc/docstring comments,
 * checks for standard project documentation files (README, CONTRIBUTING,
 * etc.), and scores overall documentation quality.
 *
 * @param cwd - Root directory of the codebase.
 * @param options - Optional configuration.
 * @param options.maxFiles - Maximum source files to scan (default 300).
 * @param options.fileGlob - Glob pattern to filter files.
 * @param options.includePrivate - Whether to include non-exported items (default false).
 * @returns Documentation coverage metrics and recommendations.
 */
export async function measureDocCoverage(
  cwd: string,
  options?: {
    maxFiles?: number;
    fileGlob?: string;
    includePrivate?: boolean;
  },
): Promise<DocCoverageResult> {
  const maxFiles = options?.maxFiles ?? 300;
  const glob = options?.fileGlob ?? '*.{ts,tsx,js,jsx,py,go,rs,java,rb}';
  const includePrivate = options?.includePrivate ?? false;

  const allFiles = await listFiles(cwd, { glob, type: 'file' });
  const files = allFiles.slice(0, maxFiles);

  const undocumented: UndocumentedItem[] = [];
  const fileScores: DocCoverageResult['fileScores'] = [];
  let totalDocumented = 0;
  let totalUndocumented = 0;

  for (const file of files) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf-8');
      const lines = content.split('\n');
      const lang = detectLanguage(file);

      const { documented, items } = analyzeFileDocCoverage(lines, file, lang, includePrivate);
      const undocItems = items.filter((item) => !item.documented);
      const docCount = documented;
      const totalExports = items.length;

      totalDocumented += docCount;
      totalUndocumented += undocItems.length;

      for (const item of undocItems) {
        undocumented.push({
          file,
          line: item.line,
          name: item.name,
          type: item.type as UndocumentedItem['type'],
          exported: item.exported,
        });
      }

      if (totalExports > 0) {
        fileScores.push({
          file,
          exports: totalExports,
          documented: docCount,
          percentage: Math.round((docCount / totalExports) * 100),
        });
      }
    } catch { /* skip unreadable files */ }
  }

  // Check for standard project docs
  const standardDocs = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md'];
  const projectDocs = standardDocs.map((file) => ({
    file,
    exists: existsSync(path.join(cwd, file)),
  }));

  // Calculate overall metrics
  const totalItems = totalDocumented + totalUndocumented;
  const percentage = totalItems > 0 ? Math.round((totalDocumented / totalItems) * 100) : 0;

  // Calculate overall score (weighted: code coverage 70%, project docs 30%)
  const existingProjectDocs = projectDocs.filter((d) => d.exists).length;
  const projectDocScore = standardDocs.length > 0 ? (existingProjectDocs / standardDocs.length) * 100 : 0;
  const overallScore = Math.round(percentage * 0.7 + projectDocScore * 0.3);

  // Assign grade
  const grade = overallScore >= 90 ? 'A' : overallScore >= 75 ? 'B' : overallScore >= 60 ? 'C' : overallScore >= 40 ? 'D' : 'F';

  // Generate recommendations
  const recommendations = generateCoverageRecommendations(
    percentage,
    overallScore,
    grade,
    undocumented,
    projectDocs,
    fileScores,
  );

  // Sort fileScores by worst coverage first
  fileScores.sort((a, b) => a.percentage - b.percentage);

  return {
    undocumented: undocumented.slice(0, 200),
    coverage: { documented: totalDocumented, undocumented: totalUndocumented, percentage },
    projectDocs,
    fileScores: fileScores.slice(0, 50),
    overallScore,
    grade,
    recommendations,
  };
}

/** Intermediate item for doc coverage analysis. */
interface DocAnalysisItem {
  name: string;
  type: string;
  line: number;
  exported: boolean;
  documented: boolean;
}

/**
 * Analyze documentation coverage for a single file.
 *
 * @param lines - Source code lines.
 * @param file - File path.
 * @param lang - Detected language.
 * @param includePrivate - Whether to include non-exported items.
 * @returns Count of documented items and list of all items.
 */
function analyzeFileDocCoverage(
  lines: string[],
  file: string,
  lang: string,
  includePrivate: boolean,
): { documented: number; items: DocAnalysisItem[] } {
  const items: DocAnalysisItem[] = [];
  let documented = 0;

  // Language-specific patterns for exported/public items
  const patterns = getDocCoveragePatterns(lang);

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern.regex);
      if (!match) continue;

      const name = match[1];
      if (!name || name.startsWith('_')) continue;

      const isExported = pattern.exported?.(lines[i]) ?? true;
      if (!includePrivate && !isExported) continue;

      // Check if there is a doc comment above
      const hasDoc = hasDocComment(lines, i, lang);

      if (hasDoc) documented++;

      items.push({
        name,
        type: pattern.type,
        line: i + 1,
        exported: isExported,
        documented: hasDoc,
      });
    }
  }

  return { documented, items };
}

/** Pattern definition for doc coverage detection. */
interface DocCoveragePattern {
  regex: RegExp;
  type: string;
  exported?: (line: string) => boolean;
}

/**
 * Get language-specific patterns for finding documentable items.
 *
 * @param lang - Programming language.
 * @returns Array of patterns to match documentable items.
 */
function getDocCoveragePatterns(lang: string): DocCoveragePattern[] {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return [
        { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: 'function', exported: (l) => l.includes('export') },
        { regex: /(?:export\s+)?class\s+(\w+)/, type: 'class', exported: (l) => l.includes('export') },
        { regex: /(?:export\s+)?interface\s+(\w+)/, type: 'interface', exported: (l) => l.includes('export') },
        { regex: /(?:export\s+)?type\s+(\w+)\s*=/, type: 'type', exported: (l) => l.includes('export') },
        { regex: /(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*[:=]/, type: 'constant', exported: (l) => l.includes('export') },
        { regex: /(?:export\s+)?enum\s+(\w+)/, type: 'type', exported: (l) => l.includes('export') },
      ];
    case 'python':
      return [
        { regex: /^def\s+(\w+)/, type: 'function', exported: (l) => !l.trim().startsWith('def _') },
        { regex: /^class\s+(\w+)/, type: 'class', exported: (l) => !l.trim().startsWith('class _') },
      ];
    case 'go':
      return [
        { regex: /^func\s+(\w+)/, type: 'function', exported: (l) => { const m = l.match(/^func\s+(\w)/); return !!m && m[1] === m[1].toUpperCase(); } },
        { regex: /^type\s+(\w+)\s+struct/, type: 'class', exported: (l) => { const m = l.match(/^type\s+(\w)/); return !!m && m[1] === m[1].toUpperCase(); } },
        { regex: /^type\s+(\w+)\s+interface/, type: 'interface', exported: (l) => { const m = l.match(/^type\s+(\w)/); return !!m && m[1] === m[1].toUpperCase(); } },
      ];
    case 'rust':
      return [
        { regex: /pub\s+(?:async\s+)?fn\s+(\w+)/, type: 'function', exported: () => true },
        { regex: /pub\s+struct\s+(\w+)/, type: 'class', exported: () => true },
        { regex: /pub\s+trait\s+(\w+)/, type: 'interface', exported: () => true },
        { regex: /pub\s+enum\s+(\w+)/, type: 'type', exported: () => true },
        { regex: /pub\s+type\s+(\w+)/, type: 'type', exported: () => true },
      ];
    case 'java':
      return [
        { regex: /public\s+(?:static\s+)?(?:[\w<>[\]]+\s+)?(\w+)\s*\(/, type: 'method', exported: () => true },
        { regex: /public\s+(?:abstract\s+)?class\s+(\w+)/, type: 'class', exported: () => true },
        { regex: /public\s+interface\s+(\w+)/, type: 'interface', exported: () => true },
      ];
    default:
      return [
        { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: 'function', exported: () => true },
        { regex: /(?:export\s+)?class\s+(\w+)/, type: 'class', exported: () => true },
        { regex: /def\s+(\w+)/, type: 'function', exported: () => true },
      ];
  }
}

/**
 * Check if there is a doc comment above a given line.
 *
 * @param lines - Source code lines.
 * @param lineIndex - Index of the declaration line.
 * @param lang - Programming language.
 * @returns True if a doc comment is found above the declaration.
 */
function hasDocComment(lines: string[], lineIndex: number, lang: string): boolean {
  // Look backwards from the line for a doc comment
  let i = lineIndex - 1;

  // Skip blank lines
  while (i >= 0 && lines[i].trim() === '') i--;

  if (i < 0) return false;

  const prevLine = lines[i].trim();

  switch (lang) {
    case 'typescript':
    case 'javascript':
    case 'java':
    case 'csharp':
    case 'cpp':
    case 'c':
    case 'kotlin':
    case 'swift':
    case 'dart':
    case 'php':
      // JSDoc/Javadoc ending with */
      return prevLine.endsWith('*/');

    case 'python':
      // Python docstring is inside the function, check next lines instead
      if (lineIndex + 1 < lines.length) {
        // Skip past the def/class line to find :
        let j = lineIndex;
        while (j < lines.length && !lines[j].includes(':')) j++;
        j++; // line after colon
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length) {
          const next = lines[j].trim();
          return next.startsWith('"""') || next.startsWith("'''");
        }
      }
      return false;

    case 'go':
      // Go doc comments are // lines
      return prevLine.startsWith('//');

    case 'rust':
      // Rust doc comments are /// lines
      return prevLine.startsWith('///');

    default:
      // Generic: check for // or /* */ style
      return prevLine.endsWith('*/') || prevLine.startsWith('//') || prevLine.startsWith('#');
  }
}

/**
 * Generate recommendations for improving doc coverage.
 *
 * @param codeCoverage - Code documentation percentage.
 * @param overallScore - Overall score.
 * @param grade - Letter grade.
 * @param undocumented - Array of undocumented items.
 * @param projectDocs - Project documentation file status.
 * @param fileScores - Per-file coverage scores.
 * @returns Array of recommendation strings.
 */
function generateCoverageRecommendations(
  codeCoverage: number,
  overallScore: number,
  grade: string,
  undocumented: UndocumentedItem[],
  projectDocs: { file: string; exists: boolean }[],
  fileScores: DocCoverageResult['fileScores'],
): string[] {
  const recs: string[] = [];

  // Missing project docs
  const missingDocs = projectDocs.filter((d) => !d.exists).map((d) => d.file);
  if (missingDocs.includes('README.md')) {
    recs.push('Create a README.md file -- this is the most important project documentation.');
  }
  if (missingDocs.includes('CONTRIBUTING.md')) {
    recs.push('Add a CONTRIBUTING.md to help onboard new contributors.');
  }
  if (missingDocs.includes('CHANGELOG.md')) {
    recs.push('Maintain a CHANGELOG.md to track project changes across releases.');
  }
  if (missingDocs.includes('LICENSE') && missingDocs.includes('LICENSE.md')) {
    recs.push('Add a LICENSE file to clarify terms of use.');
  }

  // Code doc coverage
  if (codeCoverage < 30) {
    recs.push('Code documentation coverage is very low. Start by documenting all exported functions and classes.');
  } else if (codeCoverage < 60) {
    recs.push('Improve code documentation coverage by adding JSDoc/docstrings to exported APIs.');
  }

  // Focus areas
  const exportedUndoc = undocumented.filter((u) => u.exported);
  if (exportedUndoc.length > 0) {
    const topTypes = new Map<string, number>();
    for (const item of exportedUndoc) {
      topTypes.set(item.type, (topTypes.get(item.type) || 0) + 1);
    }
    const sorted = [...topTypes.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      recs.push(`Prioritize documenting exported ${sorted[0][0]}s (${sorted[0][1]} undocumented).`);
    }
  }

  if (recs.length === 0) {
    recs.push('Documentation coverage is excellent! Continue maintaining docs as the codebase evolves.');
  }

  return recs;
}

// ═══════════════════════════════════════════════════════════════════════
//  3. generateChangelog
// ═══════════════════════════════════════════════════════════════════════

/** Maps conventional commit types to human-readable section titles. */
const COMMIT_TYPE_TITLES: Record<string, string> = {
  feat: 'Features',
  fix: 'Bug Fixes',
  refactor: 'Refactoring',
  perf: 'Performance Improvements',
  docs: 'Documentation',
  test: 'Tests',
  chore: 'Chores',
  ci: 'CI/CD',
  build: 'Build System',
  style: 'Style',
  revert: 'Reverts',
  other: 'Other Changes',
};

/** Keywords used to infer commit type when conventional format is not used. */
const TYPE_INFERENCE_KEYWORDS: { keywords: string[]; type: string }[] = [
  { keywords: ['add', 'feature', 'implement', 'new', 'introduce', 'support'], type: 'feat' },
  { keywords: ['fix', 'bug', 'patch', 'resolve', 'correct', 'repair', 'issue'], type: 'fix' },
  { keywords: ['refactor', 'restructure', 'reorganize', 'simplify', 'clean'], type: 'refactor' },
  { keywords: ['perf', 'performance', 'optimize', 'speed', 'fast'], type: 'perf' },
  { keywords: ['doc', 'readme', 'comment', 'jsdoc', 'documentation'], type: 'docs' },
  { keywords: ['test', 'spec', 'coverage', 'assert', 'mock'], type: 'test' },
  { keywords: ['ci', 'pipeline', 'workflow', 'github action', 'deploy'], type: 'ci' },
  { keywords: ['build', 'webpack', 'bundle', 'compile', 'esbuild', 'rollup'], type: 'build' },
  { keywords: ['chore', 'deps', 'dependencies', 'bump', 'upgrade', 'update package', 'lint'], type: 'chore' },
  { keywords: ['revert'], type: 'revert' },
];

/**
 * Generate a structured changelog from git history between two refs.
 *
 * Parses conventional commit messages when available, infers type from
 * keywords otherwise, and produces categorized, sorted output with
 * a rendered markdown string.
 *
 * @param cwd - Root directory of the git repository.
 * @param fromRef - Starting git reference (tag, branch, or commit hash).
 * @param toRef - Ending git reference (default: HEAD).
 * @param options - Optional configuration.
 * @param options.maxCommits - Maximum number of commits to process (default 500).
 * @param options.includeFiles - Whether to include changed file lists (default true).
 * @returns Structured changelog with categorized entries and markdown output.
 */
export async function generateChangelog(
  cwd: string,
  fromRef: string,
  toRef?: string,
  options?: {
    maxCommits?: number;
    includeFiles?: boolean;
  },
): Promise<ChangelogResult> {
  const to = toRef || 'HEAD';
  const maxCommits = options?.maxCommits ?? 500;
  const includeFiles = options?.includeFiles !== false;

  // Get git log between refs
  const format = '%H|%an|%ai|%s';
  const nameOnlyFlag = includeFiles ? '--name-only' : '';
  const args = ['log', `--max-count=${maxCommits}`, `--format=${format}`, `${fromRef}..${to}`];
  if (includeFiles) args.push('--name-only');

  let output: string;
  try {
    output = await gitExec(args, cwd);
  } catch (error) {
    throw new Error(`Failed to generate changelog: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!output.trim()) {
    return buildEmptyChangelog(fromRef, to);
  }

  // Parse git log output
  const entries: ChangelogEntry[] = [];

  if (includeFiles) {
    // When --name-only is used, entries are separated by blank lines
    const blocks = output.split('\n\n');
    for (const block of blocks) {
      const lines = block.split('\n').filter(Boolean);
      if (lines.length === 0) continue;

      const entry = parseCommitLine(lines[0]);
      if (entry) {
        entry.files = lines.slice(1).filter((l) => !l.includes('|'));
        entries.push(entry);
      }
    }
  } else {
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = parseCommitLine(line);
      if (entry) entries.push(entry);
    }
  }

  // Group by type
  const sectionMap = new Map<string, ChangelogEntry[]>();
  for (const entry of entries) {
    const title = COMMIT_TYPE_TITLES[entry.type] || COMMIT_TYPE_TITLES.other;
    if (!sectionMap.has(title)) {
      sectionMap.set(title, []);
    }
    sectionMap.get(title)!.push(entry);
  }

  // Build ordered sections
  const sectionOrder = ['Features', 'Bug Fixes', 'Performance Improvements', 'Refactoring', 'Documentation', 'Tests', 'CI/CD', 'Build System', 'Chores', 'Style', 'Reverts', 'Other Changes'];
  const sections: ChangelogResult['sections'] = [];
  for (const title of sectionOrder) {
    const sectionEntries = sectionMap.get(title);
    if (sectionEntries && sectionEntries.length > 0) {
      sections.push({ title, entries: sectionEntries });
    }
  }

  // Collect breaking changes
  const breakingChanges = entries.filter((e) => e.breaking);

  // Build markdown
  const markdown = buildChangelogMarkdown(fromRef, to, sections, breakingChanges);

  // Build summary
  const features = entries.filter((e) => e.type === 'feat').length;
  const fixes = entries.filter((e) => e.type === 'fix').length;

  return {
    fromRef,
    toRef: to,
    entries,
    sections,
    breakingChanges,
    markdown,
    summary: {
      total: entries.length,
      features,
      fixes,
      breaking: breakingChanges.length,
    },
  };
}

/**
 * Parse a single git log line into a ChangelogEntry.
 *
 * @param line - Raw git log line in format: hash|author|date|message.
 * @returns Parsed entry, or null if the line is malformed.
 */
function parseCommitLine(line: string): ChangelogEntry | null {
  const parts = line.split('|');
  if (parts.length < 4) return null;

  const [hash, author, date, ...messageParts] = parts;
  const message = messageParts.join('|').trim();

  if (!hash || !message) return null;

  // Try conventional commit format: type(scope): description
  // Also handle: type(scope)!: description (breaking)
  const conventionalMatch = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?\s*:\s*(.+)/);

  let type: string;
  let scope: string | undefined;
  let description: string;
  let breaking = false;

  if (conventionalMatch) {
    type = conventionalMatch[1].toLowerCase();
    scope = conventionalMatch[2] || undefined;
    breaking = conventionalMatch[3] === '!' || message.toLowerCase().includes('breaking');
    description = conventionalMatch[4].trim();

    // Validate type
    if (!COMMIT_TYPE_TITLES[type]) {
      type = 'other';
    }
  } else {
    // Infer type from message keywords
    type = inferCommitType(message);
    description = message;
    breaking = /\bbreaking\b/i.test(message);
  }

  return {
    hash: hash.slice(0, 8),
    type,
    scope,
    description,
    breaking,
    author,
    date: date.split(' ')[0] || date,
    files: [],
  };
}

/**
 * Infer commit type from message keywords.
 *
 * @param message - Commit message.
 * @returns Inferred commit type.
 */
function inferCommitType(message: string): string {
  const lower = message.toLowerCase();
  for (const { keywords, type } of TYPE_INFERENCE_KEYWORDS) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) return type;
    }
  }
  return 'other';
}

/**
 * Build markdown string from changelog sections.
 *
 * @param fromRef - Starting reference.
 * @param toRef - Ending reference.
 * @param sections - Categorized changelog sections.
 * @param breakingChanges - Array of breaking change entries.
 * @returns Formatted markdown changelog string.
 */
function buildChangelogMarkdown(
  fromRef: string,
  toRef: string,
  sections: ChangelogResult['sections'],
  breakingChanges: ChangelogEntry[],
): string {
  const parts: string[] = [];
  parts.push(`# Changelog: ${fromRef}..${toRef}\n`);

  if (breakingChanges.length > 0) {
    parts.push('## BREAKING CHANGES\n');
    for (const entry of breakingChanges) {
      const scope = entry.scope ? `**${entry.scope}:** ` : '';
      parts.push(`- ${scope}${entry.description} (${entry.hash})`);
    }
    parts.push('');
  }

  for (const section of sections) {
    parts.push(`## ${section.title}\n`);
    for (const entry of section.entries) {
      const scope = entry.scope ? `**${entry.scope}:** ` : '';
      const breakingTag = entry.breaking ? ' **[BREAKING]**' : '';
      parts.push(`- ${scope}${entry.description}${breakingTag} (${entry.hash})`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Build an empty changelog result when no commits are found.
 *
 * @param fromRef - Starting reference.
 * @param toRef - Ending reference.
 * @returns Empty changelog result.
 */
function buildEmptyChangelog(fromRef: string, toRef: string): ChangelogResult {
  return {
    fromRef,
    toRef,
    entries: [],
    sections: [],
    breakingChanges: [],
    markdown: `# Changelog: ${fromRef}..${toRef}\n\nNo changes found.\n`,
    summary: { total: 0, features: 0, fixes: 0, breaking: 0 },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  4. generateAPIDocs
// ═══════════════════════════════════════════════════════════════════════

/** Patterns for detecting REST endpoint definitions. */
const ROUTE_PATTERNS: { regex: RegExp; methodIndex: number; pathIndex: number }[] = [
  // Express.js: app.get('/path', handler) or router.get('/path', handler)
  { regex: /(?:app|router)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: 1, pathIndex: 2 },
  // Fastify: fastify.get('/path', handler)
  { regex: /(?:fastify|server|instance)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: 1, pathIndex: 2 },
  // Koa Router: router.get('/path', handler)
  { regex: /router\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: 1, pathIndex: 2 },
  // NestJS decorators: @Get('/path'), @Post('/path')
  { regex: /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g, methodIndex: 1, pathIndex: 2 },
  // Flask: @app.route('/path', methods=['GET'])
  { regex: /@(?:app|blueprint|bp)\.route\s*\(\s*['"]([^'"]+)['"](?:.*?methods\s*=\s*\[['"](\w+)['"])?/g, methodIndex: 2, pathIndex: 1 },
  // Python FastAPI: @app.get('/path')
  { regex: /@(?:app|router)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: 1, pathIndex: 2 },
  // Go http: http.HandleFunc("/path", handler) or r.GET("/path", handler)
  { regex: /(?:HandleFunc|Handle)\s*\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: -1, pathIndex: 1 },
  { regex: /\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: 1, pathIndex: 2 },
];

/**
 * Extract API surface documentation from the codebase.
 *
 * Detects REST endpoint definitions, exported functions with signatures,
 * exported type definitions, and generates structured API documentation
 * in both data and markdown formats.
 *
 * @param cwd - Root directory of the codebase.
 * @param options - Optional configuration.
 * @param options.maxFiles - Maximum files to scan (default 300).
 * @param options.fileGlob - Glob pattern to filter files.
 * @param options.includePrivate - Whether to include non-exported items (default false).
 * @returns API documentation with endpoints, functions, types, and markdown.
 */
export async function generateAPIDocs(
  cwd: string,
  options?: {
    maxFiles?: number;
    fileGlob?: string;
    includePrivate?: boolean;
  },
): Promise<APIDocResult> {
  const maxFiles = options?.maxFiles ?? 300;
  const glob = options?.fileGlob ?? '*.{ts,tsx,js,jsx,py,go,rs,java,rb}';
  const includePrivate = options?.includePrivate ?? false;

  const allFiles = await listFiles(cwd, { glob, type: 'file' });
  const files = allFiles.slice(0, maxFiles);

  const endpoints: APIEndpoint[] = [];
  const exportedFunctions: APIDocResult['exportedFunctions'] = [];
  const exportedTypes: APIDocResult['exportedTypes'] = [];

  for (const file of files) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf-8');
      const lines = content.split('\n');
      const lang = detectLanguage(file);

      // Detect API endpoints
      const fileEndpoints = extractEndpoints(content, lines, file);
      endpoints.push(...fileEndpoints);

      // Extract exported functions
      const fileFunctions = extractExportedFunctions(lines, file, lang, includePrivate);
      exportedFunctions.push(...fileFunctions);

      // Extract exported types
      const fileTypes = extractExportedTypes(lines, file, lang, includePrivate);
      exportedTypes.push(...fileTypes);
    } catch { /* skip unreadable files */ }
  }

  // Count documented items
  let documented = 0;
  documented += endpoints.filter((e) => e.description).length;
  documented += exportedFunctions.filter((f) => f.jsdoc).length;

  // Generate markdown
  const markdown = buildAPIMarkdown(endpoints, exportedFunctions, exportedTypes);

  return {
    endpoints: endpoints.slice(0, 200),
    exportedFunctions: exportedFunctions.slice(0, 500),
    exportedTypes: exportedTypes.slice(0, 300),
    markdown,
    summary: {
      endpoints: endpoints.length,
      functions: exportedFunctions.length,
      types: exportedTypes.length,
      documented,
    },
  };
}

/**
 * Extract REST API endpoints from file content.
 *
 * @param content - Full file content string.
 * @param lines - Source code lines.
 * @param file - File path.
 * @returns Array of detected API endpoints.
 */
function extractEndpoints(content: string, lines: string[], file: string): APIEndpoint[] {
  const endpoints: APIEndpoint[] = [];

  for (const pattern of ROUTE_PATTERNS) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(content)) !== null) {
      const method = pattern.methodIndex === -1
        ? 'ANY'
        : match[pattern.methodIndex]?.toUpperCase() || 'GET';
      const routePath = match[pattern.pathIndex] || '/';

      // Find line number
      const charIndex = match.index;
      let lineNum = 1;
      for (let i = 0; i < charIndex && i < content.length; i++) {
        if (content[i] === '\n') lineNum++;
      }

      // Try to extract handler name
      const handlerLine = lines[lineNum - 1] || '';
      const handlerMatch = handlerLine.match(/(?:,\s*)(\w+)\s*[),]/) ||
        handlerLine.match(/(?:async\s+)?(\w+)\s*\(/);
      const handler = handlerMatch ? handlerMatch[1] : 'anonymous';

      // Try to extract middleware
      const middleware = extractMiddleware(handlerLine);

      // Look for JSDoc above the route
      const description = extractDocAboveLine(lines, lineNum - 1);

      // Try to extract route parameters
      const params = extractRouteParams(routePath);

      endpoints.push({
        method,
        path: routePath,
        file,
        line: lineNum,
        handler,
        params: params.length > 0 ? params : undefined,
        description: description || undefined,
        middleware: middleware.length > 0 ? middleware : undefined,
      });
    }
  }

  return endpoints;
}

/**
 * Extract middleware from a route definition line.
 *
 * @param line - The line containing the route definition.
 * @returns Array of middleware names.
 */
function extractMiddleware(line: string): string[] {
  const middleware: string[] = [];
  // Match common middleware patterns: auth, validate, requireAuth, etc.
  const middlewareMatch = line.match(/,\s*(\w+(?:Middleware|Auth|Validate|Guard|Check|Verify)\w*)/gi);
  if (middlewareMatch) {
    for (const m of middlewareMatch) {
      const name = m.replace(/^,\s*/, '');
      middleware.push(name);
    }
  }
  return middleware;
}

/**
 * Extract route parameters from a path pattern.
 *
 * @param routePath - The route path (e.g., '/users/:id').
 * @returns Array of parameter definitions.
 */
function extractRouteParams(routePath: string): APIEndpoint['params'] & {} {
  const params: { name: string; type: string; description?: string }[] = [];

  // Express-style :param
  const expressParams = routePath.match(/:(\w+)/g);
  if (expressParams) {
    for (const param of expressParams) {
      params.push({ name: param.slice(1), type: 'string' });
    }
  }

  // FastAPI-style {param}
  const fastapiParams = routePath.match(/\{(\w+)\}/g);
  if (fastapiParams) {
    for (const param of fastapiParams) {
      params.push({ name: param.slice(1, -1), type: 'string' });
    }
  }

  return params;
}

/**
 * Extract documentation comment above a given line.
 *
 * @param lines - Source code lines.
 * @param lineIndex - Line index (0-based) of the target.
 * @returns Extracted doc string, or null.
 */
function extractDocAboveLine(lines: string[], lineIndex: number): string | null {
  let i = lineIndex - 1;

  // Skip blank lines
  while (i >= 0 && lines[i].trim() === '') i--;

  if (i < 0) return null;

  const prevLine = lines[i].trim();

  // JSDoc block ending with */
  if (prevLine.endsWith('*/')) {
    const docLines: string[] = [];
    while (i >= 0 && !lines[i].trim().startsWith('/**')) {
      docLines.unshift(lines[i].trim());
      i--;
    }
    if (i >= 0) docLines.unshift(lines[i].trim());

    const description = docLines
      .join('\n')
      .replace(/\/\*\*\s*/, '')
      .replace(/\s*\*\//, '')
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, ''))
      .filter((l) => !l.startsWith('@'))
      .join(' ')
      .trim();

    return description || null;
  }

  // Single-line // or # comment
  if (prevLine.startsWith('//') || prevLine.startsWith('#')) {
    const commentLines: string[] = [];
    while (i >= 0 && (lines[i].trim().startsWith('//') || lines[i].trim().startsWith('#'))) {
      commentLines.unshift(lines[i].trim().replace(/^[/#]+\s?/, ''));
      i--;
    }
    return commentLines.join(' ').trim() || null;
  }

  return null;
}

/**
 * Extract exported functions with their signatures and JSDoc.
 *
 * @param lines - Source code lines.
 * @param file - File path.
 * @param lang - Programming language.
 * @param includePrivate - Whether to include non-exported items.
 * @returns Array of exported function metadata.
 */
function extractExportedFunctions(
  lines: string[],
  file: string,
  lang: string,
  includePrivate: boolean,
): APIDocResult['exportedFunctions'] {
  const functions: APIDocResult['exportedFunctions'] = [];

  const patterns = getFunctionPatterns(lang);

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern.regex);
      if (!match) continue;

      const name = match[1];
      if (!name || (!includePrivate && name.startsWith('_'))) continue;

      const isExported = pattern.isExported?.(lines[i]) ?? true;
      if (!includePrivate && !isExported) continue;

      // Build signature from the current line (and potentially continuation lines)
      let signature = lines[i].trim();
      // If the line doesn't close the parameter list, include the next few lines
      if (!signature.includes(')') && !signature.includes('{')) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          signature += ' ' + lines[j].trim();
          if (lines[j].includes(')') || lines[j].includes('{')) break;
        }
      }
      // Clean up the signature
      signature = signature.replace(/\{[\s\S]*$/, '').replace(/:\s*$/, '').trim();

      // Extract JSDoc
      const jsdoc = extractDocAboveLine(lines, i);

      functions.push({
        name,
        file,
        line: i + 1,
        signature,
        jsdoc: jsdoc || undefined,
      });
    }
  }

  return functions;
}

/** Function detection pattern with export check. */
interface FunctionPattern {
  regex: RegExp;
  isExported?: (line: string) => boolean;
}

/**
 * Get function detection patterns for a language.
 *
 * @param lang - Programming language.
 * @returns Array of function patterns.
 */
function getFunctionPatterns(lang: string): FunctionPattern[] {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return [
        { regex: /export\s+(?:async\s+)?function\s+(\w+)/, isExported: () => true },
        { regex: /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/, isExported: () => true },
        { regex: /(?:async\s+)?function\s+(\w+)/, isExported: (l) => l.includes('export') },
      ];
    case 'python':
      return [
        { regex: /^def\s+(\w+)/, isExported: (l) => !l.trim().startsWith('def _') },
        { regex: /^async\s+def\s+(\w+)/, isExported: (l) => !l.trim().startsWith('async def _') },
      ];
    case 'go':
      return [
        { regex: /^func\s+(\w+)/, isExported: (l) => { const m = l.match(/^func\s+(\w)/); return !!m && m[1] === m[1].toUpperCase(); } },
        { regex: /^func\s+\([^)]+\)\s+(\w+)/, isExported: (l) => { const m = l.match(/\)\s+(\w)/); return !!m && m[1] === m[1].toUpperCase(); } },
      ];
    case 'rust':
      return [
        { regex: /pub\s+(?:async\s+)?fn\s+(\w+)/, isExported: () => true },
      ];
    case 'java':
      return [
        { regex: /public\s+(?:static\s+)?(?:[\w<>[\]]+\s+)?(\w+)\s*\(/, isExported: () => true },
      ];
    default:
      return [
        { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/, isExported: () => true },
        { regex: /def\s+(\w+)/, isExported: () => true },
        { regex: /pub\s+fn\s+(\w+)/, isExported: () => true },
      ];
  }
}

/**
 * Extract exported types/interfaces from source lines.
 *
 * @param lines - Source code lines.
 * @param file - File path.
 * @param lang - Programming language.
 * @param includePrivate - Whether to include non-exported items.
 * @returns Array of exported type metadata.
 */
function extractExportedTypes(
  lines: string[],
  file: string,
  lang: string,
  includePrivate: boolean,
): APIDocResult['exportedTypes'] {
  const types: APIDocResult['exportedTypes'] = [];

  const patterns = getTypePatterns(lang);

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern.regex);
      if (!match) continue;

      const name = match[1];
      if (!name || (!includePrivate && name.startsWith('_'))) continue;

      const isExported = pattern.isExported?.(lines[i]) ?? true;
      if (!includePrivate && !isExported) continue;

      // Build definition from the declaration (multi-line for types/interfaces)
      let definition = lines[i].trim();
      if (definition.includes('{') && !definition.includes('}')) {
        let braceCount = (definition.match(/\{/g) || []).length - (definition.match(/\}/g) || []).length;
        for (let j = i + 1; j < Math.min(i + 30, lines.length) && braceCount > 0; j++) {
          definition += '\n' + lines[j];
          braceCount += (lines[j].match(/\{/g) || []).length;
          braceCount -= (lines[j].match(/\}/g) || []).length;
        }
      }

      // Truncate very long definitions
      if (definition.length > 500) {
        definition = definition.slice(0, 497) + '...';
      }

      types.push({
        name,
        file,
        line: i + 1,
        definition: definition.trim(),
      });
    }
  }

  return types;
}

/** Type detection pattern with export check. */
interface TypePattern {
  regex: RegExp;
  isExported?: (line: string) => boolean;
}

/**
 * Get type detection patterns for a language.
 *
 * @param lang - Programming language.
 * @returns Array of type detection patterns.
 */
function getTypePatterns(lang: string): TypePattern[] {
  switch (lang) {
    case 'typescript':
      return [
        { regex: /export\s+interface\s+(\w+)/, isExported: () => true },
        { regex: /export\s+type\s+(\w+)/, isExported: () => true },
        { regex: /export\s+enum\s+(\w+)/, isExported: () => true },
      ];
    case 'go':
      return [
        { regex: /^type\s+(\w+)\s+struct/, isExported: (l) => { const m = l.match(/^type\s+(\w)/); return !!m && m[1] === m[1].toUpperCase(); } },
        { regex: /^type\s+(\w+)\s+interface/, isExported: (l) => { const m = l.match(/^type\s+(\w)/); return !!m && m[1] === m[1].toUpperCase(); } },
      ];
    case 'rust':
      return [
        { regex: /pub\s+struct\s+(\w+)/, isExported: () => true },
        { regex: /pub\s+enum\s+(\w+)/, isExported: () => true },
        { regex: /pub\s+trait\s+(\w+)/, isExported: () => true },
        { regex: /pub\s+type\s+(\w+)/, isExported: () => true },
      ];
    case 'java':
      return [
        { regex: /public\s+(?:abstract\s+)?class\s+(\w+)/, isExported: () => true },
        { regex: /public\s+interface\s+(\w+)/, isExported: () => true },
        { regex: /public\s+enum\s+(\w+)/, isExported: () => true },
      ];
    case 'python':
      return [
        { regex: /^class\s+(\w+)/, isExported: (l) => !l.trim().startsWith('class _') },
        { regex: /^(\w+)\s*=\s*(?:TypeVar|NewType|NamedTuple)/, isExported: (l) => !l.trim().startsWith('_') },
      ];
    default:
      return [
        { regex: /export\s+interface\s+(\w+)/, isExported: () => true },
        { regex: /export\s+type\s+(\w+)/, isExported: () => true },
        { regex: /class\s+(\w+)/, isExported: () => true },
      ];
  }
}

/**
 * Build markdown API documentation from extracted data.
 *
 * @param endpoints - REST API endpoints.
 * @param functions - Exported functions.
 * @param types - Exported types.
 * @returns Formatted markdown documentation string.
 */
function buildAPIMarkdown(
  endpoints: APIEndpoint[],
  functions: APIDocResult['exportedFunctions'],
  types: APIDocResult['exportedTypes'],
): string {
  const parts: string[] = [];
  parts.push('# API Documentation\n');

  // REST Endpoints
  if (endpoints.length > 0) {
    parts.push('## REST Endpoints\n');

    // Group by path prefix
    const grouped = new Map<string, APIEndpoint[]>();
    for (const ep of endpoints) {
      const prefix = ep.path.split('/').slice(0, 3).join('/') || '/';
      if (!grouped.has(prefix)) grouped.set(prefix, []);
      grouped.get(prefix)!.push(ep);
    }

    for (const [prefix, eps] of grouped) {
      parts.push(`### ${prefix}\n`);
      for (const ep of eps) {
        parts.push(`#### \`${ep.method} ${ep.path}\`\n`);
        if (ep.description) {
          parts.push(`${ep.description}\n`);
        }
        parts.push(`- **File:** \`${ep.file}:${ep.line}\``);
        parts.push(`- **Handler:** \`${ep.handler}\``);
        if (ep.params && ep.params.length > 0) {
          parts.push('- **Parameters:**');
          for (const param of ep.params) {
            parts.push(`  - \`${param.name}\` (${param.type})${param.description ? ': ' + param.description : ''}`);
          }
        }
        if (ep.middleware && ep.middleware.length > 0) {
          parts.push(`- **Middleware:** ${ep.middleware.join(', ')}`);
        }
        parts.push('');
      }
    }
  }

  // Exported Functions
  if (functions.length > 0) {
    parts.push('## Exported Functions\n');

    // Group by file
    const byFile = new Map<string, typeof functions>();
    for (const fn of functions) {
      if (!byFile.has(fn.file)) byFile.set(fn.file, []);
      byFile.get(fn.file)!.push(fn);
    }

    for (const [file, fns] of byFile) {
      parts.push(`### \`${file}\`\n`);
      for (const fn of fns.slice(0, 30)) {
        parts.push(`#### \`${fn.name}\`\n`);
        parts.push('```');
        parts.push(fn.signature);
        parts.push('```\n');
        if (fn.jsdoc) {
          parts.push(`${fn.jsdoc}\n`);
        }
      }
    }
  }

  // Exported Types
  if (types.length > 0) {
    parts.push('## Exported Types\n');

    const byFile = new Map<string, typeof types>();
    for (const t of types) {
      if (!byFile.has(t.file)) byFile.set(t.file, []);
      byFile.get(t.file)!.push(t);
    }

    for (const [file, fileTypes] of byFile) {
      parts.push(`### \`${file}\`\n`);
      for (const t of fileTypes.slice(0, 30)) {
        parts.push(`#### \`${t.name}\`\n`);
        parts.push('```typescript');
        parts.push(t.definition);
        parts.push('```\n');
      }
    }
  }

  if (endpoints.length === 0 && functions.length === 0 && types.length === 0) {
    parts.push('No API surface detected.\n');
  }

  return parts.join('\n');
}
