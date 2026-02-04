/**
 * Branch Compare
 * Structural diff between two git branches — new files, changed symbols,
 * removed exports, stats summary.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface BranchCompareResult {
  base: string;
  compare: string;
  stats: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    filesRenamed: number;
    totalChanges: number;
  };
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
  diffStat: { file: string; insertions: number; deletions: number }[];
  commitsBehind: number;
  commitsAhead: number;
  conflictFiles: string[];
}

/**
 * Compare two git branches and return structural diff information.
 * @param cwd - The working directory of the git repository.
 * @param base - The base branch name.
 * @param compare - The comparison branch name.
 * @param options - Configuration options.
 * @param options.includeStats - Whether to include diff stats.
 * @param options.showConflicts - Whether to detect potential merge conflicts.
 * @returns The branch comparison result.
 */
export async function compareBranches(
  cwd: string,
  base: string,
  compare?: string,
  options?: { includeStats?: boolean; showConflicts?: boolean },
): Promise<BranchCompareResult> {
  const compareBranch = compare || 'HEAD';

  // Get file changes between branches
  const { stdout: diffOutput } = await exec(
    'git',
    ['diff', '--name-status', '--diff-filter=ACDMRT', `${base}...${compareBranch}`],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: { from: string; to: string }[] = [];

  for (const line of diffOutput.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('A')) added.push(parts[1]);
    else if (status.startsWith('M')) modified.push(parts[1]);
    else if (status.startsWith('D')) deleted.push(parts[1]);
    else if (status.startsWith('R')) renamed.push({ from: parts[1], to: parts[2] });
    // Copy
    else if (status.startsWith('C')) added.push(parts[2]);
    // Type change
    else if (status.startsWith('T')) modified.push(parts[1]);
  }

  // Get diff stats (insertions/deletions per file)
  const diffStat: BranchCompareResult['diffStat'] = [];
  if (options?.includeStats !== false) {
    try {
      const { stdout: numstat } = await exec('git', ['diff', '--numstat', `${base}...${compareBranch}`], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      });

      for (const line of numstat.trim().split('\n')) {
        if (!line.trim()) continue;
        const [ins, del, file] = line.split('\t');
        if (file) {
          diffStat.push({
            file,
            insertions: ins === '-' ? 0 : parseInt(ins, 10),
            deletions: del === '-' ? 0 : parseInt(del, 10),
          });
        }
      }
      diffStat.sort((a, b) => b.insertions + b.deletions - (a.insertions + a.deletions));
    } catch {
      /* numstat may fail on binary files */
    }
  }

  // Count commits ahead/behind
  let commitsAhead = 0,
    commitsBehind = 0;
  try {
    const { stdout: revCount } = await exec(
      'git',
      ['rev-list', '--left-right', '--count', `${base}...${compareBranch}`],
      { cwd },
    );
    const [behind, ahead] = revCount.trim().split('\t').map(Number);
    commitsBehind = behind || 0;
    commitsAhead = ahead || 0;
  } catch {
    /* ignore */
  }

  // Check for potential merge conflicts
  const conflictFiles: string[] = [];
  if (options?.showConflicts) {
    try {
      // Find files modified in both branches relative to merge-base
      const { stdout: mergeBase } = await exec('git', ['merge-base', base, compareBranch], { cwd });
      const mb = mergeBase.trim();
      if (mb) {
        const { stdout: baseChanges } = await exec('git', ['diff', '--name-only', `${mb}...${base}`], { cwd });
        const { stdout: compareChanges } = await exec('git', ['diff', '--name-only', `${mb}...${compareBranch}`], {
          cwd,
        });
        const baseFiles = new Set(baseChanges.trim().split('\n').filter(Boolean));
        const compareFiles = compareChanges.trim().split('\n').filter(Boolean);
        for (const f of compareFiles) {
          if (baseFiles.has(f)) conflictFiles.push(f);
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    base,
    compare: compareBranch,
    stats: {
      filesAdded: added.length,
      filesModified: modified.length,
      filesDeleted: deleted.length,
      filesRenamed: renamed.length,
      totalChanges: added.length + modified.length + deleted.length + renamed.length,
    },
    added,
    modified,
    deleted,
    renamed,
    diffStat: diffStat.slice(0, 50),
    commitsAhead,
    commitsBehind,
    conflictFiles,
  };
}
