
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from '../../../src/db/sqlite-store.js';
import path from 'node:path';

// Mock fs/promises
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockStat = vi.fn();

vi.mock('node:fs/promises', () => ({
    readFile: (...args: any[]) => mockReadFile(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
    stat: (...args: any[]) => mockStat(...args),
}));

describe('SqliteStore', () => {
    let store: SqliteStore;
    const CWD = '/mock/cwd';

    beforeEach(async () => {
        vi.clearAllMocks();
        store = new SqliteStore(CWD);
        await store.init(CWD); // Initialize fresh DB in memory for each test
    });

    afterEach(() => {
        store.close();
    });

    describe('Initialization', () => {
        it('should initialize with empty tables', async () => {
            const stats = store.stats();
            expect(stats).toBeTruthy();
            expect(stats?.files).toBe(0);
            expect(stats?.symbols).toBe(0);
        });
    });

    describe('Symbol Operations', () => {
        it('should insert and retrieve symbols', () => {
            const file = '/mock/cwd/src/test.ts';
            const symbols = [
                { name: 'TestClass', type: 'class', file, line: 10, exported: true },
                { name: 'helper', type: 'function', file, line: 20, exported: false },
            ];

            store.updateSymbols(file, symbols);

            const found = store.findSymbols('TestClass');
            expect(found).toHaveLength(1);
            expect(found[0].name).toBe('TestClass');
            expect(found[0].type).toBe('class');

            const foundHelper = store.findSymbols('helper');
            expect(foundHelper).toHaveLength(1);
        });

        it('should prevent SQL injection in findSymbols', () => {
            const file = '/mock/cwd/src/injection.ts';
            store.updateSymbols(file, [
                { name: 'normal', type: 'function', file, line: 1, exported: true }
            ]);

            // Attempt SQL injection
            // If vulnerable, this might return all rows or error out
            // We expect it to treat the input as a literal string
            const injectionAttempt = "' OR '1'='1";
            const found = store.findSymbols(injectionAttempt);

            expect(found).toHaveLength(0); // Should find nothing, not specific rows
        });

        it('should handle special characters in search', () => {
            const file = '/mock/cwd/src/special.ts';
            store.updateSymbols(file, [
                { name: 'foo$bar', type: 'function', file, line: 1, exported: true }
            ]);

            const found = store.findSymbols('foo$bar');
            expect(found).toHaveLength(1);
        });
    });

    describe('File Operations', () => {
        it('should update and retrieve file stats', () => {
            store.updateFile({
                path: '/mock/cwd/file.ts',
                mtime: 123456789,
                lines: 100,
                language: 'typescript',
                size: 1024
            });

            const files = store.getFiles();
            expect(files).toHaveLength(1);
            expect(files[0].path).toBe('/mock/cwd/file.ts');
        });
    });

    describe('Analytics', () => {
        it('should log usage and retrieve stats', () => {
            store.logUsage('test_tool', 100, true, false);
            store.logUsage('test_tool', 200, false, false);
            store.logUsage('other_tool', 50, true, true);

            const stats = store.getUsageStats();
            expect(stats).toHaveLength(2);

            const testToolStats = stats.find(s => s.tool === 'test_tool');
            expect(testToolStats).toBeDefined();
            expect(testToolStats?.count).toBe(2);
            expect(testToolStats?.errorCount).toBe(1);
            expect(testToolStats?.avgDuration).toBe(150);
        });
    });

    describe('Persistence', () => {
        it('should attempt to save to disk', async () => {
            store.logUsage('tool', 10, true, false);
            // Force dirty? logUsage sets dirty = true
            await store.save();
            expect(mockMkdir).toHaveBeenCalled();
            expect(mockWriteFile).toHaveBeenCalled();
        });
    });
});
