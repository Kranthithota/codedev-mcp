/**
 * Codebase Mapper
 * Generates comprehensive overview of any codebase
 * Handles small to large enterprise codebases efficiently
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../search/fast-search.js';
import { detectLanguage, isCodeFile } from '../utils/languages.js';
import { extractSymbols, type Symbol } from './symbols.js';

/**
 * Statistics and metadata about the analyzed codebase.
 */
export interface CodebaseStats {
  totalFiles: number;
  totalCodeFiles: number;
  totalDirectories: number;
  languageBreakdown: Record<string, { files: number; percentage: number }>;
  topDirectories: { path: string; files: number }[];
  estimatedSize: 'small' | 'medium' | 'large' | 'enterprise';
  frameworks: string[];
  packageManagers: string[];
  hasTests: boolean;
  hasCI: boolean;
  hasDocs: boolean;
  hasDocker: boolean;
}

/**
 * Result of the codebase mapping process.
 */
export interface CodebaseMapResult {
  stats: CodebaseStats;
  tree: string;
  summary: string;
}

/**
 * List of directories generally ignored in tree generation.
 */
const TREE_IGNORE_LIST = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  'vendor',
  '.idea',
  '.vscode',
  '.DS_Store',
  'Pods',
  '.dart_tool',
]);

/**
 * Signals used to detect frameworks based on file presence.
 * Format: [FrameworkName, [SignalFiles]]
 */
const FRAMEWORK_SIGNALS: [string, string[]][] = [
  ['React', ['package.json']],
  ['Next.js', ['next.config.js', 'next.config.mjs', 'next.config.ts']],
  ['Vue.js', ['vue.config.js', 'nuxt.config.js', 'nuxt.config.ts']],
  ['Angular', ['angular.json']],
  ['Svelte', ['svelte.config.js']],
  ['Django', ['manage.py']],
  ['Flask', ['wsgi.py']],
  ['FastAPI', ['main.py']],
  ['Spring Boot', ['pom.xml', 'build.gradle']],
  ['Express.js', ['package.json']],
  ['Rails', ['Gemfile', 'config/routes.rb']],
  ['Laravel', ['artisan', 'composer.json']],
  ['Terraform', ['main.tf']],
  ['Flutter', ['pubspec.yaml']],
  ['SwiftUI', ['Package.swift']],
  ['.NET', ['*.csproj', '*.sln']],
];

/**
 * Generates a full overview of the codebase at the specified directory.
 *
 * @param cwd - The root directory of the codebase to map.
 * @returns A promise resolving to the codebase statistics, tree structure, and summary string.
 */
