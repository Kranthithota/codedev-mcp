import { describe, it, expect } from 'vitest';
import { securityScan } from '../../../src/analyzers/security.js';

describe('Security Tools - Core Functions', () => {
    const CWD = process.cwd();

    describe('securityScan', () => {
        it('should scan codebase for security issues', async () => {
            const result = await securityScan(CWD, {});

            expect(result).toBeDefined();
            expect(result.totalFindings).toBeGreaterThanOrEqual(0);
            expect(result.bySeverity).toBeDefined();
        });

        it('should filter by severity', async () => {
            const result = await securityScan(CWD, { severity: 'critical' });

            if (result.findings.length > 0) {
                const allCritical = result.findings.every(f => f.severity === 'critical');
                expect(allCritical).toBe(true);
            }
        });

        it('should filter by category', async () => {
            const result = await securityScan(CWD, { category: 'secrets' });

            expect(result).toBeDefined();
            expect(result.totalFindings).toBeGreaterThanOrEqual(0);
        });

        it('should filter by file glob', async () => {
            const result = await securityScan(CWD, { fileGlob: '*.ts' });

            if (result.findings.length > 0) {
                const allTs = result.findings.every(f => f.file.endsWith('.ts'));
                expect(allTs).toBe(true);
            }
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty directory', async () => {
            // This should not throw
            const result = await securityScan('/tmp', {});
            expect(result.totalFindings).toBeGreaterThanOrEqual(0);
        });

        it('should return proper severity breakdown', async () => {
            const result = await securityScan(CWD, {});

            const severities = ['critical', 'high', 'medium', 'low'];
            for (const sev of severities) {
                if (result.bySeverity[sev] !== undefined) {
                    expect(typeof result.bySeverity[sev]).toBe('number');
                }
            }
        });
    });
});
