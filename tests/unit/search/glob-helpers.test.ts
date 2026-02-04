import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fastSearch from '../../../src/search/fast-search.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process');
vi.mock('node:util', () => ({
  promisify: (fn: any) => fn,
}));

const mockExecFile = child_process.execFile as unknown as ReturnType<typeof vi.fn>;

describe('listFiles glob handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fastSearch.resetRgAvailability();
  });

  describe('find fallback with complex globs', () => {
    it('should expand brace patterns for find command', async () => {
      // fd fails (not available)
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      // find succeeds with brace-expanded patterns
      mockExecFile.mockResolvedValueOnce({
        stdout: './src/index.ts\n./src/utils.js\n',
      });

      const result = await fastSearch.listFiles('/test', { glob: '**/*.{ts,js}' });
      expect(result).toEqual(['src/index.ts', 'src/utils.js']);

      // Verify find was called (second call) with expanded patterns
      const findCall = mockExecFile.mock.calls[1];
      expect(findCall[0]).toBe('find');
      const findArgs = findCall[1] as string[];
      // The find args should contain the glob-expanded name patterns after the prune section
      // Find the section after '-prune', '-o' which contains our glob patterns
      const pruneIdx = findArgs.indexOf('-prune');
      expect(pruneIdx).toBeGreaterThan(-1);
      const afterPrune = findArgs.slice(pruneIdx + 2); // skip '-prune' and '-o'
      // Should contain expanded patterns: *.ts and *.js
      expect(afterPrune.some((a: string) => a === '*.ts')).toBe(true);
      expect(afterPrune.some((a: string) => a === '*.js')).toBe(true);
      expect(afterPrune).toContain('-o');
    });

    it('should handle simple glob without braces', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: './src/index.ts\n' });

      const result = await fastSearch.listFiles('/test', { glob: '**/*.ts' });
      expect(result).toEqual(['src/index.ts']);

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      const pruneIdx = findArgs.indexOf('-prune');
      const afterPrune = findArgs.slice(pruneIdx + 2);
      expect(afterPrune).toContain('-name');
      expect(afterPrune.some((a: string) => a === '*.ts')).toBe(true);
    });

    it('should use -path for globs with directory components', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: './.github/workflows/ci.yml\n' });

      const result = await fastSearch.listFiles('/test', { glob: '.github/workflows/*.yml' });
      expect(result).toEqual(['.github/workflows/ci.yml']);

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      const pruneIdx = findArgs.indexOf('-prune');
      const afterPrune = findArgs.slice(pruneIdx + 2);
      expect(afterPrune).toContain('-path');
    });

    it('should expand multi-extension brace patterns with paths', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({
        stdout: './.github/workflows/ci.yml\n./.github/workflows/deploy.yaml\n',
      });

      await fastSearch.listFiles('/test', { glob: '.github/workflows/*.{yml,yaml}' });

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      const pruneIdx = findArgs.indexOf('-prune');
      const afterPrune = findArgs.slice(pruneIdx + 2);
      // Should expand to two -path conditions joined with -o
      expect(afterPrune).toContain('(');
      expect(afterPrune).toContain(')');
      expect(afterPrune).toContain('-o');
      const pathArgs = afterPrune.filter((_: string, i: number) => afterPrune[i - 1] === '-path');
      expect(pathArgs.length).toBe(2);
    });

    it('should strip leading **/ from glob patterns', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: './file.sql\n' });

      await fastSearch.listFiles('/test', { glob: '**/*.sql' });

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      const pruneIdx = findArgs.indexOf('-prune');
      const afterPrune = findArgs.slice(pruneIdx + 2);
      // Should use -name '*.sql', not -name '**/*.sql'
      expect(afterPrune).toContain('-name');
      const nameIdx = afterPrune.indexOf('-name');
      expect(afterPrune[nameIdx + 1]).toBe('*.sql');
    });

    it('should handle glob with four extensions', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: '' });

      await fastSearch.listFiles('/test', { glob: '**/*.{ts,tsx,js,jsx}' });

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      const pruneIdx = findArgs.indexOf('-prune');
      const afterPrune = findArgs.slice(pruneIdx + 2);
      // 4 extensions should be joined with -o in a grouped expression
      expect(afterPrune).toContain('(');
      expect(afterPrune).toContain(')');
      // 4 extensions = 3 -o separators within the glob group
      const oCount = afterPrune.filter((a: string) => a === '-o').length;
      expect(oCount).toBe(3);
    });

    it('should pass type constraints correctly', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: '' });

      await fastSearch.listFiles('/test', { glob: '**/*.ts', type: 'file' });

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      expect(findArgs).toContain('-type');
      expect(findArgs).toContain('f');
    });

    it('should handle maxDepth option', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: '' });

      await fastSearch.listFiles('/test', { glob: '**/*.ts', maxDepth: 3 });

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      expect(findArgs).toContain('-maxdepth');
      expect(findArgs).toContain('3');
    });

    it('should handle permission errors gracefully', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockRejectedValueOnce({
        stdout: './src/index.ts\n',
        stderr: 'Permission denied',
        message: 'Permission denied',
      });

      const result = await fastSearch.listFiles('/test', { glob: '**/*.ts' });
      expect(result).toEqual(['src/index.ts']);
    });

    it('should use fd when available', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: 'src/index.ts\nsrc/utils.js\n' });

      const result = await fastSearch.listFiles('/test', { glob: '**/*.{ts,js}' });
      expect(result).toEqual(['src/index.ts', 'src/utils.js']);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile.mock.calls[0][0]).toBe('fd');
    });

    it('should handle no glob at all', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('fd not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: './file.txt\n' });

      await fastSearch.listFiles('/test');

      const findArgs = mockExecFile.mock.calls[1][1] as string[];
      // The find command has -name in the exclude prune section, but NO glob-related -name after prune
      const pruneIdx = findArgs.indexOf('-prune');
      const afterPrune = findArgs.slice(pruneIdx + 2);
      // After prune, there should be no -name or -path (no glob specified)
      expect(afterPrune).not.toContain('-name');
      expect(afterPrune).not.toContain('-path');
      expect(afterPrune).toContain('-print');
    });
  });
});
