import { describe, it, expect } from 'vitest';
import { resolveCwd, resolveRoots, safePath, resolveToRoot, CWD, ROOTS } from '../../../src/config.js';

describe('Config', () => {
  it('should resolve CWD', () => {
    expect(typeof CWD).toBe('string');
    expect(CWD.length).toBeGreaterThan(0);
  });

  it('should resolve ROOTS', () => {
    expect(Array.isArray(ROOTS)).toBe(true);
    expect(ROOTS.length).toBeGreaterThanOrEqual(1);
  });

  it('resolveCwd should return a string', () => {
    const cwd = resolveCwd();
    expect(typeof cwd).toBe('string');
    expect(cwd.length).toBeGreaterThan(0);
  });

  it('resolveRoots should return an array', () => {
    const roots = resolveRoots();
    expect(Array.isArray(roots)).toBe(true);
    expect(roots.length).toBeGreaterThanOrEqual(1);
  });

  it('safePath should validate relative paths', () => {
    // A simple relative path within the project should work
    const result = safePath('src');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('safePath should reject traversal attempts', () => {
    expect(() => safePath('../../../../etc/passwd')).toThrow();
  });

  it('resolveToRoot should return root and resolved path', () => {
    const result = resolveToRoot('src');
    expect(result).toHaveProperty('root');
    expect(result).toHaveProperty('resolved');
    expect(typeof result.root).toBe('string');
    expect(typeof result.resolved).toBe('string');
  });
});
