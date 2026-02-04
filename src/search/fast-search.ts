/**
 * Fast Code Search Engine
 * Uses ripgrep (rg) for blazing fast search, falls back to grep
 * Handles codebases of any size efficiently
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Interface representing a single search result match.
 */
export interface SearchResult {
  file: string;
  line: number;
  column?: number;
  text: string;
  before?: string[];
  after?: string[];
}

/**
 * Configuration options for code search.
 */
export interface SearchOptions {
  cwd: string;
  pattern: string;
  /**
   * Glob pattern to filter files (e.g. "*.ts").
   */
  fileGlob?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
  /**
   * Number of context lines to include before and after the match.
   */
  contextLines?: number;
  includeHidden?: boolean;
  excludeDirs?: string[];
}

let _rgAvailable: boolean | null = null;

/**
 * Checks if ripgrep (rg) is available in the system path.
 * Caches the result for subsequent calls.
 *
 * @returns Promise resolving to true if rg is available, false otherwise.
 */
async function isRgAvailable(): Promise<boolean> {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    await execFileAsync('rg', ['--version']);
    _rgAvailable = true;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}

/**
 * Resets the cached availability of ripgrep.
 * Intended for testing purposes only.
 */
export function resetRgAvailability(): void {
  _rgAvailable = null;
}

/**
 * Primary search function that delegates to ripgrep if available, otherwise falls back to grep.
 *
 * @param opts - The search options including pattern, cwd, and filters.
 * @returns A promise resolving to an array of search results.
 */
export async function searchCode(opts: SearchOptions): Promise<SearchResult[]> {
  if (await isRgAvailable()) {
    return searchWithRipgrep(opts);
  }
  return searchWithGrep(opts);
}

/**
 * Default list of directories to exclude from search to improve performance.
 */
const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  'coverage',
  '.pytest_cache',
  '.gradle',
  'vendor',
  'Pods',
  '.dart_tool',
  '.pub-cache',
];

/**
 * executes search using ripgrep.
 *
 * @param opts - Search options.
 * @returns Array of matches.
 */
async function searchWithRipgrep(opts: SearchOptions): Promise<SearchResult[]> {
  const args: string[] = ['--json', '--line-number', '--column', '--no-heading'];

  if (!opts.caseSensitive) args.push('--ignore-case');
  if (opts.wholeWord) args.push('--word-regexp');
  if (!opts.isRegex) args.push('--fixed-strings');
  if (opts.maxResults) args.push('--max-count', String(opts.maxResults));
  if (opts.contextLines) {
    args.push('--before-context', String(opts.contextLines));
    args.push('--after-context', String(opts.contextLines));
  }
  if (!opts.includeHidden) args.push('--no-hidden');

  const excludeDirs = [...DEFAULT_EXCLUDES, ...(opts.excludeDirs || [])];

  for (const dir of excludeDirs) {
    args.push('--glob', `!${dir}`);
  }

  if (opts.fileGlob) {
    args.push('--glob', opts.fileGlob);
  }

  args.push(opts.pattern, '.');

  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: opts.cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
    });

    return parseRipgrepJson(stdout, opts.cwd);
  } catch (error: unknown) {
    if (isExitCodeError(error) && error.code === 1) return [];
    if (error instanceof Error) {
      throw new Error(`Search failed: ${error.message}`);
    }
    throw new Error('Search failed with unknown error');
  }
}

/**
 * Type guard for error with code property.
 *
 * @param error - The error to check.
 * @returns True if error has a code property.
 */
function isExitCodeError(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Parses the newline-delimited JSON output from ripgrep.
 *
 * @param output - Raw stdout from ripgrep.
 * @param cwd - Current working directory to resolve relative paths.
 * @returns Parsed search results.
 */
function parseRipgrepJson(output: string, cwd: string): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = output.split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'match') {
        const data = parsed.data;
        results.push({
          file: path.relative(cwd, data.path.text),
          line: data.line_number,
          column: data.submatches?.[0]?.start,
          text: data.lines.text.trimEnd(),
        });
      }
    } catch {
      // Intentionally suppressed: skip malformed lines
    }
  }

  return results;
}

/**
 * Executes search using standard grep (fallback).
 *
 * @param opts - Search options.
 * @returns Array of matches.
 */
async function searchWithGrep(opts: SearchOptions): Promise<SearchResult[]> {
  const args: string[] = ['-r', '-n', '--line-number'];

  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  if (!opts.isRegex) args.push('-F');
  if (opts.maxResults) args.push('-m', String(opts.maxResults));
  if (opts.contextLines) {
    args.push('-B', String(opts.contextLines));
    args.push('-A', String(opts.contextLines));
  }

  const excludeDirs = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    'bin',
    'obj',
    '.next',
    'coverage',
    'vendor',
    ...(opts.excludeDirs || []),
  ];

  for (const dir of excludeDirs) {
    args.push(`--exclude-dir=${dir}`);
  }

  if (opts.fileGlob) {
    args.push(`--include=${opts.fileGlob}`);
  }

  args.push(opts.pattern, '.');

  try {
    const { stdout } = await execFileAsync('grep', args, {
      cwd: opts.cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
    });

    return parseGrepOutput(stdout);
  } catch (error: unknown) {
    if (isExitCodeError(error) && error.code === 1) return [];
    if (error instanceof Error) {
      throw new Error(`Search failed: ${error.message}`);
    }
    throw new Error('Search failed with unknown error');
  }
}

