import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mapCodebase, mapSymbols } from '../../../src/analyzers/codebase.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Codebase Mapper', () => {
  const tempDir = join(tmpdir(), `codebase-map-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'src/components'), { recursive: true });
    await mkdir(join(tempDir, 'tests'), { recursive: true });
    await mkdir(join(tempDir, '.github/workflows'), { recursive: true });

    // package.json
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        dependencies: {
          react: '^18.0.0',
          express: '^4.18.0',
        },
        devDependencies: {
          typescript: '^5.0.0',
          vitest: '^1.0.0',
        },
        scripts: { test: 'vitest', build: 'tsc' },
      }),
    );

    // TypeScript config
    await writeFile(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'es2022' } }),
    );

    // Source files
    await writeFile(
      join(tempDir, 'src/index.ts'),
      `import express from 'express';

const app = express();

export function startServer(port: number): void {
  app.listen(port);
}
`,
    );

    await writeFile(
      join(tempDir, 'src/components/Button.tsx'),
      `import React from 'react';

export interface ButtonProps {
  label: string;
  onClick: () => void;
}

export const Button: React.FC<ButtonProps> = ({ label, onClick }) => {
  return <button onClick={onClick}>{label}</button>;
};
`,
    );

    // Test file
    await writeFile(
      join(tempDir, 'tests/index.test.ts'),
      `import { startServer } from '../src/index';
describe('Server', () => { it('should start', () => {}); });
`,
    );

    // CI file
    await writeFile(join(tempDir, '.github/workflows/ci.yml'), 'name: CI\non: push\n');

    // Dockerfile
    await writeFile(join(tempDir, 'Dockerfile'), 'FROM node:18\n');

    // README
    await writeFile(join(tempDir, 'README.md'), '# Test Project\n');
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should generate codebase map', async () => {
    const result = await mapCodebase(tempDir);

    expect(result).toHaveProperty('tree');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('stats');
    expect(typeof result.tree).toBe('string');
    expect(typeof result.summary).toBe('string');
  });

  it('should detect languages', async () => {
    const result = await mapCodebase(tempDir);

    expect(result.stats.languageBreakdown).toHaveProperty('typescript');
  });

  it('should detect frameworks', async () => {
    const result = await mapCodebase(tempDir);

    const frameworks = result.stats.frameworks.map((f) => f.toLowerCase());
    // Should detect react and/or express
    expect(
      frameworks.some((f) => f.includes('react') || f.includes('express')),
    ).toBe(true);
  });

  it('should detect project features', async () => {
    const result = await mapCodebase(tempDir);

    expect(result.stats.hasTests).toBe(true);
    expect(result.stats.hasCI).toBe(true);
    expect(result.stats.hasDocker).toBe(true);
    expect(result.stats.hasDocs).toBe(true);
  });

  it('should count files', async () => {
    const result = await mapCodebase(tempDir);

    expect(result.stats.totalFiles).toBeGreaterThan(0);
    expect(result.stats.totalCodeFiles).toBeGreaterThan(0);
  });

  it('should generate tree output', async () => {
    const result = await mapCodebase(tempDir);

    expect(result.tree.length).toBeGreaterThan(0);
    expect(result.tree).toContain('src');
  });

  it('should detect package managers', async () => {
    const result = await mapCodebase(tempDir);

    expect(result.stats.packageManagers.length).toBeGreaterThan(0);
  });
});

describe('Symbol Mapper', () => {
  const tempDir = join(tmpdir(), `symbol-map-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });

    await writeFile(
      join(tempDir, 'src/service.ts'),
      `export class UserService {
  async getUser(id: string): Promise<User> {
    return {} as User;
  }

  async createUser(data: CreateUserData): Promise<User> {
    return {} as User;
  }
}

export interface User {
  id: string;
  name: string;
}

export type CreateUserData = Omit<User, 'id'>;
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should map symbols in codebase', async () => {
    const symbols = await mapSymbols(tempDir);

    expect(symbols.length).toBeGreaterThan(0);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('UserService');
  });

  it('should include file and line info', async () => {
    const symbols = await mapSymbols(tempDir);

    for (const sym of symbols) {
      expect(sym.file).toBeDefined();
      expect(sym.line).toBeGreaterThan(0);
      expect(sym.name).toBeDefined();
    }
  });
});
