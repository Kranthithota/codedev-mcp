/**
 * Monorepo Intelligence
 * Detects workspace structure (npm/yarn/pnpm, Cargo, Python),
 * cross-package dependencies, and affected packages on changes.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { listFiles } from '../search/fast-search.js';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface WorkspacePackage {
  name: string;
  path: string;
  version?: string;
  private?: boolean;
  /** Other workspace packages this depends on */
  dependencies: string[];
  scripts?: string[];
}

export interface MonorepoResult {
  type:
    | 'npm-workspaces'
    | 'yarn-workspaces'
    | 'pnpm-workspaces'
    | 'cargo-workspaces'
    | 'python-monorepo'
    | 'lerna'
    | 'nx'
    | 'turborepo'
    | 'none';
  rootPath: string;
  packages: WorkspacePackage[];
  dependencyGraph: { from: string; to: string }[];
  issues: string[];
  summary: { totalPackages: number; rootTools: string[]; crossDeps: number };
}

/**
 * Analyze monorepo workspace structure, dependencies, and issues.
 * @param cwd - The root directory of the monorepo
 * @returns Monorepo analysis results with packages, dependency graph, and issues
 */
export async function analyzeMonorepo(cwd: string): Promise<MonorepoResult> {
  const packages: WorkspacePackage[] = [];
  const dependencyGraph: { from: string; to: string }[] = [];
  const issues: string[] = [];
  let type: MonorepoResult['type'] = 'none';
  const rootTools: string[] = [];

  // 1. Check for root package.json workspaces
  const rootPkg = path.join(cwd, 'package.json');
  let workspaceGlobs: string[] = [];

  if (existsSync(rootPkg)) {
    try {
      const pkg = JSON.parse(await readFile(rootPkg, 'utf-8'));
      if (pkg.workspaces) {
        workspaceGlobs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
        type = 'npm-workspaces';
      }
    } catch (error) {
      logger.debug(`Failed to parse root package.json`, { error });
    }
  }

  // 2. pnpm-workspace.yaml
  const pnpmWs = path.join(cwd, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWs)) {
    try {
      const content = await readFile(pnpmWs, 'utf-8');
      const pkgMatches = content.matchAll(/- ['"]?([^'"]+)['"]?/g);
      workspaceGlobs = [...pkgMatches].map((m) => m[1]);
      type = 'pnpm-workspaces';
    } catch (error) {
      logger.debug(`Failed to parse root package.json`, { error });
    }
  }

  // 3. Detect tools
  if (existsSync(path.join(cwd, 'lerna.json'))) {
    rootTools.push('lerna');
    if (type === 'none') type = 'lerna';
  }
  if (existsSync(path.join(cwd, 'nx.json'))) {
    rootTools.push('nx');
    if (type === 'none') type = 'nx';
  }
  if (existsSync(path.join(cwd, 'turbo.json'))) {
    rootTools.push('turborepo');
    if (type === 'none') type = 'turborepo';
  }

  // 4. Discover workspace packages (JS/TS)
  if (workspaceGlobs.length > 0) {
    for (const glob of workspaceGlobs) {
      const pkgFiles = await listFiles(cwd, { glob: `${glob}/package.json` }).catch(() => [] as string[]);
      for (const pkgFile of pkgFiles) {
        try {
          const pkg = JSON.parse(await readFile(path.resolve(cwd, pkgFile), 'utf-8'));
          packages.push({
            name: pkg.name || path.basename(path.dirname(pkgFile)),
            path: path.dirname(pkgFile),
            version: pkg.version,
            private: pkg.private,
            dependencies: [],
            scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
          });
        } catch (error) {
          logger.debug(`Failed to parse package.json at ${pkgFile}`, { error });
        }
      }
    }
  }

  // 5. If no JS workspaces, try finding package.json files in common patterns
  if (packages.length === 0) {
    const commonPatterns = [
      'packages/*/package.json',
      'apps/*/package.json',
      'libs/*/package.json',
      'services/*/package.json',
    ];
    for (const pattern of commonPatterns) {
      const found = await listFiles(cwd, { glob: pattern }).catch(() => [] as string[]);
      for (const file of found) {
        try {
          const pkg = JSON.parse(await readFile(path.resolve(cwd, file), 'utf-8'));
          packages.push({
            name: pkg.name || path.basename(path.dirname(file)),
            path: path.dirname(file),
            version: pkg.version,
            private: pkg.private,
            dependencies: [],
            scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
          });
        } catch (error) {
          logger.debug(`Failed to parse package.json at ${file}`, { error });
        }
      }
    }
    if (packages.length > 1) type = 'npm-workspaces';
  }

  // 6. Cargo workspaces
  const cargoToml = path.join(cwd, 'Cargo.toml');
  if (existsSync(cargoToml)) {
    try {
      const content = await readFile(cargoToml, 'utf-8');
      if (content.includes('[workspace]')) {
        type = 'cargo-workspaces';
        const memberMatches = content.matchAll(/members\s*=\s*\[([\s\S]*?)\]/g);
        for (const match of memberMatches) {
          const members = match[1].matchAll(/"([^"]+)"/g);
          for (const m of members) {
            const memberPath = m[1].replace(/\*/g, '');
            if (memberPath.includes('*')) {
              const cargoFiles = await listFiles(cwd, { glob: `${m[1]}/Cargo.toml` }).catch(() => [] as string[]);
              for (const cf of cargoFiles) {
                const memberContent = await readFile(path.resolve(cwd, cf), 'utf-8').catch(() => '');
                const nameMatch = memberContent.match(/name\s*=\s*"(\w+)"/);
                packages.push({
                  name: nameMatch?.[1] || path.basename(path.dirname(cf)),
                  path: path.dirname(cf),
                  dependencies: [],
                });
              }
            } else {
              packages.push({ name: path.basename(memberPath), path: memberPath, dependencies: [] });
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse root package.json`, { error });
    }
  }

  // 7. Build cross-package dependency graph
  const packageNames = new Set(packages.map((p) => p.name));
  for (const pkg of packages) {
    try {
      const pkgJsonPath = path.resolve(cwd, pkg.path, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
        const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies, ...pkgJson.peerDependencies };
        for (const [dep] of Object.entries(allDeps)) {
          if (packageNames.has(dep)) {
            pkg.dependencies.push(dep);
            dependencyGraph.push({ from: pkg.name, to: dep });
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse root package.json`, { error });
    }
  }

  // 8. Detect issues
  // Circular dependencies
  const visited = new Set<string>();
  function detectCycle(node: string, stack: Set<string>): boolean {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    const deps = dependencyGraph.filter((d) => d.from === node).map((d) => d.to);
    for (const dep of deps) {
      if (detectCycle(dep, new Set(stack))) {
        issues.push(`Circular dependency detected: ${[...stack, node].join(' → ')}`);
        return true;
      }
    }
    return false;
  }
  for (const pkg of packages) detectCycle(pkg.name, new Set());

  // Version mismatches
  const versionMap = new Map<string, Set<string>>();
  for (const pkg of packages) {
    try {
      const pkgJsonPath = path.resolve(cwd, pkg.path, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
        const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
        for (const [dep, ver] of Object.entries(allDeps)) {
          if (!packageNames.has(dep)) {
            if (!versionMap.has(dep)) versionMap.set(dep, new Set());
            versionMap.get(dep)!.add(ver as string);
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse root package.json`, { error });
    }
  }
  for (const [dep, versions] of versionMap) {
    if (versions.size > 1) {
      issues.push(
        `Version mismatch: "${dep}" has ${versions.size} different versions across packages: ${[...versions].join(', ')}`,
      );
    }
  }

  return {
    type,
    rootPath: cwd,
    packages,
    dependencyGraph,
    issues: issues.slice(0, 30),
    summary: {
      totalPackages: packages.length,
      rootTools,
      crossDeps: dependencyGraph.length,
    },
  };
}