/**
 * Parses the standard grep output.
 *
 * @param output - Raw stdout from grep.
 * @returns Parsed search results.
 */
function parseGrepOutput(output: string): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = output.split('\n').filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^\.?\/?(.+?):(\d+):(.*)$/);
    if (match) {
      results.push({
        file: match[1],
        line: parseInt(match[2], 10),
        text: match[3].trimEnd(),
      });
    }
  }

  return results;
}

/**
 * Options for file listing.
 */
export interface ListOptions {
  glob?: string;
  maxDepth?: number;
  excludeDirs?: string[];
  type?: 'file' | 'dir' | 'all';
}

/**
 * Lists files in a directory using 'fd' or 'find'.
 *
 * @param cwd - Directory to search in.
 * @param options - Filtering options.
 * @returns List of file paths relative to cwd.
 */
export async function listFiles(cwd: string, options?: ListOptions): Promise<string[]> {
  const excludes = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    'bin',
    'obj',
    '.next',
    'coverage',
    'vendor',
    'Pods',
    '.dart_tool',
    ...(options?.excludeDirs || []),
  ];

  try {
    const fdArgs: string[] = [];
    if (options?.type === 'file') fdArgs.push('--type', 'f');
    else if (options?.type === 'dir') fdArgs.push('--type', 'd');
    if (options?.maxDepth) fdArgs.push('--max-depth', String(options.maxDepth));
    for (const dir of excludes) fdArgs.push('--exclude', dir);
    fdArgs.push('--hidden');
    if (options?.glob) fdArgs.push('--glob', options.glob);
    else fdArgs.push('.');

    const { stdout } = await execFileAsync('fd', fdArgs, { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 15000 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    // Fallback to find if fd fails
  }

  try {
    const findArgs: string[] = ['.'];
    if (options?.maxDepth) findArgs.push('-maxdepth', String(options.maxDepth));

    const excludeExpr: string[] = [];
    for (const dir of excludes) {
      excludeExpr.push('-name', dir, '-o');
    }
    if (excludeExpr.length > 0) {
      excludeExpr.pop();
      findArgs.push('(', ...excludeExpr, ')', '-prune', '-o');
    }

    if (options?.type === 'file') findArgs.push('-type', 'f');
    else if (options?.type === 'dir') findArgs.push('-type', 'd');

    if (options?.glob) {
      findArgs.push('-name', options.glob);
    }
    findArgs.push('-print');

    const { stdout } = await execFileAsync('find', findArgs, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15000,
    });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''));
  } catch (error: unknown) {
    // Handle permission errors gracefully - find may write to stderr but still succeed
    // In CI environments, find can encounter permission denied errors for system directories
    const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    // If we have stdout despite errors, use it (find can succeed with permission warnings)
    if (err.stdout) {
      return err.stdout
        .split('\n')
        .filter(Boolean)
        .map((f) => f.replace(/^\.\//, ''));
    }
    // If it's just permission errors, return empty array (common in CI environments)
    const stderr = err.stderr || '';
    const message = err instanceof Error ? err.message : err.message || String(err);
    if (
      stderr.includes('Permission denied') ||
      stderr.includes('permission') ||
      message.includes('Permission denied') ||
      message.includes('permission')
    ) {
      return [];
    }
    throw new Error(`File listing failed: ${message}`);
  }
}

/**
 * Counts the number of lines in a file efficiently using 'wc -l'.
 *
 * @param filePath - Path to the file.
 * @returns Number of lines.
 */
export async function countLines(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('wc', ['-l', filePath]);
    return parseInt(stdout.trim().split(/\s+/)[0], 10);
  } catch {
    const content = await readFile(filePath, 'utf-8');
    return content.split('\n').length;
  }
}

/**
 * Result of reading a file range.
 */
export interface ReadFileResult {
  content: string;
  totalLines: number;
}

/**
 * Reads a specific range of lines from a file.
 *
 * @param filePath - Path to the file.
 * @param startLine - 1-based start line.
 * @param endLine - 1-based end line (inclusive).
 * @returns Content and total line count.
 */
export async function readFileRange(filePath: string, startLine?: number, endLine?: number): Promise<ReadFileResult> {
  if (!startLine && !endLine) {
    const content = await readFile(filePath, 'utf-8');
    return { content, totalLines: content.split('\n').length };
  }

  try {
    const range = startLine && endLine ? `${startLine},${endLine}p` : startLine ? `${startLine},$p` : `1,${endLine}p`;

    const { stdout } = await execFileAsync('sed', ['-n', range, filePath]);
    const total = await countLines(filePath);
    return { content: stdout, totalLines: total };
  } catch {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = (startLine || 1) - 1;
    const end = endLine || lines.length;
    return {
      content: lines.slice(start, end).join('\n'),
      totalLines: lines.length,
    };
  }
}
