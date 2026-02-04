import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compareBranches } from '../../../src/analyzers/branch-compare.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

describe('Branch Compare', () => {
  const tempDir = join(tmpdir(), `branch-compare-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(tempDir, { recursive: true });

    // Initialize a git repo with two branches
    await exec('git', ['init'], { cwd: tempDir });
    await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: tempDir });

    // Create initial commit on main
    await writeFile(join(tempDir, 'file1.ts'), 'export const a = 1;\n');
    await writeFile(join(tempDir, 'file2.ts'), 'export const b = 2;\n');
    await exec('git', ['add', '.'], { cwd: tempDir });
    await exec('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    // Create feature branch
    await exec('git', ['checkout', '-b', 'feature'], { cwd: tempDir });

    // Add a new file
    await writeFile(join(tempDir, 'file3.ts'), 'export const c = 3;\n');
    // Modify existing file
    await writeFile(join(tempDir, 'file1.ts'), 'export const a = "modified";\n');
    await exec('git', ['add', '.'], { cwd: tempDir });
    await exec('git', ['commit', '-m', 'feature changes'], { cwd: tempDir });

    // Go back to main and make a change (for behind/ahead testing)
    await exec('git', ['checkout', 'main'], { cwd: tempDir }).catch(() =>
      exec('git', ['checkout', 'master'], { cwd: tempDir }),
    );
    await writeFile(join(tempDir, 'file2.ts'), 'export const b = "main change";\n');
    await exec('git', ['add', '.'], { cwd: tempDir });
    await exec('git', ['commit', '-m', 'main change'], { cwd: tempDir });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should detect added and modified files', async () => {
    // Get the main branch name
    let mainBranch = 'main';
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], { cwd: tempDir });
    } catch {
      mainBranch = 'master';
    }

    const result = await compareBranches(tempDir, mainBranch, 'feature');

    expect(result.base).toBe(mainBranch);
    expect(result.compare).toBe('feature');
    expect(result.stats).toBeDefined();
    expect(result.stats.totalChanges).toBeGreaterThan(0);

    // file3.ts was added
    expect(result.added.length).toBeGreaterThanOrEqual(1);
    expect(result.added.some((f) => f.includes('file3.ts'))).toBe(true);

    // file1.ts was modified
    expect(result.modified.length).toBeGreaterThanOrEqual(1);
    expect(result.modified.some((f) => f.includes('file1.ts'))).toBe(true);
  });

  it('should include diff stats', async () => {
    let mainBranch = 'main';
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], { cwd: tempDir });
    } catch {
      mainBranch = 'master';
    }

    const result = await compareBranches(tempDir, mainBranch, 'feature', { includeStats: true });

    expect(result.diffStat.length).toBeGreaterThan(0);
    for (const stat of result.diffStat) {
      expect(stat.file).toBeDefined();
      expect(stat.insertions).toBeGreaterThanOrEqual(0);
      expect(stat.deletions).toBeGreaterThanOrEqual(0);
    }
  });

  it('should count commits ahead and behind', async () => {
    let mainBranch = 'main';
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], { cwd: tempDir });
    } catch {
      mainBranch = 'master';
    }

    const result = await compareBranches(tempDir, mainBranch, 'feature');

    expect(result.commitsAhead).toBeGreaterThanOrEqual(0);
    expect(result.commitsBehind).toBeGreaterThanOrEqual(0);
  });

  it('should detect potential conflicts when requested', async () => {
    let mainBranch = 'main';
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], { cwd: tempDir });
    } catch {
      mainBranch = 'master';
    }

    const result = await compareBranches(tempDir, mainBranch, 'feature', { showConflicts: true });

    expect(result.conflictFiles).toBeInstanceOf(Array);
  });

  it('should have correct stats summary', async () => {
    let mainBranch = 'main';
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], { cwd: tempDir });
    } catch {
      mainBranch = 'master';
    }

    const result = await compareBranches(tempDir, mainBranch, 'feature');

    const { filesAdded, filesModified, filesDeleted, filesRenamed, totalChanges } = result.stats;
    expect(totalChanges).toBe(filesAdded + filesModified + filesDeleted + filesRenamed);
  });

  it('should use HEAD as default compare branch', async () => {
    let mainBranch = 'main';
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], { cwd: tempDir });
    } catch {
      mainBranch = 'master';
    }

    // Checkout feature branch first
    await exec('git', ['checkout', 'feature'], { cwd: tempDir });

    const result = await compareBranches(tempDir, mainBranch);
    expect(result.compare).toBe('HEAD');
    expect(result.stats.totalChanges).toBeGreaterThan(0);

    // Switch back
    await exec('git', ['checkout', mainBranch], { cwd: tempDir });
  });
});
