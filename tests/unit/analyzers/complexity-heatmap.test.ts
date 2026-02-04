import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateHeatmap } from '../../../src/analyzers/complexity-heatmap.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Complexity Heatmap', () => {
  const tempDir = join(tmpdir(), `heatmap-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });

    // Simple function - low complexity
    await writeFile(
      join(tempDir, 'src/simple.ts'),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  return \`Hello, \${name}\`;
}
`,
    );

    // Complex function - high complexity
    await writeFile(
      join(tempDir, 'src/complex.ts'),
      `export function processData(items: any[], config: any) {
  const results = [];
  for (const item of items) {
    if (item.type === 'A') {
      if (item.status === 'active') {
        for (const sub of item.children) {
          if (sub.valid && sub.enabled) {
            if (config.mode === 'strict') {
              results.push({ type: 'A', value: sub.value * 2 });
            } else if (config.mode === 'lenient') {
              results.push({ type: 'A', value: sub.value });
            } else {
              results.push({ type: 'A', value: 0 });
            }
          }
        }
      } else if (item.status === 'pending') {
        results.push({ type: 'A', value: -1 });
      }
    } else if (item.type === 'B') {
      switch (config.strategy) {
        case 'fast':
          results.push({ type: 'B', value: item.score || 0 });
          break;
        case 'accurate':
          const calc = item.score * config.factor;
          if (calc > 100) {
            results.push({ type: 'B', value: 100 });
          } else {
            results.push({ type: 'B', value: calc });
          }
          break;
        default:
          results.push({ type: 'B', value: item.score });
      }
    }
  }
  return results;
}
`,
    );

    // Medium complexity
    await writeFile(
      join(tempDir, 'src/medium.ts'),
      `export function validate(input: string): boolean {
  if (!input) return false;
  if (input.length < 3) return false;
  if (input.length > 100) return false;

  const hasLetter = /[a-zA-Z]/.test(input);
  const hasNumber = /[0-9]/.test(input);

  if (!hasLetter || !hasNumber) return false;

  for (const char of input) {
    if (char === ' ') return false;
  }
  return true;
}
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should generate heatmap with file scores', async () => {
    const result = await generateHeatmap(tempDir, { granularity: 'file' });

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.summary.totalFiles).toBeGreaterThan(0);
    expect(typeof result.summary.averageScore).toBe('number');
    expect(typeof result.summary.criticalCount).toBe('number');
    expect(typeof result.summary.healthyCount).toBe('number');
    expect(result.fileScores.length).toBeGreaterThan(0);
  });

  it('should generate heatmap with function-level hotspots', async () => {
    const result = await generateHeatmap(tempDir, { granularity: 'function' });

    expect(result.hotspots.length).toBeGreaterThan(0);
    for (const h of result.hotspots) {
      expect(h.file).toBeDefined();
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(100);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(h.grade);
      expect(h.metrics.cyclomatic).toBeGreaterThanOrEqual(1);
      expect(h.metrics.cognitive).toBeGreaterThanOrEqual(0);
      expect(h.metrics.nesting).toBeGreaterThanOrEqual(0);
      expect(h.metrics.loc).toBeGreaterThan(0);
    }
  });

  it('should rank complex file higher than simple file', async () => {
    const result = await generateHeatmap(tempDir, { granularity: 'file' });
    const scores = result.fileScores;

    const complexFile = scores.find((s) => s.file.includes('complex'));
    const simpleFile = scores.find((s) => s.file.includes('simple'));

    expect(complexFile).toBeDefined();
    expect(simpleFile).toBeDefined();
    expect(complexFile!.score).toBeGreaterThan(simpleFile!.score);
  });

  it('should respect top parameter', async () => {
    const result = await generateHeatmap(tempDir, { top: 2 });
    expect(result.fileScores.length).toBeLessThanOrEqual(2);
    expect(result.hotspots.length).toBeLessThanOrEqual(2);
  });

  it('should filter by file glob', async () => {
    const result = await generateHeatmap(tempDir, {
      fileGlob: '**/simple.ts',
      granularity: 'file',
    });
    expect(result.summary.totalFiles).toBeLessThanOrEqual(1);
  });

  it('should filter by directory', async () => {
    const result = await generateHeatmap(tempDir, { directory: 'src' });
    expect(result.summary.totalFiles).toBeGreaterThan(0);
  });

  it('should assign grades correctly', async () => {
    const result = await generateHeatmap(tempDir, { granularity: 'file' });
    for (const f of result.fileScores) {
      if (f.score <= 20) expect(f.grade).toBe('A');
      else if (f.score <= 40) expect(f.grade).toBe('B');
      else if (f.score <= 60) expect(f.grade).toBe('C');
      else if (f.score <= 80) expect(f.grade).toBe('D');
      else expect(f.grade).toBe('F');
    }
  });

  it('should handle empty directory', async () => {
    const emptyDir = join(tmpdir(), `heatmap-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });
    const result = await generateHeatmap(emptyDir);
    expect(result.summary.totalFiles).toBe(0);
    expect(result.hotspots).toHaveLength(0);
    await rm(emptyDir, { recursive: true, force: true });
  });
});
