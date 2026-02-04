/**
 * Architecture Rule Enforcement
 * Verify layer boundaries, dependency constraints, circular imports.
 */

import { listFiles } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ArchViolation {
  rule: string;
  file: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  importPath?: string;
}

export interface ArchResult {
  violations: ArchViolation[];
  rulesChecked: number;
  filesTested: number;
  passed: boolean;
  summary: { errors: number; warnings: number };
}

interface ArchRule {
  name: string;
  type: 'no-import' | 'no-circular' | 'naming';
  description: string;
  source?: string;
  forbidden?: string[];
  pattern?: string;
}

const BUILTIN_RULES: ArchRule[] = [
  { name: 'no-circular-imports', type: 'no-circular', description: 'No circular import chains' },
  {
    name: 'controllers-no-direct-db',
    type: 'no-import',
    description: 'Controllers should not import from database layer',
    source: '**/controllers/**',
    forbidden: ['models', 'database', 'db/', 'repositories'],
  },
  {
    name: 'utils-no-domain',
    type: 'no-import',
    description: 'Utils should not import domain logic',
    source: '**/utils/**',
    forbidden: ['services', 'controllers', 'routes', 'handlers'],
  },
];

function matchGlob(p: string, pattern: string): boolean {
  const re = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(re).test(p);
}

function parseFileImports(content: string): string[] {
  const imports: string[] = [];
  const jsMatches = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
  for (const m of jsMatches) imports.push(m[1]);
  const pyMatches = content.matchAll(/(?:from\s+(\S+)\s+import|import\s+(\S+))/g);
  for (const m of pyMatches) imports.push(m[1] || m[2]);
  return imports;
}

async function detectCircular(dir: string, files: string[]): Promise<ArchViolation[]> {
  const violations: ArchViolation[] = [];
  const graph = new Map<string, string[]>();

  for (const file of files.slice(0, 300)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      const imports = parseFileImports(content)
        .filter((i) => i.startsWith('.'))
        .map((i) =>
          path
            .normalize(path.join(path.dirname(file), i))
            .replace(/\\/g, '/')
            .replace(/\.[^.]+$/, ''),
        );
      graph.set(file.replace(/\.[^.]+$/, ''), imports);
    } catch {
      /* skip */
    }
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(node: string, trail: string[]) {
    if (stack.has(node)) {
      const idx = trail.indexOf(node);
      if (idx >= 0) {
        violations.push({
          rule: 'no-circular-imports',
          file: node,
          message: `Circular: ${trail.slice(idx).join(' → ')} → ${node}`,
          severity: 'error',
        });
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    for (const dep of graph.get(node) || []) {
      if (graph.has(dep)) dfs(dep, [...trail, node]);
    }
    stack.delete(node);
  }

  for (const node of graph.keys()) {
    visited.clear();
    stack.clear();
    dfs(node, []);
  }
  return violations.slice(0, 20);
}

/**
 *
 * @param cwd
 * @param options
 * @param options.builtinRules
 * @param options.directory
 * @param options.fileGlob
 */
export async function checkArchitecture(
  cwd: string,
  options?: { builtinRules?: boolean; directory?: string; fileGlob?: string },
): Promise<ArchResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const files = await listFiles(dir, { glob: options?.fileGlob || '**/*.{ts,tsx,js,jsx,py,java,go,rs}' });
  const rules = options?.builtinRules !== false ? BUILTIN_RULES : [];
  const violations: ArchViolation[] = [];

  for (const rule of rules) {
    if (rule.type === 'no-circular') {
      violations.push(...(await detectCircular(dir, files)));
      continue;
    }

    if (rule.type === 'no-import' && rule.forbidden) {
      for (const file of files.slice(0, 300)) {
        if (rule.source && !matchGlob(file, rule.source)) continue;
        try {
          const content = await readFile(path.resolve(dir, file), 'utf-8');
          const imports = parseFileImports(content);
          const lines = content.split('\n');
          for (const imp of imports) {
            for (const fb of rule.forbidden!) {
              if (imp.includes(fb)) {
                const line = lines.findIndex((l) => l.includes(imp)) + 1;
                violations.push({
                  rule: rule.name,
                  file,
                  line,
                  message: `${rule.description}: "${file}" imports "${imp}"`,
                  severity: 'error',
                  importPath: imp,
                });
              }
            }
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  return {
    violations: violations.slice(0, 100),
    rulesChecked: rules.length,
    filesTested: Math.min(files.length, 300),
    passed: violations.filter((v) => v.severity === 'error').length === 0,
    summary: {
      errors: violations.filter((v) => v.severity === 'error').length,
      warnings: violations.filter((v) => v.severity === 'warning').length,
    },
  };
}
