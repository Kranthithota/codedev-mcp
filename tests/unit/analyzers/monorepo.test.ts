import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { analyzeMonorepo } from '../../../src/analyzers/monorepo.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Monorepo Analysis', () => {
  const tempDir = join(tmpdir(), `monorepo-test-${Date.now()}`);

  beforeAll(async () => {
    // Create an npm workspaces monorepo
    await mkdir(join(tempDir, 'packages/core/src'), { recursive: true });
    await mkdir(join(tempDir, 'packages/utils/src'), { recursive: true });
    await mkdir(join(tempDir, 'packages/app/src'), { recursive: true });

    // Root package.json with workspaces
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-monorepo',
        private: true,
        workspaces: ['packages/*'],
      }),
    );

    // Core package
    await writeFile(
      join(tempDir, 'packages/core/package.json'),
      JSON.stringify({
        name: '@test/core',
        version: '1.0.0',
        dependencies: {},
      }),
    );
    await writeFile(join(tempDir, 'packages/core/src/index.ts'), 'export const core = true;\n');

    // Utils package - depends on core
    await writeFile(
      join(tempDir, 'packages/utils/package.json'),
      JSON.stringify({
        name: '@test/utils',
        version: '1.0.0',
        dependencies: {
          '@test/core': 'workspace:*',
          lodash: '^4.17.0',
        },
      }),
    );
    await writeFile(join(tempDir, 'packages/utils/src/index.ts'), 'export const utils = true;\n');

    // App package - depends on core and utils
    await writeFile(
      join(tempDir, 'packages/app/package.json'),
      JSON.stringify({
        name: '@test/app',
        version: '1.0.0',
        dependencies: {
          '@test/core': 'workspace:*',
          '@test/utils': 'workspace:*',
          lodash: '^4.18.0',
        },
      }),
    );
    await writeFile(join(tempDir, 'packages/app/src/index.ts'), 'export const app = true;\n');
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should detect npm workspaces type', async () => {
    const result = await analyzeMonorepo(tempDir);

    expect(result.type).toBe('npm-workspaces');
    expect(result.rootPath).toBe(tempDir);
  });

  it('should discover workspace packages', async () => {
    const result = await analyzeMonorepo(tempDir);

    expect(result.packages.length).toBeGreaterThanOrEqual(3);
    const names = result.packages.map((p) => p.name);
    expect(names).toContain('@test/core');
    expect(names).toContain('@test/utils');
    expect(names).toContain('@test/app');
  });

  it('should build dependency graph', async () => {
    const result = await analyzeMonorepo(tempDir);

    expect(result.dependencyGraph.length).toBeGreaterThan(0);
    // utils depends on core
    expect(result.dependencyGraph.some((d) => d.from === '@test/utils' && d.to === '@test/core')).toBe(true);
    // app depends on core and utils
    expect(result.dependencyGraph.some((d) => d.from === '@test/app' && d.to === '@test/core')).toBe(true);
    expect(result.dependencyGraph.some((d) => d.from === '@test/app' && d.to === '@test/utils')).toBe(true);
  });

  it('should detect version mismatches', async () => {
    const result = await analyzeMonorepo(tempDir);

    // lodash has ^4.17.0 in utils and ^4.18.0 in app
    const versionIssue = result.issues.find(
      (i) => i.includes('Version mismatch') && i.includes('lodash'),
    );
    expect(versionIssue).toBeDefined();
  });

  it('should have correct summary', async () => {
    const result = await analyzeMonorepo(tempDir);

    expect(result.summary.totalPackages).toBeGreaterThanOrEqual(3);
    expect(result.summary.crossDeps).toBe(result.dependencyGraph.length);
  });

  it('should include scripts in packages', async () => {
    const result = await analyzeMonorepo(tempDir);

    for (const pkg of result.packages) {
      expect(pkg.scripts).toBeInstanceOf(Array);
    }
  });

  it('should handle non-monorepo directory', async () => {
    const singleDir = join(tmpdir(), `mono-single-${Date.now()}`);
    await mkdir(singleDir, { recursive: true });
    await writeFile(
      join(singleDir, 'package.json'),
      JSON.stringify({ name: 'single-pkg', version: '1.0.0' }),
    );

    try {
      const result = await analyzeMonorepo(singleDir);
      expect(result.type).toBe('none');
      expect(result.packages.length).toBe(0);
    } finally {
      await rm(singleDir, { recursive: true, force: true });
    }
  });

  it('should detect lerna/nx/turborepo tools', async () => {
    const toolDir = join(tmpdir(), `mono-tools-${Date.now()}`);
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, 'package.json'), JSON.stringify({ name: 'tool-test', workspaces: [] }));
    await writeFile(join(toolDir, 'turbo.json'), '{}');
    await writeFile(join(toolDir, 'nx.json'), '{}');

    try {
      const result = await analyzeMonorepo(toolDir);
      expect(result.summary.rootTools).toContain('turborepo');
      expect(result.summary.rootTools).toContain('nx');
    } finally {
      await rm(toolDir, { recursive: true, force: true });
    }
  });
});
