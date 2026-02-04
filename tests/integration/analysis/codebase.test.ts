import { describe, it, expect } from 'vitest';
import { mapCodebase, mapSymbols } from '../../../src/analyzers/codebase.js';

describe('Codebase Analysis Integration', () => {
    const CWD = process.cwd();

    it('should map the current project structure', async () => {
        const result = await mapCodebase(CWD);

        expect(result).toBeDefined();
        expect(result.stats).toBeDefined();
        expect(result.stats.totalFiles).toBeGreaterThan(0);
        expect(result.stats.totalCodeFiles).toBeGreaterThan(0);
        expect(result.tree).toBeTruthy();
        expect(result.summary).toBeTruthy();
    });

    it('should detect TypeScript as primary language', async () => {
        const result = await mapCodebase(CWD);

        // This project is TypeScript
        expect(result.stats.languageBreakdown).toHaveProperty('typescript');
        expect(result.stats.languageBreakdown.typescript.files).toBeGreaterThan(0);
    });

    it('should detect frameworks', async () => {
        const result = await mapCodebase(CWD);

        // Should detect Node.js ecosystem
        expect(result.stats.packageManagers.length).toBeGreaterThan(0);
    });

    it('should extract symbols from the codebase', async () => {
        const result = await mapSymbols(CWD, { maxFiles: 20 });

        expect(result.length).toBeGreaterThan(0);
        // Each entry should have file and symbols
        const first = result[0];
        expect(first).toHaveProperty('file');
        expect(first).toHaveProperty('symbols');
    });

    it('should filter symbols by language', async () => {
        const result = await mapSymbols(CWD, {
            maxFiles: 50,
            language: 'typescript'
        });

        expect(result.length).toBeGreaterThan(0);
        // All files should be TypeScript
        const allTs = result.every(r => r.file.endsWith('.ts'));
        expect(allTs).toBe(true);
    });
});
