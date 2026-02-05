/**
 * Environment & Configuration Intelligence
 * Analyzes environment variables across .env files and code, parses configuration
 * files for conflicts and completeness, and scores dependency freshness from
 * lock files and package manifests.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectLanguage } from '../utils/languages.js';

const execFileAsync = promisify(execFile);

// ── Shared constants ────────────────────────────────────────────────────

const EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 15000 };

/**
 * Well-known variable name patterns that typically hold secrets.
 */
const SENSITIVE_NAME_PATTERNS = [
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /auth/i,
  /credential/i,
  /access[_-]?key/i,
  /signing/i,
  /encryption/i,
  /ssl/i,
  /cert/i,
  /jwt/i,
  /aws[_-]?secret/i,
  /stripe/i,
  /twilio/i,
  /sendgrid/i,
  /database[_-]?url/i,
  /db[_-]?pass/i,
  /redis[_-]?url/i,
  /mongo[_-]?uri/i,
];

// ── 1. Environment Variable Analysis ────────────────────────────────────

export interface EnvVariable {
  name: string;
  usedIn: { file: string; line: number }[];
  definedIn: string[];
  hasDefault: boolean;
  isSensitive: boolean;
  description?: string;
}

export interface EnvConfigResult {
  variables: EnvVariable[];
  envFiles: { file: string; variables: string[]; gitignored: boolean }[];
  missingInExample: string[];
  inconsistencies: { variable: string; presentIn: string[]; missingIn: string[] }[];
  summary: { totalVars: number; envFiles: number; sensitive: number; missingInExample: number; inconsistencies: number };
  score: number;
  recommendations: string[];
}

/**
 * Check whether a file is covered by .gitignore.
 */
async function isGitignored(cwd: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', filePath], { ...EXEC_OPTS, cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a .env file and return variable names and their values.
 */
function parseEnvFile(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      vars.set(key, value);
    }
  }
  return vars;
}

/**
 * Detect whether a variable usage has a default/fallback value.
 */
function hasDefaultValue(lineText: string, varName: string): boolean {
  // process.env.VAR || 'default'
  if (new RegExp(`process\\.env\\.${varName}\\s*\\|\\|`).test(lineText)) return true;
  // process.env.VAR ?? 'default'
  if (new RegExp(`process\\.env\\.${varName}\\s*\\?\\?`).test(lineText)) return true;
  // os.environ.get('VAR', 'default')
  if (/\.get\s*\([^)]+,\s*[^)]+\)/.test(lineText)) return true;
  // os.Getenv with if check
  if (/Getenv/.test(lineText) && /if/.test(lineText)) return true;
  return false;
}

/**
 * Determine if a variable name is likely sensitive.
 */
function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERNS.some((p) => p.test(name));
}

/**
 * Analyze all environment variables across code and .env files.
 *
 * Searches for `process.env.`, `os.environ`, `os.Getenv`, and `System.getenv` patterns
 * in the source code, locates all `.env*` files, compares variables across environments,
 * checks `.env.example` completeness, and flags sensitive variables without defaults.
 *
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.directory - Subdirectory to focus on.
 * @param options.includeTests - Whether to include test files in the scan.
 * @returns The environment config analysis result.
 */
