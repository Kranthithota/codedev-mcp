import { describe, it, expect } from 'vitest';
import { detectDeadCode } from '../../../src/analyzers/dead-code.js';

describe('Quality Tools - Core Functions', () => {
    const CWD = process.cwd();

    describe('detectDeadCode', () => {
        it('should analyze codebase for dead code', async () => {
            const result = await detectDeadCode(CWD);

            expect(result).toBeDefined();
            expect(result.unusedExports).toBeDefined();
            expect(Array.isArray(result.unusedExports)).toBe(true);
            expect(result.orphanFiles).toBeDefined();
            expect(Array.isArray(result.orphanFiles)).toBe(true);
            expect(result.summary).toBeDefined();
        });

        it('should return summary with counts', async () => {
            const result = await detectDeadCode(CWD);

            expect(typeof result.summary.totalUnusedExports).toBe('number');
            expect(typeof result.summary.totalOrphanFiles).toBe('number');
            expect(typeof result.summary.filesScanned).toBe('number');
        });

        it('should filter by file glob', async () => {
            const result = await detectDeadCode(CWD, { fileGlob: '*.ts' });

            expect(result).toBeDefined();
            expect(result.summary.filesScanned).toBeGreaterThan(0);
        });

        it('should filter by directory', async () => {
            const result = await detectDeadCode(CWD, { directory: 'src', fileGlob: '**/*.ts' });

            expect(result).toBeDefined();
            // Just verify it doesn't throw
            expect(result.summary).toBeDefined();
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty directory', async () => {
            const result = await detectDeadCode('/tmp');

            expect(result.unusedExports).toHaveLength(0);
            expect(result.summary.filesScanned).toBe(0);
        });

        it('should not flag common entry points', async () => {
            const result = await detectDeadCode(CWD);

            // index.ts, main.ts, etc. should not be flagged
            const flaggedEntryPoints = result.orphanFiles.filter(f =>
                /\/(index|main|app|server)\.[^/]+$/.test(f.file)
            );
            expect(flaggedEntryPoints).toHaveLength(0);
        });
    });
});
