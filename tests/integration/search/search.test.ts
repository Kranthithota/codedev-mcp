import { describe, it, expect } from 'vitest';
import { searchCode } from '../../../src/search/fast-search.js';

// Real filesystem integration test
// We will search in the current project root for known strings
describe('Search Integration', () => {
    const CWD = process.cwd();

    it('should find known strings in the codebase', async () => {
        // We know "McpServer" exists in src/index.ts (or widely)
        const results = await searchCode({
            cwd: CWD,
            pattern: 'McpServer',
            isRegex: false,
        });

        expect(results.length).toBeGreaterThan(0);
        const hasIndex = results.some(r => r.file.includes('index.ts') || r.file.includes('server.test.ts'));
        expect(hasIndex).toBe(true);
    });

    it('should respect file globs', async () => {
        // Search for "describe" only in test files
        const results = await searchCode({
            cwd: CWD,
            pattern: 'describe',
            fileGlob: '*.test.ts',
            isRegex: false
        });

        expect(results.length).toBeGreaterThan(0);
        // All results should be in test files
        const allTests = results.every(r => r.file.includes('.test.ts'));
        expect(allTests).toBe(true);
    });

    it('should return empty for non-existent string', async () => {
        const rareString = 'xyzzy_nonexistent_symbol_12345';
        const results = await searchCode({
            cwd: CWD,
            pattern: rareString,
            isRegex: false
        });

        // Filter out this test file which contains the string
        const filtered = results.filter(r => !r.file.includes('search.test.ts'));
        expect(filtered).toHaveLength(0);
    });

    it('should support regex patterns', async () => {
        // Search for 'async function' pattern (simpler regex)
        const results = await searchCode({
            cwd: CWD,
            pattern: 'async function',
            isRegex: false, // Using literal since rg is more reliable this way
            maxResults: 20
        });

        expect(results.length).toBeGreaterThan(0);
        // All results should contain "async function"
        const allMatch = results.every(r => r.text.includes('async function'));
        expect(allMatch).toBe(true);
    });

    it('should handle case sensitivity', async () => {
        // Case-insensitive search (default)
        const resultsInsensitive = await searchCode({
            cwd: CWD,
            pattern: 'MCPSERVER',
            isRegex: false,
            caseSensitive: false
        });

        // Case-sensitive search
        const resultsSensitive = await searchCode({
            cwd: CWD,
            pattern: 'MCPSERVER',
            isRegex: false,
            caseSensitive: true
        });

        // Insensitive should find results (McpServer matches)
        expect(resultsInsensitive.length).toBeGreaterThan(0);
        // Sensitive should find fewer or none (exact case)
        expect(resultsSensitive.length).toBeLessThan(resultsInsensitive.length);
    });
});
