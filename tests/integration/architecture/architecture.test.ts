import { describe, it, expect } from 'vitest';
import { checkArchitecture } from '../../../src/analyzers/architecture.js';
import { analyzeApiContracts } from '../../../src/analyzers/api-contract.js';

describe('Architecture Tools - Core Functions', () => {
    const CWD = process.cwd();

    describe('checkArchitecture', () => {
        it('should analyze architecture and return result', async () => {
            const result = await checkArchitecture(CWD);

            expect(result).toBeDefined();
            // ArchResult has: violations, rulesChecked, filesTested, passed, summary
            expect(result.violations).toBeDefined();
            expect(Array.isArray(result.violations)).toBe(true);
            expect(typeof result.rulesChecked).toBe('number');
            expect(typeof result.filesTested).toBe('number');
            expect(typeof result.passed).toBe('boolean');
        });

        it('should detect layer violations if configured', async () => {
            const result = await checkArchitecture(CWD);

            // Violations array should exist (may be empty if no violations)
            expect(result.violations).toBeDefined();
            expect(result.summary).toBeDefined();
            expect(typeof result.summary.errors).toBe('number');
            expect(typeof result.summary.warnings).toBe('number');
        });

        it('should respect file glob filter', async () => {
            const result = await checkArchitecture(CWD, { fileGlob: '*.ts' });

            expect(result).toBeDefined();
            expect(result.filesTested).toBeGreaterThan(0);
        });
    });

    describe('analyzeApiContracts', () => {
        it('should discover API endpoints', async () => {
            const result = await analyzeApiContracts(CWD);

            expect(result).toBeDefined();
            // Check that result has expected structure
            expect(typeof result).toBe('object');
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty directory gracefully', async () => {
            const result = await checkArchitecture('/tmp');

            expect(result).toBeDefined();
            expect(result.violations).toBeDefined();
            expect(result.passed).toBe(true); // No violations in empty dir
        });

        it('should handle builtin rules toggle', async () => {
            const withRules = await checkArchitecture(CWD, { builtinRules: true });
            const withoutRules = await checkArchitecture(CWD, { builtinRules: false });

            expect(withRules.rulesChecked).toBeGreaterThanOrEqual(withoutRules.rulesChecked);
        });
    });
});