export async function mapCodebase(cwd: string): Promise<CodebaseMapResult> {
  const allFiles = await listFiles(cwd, { type: 'file' });

  const langCounts: Record<string, number> = {};
  let codeFiles = 0;

  for (const file of allFiles) {
    const lang = detectLanguage(file);
    if (lang !== 'unknown') {
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
    if (isCodeFile(file)) codeFiles++;
  }

  const languageBreakdown: Record<string, { files: number; percentage: number }> = {};
  for (const [lang, count] of Object.entries(langCounts).sort((a, b) => b[1] - a[1])) {
    languageBreakdown[lang] = {
      files: count,
      percentage: Math.round((count / allFiles.length) * 100),
    };
  }

  const dirCounts: Record<string, number> = {};
  for (const file of allFiles) {
    const topDir = file.split('/')[0] || '.';
    dirCounts[topDir] = (dirCounts[topDir] || 0) + 1;
  }
  const topDirectories = Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([p, files]) => ({ path: p, files }));

  const frameworks = await detectFrameworks(cwd, allFiles);
  const packageManagers = await detectPackageManagers(cwd, allFiles);

  const hasTests = allFiles.some((f) => /\b(test|spec|__tests__|tests|_test|_spec)\b/i.test(f));
  const hasCI = allFiles.some(
    (f) =>
      f.includes('.github/workflows') ||
      f.includes('.gitlab-ci') ||
      f.includes('Jenkinsfile') ||
      f.includes('.circleci') ||
      f.includes('.travis.yml') ||
      f.includes('azure-pipelines'),
  );
  const hasDocs = allFiles.some((f) => /^(docs?|documentation)\//i.test(f) || f.toLowerCase() === 'readme.md');
  const hasDocker = allFiles.some(
    (f) => f.toLowerCase().includes('dockerfile') || f === 'docker-compose.yml' || f === 'docker-compose.yaml',
  );

  const estimatedSize =
    allFiles.length < 50 ? 'small' : allFiles.length < 500 ? 'medium' : allFiles.length < 5000 ? 'large' : 'enterprise';

  const allDirs = new Set<string>();
  for (const file of allFiles) {
    const dir = path.dirname(file);
    if (dir !== '.') allDirs.add(dir);
  }

  const stats: CodebaseStats = {
    totalFiles: allFiles.length,
    totalCodeFiles: codeFiles,
    totalDirectories: allDirs.size,
    languageBreakdown,
    topDirectories,
    estimatedSize,
    frameworks,
    packageManagers,
    hasTests,
    hasCI,
    hasDocs,
    hasDocker,
  };

  const maxDepth = estimatedSize === 'enterprise' ? 2 : estimatedSize === 'large' ? 3 : 4;
  const tree = await generateTree(cwd, maxDepth);

  const summary = formatSummary(stats);

  return { stats, tree, summary };
}

/**
 * Detects frameworks used in the codebase based on configuration files and dependencies.
 *
 * @param cwd - Root directory.
 * @param files - List of all files in the codebase.
 * @returns List of detected framework names.
 */

/**
 * Detects frameworks used in the codebase based on configuration files and dependencies.
 *
 * @param cwd - The root directory of the codebase.
 * @param files - List of all files in the codebase.
 * @returns A promise resolving to a list of detected framework names.
 */
async function detectFrameworks(cwd: string, files: string[]): Promise<string[]> {
  // ... (implementation same as before, just adding docs if missing)
  const frameworks: string[] = [];
  const fileSet = new Set(files.map((f) => f.toLowerCase()));

  for (const [name, signals] of FRAMEWORK_SIGNALS) {
    for (const signal of signals) {
      if (signal.includes('*')) {
        if (files.some((f) => f.endsWith(signal.replace('*', '')))) {
          frameworks.push(name);
          break;
        }
      } else if (
        fileSet.has(signal.toLowerCase()) ||
        files.some((f) => f.toLowerCase().endsWith('/' + signal.toLowerCase()))
      ) {
        if (name === 'React' && signal === 'package.json') {
          if (await hasPackageDependency(cwd, 'react')) frameworks.push('React');
        } else if (name === 'Express.js' && signal === 'package.json') {
          if (await hasPackageDependency(cwd, 'express')) frameworks.push('Express.js');
        } else {
          frameworks.push(name);
        }
        break;
      }
    }
  }

  return [...new Set(frameworks)];
}

/**
 * Checks if a package dependency exists in package.json.
 *
 * @param cwd - Root directory.
 * @param packageName - The package to check for.
 * @returns True if found.
 */
async function hasPackageDependency(cwd: string, packageName: string): Promise<boolean> {
  try {
    const pkgContent = await readFile(path.join(cwd, 'package.json'), 'utf-8');
    return pkgContent.includes(`"${packageName}"`);
  } catch {
    return false;
  }
}

/**
 * Detects package managers (npm, yarn, etc.) based on lockfiles.
 *
 * @param cwd - Root directory.
 * @param files - List of files.
 * @returns List of package managers.
 */
async function detectPackageManagers(cwd: string, files: string[]): Promise<string[]> {
  const managers: string[] = [];
  const fileSet = new Set(files.map((f) => path.basename(f).toLowerCase()));

  if (fileSet.has('package-lock.json') || fileSet.has('package.json')) managers.push('npm');
  if (fileSet.has('yarn.lock')) managers.push('yarn');
  if (fileSet.has('pnpm-lock.yaml')) managers.push('pnpm');
  if (fileSet.has('bun.lockb')) managers.push('bun');
  if (fileSet.has('requirements.txt') || fileSet.has('pyproject.toml') || fileSet.has('setup.py')) managers.push('pip');
  if (fileSet.has('poetry.lock')) managers.push('poetry');
  if (fileSet.has('pipfile.lock')) managers.push('pipenv');
  if (fileSet.has('cargo.toml')) managers.push('cargo');
  if (fileSet.has('go.mod')) managers.push('go modules');
  if (fileSet.has('gemfile')) managers.push('bundler');
  if (fileSet.has('composer.json')) managers.push('composer');
  if (fileSet.has('pubspec.yaml')) managers.push('pub');
  if (fileSet.has('build.gradle') || fileSet.has('build.gradle.kts')) managers.push('gradle');
  if (fileSet.has('pom.xml')) managers.push('maven');

  return managers;
}

/**
 * Generates a visual directory tree structure.
 *
 * @param cwd - Root directory.
 * @param maxDepth - Max depth for recursion.
 * @returns Tree string.
 */
async function generateTree(cwd: string, maxDepth: number): Promise<string> {
  const lines: string[] = [];

  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) {
      lines.push(`${prefix}└── ...`);
      return;
    }

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const filtered = entries
        .filter((e) => !TREE_IGNORE_LIST.has(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (let i = 0; i < filtered.length; i++) {
        const entry = filtered[i];
        const isLast = i === filtered.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const nextPrefix = prefix + (isLast ? '    ' : '│   ');

        if (entry.isDirectory()) {
          lines.push(`${prefix}${connector}${entry.name}/`);
          await walk(path.join(dir, entry.name), nextPrefix, depth + 1);
        } else {
          lines.push(`${prefix}${connector}${entry.name}`);
        }
      }
    } catch {
      // Intentionally suppressed
    }
  }

  lines.push(path.basename(cwd) + '/');
  await walk(cwd, '', 1);
  return lines.join('\n');
}

