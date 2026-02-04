import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as codebase from '../../../src/analyzers/codebase.js';
import * as fastSearch from '../../../src/search/fast-search.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';

// Mock dependencies
vi.mock('../../../src/search/fast-search.js');
vi.mock('node:fs/promises');
vi.mock('../../../src/utils/languages', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        detectLanguage: vi.fn((file: string) => {
            // Mock logic
            if (file.endsWith('.ts')) return 'typescript';
            if (file.endsWith('.json')) return 'json';
            return 'unknown';
        }),
        isCodeFile: vi.fn((file: string) => file.endsWith('.ts')),
    };
});
vi.mock('../../../src/analyzers/symbols', () => ({
    extractSymbols: vi.fn().mockResolvedValue([{ name: 'testSymbol', type: 'function' }]),
}));

describe('Codebase Analyzer', () => {
    beforeEach(() => {
        vi.clearAllMocks(); // Using clear instead of reset to keep mock implementations but clear calls
    });

    describe('mapCodebase', () => {
        it('should generate correct stats for a mocked file list', async () => {
            // Mock listFiles
            vi.mocked(fastSearch.listFiles).mockResolvedValue([
                'src/index.ts',
                'src/utils.ts',
                'package.json',
                'README.md',
                'tests/main.test.ts',
            ]);

            // Mock fs.readdir for tree generation
            vi.mocked(fs.readdir).mockResolvedValue([
                { name: 'src', isDirectory: () => true },
                { name: 'package.json', isDirectory: () => false },
            ] as any);

            // Mock package.json read
            vi.mocked(fs.readFile).mockImplementation((pathStr) => {
                if (String(pathStr).endsWith('package.json')) {
                    return Promise.resolve('{"dependencies": {"react": "^18.0.0"}}');
                }
                return Promise.reject(new Error('not found'));
            });

            const result = await codebase.mapCodebase('/app');

            expect(result.stats.totalFiles).toBe(5);
            expect(result.stats.totalCodeFiles).toBe(3); // .ts files
            expect(result.stats.languageBreakdown.typescript).toBeDefined();
            expect(result.stats.frameworks).toContain('React');
            expect(result.stats.hasTests).toBe(true);
            expect(result.stats.estimatedSize).toBe('small');
        });
    });

    describe('mapSymbols', () => {
        it('should extract symbols from code files only', async () => {
            vi.mocked(fastSearch.listFiles).mockResolvedValue(['main.ts', 'config.json']);

            const results = await codebase.mapSymbols('/app');

            expect(results).toHaveLength(1); // Only main.ts
            expect(results[0].file).toBe('main.ts');
            expect(results[0].symbols).toHaveLength(1);
        });

        it('should respect maxFiles limit', async () => {
            const files = Array(10).fill(null).map((_, i) => `file${i}.ts`);
            vi.mocked(fastSearch.listFiles).mockResolvedValue(files);

            const results = await codebase.mapSymbols('/app', { maxFiles: 5 });
            expect(results).toHaveLength(5);
        });
    });
});
