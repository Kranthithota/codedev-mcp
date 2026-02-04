import path from 'node:path';

/**
 * Resolve working directory from arguments or environment.
 * Priority: --cwd flag > CODEDEV_CWD env > process.cwd()
 * @returns The resolved working directory path.
 */
export function resolveCwd(): string {
  const cwdArg = process.argv.find((a) => a.startsWith('--cwd='));
  if (cwdArg) return path.resolve(cwdArg.split('=')[1]);
  if (process.env.CODEDEV_CWD) return path.resolve(process.env.CODEDEV_CWD);
  return process.cwd();
}

/**
 * Resolve multiple root directories from arguments or environment.
 * Multi-root: --roots=dir1,dir2 or CODEDEV_ROOTS env (comma-separated)
 * @returns An array of resolved root directory paths.
 */
export function resolveRoots(): string[] {
  const rootsArg = process.argv.find((a) => a.startsWith('--roots='));
  if (rootsArg)
    return rootsArg
      .split('=')[1]
      .split(',')
      .map((d) => path.resolve(d.trim()));
  if (process.env.CODEDEV_ROOTS) return process.env.CODEDEV_ROOTS.split(',').map((d) => path.resolve(d.trim()));
  return [resolveCwd()];
}

import { validatePath } from './utils/security.js';

export const CWD = resolveCwd();
export const ROOTS = resolveRoots();
export const IS_MULTI_ROOT = ROOTS.length > 1;

/**
 * Path security: prevent directory traversal.
 * Ensures the resolved path is within one of the configured roots.
 * @param userPath - The user-provided path to validate.
 * @returns The resolved and validated path.
 */
export function safePath(userPath: string): string {
  return validatePath(userPath, ROOTS, CWD);
}

/**
 * Resolve a path relative to the best matching root.
 * @param userPath - The user-provided path to resolve.
 * @returns An object containing the matched root and resolved path.
 */
export function resolveToRoot(userPath: string): { root: string; resolved: string } {
  const resolved = path.resolve(CWD, userPath);
  for (const root of ROOTS) {
    if (resolved.startsWith(root)) return { root, resolved };
  }
  return { root: CWD, resolved };
}
