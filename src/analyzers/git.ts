/**
 * Git Context Analyzer
 * Provides git history, blame, diff, and change analysis
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
  files?: string[];
}

export interface GitBlameEntry {
  line: number;
  hash: string;
  author: string;
  date: string;
  content: string;
}

const EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 15000 };

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

/**
 * Check if directory is a git repo.
 * @param cwd - The working directory to check
 * @returns True if the directory is a git repository
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await gitExec(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get recent git log.
 * @param cwd - The working directory
 * @param options - Log options
 * @param options.count - Maximum number of entries
 * @param options.filePath - Filter by file path
 * @param options.author - Filter by author
 * @param options.since - Filter by date
 * @returns Array of git log entries
 */
export async function getGitLog(
  cwd: string,
  options?: {
    count?: number;
    filePath?: string;
    author?: string;
    since?: string;
  },
): Promise<GitLogEntry[]> {
  const count = options?.count ?? 20;
  const args = ['log', `--max-count=${count}`, '--format=%H|%an|%ai|%s'];
  if (options?.filePath) args.push('--', options.filePath);
  if (options?.author) args.push(`--author=${options.author}`);
  if (options?.since) args.push(`--since=${options.since}`);

  const output = await gitExec(args, cwd);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, ...messageParts] = line.split('|');
      return { hash, author, date, message: messageParts.join('|') };
    });
}

/**
 * Get git log with changed files.
 * @param cwd - The working directory
 * @param count - Maximum number of entries
 * @returns Array of git log entries including changed file lists
 */
export async function getGitLogWithFiles(cwd: string, count: number = 10): Promise<GitLogEntry[]> {
  const args = ['log', `--max-count=${count}`, '--format=%H|%an|%ai|%s', '--name-only'];
  const output = await gitExec(args, cwd);

  const entries: GitLogEntry[] = [];
  const blocks = output.split('\n\n');

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    const [hash, author, date, ...messageParts] = lines[0].split('|');
    const files = lines.slice(1);
    entries.push({ hash, author, date, message: messageParts.join('|'), files });
  }

  return entries;
}

/**
 * Git diff -- staged, unstaged, or between refs.
 * @param cwd - The working directory
 * @param options - Diff options
 * @param options.staged - Show staged changes
 * @param options.ref1 - First ref for comparison
 * @param options.ref2 - Second ref for comparison
 * @param options.filePath - Filter by file path
 * @param options.stat - Show diff stats only
 * @returns The diff output as a string
 */
export async function getGitDiff(
  cwd: string,
  options?: {
    staged?: boolean;
    ref1?: string;
    ref2?: string;
    filePath?: string;
    stat?: boolean;
  },
): Promise<string> {
  const args = ['diff'];
  if (options?.stat) args.push('--stat');
  if (options?.staged) args.push('--cached');
  if (options?.ref1) args.push(options.ref1);
  if (options?.ref2) args.push(options.ref2);
  if (options?.filePath) args.push('--', options.filePath);

  return gitExec(args, cwd);
}

/**
 * Git blame for a file.
 * @param cwd - The working directory
 * @param filePath - Path to the file
 * @param options - Blame options
 * @param options.startLine - Start line for range
 * @param options.endLine - End line for range
 * @returns Array of blame entries per line
 */
export async function getGitBlame(
  cwd: string,
  filePath: string,
  options?: {
    startLine?: number;
    endLine?: number;
  },
): Promise<GitBlameEntry[]> {
  const args = ['blame', '--porcelain'];
  if (options?.startLine && options?.endLine) {
    args.push(`-L${options.startLine},${options.endLine}`);
  }
  args.push(filePath);

  const output = await gitExec(args, cwd);
  const entries: GitBlameEntry[] = [];
  const lines = output.split('\n');

  let currentHash = '',
    currentAuthor = '',
    currentDate = '',
    lineNum = 0;

  for (const line of lines) {
    if (line.match(/^[0-9a-f]{40}/)) {
      const parts = line.split(' ');
      currentHash = parts[0].slice(0, 8);
      lineNum = parseInt(parts[2] || parts[1], 10);
    } else if (line.startsWith('author ')) {
      currentAuthor = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      const ts = parseInt(line.slice(12), 10);
      currentDate = new Date(ts * 1000).toISOString().split('T')[0];
    } else if (line.startsWith('\t')) {
      entries.push({
        line: lineNum,
        hash: currentHash,
        author: currentAuthor,
        date: currentDate,
        content: line.slice(1),
      });
    }
  }

  return entries;
}

/**
 * Get current git status.
 * @param cwd - The working directory
 * @returns Short-format git status output
 */
export async function getGitStatus(cwd: string): Promise<string> {
  return gitExec(['status', '--short'], cwd);
}

/**
 * Get current branch name.
 * @param cwd - The working directory
 * @returns The current branch name
 */
export async function getGitBranch(cwd: string): Promise<string> {
  const output = await gitExec(['branch', '--show-current'], cwd);
  return output.trim();
}

/**
 * Get list of all branches.
 * @param cwd - The working directory
 * @returns Array of branch names
 */
export async function getGitBranches(cwd: string): Promise<string[]> {
  const output = await gitExec(['branch', '-a', '--format=%(refname:short)'], cwd);
  return output.split('\n').filter(Boolean);
}

/**
 * Show a specific commit.
 * @param cwd - The working directory
 * @param ref - The commit reference
 * @param stat - Whether to show stats only
 * @returns The commit details as a string
 */
export async function getGitShow(cwd: string, ref: string, stat?: boolean): Promise<string> {
  const args = ['show'];
  if (stat) args.push('--stat');
  args.push(ref);
  return gitExec(args, cwd);
}

/**
 * Get contributors for a file or repo.
 * @param cwd - The working directory
 * @param filePath - Optional file path to filter by
 * @returns Array of contributors with commit counts
 */
export async function getContributors(cwd: string, filePath?: string): Promise<{ author: string; commits: number }[]> {
  const args = ['shortlog', '-sne', 'HEAD'];
  if (filePath) args.push('--', filePath);

  const output = await gitExec(args, cwd);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match ? { author: match[2], commits: parseInt(match[1], 10) } : { author: line.trim(), commits: 0 };
    })
    .filter((c) => c.commits > 0);
}
