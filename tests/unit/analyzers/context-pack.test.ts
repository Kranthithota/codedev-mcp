import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { packContext } from '../../../src/analyzers/context-pack.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Context Pack', () => {
  const tempDir = join(tmpdir(), `context-pack-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });

    await writeFile(
      join(tempDir, 'src/auth.ts'),
      `import { jwt } from 'jsonwebtoken';

export async function authenticate(token: string): Promise<boolean> {
  try {
    const decoded = jwt.verify(token, process.env.SECRET);
    return !!decoded;
  } catch {
    return false;
  }
}

export function createSession(userId: string): string {
  return jwt.sign({ userId }, process.env.SECRET, { expiresIn: '1h' });
}
`,
    );

    await writeFile(
      join(tempDir, 'src/database.ts'),
      `import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query(sql: string, params: unknown[]): Promise<unknown[]> {
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function getUser(id: string) {
  return query('SELECT * FROM users WHERE id = $1', [id]);
}
`,
    );

    await writeFile(
      join(tempDir, 'src/utils.ts'),
      `export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
`,
    );

    await writeFile(
      join(tempDir, 'src/config.ts'),
      `export const config = {
  port: process.env.PORT || 3000,
  database: process.env.DATABASE_URL || 'postgres://localhost/dev',
  secret: process.env.SECRET || 'dev-secret',
};
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return items within token budget', async () => {
    const result = await packContext(tempDir, { query: 'authenticate', maxTokens: 5000 });

    expect(result.totalTokens).toBeLessThanOrEqual(result.budget);
    expect(result.budget).toBe(5000);
    expect(result.strategy).toBeDefined();
  });

  it('should return correct structure', async () => {
    const result = await packContext(tempDir, { query: 'database', maxTokens: 10000 });

    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('totalTokens');
    expect(result).toHaveProperty('budget');
    expect(result).toHaveProperty('filesIncluded');
    expect(result).toHaveProperty('filesSkipped');
    expect(result).toHaveProperty('strategy');
    expect(result.filesIncluded).toBe(result.items.length);
  });

  it('should sort items by relevance descending', async () => {
    const result = await packContext(tempDir, { query: 'query database', maxTokens: 10000 });

    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].relevance).toBeGreaterThanOrEqual(result.items[i].relevance);
    }
  });

  it('should include relevance and reason in items', async () => {
    const result = await packContext(tempDir, { query: 'function', maxTokens: 10000 });

    for (const item of result.items) {
      expect(item.file).toBeDefined();
      expect(item.content).toBeDefined();
      expect(item.relevance).toBeGreaterThanOrEqual(0);
      expect(item.relevance).toBeLessThanOrEqual(1);
      expect(item.reason).toBeDefined();
      expect(item.estimatedTokens).toBeGreaterThan(0);
    }
  });

  it('should respect maxTokens budget', async () => {
    const result = await packContext(tempDir, { query: 'function', maxTokens: 100 });

    expect(result.totalTokens).toBeLessThanOrEqual(100);
  });

  it('should handle empty query gracefully', async () => {
    const result = await packContext(tempDir, { query: '', maxTokens: 5000 });

    expect(result.items).toBeInstanceOf(Array);
    expect(result.totalTokens).toBeGreaterThanOrEqual(0);
  });

  it('should handle non-matching query', async () => {
    const result = await packContext(tempDir, { query: 'xyznonexistent12345', maxTokens: 5000 });

    expect(result.items).toBeInstanceOf(Array);
  });

  it('should respect maxFiles option', async () => {
    const result = await packContext(tempDir, {
      query: 'function',
      maxTokens: 50000,
      maxFiles: 2,
    });

    expect(result.filesIncluded).toBeLessThanOrEqual(2);
  });

  it('should use default budget when maxTokens not specified', async () => {
    const result = await packContext(tempDir, { query: 'config' });

    expect(result.budget).toBe(8000);
  });
});
