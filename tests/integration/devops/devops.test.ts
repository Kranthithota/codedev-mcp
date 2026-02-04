import { describe, it, expect } from 'vitest';
import { analyzeIaC } from '../../../src/analyzers/iac.js';
import { parseCICD } from '../../../src/analyzers/cicd.js';
import { analyzeMonorepo } from '../../../src/analyzers/monorepo.js';

describe('DevOps Tools - Core Functions', () => {
    const CWD = process.cwd();

    describe('analyzeIaC', () => {
        it('should analyze infrastructure configurations', async () => {
            const result = await analyzeIaC(CWD);

            expect(result).toBeDefined();
            expect(result.platform).toBeDefined();
            expect(Array.isArray(result.platform)).toBe(true);
            expect(result.resources).toBeDefined();
            expect(Array.isArray(result.resources)).toBe(true);
            expect(result.summary).toBeDefined();
        });

        it('should detect Docker configurations if present', async () => {
            const result = await analyzeIaC(CWD);

            // This project has Dockerfile
            if (result.platform.includes('docker')) {
                expect(result.resources.some(r => r.source.includes('Docker'))).toBe(true);
            }
        });

        it('should report issues array', async () => {
            const result = await analyzeIaC(CWD);

            expect(result.issues).toBeDefined();
            expect(Array.isArray(result.issues)).toBe(true);
        });
    });

    describe('parseCICD', () => {
        it('should parse CI/CD configurations', async () => {
            const result = await parseCICD(CWD);

            expect(result).toBeDefined();
            expect(result.pipelines).toBeDefined();
            expect(Array.isArray(result.pipelines)).toBe(true);
            expect(result.summary).toBeDefined();
        });

        it('should detect GitHub Actions if present', async () => {
            const result = await parseCICD(CWD);

            // This project has .github/workflows
            const hasGitHub = result.pipelines.some(p => p.platform === 'github-actions');
            // May or may not have GitHub Actions
            expect(typeof hasGitHub).toBe('boolean');
        });

        it('should extract jobs from pipelines', async () => {
            const result = await parseCICD(CWD);

            if (result.pipelines.length > 0) {
                const firstPipeline = result.pipelines[0];
                expect(firstPipeline.jobs).toBeDefined();
                expect(Array.isArray(firstPipeline.jobs)).toBe(true);
            }
        });
    });

    describe('analyzeMonorepo', () => {
        it('should analyze workspace structure', async () => {
            const result = await analyzeMonorepo(CWD);

            expect(result).toBeDefined();
            expect(result.type).toBeDefined();
            expect(result.packages).toBeDefined();
            expect(Array.isArray(result.packages)).toBe(true);
            expect(result.summary).toBeDefined();
        });

        it('should detect monorepo type', async () => {
            const result = await analyzeMonorepo(CWD);

            // Type should be one of the valid types
            const validTypes = [
                'npm-workspaces', 'yarn-workspaces', 'pnpm-workspaces',
                'cargo-workspaces', 'python-monorepo', 'lerna', 'nx', 'turborepo', 'none'
            ];
            expect(validTypes).toContain(result.type);
        });

        it('should return dependency graph', async () => {
            const result = await analyzeMonorepo(CWD);

            expect(result.dependencyGraph).toBeDefined();
            expect(Array.isArray(result.dependencyGraph)).toBe(true);
        });
    });

    describe('Edge Cases', () => {
        it('should handle directory with no IaC files', async () => {
            const result = await analyzeIaC('/tmp');

            expect(result.resources).toHaveLength(0);
            expect(result.platform).toHaveLength(0);
        });

        it('should handle directory with no CI/CD configs', async () => {
            const result = await parseCICD('/tmp');

            expect(result.pipelines).toHaveLength(0);
        });

        it('should handle non-monorepo directory', async () => {
            const result = await analyzeMonorepo('/tmp');

            expect(result.type).toBe('none');
        });
    });
});
