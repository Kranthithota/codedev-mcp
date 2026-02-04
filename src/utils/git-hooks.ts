/**
 * Git Hooks Integration
 * Generates pre-commit hooks and provides dry-run preview mode.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

export interface HookResult {
  action: 'generate' | 'preview' | 'status';
  hookPath?: string;
  hookContent?: string;
  installed?: boolean;
  existingHook?: boolean;
  previewFindings?: { check: string; count: number; examples: string[] }[];
}

/**
 *
 * @param cwd
 * @param action
 */
export async function manageGitHooks(cwd: string, action: 'generate' | 'preview' | 'status'): Promise<HookResult> {
  const hookPath = path.join(cwd, '.git', 'hooks', 'pre-commit');

  if (action === 'status') {
    const installed = existsSync(hookPath);
    let content = '';
    if (installed) content = await readFile(hookPath, 'utf-8').catch(() => '');
    return {
      action: 'status',
      hookPath,
      installed,
      existingHook: installed && !content.includes('codedev-mcp'),
      hookContent: installed ? content : undefined,
    };
  }

  if (action === 'preview') {
    const findings: HookResult['previewFindings'] = [];
    try {
      const { stdout } = await exec('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd });
      const staged = stdout
        .trim()
        .split('\n')
        .filter((f) => /\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|cs)$/.test(f));
      if (staged.length === 0)
        return {
          action: 'preview',
          previewFindings: [{ check: 'info', count: 0, examples: ['No staged source files'] }],
        };

      for (const file of staged.slice(0, 20)) {
        try {
          const content = await readFile(path.resolve(cwd, file), 'utf-8');
          const lines = content.split('\n');
          const secrets = lines.filter((l) => /(password|secret|api_key|token)\s*[:=]\s*["'][^${}]/.test(l));
          if (secrets.length) {
            const e = findings.find((f) => f.check === 'secrets');
            if (e) e.count += secrets.length;
            else findings.push({ check: 'secrets', count: secrets.length, examples: [`${file}`] });
          }
          const logs = lines.filter((l) => /console\.(log|debug|info)|print\(|fmt\.Print/.test(l));
          if (logs.length) {
            const e = findings.find((f) => f.check === 'console_logs');
            if (e) e.count += logs.length;
            else findings.push({ check: 'console_logs', count: logs.length, examples: [`${file}: ${logs.length}`] });
          }
          const todos = lines.filter((l) => /TODO|FIXME|HACK|XXX/.test(l));
          if (todos.length) {
            const e = findings.find((f) => f.check === 'todos');
            if (e) e.count += todos.length;
            else findings.push({ check: 'todos', count: todos.length, examples: [`${file}: ${todos.length}`] });
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* not git repo */
    }
    return { action: 'preview', previewFindings: findings };
  }

  // Generate hook script
  const hookContent = [
    '#!/bin/sh',
    '# codedev-mcp pre-commit hook',
    'echo "Running pre-commit checks..."',
    'STAGED=$(git diff --cached --name-only --diff-filter=ACM)',
    'ERRORS=0',
    '',
    '# Check for hardcoded secrets',
    'SECRETS=$(echo "$STAGED" | xargs grep -nE "(password|secret|api_key|token)\\s*[:=]\\s*[\\x22\\x27][^\\$]" 2>/dev/null || true)',
    'if [ -n "$SECRETS" ]; then echo "SECRETS DETECTED:"; echo "$SECRETS" | head -5; ERRORS=$((ERRORS+1)); fi',
    '',
    '# Check for debug statements',
    'DEBUG=$(echo "$STAGED" | xargs grep -nE "console\\.(log|debug)|print\\(" 2>/dev/null || true)',
    'if [ -n "$DEBUG" ]; then echo "Debug statements:"; echo "$DEBUG" | head -5; fi',
    '',
    'if [ $ERRORS -gt 0 ]; then echo "Pre-commit failed"; exit 1; fi',
    'echo "Pre-commit passed"',
    'exit 0',
  ].join('\n');

  return { action: 'generate', hookPath, hookContent, installed: false, existingHook: existsSync(hookPath) };
}
