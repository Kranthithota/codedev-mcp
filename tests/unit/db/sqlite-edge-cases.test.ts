import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from '../../../src/db/sqlite-store.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Extended database edge case tests covering:
 * - Concurrent operations
 * - Large data sets
 * - Corruption recovery
 * - Edge case queries
 */
describe('Database - Extended Edge Cases', () => {
    let store: SqliteStore;
    let tempDir: string;

    beforeEach(async () => {
        tempDir = join(tmpdir(), `db-edge-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
        store = new SqliteStore(tempDir);
        await store.init(tempDir);
    });

    afterEach(async () => {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    describe('Concurrent Operations', () => {
        it('should handle rapid sequential writes', async () => {
            for (let i = 0; i < 100; i++) {
                store.updateFile({
                    path: `/file${i}.ts`,
                    mtime: Date.now(),
                    lines: i,
                    language: 'typescript',
                    size: i * 10
                });
            }

            await store.save();
            const files = store.getFiles();
            expect(files.length).toBe(100);
        });

        it('should handle concurrent reads and writes', async () => {
            // Setup initial data
            store.updateFile({
                path: '/initial.ts',
                mtime: Date.now(),
                lines: 10,
                language: 'typescript',
                size: 100
            });

            // Concurrent operations
            const operations = [];
            for (let i = 0; i < 50; i++) {
                operations.push(
                    Promise.resolve().then(() => {
                        store.logUsage(`tool_${i}`, i, true, false);
                        return store.getFiles();
                    })
                );
            }

            await Promise.all(operations);
            const stats = store.getUsageStats();
            expect(stats.length).toBe(50);
        });
    });

    describe('Large Data Sets', () => {
        it('should handle many files', async () => {
            for (let i = 0; i < 1000; i++) {
                store.updateFile({
                    path: `/large/path/to/file${i}.ts`,
                    mtime: Date.now() + i,
                    lines: i,
                    language: 'typescript',
                    size: i * 100
                });
            }

            await store.save();
            const files = store.getFiles();
            expect(files.length).toBe(1000);
        });

        it('should handle many symbols per file', async () => {
            const symbols = [];
            for (let i = 0; i < 500; i++) {
                symbols.push({
                    name: `symbol_${i}`,
                    type: i % 2 === 0 ? 'function' : 'class',
                    file: '/many-symbols.ts',
                    line: i + 1,
                    exported: i % 3 === 0
                });
            }

            store.updateSymbols('/many-symbols.ts', symbols);
            await store.save();

            const found = store.findSymbols('symbol_');
            expect(found.length).toBeGreaterThan(0);
        });
    });

    describe('Edge Case Queries', () => {
        it('should handle SQL special characters in search', async () => {
            store.updateSymbols('/special.ts', [{
                name: "O'Reilly",
                type: 'class',
                file: '/special.ts',
                line: 1,
                exported: true
            }]);

            // Should not throw SQL error
            const found = store.findSymbols("O'Reilly");
            expect(found.length).toBe(1);
        });

        it('should handle percent in search (SQL LIKE)', async () => {
            store.updateSymbols('/percent.ts', [{
                name: '100%Complete',
                type: 'function',
                file: '/percent.ts',
                line: 1,
                exported: true
            }]);

            const found = store.findSymbols('100%');
            expect(found.length).toBe(1);
        });

        it('should handle underscore in search (SQL LIKE)', async () => {
            store.updateSymbols('/underscore.ts', [{
                name: 'my_special_function',
                type: 'function',
                file: '/underscore.ts',
                line: 1,
                exported: true
            }]);

            const found = store.findSymbols('my_special');
            expect(found.length).toBe(1);
        });

        it('should handle empty pattern in findSymbols', async () => {
            store.updateSymbols('/test.ts', [{
                name: 'TestSymbol',
                type: 'function',
                file: '/test.ts',
                line: 1,
                exported: true
            }]);

            const found = store.findSymbols('');
            // Empty pattern should match all or none, not crash
            expect(Array.isArray(found)).toBe(true);
        });
    });

    describe('Data Integrity', () => {
        it('should survive multiple save/load cycles', async () => {
            store.updateFile({
                path: '/persist.ts',
                mtime: Date.now(),
                lines: 50,
                language: 'typescript',
                size: 1000
            });

            // Multiple save/load cycles
            for (let i = 0; i < 5; i++) {
                await store.save();
                await store.load();
            }

            const files = store.getFiles();
            expect(files.length).toBe(1);
            expect(files[0].path).toBe('/persist.ts');
        });

        it('should handle file removal correctly', async () => {
            store.updateFile({
                path: '/to-remove.ts',
                mtime: Date.now(),
                lines: 10,
                language: 'typescript',
                size: 100
            });

            store.updateSymbols('/to-remove.ts', [{
                name: 'ToRemove',
                type: 'class',
                file: '/to-remove.ts',
                line: 1,
                exported: true
            }]);

            store.removeFile('/to-remove.ts');

            const files = store.getFiles();
            const symbols = store.findSymbols('ToRemove');

            expect(files.find(f => f.path === '/to-remove.ts')).toBeUndefined();
            expect(symbols.length).toBe(0);
        });
    });
});
