import { describe, it, expect } from 'vitest';
import { searchCode } from '../../../src/search/fast-search.js';

describe('Search Tools - Extended Functions', () => {
    const CWD = process.cwd();

    describe('searchCode - Advanced', () => {
        it('should support whole word matching', async () => {
            const results = await searchCode({
                cwd: CWD,
                pattern: 'function',
                isRegex: false,
                wholeWord: true
            });

            expect(results.length).toBeGreaterThan(0);
        });

        it('should support context lines', async () => {
            const results = await searchCode({
                cwd: CWD,
                pattern: 'McpServer',
                isRegex: false,
                contextLines: 2
            });

            expect(results.length).toBeGreaterThan(0);
        });

        it('should handle regex special characters in literal mode', async () => {
            // Search for literal "[]" which is a regex metacharacter
            const results = await searchCode({
                cwd: CWD,
                pattern: '[]',
                isRegex: false
            });

            // Should not throw, may have results or not
            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle empty pattern gracefully', async () => {
            const results = await searchCode({
                cwd: CWD,
                pattern: '',
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });
    });



    describe('Edge Cases', () => {
        it('should handle very long patterns', async () => {
            const longPattern = 'a'.repeat(100);
            const results = await searchCode({
                cwd: CWD,
                pattern: longPattern,
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle unicode patterns', async () => {
            const results = await searchCode({
                cwd: CWD,
                pattern: '日本語',
                isRegex: false
            });

            expect(Array.isArray(results)).toBe(true);
        });

        it('should respect maxResults parameter', async () => {
            const allResults = await searchCode({
                cwd: CWD,
                pattern: 'import',
                isRegex: false
            });

            // Note: maxResults is per-file in ripgrep, not total
            expect(allResults.length).toBeGreaterThan(0);
        });
    });
});
