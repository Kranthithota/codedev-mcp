import { describe, it, expect } from 'vitest';
import { readFileRange, listFiles } from '../../../src/search/fast-search.js';
import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('Navigation Tools - Core Functions', () => {
    const CWD = process.cwd();

    describe('readFileRange', () => {
        it('should read entire file when no range specified', async () => {
            const result = await readFileRange(join(CWD, 'package.json'));

            expect(result.content).toContain('codedev-mcp');
            expect(result.totalLines).toBeGreaterThan(0);
        });

        it('should read specific line range', async () => {
            const result = await readFileRange(join(CWD, 'package.json'), 1, 5);

            // sed returns lines 1-5, but may include trailing newline
            const lines = result.content.split('\n').filter(l => l.trim());
            expect(lines.length).toBeLessThanOrEqual(6);
        });

        it('should handle start line only', async () => {
            const result = await readFileRange(join(CWD, 'package.json'), 3);

            expect(result.content).toBeTruthy();
            expect(result.totalLines).toBeGreaterThan(0);
        });

        it('should throw for non-existent file', async () => {
            await expect(
                readFileRange(join(CWD, 'nonexistent-file-12345.txt'))
            ).rejects.toThrow();
        });
    });

    describe('listFiles', () => {
        it('should list files in project root', async () => {
            const files = await listFiles(CWD, { type: 'file' });

            expect(files.length).toBeGreaterThan(0);
            expect(files.some(f => f.includes('package.json'))).toBe(true);
        });

        it('should filter by glob pattern', async () => {
            const files = await listFiles(CWD, {
                type: 'file',
                glob: '*.ts'
            });

            const allTs = files.every(f => f.endsWith('.ts'));
            expect(allTs).toBe(true);
        });

        it('should respect maxDepth', async () => {
            const shallow = await listFiles(CWD, { maxDepth: 1 });
            const deep = await listFiles(CWD, { maxDepth: 5 });

            expect(shallow.length).toBeLessThanOrEqual(deep.length);
        });

        it('should filter directories only', async () => {
            const dirs = await listFiles(CWD, { type: 'dir', maxDepth: 2 });

            expect(dirs.length).toBeGreaterThan(0);
        });

        it('should exclude node_modules by default', async () => {
            const files = await listFiles(CWD, { type: 'file' });

            const hasNodeModules = files.some(f => f.includes('node_modules'));
            expect(hasNodeModules).toBe(false);
        });
    });

    describe('Edge Cases', () => {
        let tempDir: string;

        beforeAll(async () => {
            tempDir = join(tmpdir(), `nav-test-${Date.now()}`);
            await mkdir(tempDir, { recursive: true });
        });

        afterAll(async () => {
            await rm(tempDir, { recursive: true, force: true });
        });

        it('should handle empty directory', async () => {
            const emptyDir = join(tempDir, 'empty');
            await mkdir(emptyDir, { recursive: true });

            const files = await listFiles(emptyDir, { type: 'file' });
            // fd may return '.' for current directory, filter it out
            const actualFiles = files.filter(f => f !== '.' && f !== '');
            expect(actualFiles).toHaveLength(0);
        });

        it('should handle file with special characters in name', async () => {
            const specialFile = join(tempDir, 'file with spaces & symbols.txt');
            await writeFile(specialFile, 'content');

            const files = await listFiles(tempDir);
            expect(files.some(f => f.includes('file with spaces'))).toBe(true);
        });

        it('should handle large line range gracefully', async () => {
            const result = await readFileRange(join(CWD, 'package.json'), 1, 99999);

            expect(result.content).toBeTruthy();
            expect(result.totalLines).toBeGreaterThan(0);
        });

        it('should handle unicode content', async () => {
            const unicodeFile = join(tempDir, 'unicode.txt');
            await writeFile(unicodeFile, '你好世界\nこんにちは\n🎉');

            const result = await readFileRange(unicodeFile);
            expect(result.content).toContain('你好世界');
            expect(result.content).toContain('🎉');
        });
    });
});