/**
 * Formats the codebase statistics into a human-readable summary string.
 *
 * @param stats - The codebase statistics.
 * @returns Formatted summary string in Markdown.
 */
function formatSummary(stats: CodebaseStats): string {
  const parts: string[] = [];

  parts.push(`## Codebase Overview`);
  parts.push(
    `Size: ${stats.estimatedSize.toUpperCase()} (${stats.totalFiles} files, ${stats.totalCodeFiles} code files, ${stats.totalDirectories} directories)`,
  );
  parts.push('');

  parts.push(`### Languages`);
  for (const [lang, info] of Object.entries(stats.languageBreakdown).slice(0, 10)) {
    const bar = '█'.repeat(Math.max(1, Math.round(info.percentage / 5)));
    parts.push(`  ${lang.padEnd(15)} ${bar} ${info.files} files (${info.percentage}%)`);
  }
  parts.push('');

  if (stats.frameworks.length > 0) {
    parts.push(`### Frameworks: ${stats.frameworks.join(', ')}`);
  }
  if (stats.packageManagers.length > 0) {
    parts.push(`### Package Managers: ${stats.packageManagers.join(', ')}`);
  }

  const caps: string[] = [];
  if (stats.hasTests) caps.push('✅ Tests');
  if (stats.hasCI) caps.push('✅ CI/CD');
  if (stats.hasDocs) caps.push('✅ Docs');
  if (stats.hasDocker) caps.push('✅ Docker');
  if (!stats.hasTests) caps.push('❌ Tests');
  if (!stats.hasCI) caps.push('❌ CI/CD');
  if (caps.length > 0) {
    parts.push(`### Infrastructure: ${caps.join(' | ')}`);
  }

  parts.push('');
  parts.push('### Top Directories');
  for (const dir of stats.topDirectories.slice(0, 10)) {
    parts.push(`  ${dir.path.padEnd(30)} ${dir.files} files`);
  }

  return parts.join('\n');
}

/**
 * Options for symbol mapping.
 */
export interface MapSymbolsOptions {
  maxFiles?: number;
  language?: string;
  directory?: string;
}

/**
 * Maps symbols (functions, classes, etc.) for code files in the codebase.
 *
 * @param cwd - Root directory.
 * @param options - Filtering and limit options.
 * @returns List of files with their extracted symbols.
 */
export async function mapSymbols(
  cwd: string,
  options?: MapSymbolsOptions,
): Promise<{ file: string; symbols: Symbol[] }[]> {
  let files = await listFiles(cwd, { type: 'file' });

  if (options?.directory) {
    files = files.filter((f) => f.startsWith(options.directory!));
  }

  files = files.filter((f) => isCodeFile(f));

  if (options?.language) {
    files = files.filter((f) => detectLanguage(f) === options.language);
  }

  const maxFiles = options?.maxFiles || 200;
  if (files.length > maxFiles) {
    files = files.slice(0, maxFiles);
  }

  const results: { file: string; symbols: Symbol[] }[] = [];

  for (const file of files) {
    try {
      const symbols = await extractSymbols(path.join(cwd, file));
      if (symbols.length > 0) {
        results.push({ file, symbols });
      }
    } catch {
      // Skip files that fail symbol extraction
    }
  }

  return results;
}
