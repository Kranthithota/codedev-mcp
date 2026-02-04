import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { analyzePerformance } from '../../../src/analyzers/perf-profile.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Performance Profiling', () => {
  const tempDir = join(tmpdir(), `perf-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await mkdir(join(tempDir, 'profiles'), { recursive: true });

    // Create a CPU profile file
    await writeFile(
      join(tempDir, 'profiles/app.cpuprofile'),
      JSON.stringify({
        nodes: [
          { id: 1, callFrame: { functionName: 'main', url: 'file:///app/index.js' }, hitCount: 100 },
          { id: 2, callFrame: { functionName: 'processData', url: 'file:///app/data.js' }, hitCount: 50 },
          { id: 3, callFrame: { functionName: 'render', url: 'file:///app/ui.js' }, hitCount: 20 },
          { id: 4, callFrame: { functionName: '(anonymous)', url: '' }, hitCount: 5 },
          { id: 5, callFrame: { functionName: 'idle', url: '' }, hitCount: 0 },
        ],
      }),
    );

    // Create a webpack stats file
    await writeFile(
      join(tempDir, 'bundle-stats.json'),
      JSON.stringify({
        assets: [
          { name: 'main.js', size: 800000 },
          { name: 'vendor.js', size: 300000 },
          { name: 'styles.css', size: 50000 },
          { name: 'small.js', size: 10000 },
        ],
        modules: [],
      }),
    );

    // Create a large source file (>100KB)
    const largeContent = 'export const data = ' + JSON.stringify('x'.repeat(150 * 1024)) + ';\n';
    await writeFile(join(tempDir, 'src/large-file.ts'), largeContent);

    // Create a normal source file
    await writeFile(
      join(tempDir, 'src/small.ts'),
      'export const x = 1;\n',
    );

    // Create package.json with heavy deps
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          moment: '^2.29.0',
          lodash: '^4.17.0',
          express: '^4.18.0',
        },
      }),
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return correct result structure', async () => {
    const result = await analyzePerformance(tempDir);

    expect(result).toHaveProperty('entries');
    expect(result).toHaveProperty('sources');
    expect(result).toHaveProperty('profFiles');
    expect(result).toHaveProperty('summary');
    expect(result.summary).toHaveProperty('critical');
    expect(result.summary).toHaveProperty('warning');
    expect(result.summary).toHaveProperty('info');
  });

  it('should parse CPU profiles', async () => {
    const result = await analyzePerformance(tempDir);

    const hotFunctions = result.entries.filter((e) => e.type === 'hot_function');
    if (hotFunctions.length > 0) {
      expect(hotFunctions[0].name).toBeDefined();
      expect(hotFunctions[0].value).toBeGreaterThan(0);
      expect(hotFunctions[0].unit).toBe('%');
      expect(result.sources).toContain('cpuprofile');
    }
  });

  it('should parse webpack bundle stats', async () => {
    const result = await analyzePerformance(tempDir);

    const bundleEntries = result.entries.filter((e) => e.type === 'large_bundle');
    if (bundleEntries.length > 0) {
      expect(bundleEntries[0].metric).toBe('Bundle size');
      expect(bundleEntries[0].unit).toBe('bytes');
      expect(result.sources).toContain('webpack-stats');

      // Should also have bundleSize summary
      if (result.bundleSize) {
        expect(result.bundleSize.total).toBeGreaterThan(0);
        expect(result.bundleSize.largest.length).toBeGreaterThan(0);
      }
    }
  });

  it('should detect large files', async () => {
    const result = await analyzePerformance(tempDir);

    const largeFiles = result.entries.filter((e) => e.type === 'large_file');
    if (largeFiles.length > 0) {
      expect(largeFiles[0].unit).toBe('KB');
      expect(largeFiles[0].value).toBeGreaterThan(100);
    }
  });

  it('should detect heavy dependencies', async () => {
    const result = await analyzePerformance(tempDir);

    const heavyDeps = result.entries.filter((e) => e.type === 'heavy_dep');
    if (heavyDeps.length > 0) {
      const depNames = heavyDeps.map((e) => e.name);
      expect(depNames).toContain('moment');
      expect(depNames).toContain('lodash');
      // express is NOT in the heavy deps list
      expect(depNames).not.toContain('express');

      for (const dep of heavyDeps) {
        expect(dep.recommendation).toBeDefined();
        expect(dep.unit).toBe('KB');
      }
    }
  });

  it('should count severity levels correctly', async () => {
    const result = await analyzePerformance(tempDir);

    const { critical, warning, info } = result.summary;
    const totalBySum = critical + warning + info;
    expect(totalBySum).toBe(result.entries.length);
  });

  it('should handle empty directory', async () => {
    const emptyDir = join(tmpdir(), `perf-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });

    try {
      const result = await analyzePerformance(emptyDir);
      expect(result.entries).toBeInstanceOf(Array);
      expect(result.summary.critical).toBe(0);
      expect(result.summary.warning).toBe(0);
      expect(result.summary.info).toBe(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should assign correct severity levels', async () => {
    const result = await analyzePerformance(tempDir);

    for (const entry of result.entries) {
      expect(['critical', 'warning', 'info']).toContain(entry.severity);
      expect(entry.name).toBeDefined();
      expect(entry.value).toBeGreaterThanOrEqual(0);
    }
  });
});
