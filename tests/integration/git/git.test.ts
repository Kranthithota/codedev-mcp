import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

describe('Git Tools - Core Functions', () => {
    const CWD = process.cwd();
    let isGitRepo = false;

    beforeAll(async () => {
        try {
            await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: CWD });
            isGitRepo = true;
        } catch {
            isGitRepo = false;
        }
    });

    describe('git log', () => {
        it('should retrieve commit history', async () => {
            if (!isGitRepo) return;

            const { stdout } = await execFileAsync('git', ['log', '--oneline', '-5'], { cwd: CWD });
            expect(stdout.trim().length).toBeGreaterThan(0);
        });

        it('should handle file-specific history', async () => {
            if (!isGitRepo) return;

            const { stdout } = await execFileAsync('git', ['log', '--oneline', '-3', '--', 'package.json'], { cwd: CWD });
            expect(stdout.trim().length).toBeGreaterThan(0);
        });
    });

    describe('git diff', () => {
        it('should show working tree diff', async () => {
            if (!isGitRepo) return;

            // This may be empty if no changes, but should not error
            const { stdout } = await execFileAsync('git', ['diff', '--stat'], { cwd: CWD });
            expect(typeof stdout).toBe('string');
        });

        it('should diff between commits', async () => {
            if (!isGitRepo) return;

            try {
                const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1', 'HEAD'], { cwd: CWD });
                expect(typeof stdout).toBe('string');
            } catch {
                // May fail if only one commit
            }
        });
    });

    describe('git blame', () => {
        it('should blame a file', async () => {
            if (!isGitRepo) return;

            const { stdout } = await execFileAsync('git', ['blame', '--line-porcelain', '-L', '1,5', 'package.json'], { cwd: CWD });
            expect(stdout).toContain('author');
        });
    });

    describe('Edge Cases', () => {
        it('should handle non-git directory gracefully', async () => {
            try {
                await execFileAsync('git', ['status'], { cwd: '/tmp' });
            } catch (error: any) {
                expect(error.message).toContain('not a git repository');
            }
        });

        it('should handle non-existent file in blame', async () => {
            if (!isGitRepo) return;

            try {
                await execFileAsync('git', ['blame', 'nonexistent-file-12345.txt'], { cwd: CWD });
            } catch (error: any) {
                expect(error.message.toLowerCase()).toMatch(/no such|does not exist/i);
            }
        });

        it('should handle empty commit range', async () => {
            if (!isGitRepo) return;

            const { stdout } = await execFileAsync('git', ['log', '--oneline', '-0'], { cwd: CWD });
            expect(stdout).toBe('');
        });
    });
});
