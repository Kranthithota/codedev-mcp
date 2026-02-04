import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from '../../../src/db/sqlite-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

describe('Database Integration', () => {
    let store: SqliteStore;
    const testDir = join(tmpdir(), `codedev-test-${Date.now()}`);

    beforeEach(async () => {
        store = new SqliteStore(testDir);
        await store.init(testDir);
    });

    afterEach(async () => {
        store.close();
        // Clean up temp directory
        try {
            await rm(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    it('should persist and retrieve file data', async () => {
        const testFile = {
            path: '/test/file.ts',
            mtime: Date.now(),
            lines: 100,
            language: 'typescript',
            size: 1024
        };

        store.updateFile(testFile);
        await store.save();

        const files = store.getFiles();
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe(testFile.path);
    });

    it('should persist and retrieve symbols', async () => {
        const testSymbols = [
            { name: 'TestClass', type: 'class', file: '/test/file.ts', line: 10, exported: true },
            { name: 'testFunction', type: 'function', file: '/test/file.ts', line: 20, exported: false }
        ];

        store.updateSymbols('/test/file.ts', testSymbols);
        await store.save();

        const found = store.findSymbols('TestClass');
        expect(found).toHaveLength(1);
        expect(found[0].name).toBe('TestClass');
    });

    it('should handle concurrent operations', async () => {
        // Simulate concurrent writes
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(
                Promise.resolve().then(() => {
                    store.logUsage(`tool_${i}`, i * 10, true, false);
                })
            );
        }

        await Promise.all(promises);

        const stats = store.getUsageStats();
        expect(stats.length).toBe(10);
    });

    it('should survive save/load cycle', async () => {
        store.updateFile({
            path: '/persist/test.ts',
            mtime: Date.now(),
            lines: 50,
            language: 'typescript',
            size: 512
        });

        store.logUsage('test_tool', 100, true, false);

        await store.save();

        // Create new instance and load
        const store2 = new SqliteStore(testDir);
        await store2.init(testDir);
        await store2.load();

        const files = store2.getFiles();
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/persist/test.ts');

        const stats = store2.getUsageStats();
        expect(stats).toHaveLength(1);

        store2.close();
    });
});