export async function analyzeEnvConfig(
  cwd: string,
  options?: { directory?: string; includeTests?: boolean },
): Promise<EnvConfigResult> {
  const dir = path.resolve(cwd, options?.directory || '.');

  // 1. Find all .env files
  const allFiles = await listFiles(dir, { glob: '**/.env*', maxDepth: 3 });
  const envFileNames = allFiles.filter(
    (f) => /\/(\.env|\.env\..+)$/.test('/' + f) && !/node_modules/.test(f),
  );

  // Also check root-level .env files
  const rootEnvPatterns = ['.env', '.env.local', '.env.development', '.env.production', '.env.staging', '.env.test', '.env.example', '.env.sample'];
  for (const name of rootEnvPatterns) {
    if (!envFileNames.includes(name)) {
      try {
        await readFile(path.resolve(dir, name), 'utf-8');
        envFileNames.push(name);
      } catch {
        /* does not exist */
      }
    }
  }

  // Parse each env file
  const envFilesData: EnvConfigResult['envFiles'] = [];
  const allDefinedVars = new Map<string, Set<string>>(); // varName -> set of files defining it

  for (const envFile of envFileNames) {
    try {
      const absPath = path.resolve(dir, envFile);
      const content = await readFile(absPath, 'utf-8');
      const vars = parseEnvFile(content);
      const varNames = Array.from(vars.keys());
      const gitignored = await isGitignored(dir, envFile);

      envFilesData.push({ file: envFile, variables: varNames, gitignored });

      for (const varName of varNames) {
        if (!allDefinedVars.has(varName)) allDefinedVars.set(varName, new Set());
        allDefinedVars.get(varName)!.add(envFile);
      }
    } catch {
      /* skip */
    }
  }

  // 2. Search for env variable usage in code
  const envPatterns = [
    { pattern: 'process.env.', language: 'js/ts' },
    { pattern: 'os.environ', language: 'python' },
    { pattern: 'os.Getenv', language: 'go' },
    { pattern: 'System.getenv', language: 'java' },
    { pattern: 'ENV[', language: 'ruby' },
    { pattern: 'env(', language: 'php' },
  ];

  const variableMap = new Map<string, EnvVariable>();

  for (const { pattern } of envPatterns) {
    try {
      const results = await searchCode({
        cwd: dir,
        pattern,
        maxResults: 500,
        fileGlob: options?.includeTests
          ? '*.{ts,tsx,js,jsx,py,java,go,rs,rb,php}'
          : undefined,
      });

      for (const result of results) {
        // Extract the variable name from the match
        const varNames = extractEnvVarNames(result.text, pattern);

        for (const varName of varNames) {
          if (!variableMap.has(varName)) {
            variableMap.set(varName, {
              name: varName,
              usedIn: [],
              definedIn: [],
              hasDefault: false,
              isSensitive: isSensitiveName(varName),
            });
          }
          const variable = variableMap.get(varName)!;
          variable.usedIn.push({ file: result.file, line: result.line });

          if (hasDefaultValue(result.text, varName)) {
            variable.hasDefault = true;
          }
        }
      }
    } catch {
      /* search may fail in some environments */
    }
  }

  // 3. Merge definitions from env files
  for (const [varName, files] of allDefinedVars.entries()) {
    if (!variableMap.has(varName)) {
      variableMap.set(varName, {
        name: varName,
        usedIn: [],
        definedIn: [],
        hasDefault: false,
        isSensitive: isSensitiveName(varName),
      });
    }
    variableMap.get(varName)!.definedIn = Array.from(files);
  }

  const variables = Array.from(variableMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  // 4. Check .env.example completeness
  const exampleFile = envFilesData.find(
    (f) => f.file.endsWith('.env.example') || f.file.endsWith('.env.sample'),
  );
  const exampleVars = new Set(exampleFile?.variables || []);
  const usedVarNames = new Set(variables.filter((v) => v.usedIn.length > 0).map((v) => v.name));
  const missingInExample = Array.from(usedVarNames).filter((v) => !exampleVars.has(v)).sort();

  // 5. Find inconsistencies across env files
  const inconsistencies: EnvConfigResult['inconsistencies'] = [];
  const envFileNamesSet = envFilesData.map((f) => f.file).filter(
    (f) => !f.endsWith('.example') && !f.endsWith('.sample'),
  );

  if (envFileNamesSet.length >= 2) {
    const allVarNamesInEnvFiles = new Set<string>();
    for (const ef of envFilesData) {
      if (ef.file.endsWith('.example') || ef.file.endsWith('.sample')) continue;
      for (const v of ef.variables) allVarNamesInEnvFiles.add(v);
    }

    for (const varName of allVarNamesInEnvFiles) {
      const presentIn = envFileNamesSet.filter((f) => {
        const ef = envFilesData.find((e) => e.file === f);
        return ef?.variables.includes(varName);
      });
      const missingIn = envFileNamesSet.filter((f) => !presentIn.includes(f));

      if (missingIn.length > 0 && presentIn.length > 0) {
        inconsistencies.push({ variable: varName, presentIn, missingIn });
      }
    }
  }

  // 6. Calculate score (0-100)
  const sensitiveCount = variables.filter((v) => v.isSensitive).length;
  const sensitiveWithoutDefault = variables.filter((v) => v.isSensitive && !v.hasDefault).length;
  const undefinedVars = variables.filter((v) => v.usedIn.length > 0 && v.definedIn.length === 0);

  let score = 100;
  score -= missingInExample.length * 3;
  score -= inconsistencies.length * 5;
  score -= undefinedVars.length * 5;
  // Penalize sensitive vars in non-gitignored files
  for (const ef of envFilesData) {
    if (!ef.gitignored && ef.variables.some((v) => isSensitiveName(v))) {
      score -= 15;
    }
  }
  score = Math.max(0, Math.min(100, score));

  // 7. Generate recommendations
  const recommendations: string[] = [];
  if (missingInExample.length > 0) {
    recommendations.push(
      `Add ${missingInExample.length} missing variables to .env.example: ${missingInExample.slice(0, 5).join(', ')}${missingInExample.length > 5 ? '...' : ''}.`,
    );
  }
  if (inconsistencies.length > 0) {
    recommendations.push(
      `${inconsistencies.length} variables are inconsistent across env files. Ensure parity.`,
    );
  }
  for (const ef of envFilesData) {
    if (!ef.gitignored && !ef.file.endsWith('.example') && !ef.file.endsWith('.sample')) {
      recommendations.push(
        `${ef.file} is not gitignored - add it to .gitignore to prevent leaking secrets.`,
      );
    }
  }
  if (sensitiveWithoutDefault > 0) {
    recommendations.push(
      `${sensitiveWithoutDefault} sensitive variables lack fallback defaults - they will crash if unset.`,
    );
  }
  if (undefinedVars.length > 0) {
    recommendations.push(
      `${undefinedVars.length} variables are used in code but not defined in any .env file.`,
    );
  }
  if (!exampleFile) {
    recommendations.push(
      'Create a .env.example file documenting all required environment variables.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Environment variable configuration looks well-organized.');
  }

  return {
    variables,
    envFiles: envFilesData,
    missingInExample,
    inconsistencies,
    summary: {
      totalVars: variables.length,
      envFiles: envFilesData.length,
      sensitive: sensitiveCount,
      missingInExample: missingInExample.length,
      inconsistencies: inconsistencies.length,
    },
    score,
    recommendations,
  };
}

/**
 * Extract environment variable names from a source line.
 */
function extractEnvVarNames(line: string, pattern: string): string[] {
  const names: string[] = [];

  if (pattern === 'process.env.') {
    // process.env.VARIABLE_NAME or process.env['VARIABLE_NAME'] or process.env["VARIABLE_NAME"]
    const dotMatches = line.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/gi);
    for (const m of dotMatches) names.push(m[1]);
    const bracketMatches = line.matchAll(/process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/gi);
    for (const m of bracketMatches) names.push(m[1]);
  } else if (pattern === 'os.environ') {
    // os.environ['VAR'], os.environ.get('VAR'), os.environ["VAR"]
    const matches = line.matchAll(/os\.environ(?:\.get)?\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi);
    for (const m of matches) names.push(m[1]);
    const bracketMatches = line.matchAll(/os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]\]/gi);
    for (const m of bracketMatches) names.push(m[1]);
  } else if (pattern === 'os.Getenv') {
    const matches = line.matchAll(/os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/gi);
    for (const m of matches) names.push(m[1]);
  } else if (pattern === 'System.getenv') {
    const matches = line.matchAll(/System\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/gi);
    for (const m of matches) names.push(m[1]);
  } else if (pattern === 'ENV[') {
    const matches = line.matchAll(/ENV\[['"]([A-Z_][A-Z0-9_]*)['"]\]/gi);
    for (const m of matches) names.push(m[1]);
  } else if (pattern === 'env(') {
    const matches = line.matchAll(/env\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi);
    for (const m of matches) names.push(m[1]);
  }

  return names;
}

// ── 2. Configuration File Analysis ──────────────────────────────────────

export interface ConfigFile {
  file: string;
  type: string;
  purpose: string;
  keySettings: Record<string, unknown>;
  potentialIssues: string[];
  referencedBy: string[];
}

export interface ConfigAnalysisResult {
  configs: ConfigFile[];
  conflicts: { file1: string; file2: string; setting: string; description: string }[];
  missingRecommended: string[];
  summary: { totalConfigs: number; conflicts: number; issues: number };
  recommendations: string[];
}

/**
 * Well-known config file patterns with their types, purposes, and key field extractors.
 */
const CONFIG_PATTERNS: {
  glob: string;
  names: string[];
  type: string;
  purpose: string;
  keyFields: string[];
}[] = [
  { glob: 'tsconfig*.json', names: ['tsconfig.json', 'tsconfig.build.json'], type: 'typescript', purpose: 'TypeScript compiler configuration', keyFields: ['compilerOptions.target', 'compilerOptions.module', 'compilerOptions.strict', 'compilerOptions.outDir'] },
  { glob: 'package.json', names: ['package.json'], type: 'npm', purpose: 'Node.js package manifest', keyFields: ['name', 'version', 'main', 'type', 'engines'] },
  { glob: '.eslintrc*', names: ['.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml'], type: 'eslint', purpose: 'ESLint code linting rules', keyFields: ['extends', 'rules', 'parser', 'plugins'] },
  { glob: 'eslint.config.*', names: ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'], type: 'eslint-flat', purpose: 'ESLint flat config', keyFields: [] },
  { glob: '.prettierrc*', names: ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.yml'], type: 'prettier', purpose: 'Prettier code formatting rules', keyFields: ['semi', 'singleQuote', 'tabWidth', 'printWidth', 'trailingComma'] },
  { glob: 'jest.config.*', names: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs'], type: 'jest', purpose: 'Jest testing framework configuration', keyFields: ['preset', 'testEnvironment', 'transform', 'moduleNameMapper'] },
  { glob: 'vitest.config.*', names: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'], type: 'vitest', purpose: 'Vitest testing framework configuration', keyFields: [] },
  { glob: 'vite.config.*', names: ['vite.config.ts', 'vite.config.js', 'vite.config.mts'], type: 'vite', purpose: 'Vite build tool and dev server configuration', keyFields: [] },
  { glob: 'webpack.config.*', names: ['webpack.config.js', 'webpack.config.ts', 'webpack.config.mjs'], type: 'webpack', purpose: 'Webpack module bundler configuration', keyFields: [] },
  { glob: 'rollup.config.*', names: ['rollup.config.js', 'rollup.config.ts', 'rollup.config.mjs'], type: 'rollup', purpose: 'Rollup module bundler configuration', keyFields: [] },
  { glob: 'babel.config.*', names: ['babel.config.js', 'babel.config.json', '.babelrc', '.babelrc.json'], type: 'babel', purpose: 'Babel JavaScript transpiler configuration', keyFields: ['presets', 'plugins'] },
  { glob: 'Dockerfile*', names: ['Dockerfile', 'Dockerfile.dev', 'Dockerfile.prod'], type: 'docker', purpose: 'Docker container image definition', keyFields: [] },
  { glob: 'docker-compose*.yml', names: ['docker-compose.yml', 'docker-compose.yaml', 'docker-compose.override.yml'], type: 'docker-compose', purpose: 'Docker Compose service orchestration', keyFields: [] },
  { glob: '.github/workflows/*.yml', names: [], type: 'github-actions', purpose: 'GitHub Actions CI/CD workflow', keyFields: [] },
  { glob: '.gitlab-ci.yml', names: ['.gitlab-ci.yml'], type: 'gitlab-ci', purpose: 'GitLab CI/CD pipeline configuration', keyFields: [] },
  { glob: 'Makefile', names: ['Makefile'], type: 'makefile', purpose: 'Build automation rules', keyFields: [] },
  { glob: '.dockerignore', names: ['.dockerignore'], type: 'dockerignore', purpose: 'Docker build context exclusion rules', keyFields: [] },
  { glob: '.gitignore', names: ['.gitignore'], type: 'gitignore', purpose: 'Git file tracking exclusion rules', keyFields: [] },
  { glob: 'tailwind.config.*', names: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs'], type: 'tailwind', purpose: 'Tailwind CSS utility framework configuration', keyFields: [] },
  { glob: 'next.config.*', names: ['next.config.js', 'next.config.mjs', 'next.config.ts'], type: 'nextjs', purpose: 'Next.js framework configuration', keyFields: [] },
  { glob: 'nuxt.config.*', names: ['nuxt.config.js', 'nuxt.config.ts'], type: 'nuxtjs', purpose: 'Nuxt.js framework configuration', keyFields: [] },
];

/**
 * Extract a nested value from an object using a dot-delimited path.
 */
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Safely parse JSON content, returning null on failure.
 */
function safeJsonParse(content: string): Record<string, unknown> | null {
  try {
    // Strip comments (common in tsconfig, .eslintrc)
    const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Detect potential issues within a config file.
 */
function detectConfigIssues(type: string, content: string, parsed: Record<string, unknown> | null): string[] {
  const issues: string[] = [];

  if (type === 'typescript' && parsed) {
    const opts = (parsed.compilerOptions || {}) as Record<string, unknown>;
    if (opts.strict === false) issues.push('strict mode is disabled - consider enabling for safer code.');
    if (opts.any === true || opts.noImplicitAny === false) issues.push('noImplicitAny is off - allows implicit any types.');
    if (opts.skipLibCheck === true) issues.push('skipLibCheck is enabled - type errors in dependencies will be hidden.');
    if (!opts.outDir) issues.push('No outDir specified - compiled files may pollute source directory.');
  }

  if (type === 'npm' && parsed) {
    if (!parsed.engines) issues.push('No engines field - Node.js version not constrained.');
    if (!parsed.license) issues.push('No license specified.');
    if (parsed.type !== 'module' && parsed.type !== 'commonjs') {
      issues.push('No explicit module type - consider setting "type": "module" or "commonjs".');
    }
  }

  if (type === 'docker') {
    if (/FROM\s+\S+:latest/i.test(content)) issues.push('Using :latest tag - pin to a specific version for reproducibility.');
    if (/npm install(?!\s+--production)/.test(content) && !/npm ci/.test(content)) {
      issues.push('Using "npm install" instead of "npm ci" - may cause inconsistent builds.');
    }
    if (!/USER\s+/i.test(content)) issues.push('No USER directive - container runs as root by default.');
  }

  if (type === 'eslint' && parsed) {
    const rules = (parsed.rules || {}) as Record<string, unknown>;
    const offRules = Object.entries(rules).filter(([, v]) => v === 'off' || (Array.isArray(v) && v[0] === 'off'));
    if (offRules.length > 10) {
      issues.push(`${offRules.length} rules are disabled - consider addressing underlying issues.`);
    }
  }

  return issues;
}

/**
 * Parse and analyze all configuration files in a project.
 *
 * Detects config files such as tsconfig.json, webpack/vite/rollup configs, babel,
 * eslint, prettier, jest, Docker, CI, and more. For each detected file, extracts
 * key settings, identifies potential issues, and detects conflicts between configs.
 *
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.directory - Subdirectory to focus on.
 * @returns The config analysis result including conflicts and recommendations.
 */
export async function analyzeConfigFiles(
  cwd: string,
  options?: { directory?: string },
): Promise<ConfigAnalysisResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const configs: ConfigFile[] = [];
  const foundTypes = new Set<string>();

  // Scan for all known config files
  for (const pattern of CONFIG_PATTERNS) {
    const candidates = [...pattern.names];

    // Also use glob to find files matching the pattern (e.g., CI workflows)
    if (pattern.glob.includes('*')) {
      try {
        const globResults = await listFiles(dir, { glob: pattern.glob, maxDepth: 4 });
        candidates.push(...globResults);
      } catch {
        /* skip */
      }
    }

    for (const candidate of candidates) {
      try {
        const absPath = path.resolve(dir, candidate);
        const content = await readFile(absPath, 'utf-8');
        const parsed = safeJsonParse(content);

        // Extract key settings
        const keySettings: Record<string, unknown> = {};
        if (parsed && pattern.keyFields.length > 0) {
          for (const field of pattern.keyFields) {
            const value = getNestedValue(parsed, field);
            if (value !== undefined) keySettings[field] = value;
          }
        }

        // Detect issues
        const potentialIssues = detectConfigIssues(pattern.type, content, parsed);

        // Find files that reference this config
        const referencedBy: string[] = [];
        if (pattern.type === 'typescript') {
          // Check for "extends" in other tsconfig files
          try {
            const tsconfigFiles = await listFiles(dir, { glob: 'tsconfig*.json', maxDepth: 3 });
            for (const tsFile of tsconfigFiles) {
              if (tsFile === candidate) continue;
              try {
                const tsContent = await readFile(path.resolve(dir, tsFile), 'utf-8');
                if (tsContent.includes(candidate) || tsContent.includes(path.basename(candidate))) {
                  referencedBy.push(tsFile);
                }
              } catch {
                /* skip */
              }
            }
          } catch {
            /* skip */
          }
        }

        configs.push({
          file: candidate,
          type: pattern.type,
          purpose: pattern.purpose,
          keySettings,
          potentialIssues,
          referencedBy,
        });

        foundTypes.add(pattern.type);
      } catch {
        /* file does not exist */
      }
    }
  }

  // Detect conflicts between configs
  const conflicts: ConfigAnalysisResult['conflicts'] = [];

  // tsconfig target vs babel presets
  const tsconfig = configs.find((c) => c.type === 'typescript');
  const babelConfig = configs.find((c) => c.type === 'babel');
  if (tsconfig && babelConfig) {
    const tsTarget = tsconfig.keySettings['compilerOptions.target'] as string | undefined;
    if (tsTarget) {
      conflicts.push({
        file1: tsconfig.file,
        file2: babelConfig.file,
        setting: 'target/preset-env',
        description: `TypeScript targets "${tsTarget}". Ensure Babel preset-env is aligned to avoid double-transpilation.`,
      });
    }
  }

  // eslint vs prettier conflicts
  const eslintConfig = configs.find((c) => c.type === 'eslint' || c.type === 'eslint-flat');
  const prettierConfig = configs.find((c) => c.type === 'prettier');
  if (eslintConfig && prettierConfig) {
    const eslintFile = eslintConfig.file;
    try {
      const eslintContent = await readFile(path.resolve(dir, eslintFile), 'utf-8');
      if (!eslintContent.includes('prettier') && !eslintContent.includes('eslint-config-prettier')) {
        conflicts.push({
          file1: eslintConfig.file,
          file2: prettierConfig.file,
          setting: 'formatting rules',
          description: 'ESLint does not extend eslint-config-prettier - formatting rules may conflict.',
        });
      }
    } catch {
      /* skip */
    }
  }

  // Multiple test framework configs
  const testConfigs = configs.filter((c) => c.type === 'jest' || c.type === 'vitest');
  if (testConfigs.length > 1) {
    conflicts.push({
      file1: testConfigs[0].file,
      file2: testConfigs[1].file,
      setting: 'test framework',
      description: 'Both Jest and Vitest configs found - consider standardizing on one test framework.',
    });
  }

  // Identify missing recommended configs
  const missingRecommended: string[] = [];
  const projectHasTs = foundTypes.has('typescript');
  const projectHasNpm = foundTypes.has('npm');

  if (projectHasNpm && !foundTypes.has('eslint') && !foundTypes.has('eslint-flat')) {
    missingRecommended.push('.eslintrc or eslint.config.js - linting configuration');
  }
  if (projectHasNpm && !foundTypes.has('prettier')) {
    missingRecommended.push('.prettierrc - code formatting configuration');
  }
  if (projectHasTs && !foundTypes.has('jest') && !foundTypes.has('vitest')) {
    missingRecommended.push('jest.config or vitest.config - test framework configuration');
  }
  if (projectHasNpm && !foundTypes.has('gitignore')) {
    missingRecommended.push('.gitignore - file tracking exclusions');
  }

  // Count total issues
  const totalIssues = configs.reduce((sum, c) => sum + c.potentialIssues.length, 0);

  // Generate recommendations
  const recommendations: string[] = [];
  if (conflicts.length > 0) {
    recommendations.push(`Resolve ${conflicts.length} config conflicts to prevent unexpected build behavior.`);
  }
  if (totalIssues > 0) {
    recommendations.push(`Address ${totalIssues} potential issues across config files.`);
  }
  if (missingRecommended.length > 0) {
    recommendations.push(`Consider adding: ${missingRecommended.join('; ')}.`);
  }
  if (configs.length > 15) {
    recommendations.push('Large number of config files detected. Consider consolidating where possible.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Configuration files are well-structured with no detected conflicts.');
  }

  return {
    configs,
    conflicts,
    missingRecommended,
    summary: {
      totalConfigs: configs.length,
      conflicts: conflicts.length,
      issues: totalIssues,
    },
    recommendations,
  };
}

// ── 3. Dependency Freshness Analysis ────────────────────────────────────

export interface DependencyStatus {
  name: string;
  currentVersion: string;
  specifiedRange: string;
  isDeprecated: boolean;
  isDev: boolean;
  hasVulnerabilities: boolean;
  freshnessScore: number;
}

export interface DependencyFreshnessResult {
  dependencies: DependencyStatus[];
  summary: { total: number; upToDate: number; outdated: number; deprecated: number; vulnerable: number };
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  recommendations: string[];
}

/**
 * Parse a semver string into [major, minor, patch].
 */
function parseSemver(version: string): [number, number, number] {
  const cleaned = version.replace(/^[~^>=<!\s]+/, '').replace(/-.*$/, '');
  const parts = cleaned.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Compare two semver tuples. Returns < 0 if a < b, 0 if equal, > 0 if a > b.
 */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Read the installed version of an npm package from node_modules.
 */
async function getInstalledVersion(cwd: string, pkgName: string): Promise<{ version: string; deprecated?: string } | null> {
  try {
    const pkgJsonPath = path.join(cwd, 'node_modules', pkgName, 'package.json');
    const content = await readFile(pkgJsonPath, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      version: parsed.version || '0.0.0',
      deprecated: parsed.deprecated || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Read the installed version from a lockfile entry.
 */
function getVersionFromLockfile(
  lockData: Record<string, unknown>,
  pkgName: string,
): string | null {
  // package-lock.json v2/v3 format
  const packages = lockData.packages as Record<string, Record<string, unknown>> | undefined;
  if (packages) {
    const key = `node_modules/${pkgName}`;
    if (packages[key]?.version) return packages[key].version as string;
  }

  // package-lock.json v1 format
  const deps = lockData.dependencies as Record<string, Record<string, unknown>> | undefined;
  if (deps?.[pkgName]?.version) return deps[pkgName].version as string;

  return null;
}

/**
 * Attempt to run npm audit --json and extract vulnerable package names.
 */
async function getVulnerablePackages(cwd: string): Promise<Set<string>> {
  const vulnerable = new Set<string>();
  try {
    let stdout = '';
    try {
      const result = await execFileAsync('npm', ['audit', '--json'], {
        cwd,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error: unknown) {
      // npm audit exits with code 1 when vulnerabilities are found
      const execError = error as { stdout?: string; code?: number };
      if (execError.stdout) stdout = execError.stdout;
    }

    if (stdout) {
      const auditData = JSON.parse(stdout);
      if (auditData.vulnerabilities) {
        for (const pkgName of Object.keys(auditData.vulnerabilities)) {
          vulnerable.add(pkgName);
        }
      }
    }
  } catch {
    /* npm audit not available */
  }
  return vulnerable;
}

/**
 * Score dependency freshness for an npm project.
 *
 * Reads package.json to identify all production and dev dependencies, resolves
 * installed versions from the lockfile or node_modules, checks for deprecation
 * markers, and optionally runs `npm audit --json` to detect known vulnerabilities.
 * Each dependency receives a freshness score from 0 to 100 based on how closely
 * the installed version matches the specified range.
 *
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.directory - Subdirectory containing the package.json.
 * @param options.checkVulnerabilities - Whether to run npm audit (default true).
 * @returns The dependency freshness result with per-dependency scores and an overall grade.
 */
export async function analyzeDependencyFreshness(
  cwd: string,
  options?: { directory?: string; checkVulnerabilities?: boolean },
): Promise<DependencyFreshnessResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const checkVuln = options?.checkVulnerabilities !== false;

  // 1. Read package.json
  let pkgJson: Record<string, unknown>;
  try {
    const content = await readFile(path.join(dir, 'package.json'), 'utf-8');
    pkgJson = JSON.parse(content);
  } catch {
    return {
      dependencies: [],
      summary: { total: 0, upToDate: 0, outdated: 0, deprecated: 0, vulnerable: 0 },
      overallScore: 0,
      grade: 'F',
      recommendations: ['No package.json found in the specified directory.'],
    };
  }

  const prodDeps = (pkgJson.dependencies || {}) as Record<string, string>;
  const devDeps = (pkgJson.devDependencies || {}) as Record<string, string>;

  // 2. Read lockfile for accurate version resolution
  let lockData: Record<string, unknown> | null = null;
  try {
    const lockContent = await readFile(path.join(dir, 'package-lock.json'), 'utf-8');
    lockData = JSON.parse(lockContent);
  } catch {
    /* no lockfile */
  }

  // 3. Optionally check for vulnerabilities
  const vulnerablePackages = checkVuln ? await getVulnerablePackages(dir) : new Set<string>();

  // 4. Analyze each dependency
  const dependencies: DependencyStatus[] = [];

  const allDeps: [string, string, boolean][] = [
    ...Object.entries(prodDeps).map(([n, v]): [string, string, boolean] => [n, v, false]),
    ...Object.entries(devDeps).map(([n, v]): [string, string, boolean] => [n, v, true]),
  ];

  for (const [name, specifiedRange, isDev] of allDeps) {
    // Skip workspace/file/link references
    if (specifiedRange.startsWith('workspace:') || specifiedRange.startsWith('file:') || specifiedRange.startsWith('link:')) {
      continue;
    }

    // Resolve installed version
    let currentVersion = '0.0.0';
    let isDeprecated = false;

    // Try lockfile first
    if (lockData) {
      const lockVersion = getVersionFromLockfile(lockData, name);
      if (lockVersion) currentVersion = lockVersion;
    }

    // Then try node_modules for deprecation info
    const installed = await getInstalledVersion(dir, name);
    if (installed) {
      currentVersion = installed.version;
      isDeprecated = !!installed.deprecated;
    }

    const hasVulnerabilities = vulnerablePackages.has(name);

    // Calculate freshness score
    const specified = parseSemver(specifiedRange);
    const current = parseSemver(currentVersion);
    let freshnessScore = 100;

    // Compare installed vs specified minimum
    const cmp = compareSemver(current, specified);

    if (cmp < 0) {
      // Installed is behind specified range
      const majorDiff = specified[0] - current[0];
      const minorDiff = Math.max(0, specified[1] - current[1]);
      freshnessScore -= majorDiff * 20;
      freshnessScore -= minorDiff * 5;
    }

    // Penalties
    if (isDeprecated) freshnessScore -= 30;
    if (hasVulnerabilities) freshnessScore -= 25;
    freshnessScore = Math.max(0, Math.min(100, freshnessScore));

    dependencies.push({
      name,
      currentVersion,
      specifiedRange,
      isDeprecated,
      isDev,
      hasVulnerabilities,
      freshnessScore,
    });
  }

  // Sort by freshness score (worst first)
  dependencies.sort((a, b) => a.freshnessScore - b.freshnessScore);

  // 5. Compute summary
  const upToDate = dependencies.filter((d) => d.freshnessScore >= 90).length;
  const outdated = dependencies.filter((d) => d.freshnessScore < 70).length;
  const deprecated = dependencies.filter((d) => d.isDeprecated).length;
  const vulnerable = dependencies.filter((d) => d.hasVulnerabilities).length;

  const overallScore = dependencies.length > 0
    ? Math.round(dependencies.reduce((sum, d) => sum + d.freshnessScore, 0) / dependencies.length)
    : 100;

  const grade: DependencyFreshnessResult['grade'] =
    overallScore >= 90 ? 'A' : overallScore >= 75 ? 'B' : overallScore >= 60 ? 'C' : overallScore >= 40 ? 'D' : 'F';

  // 6. Generate recommendations
  const recommendations: string[] = [];
  if (vulnerable > 0) {
    recommendations.push(
      `${vulnerable} packages have known vulnerabilities. Run "npm audit fix" to address them.`,
    );
  }
  if (deprecated > 0) {
    const depNames = dependencies.filter((d) => d.isDeprecated).map((d) => d.name).slice(0, 5);
    recommendations.push(
      `${deprecated} deprecated packages found: ${depNames.join(', ')}${deprecated > 5 ? '...' : ''}. Find replacements.`,
    );
  }
  if (outdated > 5) {
    recommendations.push(
      `${outdated} packages are significantly outdated. Schedule a dependency update sprint.`,
    );
  }
  if (!lockData) {
    recommendations.push(
      'No package-lock.json found. Run "npm install" to generate one for reproducible builds.',
    );
  }
  const majorBehind = dependencies.filter((d) => {
    const spec = parseSemver(d.specifiedRange);
    const cur = parseSemver(d.currentVersion);
    return spec[0] - cur[0] >= 2;
  });
  if (majorBehind.length > 0) {
    recommendations.push(
      `${majorBehind.length} packages are 2+ major versions behind. These may require migration effort.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Dependencies are fresh and well-maintained. Keep up with regular updates.');
  }

  return {
    dependencies,
    summary: {
      total: dependencies.length,
      upToDate,
      outdated,
      deprecated,
      vulnerable,
    },
    overallScore,
    grade,
    recommendations,
  };
}
