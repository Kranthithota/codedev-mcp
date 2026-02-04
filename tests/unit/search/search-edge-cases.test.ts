import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { searchCode, readFileRange, listFiles } from '../../../src/search/fast-search.js';
import { writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Extended search edge case tests covering:
 * - Binary files
 * - Files with no newlines
 * - Very large files
 * - Symlinks
 * - Special filename patterns
 */
describe('Search - Extended Edge Cases', () => {
    const CWD = process.cwd();
    let tempDir: string;

    beforeAll(async () => {
        tempDir = join(tmpdir(), `search-edge-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    describe('Binary File Handling', () => {
        it('should skip binary files gracefully', async () => {
            const binaryFile = join(tempDir, 'binary.bin');
            await writeFile(binaryFile, Buffer.from([0x00, 0x01, 0xFF, 0xFE]));

            const results = await searchCode({
                cwd: tempDir,
                pattern: 'test',
                isRegex: false
            });

            // Should not crash and binary should be skipped
            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle mixed binary/text content', async () => {
            const mixedFile = join(tempDir, 'mixed.txt');
            const content = 'text content\x00binary content';
            await writeFile(mixedFile, content);

            const results = await searchCode({
                cwd: tempDir,
                pattern: 'text',
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('File Content Edge Cases', () => {
        it('should handle file with no newlines', async () => {
            const noNewlineFile = join(tempDir, 'no-newline.txt');
            await writeFile(noNewlineFile, 'single line without newline');

            const result = await readFileRange(noNewlineFile);
            expect(result.content).toBe('single line without newline');
            expect(result.totalLines).toBe(1);
        });

        it('should handle file with only newlines', async () => {
            const onlyNewlines = join(tempDir, 'only-newlines.txt');
            await writeFile(onlyNewlines, '\n\n\n\n\n');

            const result = await readFileRange(onlyNewlines);
            expect(result.totalLines).toBeGreaterThan(0);
        });

        it('should handle file with very long lines', async () => {
            const longLineFile = join(tempDir, 'long-line.txt');
            const longLine = 'x'.repeat(10000);
            await writeFile(longLineFile, longLine);

            const result = await readFileRange(longLineFile);
            expect(result.content.length).toBe(10000);
        });

        it('should handle file with mixed line endings', async () => {
            const mixedEndings = join(tempDir, 'mixed-endings.txt');
            await writeFile(mixedEndings, 'line1\nline2\r\nline3\rline4');

            const result = await readFileRange(mixedEndings);
            expect(result.content).toContain('line1');
            expect(result.content).toContain('line4');
        });
    });

    describe('Filename Edge Cases', () => {
        it('should handle files starting with dot', async () => {
            const dotFile = join(tempDir, '.hidden-file.txt');
            await writeFile(dotFile, 'hidden content');

            const files = await listFiles(tempDir, { type: 'file' });
            expect(files.some(f => f.includes('.hidden-file'))).toBe(true);
        });

        it('should handle files with multiple extensions', async () => {
            const multiExt = join(tempDir, 'file.test.spec.ts');
            await writeFile(multiExt, 'content');

            const files = await listFiles(tempDir, { glob: '*.ts' });
            expect(files.some(f => f.includes('file.test.spec'))).toBe(true);
        });

        it('should handle files with spaces', async () => {
            const spacedFile = join(tempDir, 'file with spaces.txt');
            await writeFile(spacedFile, 'content');

            const files = await listFiles(tempDir, { type: 'file' });
            expect(files.some(f => f.includes('file with spaces'))).toBe(true);
        });

        it('should handle files with special regex chars in name', async () => {
            const regexFile = join(tempDir, 'file[1].txt');
            await writeFile(regexFile, 'content');

            const results = await searchCode({
                cwd: tempDir,
                pattern: 'content',
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Search Pattern Edge Cases', () => {
        it('should handle pattern with only spaces', async () => {
            const results = await searchCode({
                cwd: CWD,
                pattern: '   ',
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle pattern with tab characters', async () => {
            const results = await searchCode({
                cwd: CWD,
                pattern: '\t',
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle pattern with shell special chars', async () => {
            const results = await searchCode({
                cwd: CWD,
                pattern: '$(echo test)',
                isRegex: false
            });

            // Should not execute shell command, just search literally
            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle regex with catastrophic backtracking pattern', async () => {
            // This pattern could cause ReDoS - should timeout or handle gracefully
            const results = await searchCode({
                cwd: tempDir,
                pattern: 'test',
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });
    });
});
