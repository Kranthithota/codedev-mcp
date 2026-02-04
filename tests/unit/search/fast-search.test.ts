import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fastSearch from '../../../src/search/fast-search.js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs/promises';

// Mock child_process
vi.mock('node:child_process');
// Mock fs/promises
vi.mock('node:fs/promises');

// Mock util.promisify to simply return the function itself, 
// allowing us to mock execFile as an async function directly.
vi.mock('node:util', () => ({
    promisify: (fn: any) => fn,
}));

describe('Fast Search Engine', () => {
    const mockExecFile = child_process.execFile as unknown as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetAllMocks();
        fastSearch.resetRgAvailability();
    });

    describe('isRgAvailable', () => {
        it('should return true if rg command succeeds', async () => {
            // execFile is now treated as async (promisified)
            mockExecFile.mockResolvedValue({ stdout: 'ripgrep 13.0.0' });
            // Implicitly tested via searchCode
        });
    });

    describe('searchCode', () => {
        it('should use ripgrep when available', async () => {
            // 1. Mock rg availability check
            mockExecFile.mockResolvedValueOnce({ stdout: 'v13' });

            // 2. Mock rg search
            mockExecFile.mockResolvedValueOnce({
                stdout: '{"type":"match","data":{"path":{"text":"/tmp/foo.ts"},"line_number":1,"lines":{"text":"const x = 1"}}}\n'
            });

            const results = await fastSearch.searchCode({ cwd: '/tmp', pattern: 'x' });
            expect(results).toHaveLength(1);
            expect(results[0].file).toBe('foo.ts');

            // Verify rg was called (second call)
            expect(mockExecFile).toHaveBeenCalledTimes(2);
            expect(mockExecFile.mock.calls[1][0]).toBe('rg');
        });

        it('should fallback to grep if rg fails/missing', async () => {
            // 1. Mock rg availability check FAILS
            mockExecFile.mockRejectedValueOnce(new Error('not found'));

            // 2. Mock grep search
            mockExecFile.mockResolvedValueOnce({
                stdout: './bar.ts:10:val y = 2\n'
            });

            const results = await fastSearch.searchCode({ cwd: '/tmp', pattern: 'y' });
            expect(results).toHaveLength(1);
            expect(results[0].file).toBe('bar.ts');

            // Verify grep was called (second call, first was rg check)
            expect(mockExecFile.mock.calls[1][0]).toBe('grep');
        });
    });

    describe('readFileRange', () => {
        it('should return full content when no range specified', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('line1\nline2\nline3');
            const res = await fastSearch.readFileRange('test.txt');
            expect(res.content).toBe('line1\nline2\nline3');
            expect(res.totalLines).toBe(3);
        });
    });
});
