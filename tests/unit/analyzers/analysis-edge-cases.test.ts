import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mapCodebase, mapSymbols } from '../../../src/analyzers/codebase.js';
import { checkArchitecture } from '../../../src/analyzers/architecture.js';
import { analyzeApiContracts } from '../../../src/analyzers/api-contract.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Extended analysis edge case tests covering:
 * - Malformed files
 * - Very deep nesting
 * - Circular dependencies
 * - Files with syntax errors
 */
describe('Analysis - Extended Edge Cases', () => {
    const CWD = process.cwd();
    let tempDir: string;

    beforeAll(async () => {
        tempDir = join(tmpdir(), `analysis-edge-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
        await mkdir(join(tempDir, 'src'), { recursive: true });
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    describe('Malformed Files', () => {
        it('should handle file with syntax errors', async () => {
            const syntaxError = join(tempDir, 'src', 'syntax-error.ts');
            await writeFile(syntaxError, `
                export function broken( {
                    // Missing closing brace
            `);

            const result = await mapSymbols(tempDir, { maxFiles: 10 });
            // Should not crash
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle file with incomplete imports', async () => {
            const incompleteImport = join(tempDir, 'src', 'incomplete.ts');
            await writeFile(incompleteImport, `
                import { something from 'somewhere'
                export const x = 1;
            `);

            const result = await mapCodebase(tempDir);
            expect(result.stats).toBeDefined();
        });

        it('should handle file with invalid JSON', async () => {
            const invalidJson = join(tempDir, 'package.json');
            await writeFile(invalidJson, '{ invalid json }');

            const result = await mapCodebase(tempDir);
            // Should complete even with invalid package.json
            expect(result.stats).toBeDefined();
        });
    });

    describe('Deep Nesting', () => {
        it('should handle deeply nested directory structure', async () => {
            const deepPath = join(tempDir, 'a/b/c/d/e/f/g/h/i/j');
            await mkdir(deepPath, { recursive: true });
            await writeFile(join(deepPath, 'deep.ts'), 'export const deep = true;');

            const result = await mapCodebase(tempDir);
            expect(result.stats.totalFiles).toBeGreaterThan(0);
        });

        it('should handle deeply nested code blocks', async () => {
            const deepNesting = join(tempDir, 'src', 'deep-nesting.ts');
            const code = `
export function deep() {
    if (true) {
        if (true) {
            if (true) {
                if (true) {
                    if (true) {
                        if (true) {
                            if (true) {
                                return 'deep';
                            }
                        }
                    }
                }
            }
        }
    }
}`;
            await writeFile(deepNesting, code);

            const result = await mapSymbols(tempDir, { maxFiles: 20 });
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('Circular Dependencies', () => {
        it('should detect circular imports', async () => {
            await writeFile(join(tempDir, 'src', 'a.ts'), `import { b } from './b'; export const a = 'a';`);
            await writeFile(join(tempDir, 'src', 'b.ts'), `import { a } from './a'; export const b = 'b';`);

            const result = await checkArchitecture(tempDir);
            // Should detect circular import or at least not crash
            expect(result.violations).toBeDefined();
        });

        it('should handle self-importing file', async () => {
            await writeFile(join(tempDir, 'src', 'self.ts'), `import { x } from './self'; export const x = 1;`);

            const result = await checkArchitecture(tempDir);
            expect(result).toBeDefined();
        });
    });

    describe('Edge Case Content', () => {
        it('should handle file with only comments', async () => {
            const onlyComments = join(tempDir, 'src', 'comments.ts');
            await writeFile(onlyComments, `
// This file has only comments
/* Multi-line
   comment */
// More comments
`);

            const result = await mapSymbols(tempDir, { maxFiles: 30 });
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle very large file', async () => {
            const largeFile = join(tempDir, 'src', 'large.ts');
            let content = 'export const items = [\n';
            for (let i = 0; i < 1000; i++) {
                content += `  { id: ${i}, name: 'item${i}' },\n`;
            }
            content += '];\n';
            await writeFile(largeFile, content);

            const result = await mapSymbols(tempDir, { maxFiles: 50 });
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle file with unicode function names', async () => {
            const unicodeFile = join(tempDir, 'src', 'unicode.ts');
            await writeFile(unicodeFile, `
export function 计算() { return 1; }
export function λ() { return 2; }
export const π = 3.14;
`);

            const result = await mapSymbols(tempDir, { maxFiles: 50 });
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('API Contract Edge Cases', () => {
        it('should handle OpenAPI spec with missing fields', async () => {
            const incompleteSpec = join(tempDir, 'openapi.yaml');
            await writeFile(incompleteSpec, `
openapi: 3.0.0
info:
  title: Test
  # Missing version
paths: {}
`);

            const result = await analyzeApiContracts(tempDir);
            expect(result).toBeDefined();
        });
    });
});
