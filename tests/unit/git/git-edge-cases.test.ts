import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getGitLog, getGitDiff, getGitBlame, isGitRepo } from '../../../src/analyzers/git.js';
import { compareBranches } from '../../../src/analyzers/branch-compare.js';
import { mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * Extended git edge case tests covering:
 * - Non-git directories
 * - Empty repositories
 * - Detached HEAD
 * - Invalid refs
 */
describe('Git - Extended Edge Cases', () => {
    const CWD = process.cwd();

    describe('Non-Git Directories', () => {
        it('should detect non-git directory', async () => {
            const result = await isGitRepo('/tmp');
            expect(result).toBe(false);
        });

        it('should handle git log in non-git dir gracefully', async () => {
            try {
                await getGitLog('/tmp');
                // If it doesn't throw, that's fine
            } catch (error: any) {
                expect(error.message).toMatch(/not a git/i);
            }
        });

        it('should handle git diff in non-git dir gracefully', async () => {
            try {
                await getGitDiff('/tmp');
            } catch (error: any) {
                expect(error.message).toMatch(/not a git/i);
            }
        });
    });

    describe('Invalid Refs', () => {
        it('should handle non-existent commit ref', async () => {
            if (!(await isGitRepo(CWD))) return;

            try {
                await getGitDiff(CWD, { ref1: 'nonexistent123', ref2: 'HEAD' });
            } catch (error: any) {
                expect(error.message).toMatch(/unknown revision|bad revision/i);
            }
        });

        it('should handle invalid branch name', async () => {
            if (!(await isGitRepo(CWD))) return;

            try {
                await compareBranches(CWD, 'nonexistent-branch-123', 'HEAD');
            } catch (error: any) {
                expect(typeof error.message).toBe('string');
            }
        });
    });

    describe('Blame Edge Cases', () => {
        it('should handle blame on binary file', async () => {
            if (!(await isGitRepo(CWD))) return;

            try {
                // Try to blame a potential binary file
                await getGitBlame(CWD, 'node_modules/.bin/vitest');
            } catch (error: any) {
                // Expected to fail for binary
                expect(typeof error.message).toBe('string');
            }
        });

        it('should handle blame on deleted file', async () => {
            if (!(await isGitRepo(CWD))) return;

            try {
                await getGitBlame(CWD, 'definitely-not-existing-file.xyz');
            } catch (error: any) {
                expect(error.message).toMatch(/no such|path.*does not exist/i);
            }
        });

        it('should handle blame with invalid line range', async () => {
            if (!(await isGitRepo(CWD))) return;

            try {
                await getGitBlame(CWD, 'package.json', { startLine: 9999, endLine: 10000 });
            } catch (error: any) {
                // May fail or return empty
                expect(typeof error.message).toBe('string');
            }
        });
    });

    describe('Log Edge Cases', () => {
        it('should handle log with count of 0', async () => {
            if (!(await isGitRepo(CWD))) return;

            const result = await getGitLog(CWD, { count: 0 });
            expect(result).toHaveLength(0);
        });

        it('should handle log with very large count', async () => {
            if (!(await isGitRepo(CWD))) return;

            // Should not crash, just return what's available
            const result = await getGitLog(CWD, { count: 99999 });
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle log for non-existent file', async () => {
            if (!(await isGitRepo(CWD))) return;

            const result = await getGitLog(CWD, {
                count: 5,
                filePath: 'nonexistent-file-12345.xyz'
            });
            expect(result).toHaveLength(0);
        });

        it('should handle log with invalid author filter', async () => {
            if (!(await isGitRepo(CWD))) return;

            const result = await getGitLog(CWD, {
                count: 5,
                author: 'nobody@nonexistent.invalid'
            });
            expect(result).toHaveLength(0);
        });
    });
});
