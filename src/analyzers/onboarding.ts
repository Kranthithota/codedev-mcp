/**
 * Onboarding & Knowledge Intelligence Analyzers
 * Generates onboarding guides, detects coding conventions, and builds
 * domain glossaries from codebase analysis.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { detectLanguage } from '../utils/languages.js';

const execFileAsync = promisify(execFile);

/** Maximum buffer size for child process output. */
const EXEC_OPTS = { maxBuffer: 20 * 1024 * 1024, timeout: 15000 };

// ── Onboarding Guide Types ──────────────────────────────────────────────

/** A single section within the onboarding guide. */
export interface OnboardingSection {
  title: string;
  content: string;
  files?: string[];
  commands?: string[];
}

/** Complete onboarding guide generated from codebase analysis. */
export interface OnboardingGuide {
  projectName: string;
  projectType: string;
  techStack: string[];
  sections: OnboardingSection[];
  entryPoints: { file: string; purpose: string }[];
  keyFiles: { file: string; purpose: string }[];
  setupSteps: string[];
  commonTasks: { task: string; command: string }[];
  architecture: { layer: string; directory: string; description: string }[];
}

// ── Convention Detection Types ──────────────────────────────────────────

/** A single detected coding convention with confidence and examples. */
export interface Convention {
  category: string;
  name: string;
  value: string;
  confidence: number;
  examples: { file: string; line: number; code: string }[];
}

/** Aggregated convention detection results. */
export interface ConventionResult {
  conventions: Convention[];
  fileNaming: { pattern: string; examples: string[]; percentage: number }[];
  importStyle: { style: string; count: number; percentage: number }[];
  codeStyle: Record<string, string>;
  summary: string;
}

// ── Glossary Types ──────────────────────────────────────────────────────

/** A domain term extracted from the codebase. */
export interface GlossaryTerm {
  term: string;
  category: string;
  definition?: string;
  occurrences: number;
  relatedTerms: string[];
  files: string[];
}

/** Complete glossary result with categories and statistics. */
export interface GlossaryResult {
  terms: GlossaryTerm[];
  categories: { name: string; termCount: number }[];
  summary: { totalTerms: number; categories: number; documented: number; undocumented: number };
}

// ── Project type detection signals ──────────────────────────────────────

/** Maps config files to project types. */
const PROJECT_TYPE_SIGNALS: { file: string; type: string }[] = [
  { file: 'package.json', type: 'Node.js' },
  { file: 'tsconfig.json', type: 'TypeScript' },
  { file: 'pyproject.toml', type: 'Python' },
  { file: 'setup.py', type: 'Python' },
  { file: 'requirements.txt', type: 'Python' },
  { file: 'Pipfile', type: 'Python' },
  { file: 'go.mod', type: 'Go' },
  { file: 'Cargo.toml', type: 'Rust' },
  { file: 'pom.xml', type: 'Java (Maven)' },
  { file: 'build.gradle', type: 'Java (Gradle)' },
  { file: 'build.gradle.kts', type: 'Kotlin (Gradle)' },
  { file: 'Gemfile', type: 'Ruby' },
  { file: 'composer.json', type: 'PHP' },
  { file: 'pubspec.yaml', type: 'Dart/Flutter' },
  { file: 'Package.swift', type: 'Swift' },
  { file: 'mix.exs', type: 'Elixir' },
  { file: 'stack.yaml', type: 'Haskell' },
  { file: 'dune-project', type: 'OCaml' },
  { file: 'CMakeLists.txt', type: 'C/C++ (CMake)' },
  { file: 'Makefile', type: 'Make-based' },
];

/** Maps config files to tech stack entries. */
const TECH_STACK_SIGNALS: { file: string; tech: string }[] = [
  { file: 'next.config.js', tech: 'Next.js' },
  { file: 'next.config.mjs', tech: 'Next.js' },
  { file: 'next.config.ts', tech: 'Next.js' },
  { file: 'nuxt.config.js', tech: 'Nuxt.js' },
  { file: 'nuxt.config.ts', tech: 'Nuxt.js' },
  { file: 'angular.json', tech: 'Angular' },
  { file: 'svelte.config.js', tech: 'Svelte' },
  { file: 'vue.config.js', tech: 'Vue.js' },
  { file: 'vite.config.ts', tech: 'Vite' },
  { file: 'vite.config.js', tech: 'Vite' },
  { file: 'webpack.config.js', tech: 'Webpack' },
  { file: 'rollup.config.js', tech: 'Rollup' },
  { file: 'tailwind.config.js', tech: 'Tailwind CSS' },
  { file: 'tailwind.config.ts', tech: 'Tailwind CSS' },
  { file: '.eslintrc.json', tech: 'ESLint' },
  { file: '.eslintrc.js', tech: 'ESLint' },
  { file: 'eslint.config.js', tech: 'ESLint' },
  { file: '.prettierrc', tech: 'Prettier' },
  { file: 'jest.config.js', tech: 'Jest' },
  { file: 'jest.config.ts', tech: 'Jest' },
  { file: 'vitest.config.ts', tech: 'Vitest' },
  { file: 'vitest.config.js', tech: 'Vitest' },
  { file: 'cypress.config.js', tech: 'Cypress' },
  { file: 'playwright.config.ts', tech: 'Playwright' },
  { file: '.storybook', tech: 'Storybook' },
  { file: 'docker-compose.yml', tech: 'Docker Compose' },
  { file: 'docker-compose.yaml', tech: 'Docker Compose' },
  { file: 'Dockerfile', tech: 'Docker' },
  { file: '.github/workflows', tech: 'GitHub Actions' },
  { file: '.gitlab-ci.yml', tech: 'GitLab CI' },
  { file: 'Jenkinsfile', tech: 'Jenkins' },
  { file: '.travis.yml', tech: 'Travis CI' },
  { file: 'prisma/schema.prisma', tech: 'Prisma' },
  { file: 'drizzle.config.ts', tech: 'Drizzle ORM' },
  { file: '.env', tech: 'dotenv' },
  { file: 'terraform', tech: 'Terraform' },
];

/** Maps directory names to architectural layers. */
const ARCHITECTURE_LAYERS: { dirs: string[]; layer: string; description: string }[] = [
  { dirs: ['src/controllers', 'src/routes', 'src/handlers', 'app/controllers', 'api/routes'], layer: 'API / Routes', description: 'HTTP request handlers and route definitions' },
  { dirs: ['src/services', 'src/domain', 'src/core', 'app/services', 'lib/services'], layer: 'Business Logic', description: 'Core domain logic and service orchestration' },
  { dirs: ['src/models', 'src/entities', 'src/schemas', 'app/models', 'db/models'], layer: 'Data Models', description: 'Database models, entities, and schema definitions' },
  { dirs: ['src/repositories', 'src/dal', 'src/database', 'src/db', 'app/repositories'], layer: 'Data Access', description: 'Database access layer and repository pattern' },
  { dirs: ['src/middleware', 'src/middlewares', 'app/middleware'], layer: 'Middleware', description: 'Request/response middleware and interceptors' },
  { dirs: ['src/utils', 'src/helpers', 'src/lib', 'src/common', 'lib/utils'], layer: 'Utilities', description: 'Shared utility functions and helpers' },
  { dirs: ['src/config', 'config', 'src/settings'], layer: 'Configuration', description: 'Application configuration and environment setup' },
  { dirs: ['src/types', 'src/interfaces', 'types', 'src/@types'], layer: 'Type Definitions', description: 'Type definitions, interfaces, and contracts' },
  { dirs: ['src/components', 'src/ui', 'app/components', 'components'], layer: 'UI Components', description: 'Frontend UI components and views' },
  { dirs: ['src/hooks', 'src/composables'], layer: 'Hooks / Composables', description: 'Reusable stateful logic (React hooks, Vue composables)' },
  { dirs: ['src/store', 'src/state', 'src/redux', 'src/stores'], layer: 'State Management', description: 'Application state management (Redux, Vuex, etc.)' },
  { dirs: ['src/pages', 'src/views', 'app/views', 'pages'], layer: 'Pages / Views', description: 'Page-level components and view templates' },
  { dirs: ['tests', 'test', '__tests__', 'spec', 'src/__tests__'], layer: 'Tests', description: 'Unit, integration, and end-to-end tests' },
  { dirs: ['scripts', 'tools', 'bin'], layer: 'Scripts / Tools', description: 'Build scripts, CLI tools, and automation' },
  { dirs: ['docs', 'documentation'], layer: 'Documentation', description: 'Project documentation and guides' },
  { dirs: ['public', 'static', 'assets', 'src/assets'], layer: 'Static Assets', description: 'Static files, images, fonts, and public resources' },
  { dirs: ['migrations', 'db/migrations', 'src/migrations'], layer: 'Migrations', description: 'Database migration scripts' },
  { dirs: ['deploy', 'k8s', 'infra', 'infrastructure', '.github', '.circleci'], layer: 'Infrastructure', description: 'Deployment, CI/CD, and infrastructure configuration' },
];

/** Well-known configuration files and their purposes. */
const KEY_CONFIG_FILES: { file: string; purpose: string }[] = [
  { file: 'package.json', purpose: 'Node.js project manifest: dependencies, scripts, metadata' },
  { file: 'tsconfig.json', purpose: 'TypeScript compiler configuration' },
  { file: '.eslintrc.json', purpose: 'ESLint linting rules configuration' },
  { file: '.eslintrc.js', purpose: 'ESLint linting rules configuration' },
  { file: 'eslint.config.js', purpose: 'ESLint flat config' },
  { file: '.prettierrc', purpose: 'Prettier code formatting configuration' },
  { file: '.prettierrc.json', purpose: 'Prettier code formatting configuration' },
  { file: '.env', purpose: 'Environment variables (DO NOT commit secrets)' },
  { file: '.env.example', purpose: 'Environment variable template' },
  { file: '.gitignore', purpose: 'Git ignore patterns for untracked files' },
  { file: 'Dockerfile', purpose: 'Docker container build instructions' },
  { file: 'docker-compose.yml', purpose: 'Multi-container Docker orchestration' },
  { file: 'Makefile', purpose: 'Build automation targets' },
  { file: 'jest.config.js', purpose: 'Jest test runner configuration' },
  { file: 'jest.config.ts', purpose: 'Jest test runner configuration' },
  { file: 'vitest.config.ts', purpose: 'Vitest test runner configuration' },
  { file: 'pyproject.toml', purpose: 'Python project configuration and dependencies' },
  { file: 'setup.py', purpose: 'Python package setup and installation' },
  { file: 'setup.cfg', purpose: 'Python package configuration' },
  { file: 'go.mod', purpose: 'Go module definition and dependencies' },
  { file: 'Cargo.toml', purpose: 'Rust package manifest and dependencies' },
  { file: 'pom.xml', purpose: 'Maven project object model and dependencies' },
  { file: 'build.gradle', purpose: 'Gradle build configuration' },
  { file: 'Gemfile', purpose: 'Ruby dependency manifest' },
  { file: 'composer.json', purpose: 'PHP dependency manifest' },
  { file: '.github/workflows', purpose: 'GitHub Actions CI/CD workflow definitions' },
  { file: '.gitlab-ci.yml', purpose: 'GitLab CI/CD pipeline configuration' },
  { file: 'nginx.conf', purpose: 'Nginx web server configuration' },
  { file: 'prisma/schema.prisma', purpose: 'Prisma ORM database schema' },
];

/** Entry point patterns for various project types. */
const ENTRY_POINT_PATTERNS: { glob: string; purpose: string }[] = [
  { glob: 'src/index.ts', purpose: 'Main TypeScript entry point' },
  { glob: 'src/index.js', purpose: 'Main JavaScript entry point' },
  { glob: 'src/main.ts', purpose: 'Application main entry point' },
  { glob: 'src/main.js', purpose: 'Application main entry point' },
  { glob: 'src/app.ts', purpose: 'Application bootstrap / Express app' },
  { glob: 'src/app.js', purpose: 'Application bootstrap / Express app' },
  { glob: 'src/server.ts', purpose: 'HTTP server start file' },
  { glob: 'src/server.js', purpose: 'HTTP server start file' },
  { glob: 'index.ts', purpose: 'Root entry point' },
  { glob: 'index.js', purpose: 'Root entry point' },
  { glob: 'main.py', purpose: 'Python main entry point' },
  { glob: 'app.py', purpose: 'Python application (Flask/FastAPI)' },
  { glob: 'manage.py', purpose: 'Django management script' },
  { glob: 'wsgi.py', purpose: 'WSGI application entry point' },
  { glob: 'asgi.py', purpose: 'ASGI application entry point' },
  { glob: 'main.go', purpose: 'Go main entry point' },
  { glob: 'cmd/main.go', purpose: 'Go command entry point' },
  { glob: 'src/main.rs', purpose: 'Rust main entry point' },
  { glob: 'src/lib.rs', purpose: 'Rust library crate root' },
  { glob: 'Main.java', purpose: 'Java main class' },
  { glob: 'Application.java', purpose: 'Spring Boot application entry point' },
  { glob: 'config/routes.rb', purpose: 'Rails route definitions' },
  { glob: 'lib/main.dart', purpose: 'Flutter/Dart main entry point' },
];

// ── Test framework signals ──────────────────────────────────────────────

/** Maps config files and dependencies to test frameworks. */
const TEST_FRAMEWORK_SIGNALS: { signal: string; framework: string; command: string }[] = [
  { signal: 'jest.config', framework: 'Jest', command: 'npx jest' },
  { signal: 'vitest.config', framework: 'Vitest', command: 'npx vitest' },
  { signal: 'mocha', framework: 'Mocha', command: 'npx mocha' },
  { signal: 'cypress.config', framework: 'Cypress', command: 'npx cypress run' },
  { signal: 'playwright.config', framework: 'Playwright', command: 'npx playwright test' },
  { signal: 'pytest', framework: 'pytest', command: 'pytest' },
  { signal: 'unittest', framework: 'unittest', command: 'python -m unittest' },
  { signal: '_test.go', framework: 'Go testing', command: 'go test ./...' },
  { signal: 'rspec', framework: 'RSpec', command: 'bundle exec rspec' },
  { signal: 'cargo test', framework: 'Cargo test', command: 'cargo test' },
  { signal: 'JUnit', framework: 'JUnit', command: 'mvn test' },
];

// ═══════════════════════════════════════════════════════════════════════
//  1. generateOnboardingGuide
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate a structured onboarding document for a codebase.
 *
 * Analyzes the project structure, configuration files, dependencies,
 * and architectural patterns to produce a comprehensive guide for new
 * developers joining the project.
 *
 * @param cwd - Root directory of the codebase to analyze.
 * @param options - Optional configuration.
 * @param options.maxFiles - Maximum files to scan (default 2000).
 * @param options.includeArchitecture - Whether to detect architectural layers (default true).
 * @param options.includeDependencies - Whether to analyze dependencies (default true).
 * @returns A structured onboarding guide.
 */
export async function generateOnboardingGuide(
  cwd: string,
  options?: {
    maxFiles?: number;
    includeArchitecture?: boolean;
    includeDependencies?: boolean;
  },
): Promise<OnboardingGuide> {
  const maxFiles = options?.maxFiles ?? 2000;
  const includeArchitecture = options?.includeArchitecture !== false;
  const includeDeps = options?.includeDependencies !== false;

  // Gather all files once
  const allFiles = await listFiles(cwd, { type: 'file' });
  const files = allFiles.slice(0, maxFiles);
  const fileSet = new Set(files.map((f) => f.toLowerCase()));
  const fileBasenames = new Set(files.map((f) => path.basename(f).toLowerCase()));

  // Detect project name
  const projectName = await detectProjectName(cwd);

  // Detect project type
  const projectType = detectProjectType(fileSet, fileBasenames);

  // Detect tech stack
  const techStack = detectTechStack(cwd, files, fileSet, fileBasenames);

  // Detect entry points
  const entryPoints = detectEntryPoints(cwd, files);

  // Detect key config files
  const keyFiles = detectKeyFiles(cwd, files, fileSet, fileBasenames);

  // Extract setup commands
  const { setupSteps, commonTasks } = await extractSetupInfo(cwd, fileSet, fileBasenames);

  // Detect architecture
  const architecture = includeArchitecture ? detectArchitectureLayers(cwd, files) : [];

  // Build sections
  const sections: OnboardingSection[] = [];

  // Overview section
  sections.push({
    title: 'Project Overview',
    content: `${projectName} is a ${projectType} project using ${techStack.slice(0, 5).join(', ') || 'standard tooling'}.`,
  });

  // Getting Started section
  if (setupSteps.length > 0) {
    sections.push({
      title: 'Getting Started',
      content: 'Follow these steps to set up your local development environment:',
      commands: setupSteps,
    });
  }

  // Architecture section
  if (architecture.length > 0) {
    const archContent = architecture
      .map((a) => `- **${a.layer}** (\`${a.directory}\`): ${a.description}`)
      .join('\n');
    sections.push({
      title: 'Architecture',
      content: `The project follows a layered architecture:\n\n${archContent}`,
      files: architecture.map((a) => a.directory),
    });
  }

  // Entry Points section
  if (entryPoints.length > 0) {
    const epContent = entryPoints.map((e) => `- \`${e.file}\`: ${e.purpose}`).join('\n');
    sections.push({
      title: 'Entry Points',
      content: `Key entry points to understand the application flow:\n\n${epContent}`,
      files: entryPoints.map((e) => e.file),
    });
  }

  // Key Files section
  if (keyFiles.length > 0) {
    const kfContent = keyFiles.map((k) => `- \`${k.file}\`: ${k.purpose}`).join('\n');
    sections.push({
      title: 'Key Configuration Files',
      content: `Important configuration files you should be familiar with:\n\n${kfContent}`,
      files: keyFiles.map((k) => k.file),
    });
  }

  // Testing section
  const testInfo = await detectTestFramework(cwd, files, fileBasenames);
  if (testInfo) {
    sections.push({
      title: 'Testing',
      content: `Tests use **${testInfo.framework}**. Run the test suite with:`,
      commands: [testInfo.command],
    });
  }

  // Common Tasks section
  if (commonTasks.length > 0) {
    const tasksContent = commonTasks.map((t) => `- **${t.task}**: \`${t.command}\``).join('\n');
    sections.push({
      title: 'Common Tasks',
      content: tasksContent,
      commands: commonTasks.map((t) => t.command),
    });
  }

  // Dependencies section
  if (includeDeps) {
    const deps = await extractKeyDependencies(cwd);
    if (deps.length > 0) {
      const depContent = deps.map((d) => `- **${d.name}**: ${d.role}`).join('\n');
      sections.push({
        title: 'Key Dependencies',
        content: depContent,
      });
    }
  }

  // Deployment section
  const deployFiles = files.filter(
    (f) =>
      f.toLowerCase().includes('dockerfile') ||
      f.includes('k8s/') ||
      f.includes('kubernetes/') ||
      f.includes('deploy/') ||
      f.includes('.github/workflows') ||
      f.includes('.gitlab-ci') ||
      f.includes('Jenkinsfile') ||
      f.includes('helm/'),
  );
  if (deployFiles.length > 0) {
    sections.push({
      title: 'Deployment & CI/CD',
      content: 'The project includes deployment and CI/CD configuration:',
      files: deployFiles.slice(0, 10),
    });
  }

  return {
    projectName,
    projectType,
    techStack,
    sections,
    entryPoints,
    keyFiles,
    setupSteps,
    commonTasks,
    architecture,
  };
}

/**
 * Detect the project name from package.json, Cargo.toml, go.mod, etc.
 *
 * @param cwd - Root directory.
 * @returns The detected project name or the directory basename.
 */
async function detectProjectName(cwd: string): Promise<string> {
  // Try package.json
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    if (pkg.name) return pkg.name;
  } catch { /* not a Node.js project */ }

  // Try Cargo.toml
  try {
    const cargo = await readFile(path.join(cwd, 'Cargo.toml'), 'utf-8');
    const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) return nameMatch[1];
  } catch { /* not a Rust project */ }

  // Try go.mod
  try {
    const gomod = await readFile(path.join(cwd, 'go.mod'), 'utf-8');
    const modMatch = gomod.match(/^module\s+(\S+)/m);
    if (modMatch) return modMatch[1].split('/').pop() || modMatch[1];
  } catch { /* not a Go project */ }

  // Try pyproject.toml
  try {
    const pyproject = await readFile(path.join(cwd, 'pyproject.toml'), 'utf-8');
    const nameMatch = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) return nameMatch[1];
  } catch { /* not a Python project */ }

  return path.basename(cwd);
}

/**
 * Detect the primary project type from config file presence.
 *
 * @param fileSet - Lowercased set of all file paths.
 * @param basenames - Set of lowercased file basenames.
 * @returns Detected project type string.
 */
function detectProjectType(fileSet: Set<string>, basenames: Set<string>): string {
  const detected: string[] = [];
  for (const signal of PROJECT_TYPE_SIGNALS) {
    if (basenames.has(signal.file.toLowerCase()) || fileSet.has(signal.file.toLowerCase())) {
      detected.push(signal.type);
    }
  }
  return detected.length > 0 ? [...new Set(detected)].join(' / ') : 'Unknown';
}

/**
 * Detect the technology stack from config files and directory presence.
 *
 * @param cwd - Root directory.
 * @param files - All file paths.
 * @param fileSet - Lowercased set of file paths.
 * @param basenames - Set of lowercased basenames.
 * @returns Array of detected technology names.
 */
function detectTechStack(cwd: string, files: string[], fileSet: Set<string>, basenames: Set<string>): string[] {
  const stack: Set<string> = new Set();

  for (const signal of TECH_STACK_SIGNALS) {
    const lower = signal.file.toLowerCase();
    if (basenames.has(lower) || fileSet.has(lower) || files.some((f) => f.toLowerCase().includes(lower))) {
      stack.add(signal.tech);
    }
  }

  // Detect languages from file extensions
  const langCounts: Record<string, number> = {};
  for (const file of files) {
    const lang = detectLanguage(file);
    if (lang !== 'unknown') {
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
  }
  const topLangs = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);
  for (const lang of topLangs) {
    stack.add(lang.charAt(0).toUpperCase() + lang.slice(1));
  }

  return [...stack];
}

/**
 * Detect entry points from known patterns.
 *
 * @param cwd - Root directory.
 * @param files - All file paths.
 * @returns Array of entry points with file path and purpose.
 */
function detectEntryPoints(cwd: string, files: string[]): { file: string; purpose: string }[] {
  const entryPoints: { file: string; purpose: string }[] = [];
  const seen = new Set<string>();

  for (const pattern of ENTRY_POINT_PATTERNS) {
    for (const file of files) {
      if (
        file === pattern.glob ||
        file.endsWith('/' + pattern.glob) ||
        file.toLowerCase() === pattern.glob.toLowerCase()
      ) {
        if (!seen.has(file)) {
          seen.add(file);
          entryPoints.push({ file, purpose: pattern.purpose });
        }
      }
    }
  }

  return entryPoints.slice(0, 15);
}

/**
 * Detect key configuration files present in the project.
 *
 * @param cwd - Root directory.
 * @param files - All file paths.
 * @param fileSet - Lowercased set of file paths.
 * @param basenames - Set of lowercased basenames.
 * @returns Array of key files with purpose descriptions.
 */
function detectKeyFiles(
  cwd: string,
  files: string[],
  fileSet: Set<string>,
  basenames: Set<string>,
): { file: string; purpose: string }[] {
  const keyFiles: { file: string; purpose: string }[] = [];

  for (const kf of KEY_CONFIG_FILES) {
    const lower = kf.file.toLowerCase();
    if (basenames.has(lower) || fileSet.has(lower)) {
      // Find the actual file path
      const actual = files.find(
        (f) => f.toLowerCase() === lower || path.basename(f).toLowerCase() === lower,
      );
      if (actual) {
        keyFiles.push({ file: actual, purpose: kf.purpose });
      }
    } else if (files.some((f) => f.toLowerCase().includes(lower))) {
      const actual = files.find((f) => f.toLowerCase().includes(lower));
      if (actual) {
        keyFiles.push({ file: actual, purpose: kf.purpose });
      }
    }
  }

  return keyFiles.slice(0, 20);
}

/**
 * Extract setup steps and common tasks from package.json scripts, Makefile, and Dockerfile.
 *
 * @param cwd - Root directory.
 * @param fileSet - Lowercased file set.
 * @param basenames - Set of lowercased basenames.
 * @returns Setup steps and common tasks extracted from build files.
 */
async function extractSetupInfo(
  cwd: string,
  fileSet: Set<string>,
  basenames: Set<string>,
): Promise<{ setupSteps: string[]; commonTasks: { task: string; command: string }[] }> {
  const setupSteps: string[] = [];
  const commonTasks: { task: string; command: string }[] = [];

  // Clone step
  setupSteps.push('git clone <repository-url> && cd <project-directory>');

  // package.json scripts
  if (basenames.has('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));

      // Detect package manager
      let pm = 'npm';
      if (existsSync(path.join(cwd, 'yarn.lock'))) pm = 'yarn';
      else if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) pm = 'pnpm';
      else if (existsSync(path.join(cwd, 'bun.lockb'))) pm = 'bun';

      setupSteps.push(`${pm} install`);

      if (pkg.scripts) {
        const scripts = pkg.scripts as Record<string, string>;
        if (scripts.build) commonTasks.push({ task: 'Build', command: `${pm} run build` });
        if (scripts.dev) {
          setupSteps.push(`${pm} run dev`);
          commonTasks.push({ task: 'Development server', command: `${pm} run dev` });
        } else if (scripts.start) {
          setupSteps.push(`${pm} run start`);
          commonTasks.push({ task: 'Start', command: `${pm} run start` });
        }
        if (scripts.test) commonTasks.push({ task: 'Run tests', command: `${pm} run test` });
        if (scripts.lint) commonTasks.push({ task: 'Lint', command: `${pm} run lint` });
        if (scripts.format) commonTasks.push({ task: 'Format', command: `${pm} run format` });
        if (scripts['type-check'] || scripts.typecheck) {
          commonTasks.push({ task: 'Type check', command: `${pm} run ${scripts['type-check'] ? 'type-check' : 'typecheck'}` });
        }
        if (scripts.migrate) commonTasks.push({ task: 'Run migrations', command: `${pm} run migrate` });
        if (scripts.seed) commonTasks.push({ task: 'Seed database', command: `${pm} run seed` });
      }
    } catch { /* package.json parse error */ }
  }

  // Python projects
  if (basenames.has('requirements.txt') || basenames.has('pyproject.toml') || basenames.has('pipfile')) {
    if (basenames.has('pipfile')) {
      setupSteps.push('pipenv install');
    } else if (basenames.has('pyproject.toml')) {
      setupSteps.push('pip install -e ".[dev]"');
    } else {
      setupSteps.push('pip install -r requirements.txt');
    }
  }

  // Go projects
  if (basenames.has('go.mod')) {
    setupSteps.push('go mod download');
    commonTasks.push({ task: 'Build', command: 'go build ./...' });
    commonTasks.push({ task: 'Run tests', command: 'go test ./...' });
  }

  // Rust projects
  if (basenames.has('cargo.toml')) {
    setupSteps.push('cargo build');
    commonTasks.push({ task: 'Build', command: 'cargo build' });
    commonTasks.push({ task: 'Run tests', command: 'cargo test' });
  }

  // Makefile targets
  if (basenames.has('makefile')) {
    try {
      const makeContent = await readFile(path.join(cwd, 'Makefile'), 'utf-8');
      const targets = makeContent.match(/^([a-zA-Z_][\w-]*):/gm);
      if (targets) {
        for (const target of targets.slice(0, 10)) {
          const name = target.replace(':', '');
          if (!['all', 'default', '.PHONY'].includes(name)) {
            commonTasks.push({ task: `Make ${name}`, command: `make ${name}` });
          }
        }
      }
    } catch { /* Makefile read error */ }
  }

  // Docker
  if (basenames.has('dockerfile') || fileSet.has('dockerfile')) {
    commonTasks.push({ task: 'Build Docker image', command: 'docker build -t <image-name> .' });
  }
  if (basenames.has('docker-compose.yml') || basenames.has('docker-compose.yaml')) {
    commonTasks.push({ task: 'Start services', command: 'docker-compose up -d' });
  }

  return { setupSteps, commonTasks };
}

/**
 * Detect the test framework used in the project.
 *
 * @param cwd - Root directory.
 * @param files - All file paths.
 * @param basenames - Set of lowercased basenames.
 * @returns Test framework info, or null if not detected.
 */
async function detectTestFramework(
  cwd: string,
  files: string[],
  basenames: Set<string>,
): Promise<{ framework: string; command: string } | null> {
  for (const signal of TEST_FRAMEWORK_SIGNALS) {
    if (
      files.some((f) => f.toLowerCase().includes(signal.signal.toLowerCase())) ||
      basenames.has(signal.signal.toLowerCase())
    ) {
      return { framework: signal.framework, command: signal.command };
    }
  }

  // Check package.json devDependencies
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps.vitest) return { framework: 'Vitest', command: 'npx vitest' };
    if (allDeps.jest) return { framework: 'Jest', command: 'npx jest' };
    if (allDeps.mocha) return { framework: 'Mocha', command: 'npx mocha' };
    if (allDeps.ava) return { framework: 'AVA', command: 'npx ava' };
  } catch { /* no package.json */ }

  return null;
}

/**
 * Detect architectural layers from directory structure.
 *
 * @param cwd - Root directory.
 * @param files - All file paths.
 * @returns Array of detected architecture layers.
 */
function detectArchitectureLayers(
  cwd: string,
  files: string[],
): { layer: string; directory: string; description: string }[] {
  const layers: { layer: string; directory: string; description: string }[] = [];
  const seen = new Set<string>();

  // Collect all directories
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i <= Math.min(parts.length - 1, 3); i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  for (const layerDef of ARCHITECTURE_LAYERS) {
    for (const dir of layerDef.dirs) {
      if (dirs.has(dir) && !seen.has(layerDef.layer)) {
        seen.add(layerDef.layer);
        layers.push({
          layer: layerDef.layer,
          directory: dir,
          description: layerDef.description,
        });
        break;
      }
    }
  }

  return layers;
}

/**
 * Extract key dependencies and their roles from package.json.
 *
 * @param cwd - Root directory.
 * @returns Array of key dependencies with name and role.
 */
async function extractKeyDependencies(cwd: string): Promise<{ name: string; role: string }[]> {
  const deps: { name: string; role: string }[] = [];

  /** Well-known npm packages and their roles. */
  const KNOWN_PACKAGES: Record<string, string> = {
    express: 'HTTP server framework',
    fastify: 'High-performance HTTP framework',
    koa: 'Lightweight HTTP framework',
    hapi: 'Server framework for APIs',
    react: 'UI component library',
    'react-dom': 'React DOM renderer',
    vue: 'Progressive UI framework',
    angular: 'Full-featured UI framework',
    svelte: 'Compiled UI framework',
    next: 'React full-stack framework (SSR/SSG)',
    nuxt: 'Vue full-stack framework',
    prisma: 'Type-safe database ORM',
    drizzle: 'Lightweight TypeScript ORM',
    typeorm: 'TypeScript ORM with decorators',
    sequelize: 'Promise-based SQL ORM',
    mongoose: 'MongoDB ODM',
    knex: 'SQL query builder',
    graphql: 'GraphQL query language runtime',
    'apollo-server': 'GraphQL server',
    axios: 'HTTP client',
    lodash: 'Utility library',
    zod: 'Schema validation library',
    joi: 'Schema validation library',
    winston: 'Logging library',
    pino: 'Fast JSON logger',
    redis: 'Redis client',
    ioredis: 'Redis client (advanced)',
    bull: 'Job queue for Redis',
    bullmq: 'Job queue for Redis (modern)',
    passport: 'Authentication middleware',
    jsonwebtoken: 'JWT implementation',
    bcrypt: 'Password hashing',
    socket: 'WebSocket library',
    'socket.io': 'Real-time bidirectional events',
    tailwindcss: 'Utility-first CSS framework',
    'styled-components': 'CSS-in-JS library',
    jest: 'JavaScript test framework',
    vitest: 'Vite-native test framework',
    mocha: 'Test framework',
    cypress: 'E2E testing framework',
    playwright: 'Browser automation / E2E testing',
    webpack: 'Module bundler',
    vite: 'Next-gen frontend build tool',
    esbuild: 'Fast JavaScript bundler',
    rollup: 'ES module bundler',
    eslint: 'JavaScript/TypeScript linter',
    prettier: 'Code formatter',
    typescript: 'TypeScript compiler',
  };

  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const [name, _version] of Object.entries(allDeps)) {
      const baseName = name.replace(/^@[^/]+\//, '');
      const knownRole = KNOWN_PACKAGES[baseName] || KNOWN_PACKAGES[name];
      if (knownRole) {
        deps.push({ name, role: knownRole });
      }
    }
  } catch { /* no package.json */ }

  return deps.slice(0, 25);
}

// ═══════════════════════════════════════════════════════════════════════
//  2. detectConventions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Auto-detect coding conventions used in the codebase.
 *
 * Samples source files to determine naming patterns, import styles,
 * code formatting preferences, error handling patterns, and file
 * organization conventions.
 *
 * @param cwd - Root directory of the codebase.
 * @param options - Optional configuration.
 * @param options.maxFiles - Maximum files to sample (default 50).
 * @param options.fileGlob - Glob pattern to filter files.
 * @returns Detected conventions with confidence scores and examples.
 */
export async function detectConventions(
  cwd: string,
  options?: {
    maxFiles?: number;
    fileGlob?: string;
  },
): Promise<ConventionResult> {
  const maxFiles = options?.maxFiles ?? 50;
  const glob = options?.fileGlob ?? '*.{ts,tsx,js,jsx,py,go,rs,java,rb,php}';

  const allFiles = await listFiles(cwd, { glob, type: 'file' });
  // Sample up to maxFiles, evenly distributed
  const step = Math.max(1, Math.floor(allFiles.length / maxFiles));
  const sampledFiles: string[] = [];
  for (let i = 0; i < allFiles.length && sampledFiles.length < maxFiles; i += step) {
    sampledFiles.push(allFiles[i]);
  }

  const conventions: Convention[] = [];
  const fileContents: { file: string; content: string; lines: string[] }[] = [];

  // Read all sampled files
  for (const file of sampledFiles) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf-8');
      fileContents.push({ file, content, lines: content.split('\n') });
    } catch { /* skip unreadable files */ }
  }

  if (fileContents.length === 0) {
    return {
      conventions: [],
      fileNaming: [],
      importStyle: [],
      codeStyle: {},
      summary: 'No source files found to analyze conventions.',
    };
  }

  // ── Naming conventions ────────────────────────────────────────────

  const fileNaming = analyzeFileNaming(allFiles);
  const namingConventions = analyzeIdentifierNaming(fileContents);
  conventions.push(...namingConventions);

  // ── File organization ─────────────────────────────────────────────

  const orgConventions = analyzeFileOrganization(allFiles);
  conventions.push(...orgConventions);

  // ── Import style ──────────────────────────────────────────────────

  const importStyle = analyzeImportStyle(fileContents);

  // ── Error handling ────────────────────────────────────────────────

  const errorConventions = analyzeErrorHandling(fileContents);
  conventions.push(...errorConventions);

  // ── Logging ───────────────────────────────────────────────────────

  const logConventions = analyzeLogging(fileContents);
  conventions.push(...logConventions);

  // ── Code style ────────────────────────────────────────────────────

  const codeStyle = analyzeCodeStyle(fileContents);

  // Build summary
  const highConfidence = conventions.filter((c) => c.confidence >= 0.7);
  const summaryParts = highConfidence
    .slice(0, 10)
    .map((c) => `${c.category}/${c.name}: ${c.value}`)
    .join(', ');

  return {
    conventions,
    fileNaming,
    importStyle,
    codeStyle,
    summary: highConfidence.length > 0
      ? `Detected conventions: ${summaryParts}`
      : 'Insufficient data to confidently detect conventions.',
  };
}

/**
 * Analyze file naming patterns (camelCase, kebab-case, snake_case, PascalCase).
 *
 * @param files - All file paths.
 * @returns Distribution of naming patterns.
 */
function analyzeFileNaming(files: string[]): { pattern: string; examples: string[]; percentage: number }[] {
  const patterns: Record<string, string[]> = {
    'kebab-case': [],
    camelCase: [],
    snake_case: [],
    PascalCase: [],
    'UPPER_CASE': [],
    other: [],
  };

  for (const file of files) {
    const basename = path.basename(file, path.extname(file));
    // Skip dotfiles and index/test files
    if (basename.startsWith('.') || basename === 'index' || basename === 'main') continue;

    if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(basename)) {
      patterns['kebab-case'].push(file);
    } else if (/^[a-z][a-zA-Z0-9]*$/.test(basename) && /[A-Z]/.test(basename)) {
      patterns['camelCase'].push(file);
    } else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(basename)) {
      patterns['snake_case'].push(file);
    } else if (/^[A-Z][a-zA-Z0-9]*$/.test(basename)) {
      patterns['PascalCase'].push(file);
    } else if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(basename)) {
      patterns['UPPER_CASE'].push(file);
    } else {
      patterns['other'].push(file);
    }
  }

  const total = Object.values(patterns).reduce((s, arr) => s + arr.length, 0);
  if (total === 0) return [];

  return Object.entries(patterns)
    .filter(([, arr]) => arr.length > 0)
    .map(([pattern, arr]) => ({
      pattern,
      examples: arr.slice(0, 5),
      percentage: Math.round((arr.length / total) * 100),
    }))
    .sort((a, b) => b.percentage - a.percentage);
}

/**
 * Analyze identifier naming conventions in source code.
 *
 * @param fileContents - Array of file content objects.
 * @returns Conventions detected for function, class, and variable naming.
 */
function analyzeIdentifierNaming(
  fileContents: { file: string; content: string; lines: string[] }[],
): Convention[] {
  const conventions: Convention[] = [];

  // Detect function naming: camelCase vs snake_case vs PascalCase
  let camelFuncs = 0;
  let snakeFuncs = 0;
  let pascalFuncs = 0;
  const camelExamples: Convention['examples'] = [];
  const snakeExamples: Convention['examples'] = [];

  for (const { file, lines } of fileContents) {
    for (let i = 0; i < lines.length; i++) {
      const funcMatch = lines[i].match(
        /(?:function|def|fn|func)\s+([a-zA-Z_]\w*)/,
      );
      if (funcMatch) {
        const name = funcMatch[1];
        if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) {
          camelFuncs++;
          if (camelExamples.length < 3) {
            camelExamples.push({ file, line: i + 1, code: lines[i].trim() });
          }
        } else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) {
          snakeFuncs++;
          if (snakeExamples.length < 3) {
            snakeExamples.push({ file, line: i + 1, code: lines[i].trim() });
          }
        } else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
          pascalFuncs++;
        }
      }
    }
  }

  const totalFuncs = camelFuncs + snakeFuncs + pascalFuncs;
  if (totalFuncs > 0) {
    if (camelFuncs >= snakeFuncs && camelFuncs >= pascalFuncs) {
      conventions.push({
        category: 'naming',
        name: 'function-naming',
        value: 'camelCase',
        confidence: camelFuncs / totalFuncs,
        examples: camelExamples,
      });
    } else if (snakeFuncs >= camelFuncs) {
      conventions.push({
        category: 'naming',
        name: 'function-naming',
        value: 'snake_case',
        confidence: snakeFuncs / totalFuncs,
        examples: snakeExamples,
      });
    }
  }

  // Detect class naming
  let pascalClasses = 0;
  const classExamples: Convention['examples'] = [];

  for (const { file, lines } of fileContents) {
    for (let i = 0; i < lines.length; i++) {
      const classMatch = lines[i].match(/(?:class|interface|struct|trait|type)\s+([A-Z]\w*)/);
      if (classMatch) {
        pascalClasses++;
        if (classExamples.length < 3) {
          classExamples.push({ file, line: i + 1, code: lines[i].trim() });
        }
      }
    }
  }

  if (pascalClasses > 0) {
    conventions.push({
      category: 'naming',
      name: 'class-naming',
      value: 'PascalCase',
      confidence: 1.0,
      examples: classExamples,
    });
  }

  return conventions;
}

/**
 * Analyze file organization patterns.
 *
 * @param files - All file paths.
 * @returns Conventions for file organization.
 */
function analyzeFileOrganization(files: string[]): Convention[] {
  const conventions: Convention[] = [];

  // Check flat vs nested
  const maxDepths = files.map((f) => f.split('/').length);
  const avgDepth = maxDepths.reduce((a, b) => a + b, 0) / maxDepths.length;

  conventions.push({
    category: 'file-organization',
    name: 'directory-depth',
    value: avgDepth < 2.5 ? 'flat' : avgDepth < 4 ? 'moderately nested' : 'deeply nested',
    confidence: 0.8,
    examples: [],
  });

  // Co-located tests vs separate test directory
  const colocatedTests = files.filter((f) =>
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f) && !f.startsWith('tests/') && !f.startsWith('test/') && !f.includes('__tests__'),
  );
  const separateTests = files.filter((f) =>
    f.startsWith('tests/') || f.startsWith('test/') || f.includes('__tests__/'),
  );
  const testDirTests = files.filter((f) => f.includes('__tests__/'));

  if (colocatedTests.length > 0 || separateTests.length > 0) {
    const total = colocatedTests.length + separateTests.length;
    const isColocated = colocatedTests.length >= separateTests.length;
    conventions.push({
      category: 'file-organization',
      name: 'test-location',
      value: isColocated ? 'co-located with source' : 'separate test directory',
      confidence: Math.max(colocatedTests.length, separateTests.length) / total,
      examples: (isColocated ? colocatedTests : separateTests).slice(0, 3).map((f) => ({
        file: f,
        line: 0,
        code: f,
      })),
    });
  }

  // Barrel files (index.ts re-exports)
  const barrelFiles = files.filter((f) => /\/index\.(ts|js)$/.test(f));
  if (barrelFiles.length > 2) {
    conventions.push({
      category: 'file-organization',
      name: 'barrel-files',
      value: 'uses barrel files (index re-exports)',
      confidence: Math.min(barrelFiles.length / 10, 1.0),
      examples: barrelFiles.slice(0, 3).map((f) => ({ file: f, line: 0, code: f })),
    });
  }

  return conventions;
}

/**
 * Analyze import style conventions.
 *
 * @param fileContents - Array of file content objects.
 * @returns Distribution of import styles.
 */
function analyzeImportStyle(
  fileContents: { file: string; content: string; lines: string[] }[],
): { style: string; count: number; percentage: number }[] {
  let relativeImports = 0;
  let absoluteImports = 0;
  let namedImports = 0;
  let defaultImports = 0;
  let typeImports = 0;

  for (const { lines } of fileContents) {
    for (const line of lines) {
      const importMatch = line.match(/^import\s+/);
      if (!importMatch) continue;

      // Relative vs absolute
      if (line.includes("from './") || line.includes("from '../") || line.includes('from "./') || line.includes('from "../')) {
        relativeImports++;
      } else if (line.includes("from '@/") || line.includes("from '~") || line.includes('from "@/') || line.includes('from "~')) {
        absoluteImports++;
      }

      // Named vs default
      if (line.includes('{')) {
        namedImports++;
      } else if (/^import\s+\w+\s+from/.test(line)) {
        defaultImports++;
      }

      // Type imports
      if (line.includes('import type') || line.includes('import { type')) {
        typeImports++;
      }
    }
  }

  const styles: { style: string; count: number; percentage: number }[] = [];
  const totalImports = relativeImports + absoluteImports;
  if (totalImports > 0) {
    if (relativeImports > 0) {
      styles.push({ style: 'relative paths', count: relativeImports, percentage: Math.round((relativeImports / totalImports) * 100) });
    }
    if (absoluteImports > 0) {
      styles.push({ style: 'alias/absolute paths', count: absoluteImports, percentage: Math.round((absoluteImports / totalImports) * 100) });
    }
  }

  const totalNaming = namedImports + defaultImports;
  if (totalNaming > 0) {
    if (namedImports > 0) {
      styles.push({ style: 'named imports', count: namedImports, percentage: Math.round((namedImports / totalNaming) * 100) });
    }
    if (defaultImports > 0) {
      styles.push({ style: 'default imports', count: defaultImports, percentage: Math.round((defaultImports / totalNaming) * 100) });
    }
  }

  if (typeImports > 0) {
    styles.push({ style: 'type imports', count: typeImports, percentage: 0 });
  }

  return styles.sort((a, b) => b.count - a.count);
}

/**
 * Analyze error handling patterns in source code.
 *
 * @param fileContents - Array of file content objects.
 * @returns Error handling conventions detected.
 */
function analyzeErrorHandling(
  fileContents: { file: string; content: string; lines: string[] }[],
): Convention[] {
  const conventions: Convention[] = [];
  let tryCatch = 0;
  let dotCatch = 0;
  let customErrors = 0;
  let resultTypes = 0;
  const tryCatchExamples: Convention['examples'] = [];
  const dotCatchExamples: Convention['examples'] = [];

  for (const { file, content, lines } of fileContents) {
    for (let i = 0; i < lines.length; i++) {
      if (/\btry\s*\{/.test(lines[i]) || /\btry:/.test(lines[i])) {
        tryCatch++;
        if (tryCatchExamples.length < 3) {
          tryCatchExamples.push({ file, line: i + 1, code: lines[i].trim() });
        }
      }
      if (/\.catch\s*\(/.test(lines[i])) {
        dotCatch++;
        if (dotCatchExamples.length < 3) {
          dotCatchExamples.push({ file, line: i + 1, code: lines[i].trim() });
        }
      }
      if (/class\s+\w+Error\s+extends\s+(Error|BaseError|CustomError)/.test(lines[i])) {
        customErrors++;
      }
      if (/\bResult</.test(lines[i]) || /\bEither</.test(lines[i]) || /-> Result</.test(lines[i])) {
        resultTypes++;
      }
    }
  }

  const totalErrorHandling = tryCatch + dotCatch;
  if (totalErrorHandling > 0) {
    if (tryCatch >= dotCatch) {
      conventions.push({
        category: 'error-handling',
        name: 'error-style',
        value: 'try/catch blocks',
        confidence: tryCatch / totalErrorHandling,
        examples: tryCatchExamples,
      });
    } else {
      conventions.push({
        category: 'error-handling',
        name: 'error-style',
        value: 'promise .catch()',
        confidence: dotCatch / totalErrorHandling,
        examples: dotCatchExamples,
      });
    }
  }

  if (customErrors > 0) {
    conventions.push({
      category: 'error-handling',
      name: 'custom-errors',
      value: 'uses custom error classes',
      confidence: Math.min(customErrors / 5, 1.0),
      examples: [],
    });
  }

  if (resultTypes > 0) {
    conventions.push({
      category: 'error-handling',
      name: 'result-types',
      value: 'uses Result/Either types',
      confidence: Math.min(resultTypes / 5, 1.0),
      examples: [],
    });
  }

  return conventions;
}

/**
 * Analyze logging patterns in source code.
 *
 * @param fileContents - Array of file content objects.
 * @returns Logging conventions detected.
 */
function analyzeLogging(
  fileContents: { file: string; content: string; lines: string[] }[],
): Convention[] {
  const conventions: Convention[] = [];
  let consoleLog = 0;
  let structuredLogger = 0;
  const loggerExamples: Convention['examples'] = [];
  const consoleExamples: Convention['examples'] = [];

  for (const { file, lines } of fileContents) {
    for (let i = 0; i < lines.length; i++) {
      if (/\bconsole\.(log|warn|error|info|debug)\b/.test(lines[i])) {
        consoleLog++;
        if (consoleExamples.length < 3) {
          consoleExamples.push({ file, line: i + 1, code: lines[i].trim() });
        }
      }
      if (/\blogger\.(log|warn|error|info|debug|trace|fatal)\b/.test(lines[i]) ||
          /\blogging\.(log|warn|error|info|debug)\b/.test(lines[i]) ||
          /\blog\.(log|warn|error|info|debug|trace|fatal)\b/.test(lines[i])) {
        structuredLogger++;
        if (loggerExamples.length < 3) {
          loggerExamples.push({ file, line: i + 1, code: lines[i].trim() });
        }
      }
    }
  }

  const totalLogging = consoleLog + structuredLogger;
  if (totalLogging > 0) {
    if (structuredLogger >= consoleLog && structuredLogger > 0) {
      conventions.push({
        category: 'logging',
        name: 'logging-style',
        value: 'structured logger (winston/pino/bunyan)',
        confidence: structuredLogger / totalLogging,
        examples: loggerExamples,
      });
    } else if (consoleLog > 0) {
      conventions.push({
        category: 'logging',
        name: 'logging-style',
        value: 'console.log',
        confidence: consoleLog / totalLogging,
        examples: consoleExamples,
      });
    }
  }

  return conventions;
}

/**
 * Analyze code formatting style: semicolons, quotes, indentation, trailing commas.
 *
 * @param fileContents - Array of file content objects.
 * @returns Code style preferences as key-value pairs.
 */
function analyzeCodeStyle(
  fileContents: { file: string; content: string; lines: string[] }[],
): Record<string, string> {
  const style: Record<string, string> = {};

  let semicolons = 0;
  let noSemicolons = 0;
  let singleQuotes = 0;
  let doubleQuotes = 0;
  let tabs = 0;
  let spaces2 = 0;
  let spaces4 = 0;
  let trailingCommas = 0;
  let noTrailingCommas = 0;

  for (const { lines, content } of fileContents) {
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

      // Semicolons (only for JS/TS-like code)
      if (/[)}\]'"\w];\s*$/.test(trimmed)) {
        semicolons++;
      } else if (/[)}\]'"\w]\s*$/.test(trimmed) && !trimmed.endsWith('{') && !trimmed.endsWith(',') && !trimmed.endsWith('(')) {
        noSemicolons++;
      }

      // Quotes
      const singleMatches = trimmed.match(/'/g);
      const doubleMatches = trimmed.match(/"/g);
      if (singleMatches) singleQuotes += singleMatches.length;
      if (doubleMatches) doubleQuotes += doubleMatches.length;

      // Indentation
      if (line.startsWith('\t')) {
        tabs++;
      } else {
        const spaceMatch = line.match(/^( +)\S/);
        if (spaceMatch) {
          const indent = spaceMatch[1].length;
          if (indent === 2 || indent % 2 === 0 && indent < 4) spaces2++;
          else if (indent === 4 || indent % 4 === 0) spaces4++;
        }
      }

      // Trailing commas
      if (/,\s*$/.test(trimmed) && !/[({[]/.test(trimmed.charAt(trimmed.length - 1))) {
        trailingCommas++;
      }
    }
  }

  // Determine semicolon style
  const totalSemicolons = semicolons + noSemicolons;
  if (totalSemicolons > 10) {
    style.semicolons = semicolons > noSemicolons ? 'always' : 'never';
  }

  // Determine quote style
  if (singleQuotes + doubleQuotes > 10) {
    style.quotes = singleQuotes > doubleQuotes ? 'single' : 'double';
  }

  // Determine indentation
  const totalIndent = tabs + spaces2 + spaces4;
  if (totalIndent > 10) {
    if (tabs > spaces2 && tabs > spaces4) {
      style.indentation = 'tabs';
    } else if (spaces2 > spaces4) {
      style.indentation = '2 spaces';
    } else {
      style.indentation = '4 spaces';
    }
  }

  // Trailing commas
  if (trailingCommas > 5) {
    style.trailingCommas = 'yes';
  }

  return style;
}

// ═══════════════════════════════════════════════════════════════════════
//  3. buildCodebaseGlossary
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract domain-specific terminology from the codebase.
 *
 * Analyzes identifiers, comments, and documentation to build a glossary
 * of domain concepts. Groups related terms and attempts to extract
 * definitions from JSDoc, docstrings, and inline comments.
 *
 * @param cwd - Root directory of the codebase.
 * @param options - Optional configuration.
 * @param options.maxFiles - Maximum files to scan (default 200).
 * @param options.minOccurrences - Minimum occurrences for a term to be included (default 2).
 * @param options.fileGlob - Glob pattern to filter files.
 * @returns Glossary of domain terms with categories and statistics.
 */
export async function buildCodebaseGlossary(
  cwd: string,
  options?: {
    maxFiles?: number;
    minOccurrences?: number;
    fileGlob?: string;
  },
): Promise<GlossaryResult> {
  const maxFiles = options?.maxFiles ?? 200;
  const minOccurrences = options?.minOccurrences ?? 2;
  const glob = options?.fileGlob ?? '*.{ts,tsx,js,jsx,py,go,rs,java,rb,php}';

  const allFiles = await listFiles(cwd, { glob, type: 'file' });
  const files = allFiles.slice(0, maxFiles);

  // Collect all identifiers and their occurrences
  const identifierMap = new Map<string, { count: number; files: Set<string>; type: string }>();
  // Collect definitions from comments
  const definitions = new Map<string, string>();

  for (const file of files) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf-8');
      const lines = content.split('\n');

      extractIdentifiers(lines, file, identifierMap);
      extractDefinitions(lines, definitions);
    } catch { /* skip unreadable files */ }
  }

  // Filter to meaningful terms (min occurrences, multi-word or domain-specific)
  const rawTerms: GlossaryTerm[] = [];
  for (const [term, data] of identifierMap) {
    if (data.count < minOccurrences) continue;
    // Skip common programming keywords and single-character names
    if (isCommonKeyword(term) || term.length <= 2) continue;

    const definition = definitions.get(term) || definitions.get(term.toLowerCase());

    rawTerms.push({
      term,
      category: data.type,
      definition,
      occurrences: data.count,
      relatedTerms: [],
      files: [...data.files].slice(0, 10),
    });
  }

  // Sort by occurrences descending
  rawTerms.sort((a, b) => b.occurrences - a.occurrences);

  // Group by domain concept and find related terms
  const categorized = categorizeTerms(rawTerms);

  // Build category summary
  const categoryMap = new Map<string, number>();
  for (const term of categorized) {
    categoryMap.set(term.category, (categoryMap.get(term.category) || 0) + 1);
  }

  const categories = [...categoryMap.entries()]
    .map(([name, termCount]) => ({ name, termCount }))
    .sort((a, b) => b.termCount - a.termCount);

  const documented = categorized.filter((t) => t.definition).length;

  return {
    terms: categorized.slice(0, 200),
    categories,
    summary: {
      totalTerms: categorized.length,
      categories: categories.length,
      documented,
      undocumented: categorized.length - documented,
    },
  };
}

/**
 * Extract identifiers (class names, function names, type names) from source lines.
 *
 * @param lines - Source code lines.
 * @param file - File path for reference.
 * @param map - Accumulator map of identifiers to metadata.
 */
function extractIdentifiers(
  lines: string[],
  file: string,
  map: Map<string, { count: number; files: Set<string>; type: string }>,
): void {
  const patterns: { regex: RegExp; type: string }[] = [
    { regex: /(?:class|struct)\s+([A-Z]\w{2,})/g, type: 'class' },
    { regex: /(?:interface|trait|protocol)\s+([A-Z]\w{2,})/g, type: 'interface' },
    { regex: /(?:type|enum)\s+([A-Z]\w{2,})/g, type: 'type' },
    { regex: /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z]\w{2,})/g, type: 'function' },
    { regex: /(?:def|fn|func)\s+([a-zA-Z_]\w{2,})/g, type: 'function' },
    { regex: /(?:const|let|var)\s+([A-Z]\w{2,})\s*[:=]/g, type: 'constant' },
  ];

  const fullContent = lines.join('\n');

  for (const { regex, type } of patterns) {
    // Reset regex state since we reuse them
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(fullContent)) !== null) {
      const name = match[1];
      const existing = map.get(name);
      if (existing) {
        existing.count++;
        existing.files.add(file);
      } else {
        map.set(name, { count: 1, files: new Set([file]), type });
      }
    }
  }
}

/**
 * Extract definitions from JSDoc, docstrings, and comments.
 *
 * @param lines - Source code lines.
 * @param definitions - Accumulator map of term to definition text.
 */
function extractDefinitions(
  lines: string[],
  definitions: Map<string, string>,
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // JSDoc: /** ... */ followed by a declaration
    if (line.trim().startsWith('/**')) {
      const commentLines: string[] = [];
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) {
        commentLines.push(lines[j]);
        j++;
      }
      if (j < lines.length) commentLines.push(lines[j]);
      j++;

      // Skip empty lines
      while (j < lines.length && lines[j].trim() === '') j++;

      if (j < lines.length) {
        // Find the symbol name
        const symbolMatch = lines[j].match(
          /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|struct|trait)\s+(\w+)/,
        );
        if (symbolMatch) {
          const description = commentLines
            .join('\n')
            .replace(/\/\*\*\s*/, '')
            .replace(/\s*\*\//, '')
            .split('\n')
            .map((l) => l.replace(/^\s*\*\s?/, ''))
            .filter((l) => !l.startsWith('@'))
            .join(' ')
            .trim();
          if (description.length > 5) {
            definitions.set(symbolMatch[1], description);
          }
        }
      }
    }

    // Python docstrings
    const defMatch = line.match(/^(\s*)(?:class|def)\s+(\w+)/);
    if (defMatch) {
      // Look for docstring within next 3 lines
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const trimmed = lines[j].trim();
        if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
          const quote = trimmed.startsWith('"""') ? '"""' : "'''";
          if (trimmed.length > 6 && trimmed.endsWith(quote)) {
            // Single-line docstring
            definitions.set(defMatch[2], trimmed.slice(3, -3).trim());
          } else {
            // Multi-line docstring
            const docLines: string[] = [trimmed.slice(3)];
            let k = j + 1;
            while (k < lines.length && !lines[k].trim().endsWith(quote)) {
              docLines.push(lines[k].trim());
              k++;
            }
            const description = docLines.join(' ').trim();
            if (description.length > 5) {
              definitions.set(defMatch[2], description);
            }
          }
          break;
        }
        if (trimmed !== '') break;
      }
    }

    // Inline comments defining terms: // FooBar: description of foobar
    const inlineDefMatch = line.match(/\/\/\s*([A-Z]\w+)\s*[:—-]\s*(.{10,})/);
    if (inlineDefMatch) {
      definitions.set(inlineDefMatch[1], inlineDefMatch[2].trim());
    }
  }
}

/**
 * Check if a term is a common programming keyword that should be excluded.
 *
 * @param term - The identifier to check.
 * @returns True if the term is a common keyword.
 */
function isCommonKeyword(term: string): boolean {
  const keywords = new Set([
    // JavaScript/TypeScript
    'function', 'return', 'const', 'let', 'var', 'class', 'export', 'import',
    'default', 'async', 'await', 'Promise', 'Error', 'Array', 'Object', 'String',
    'Number', 'Boolean', 'Map', 'Set', 'Date', 'null', 'undefined', 'void', 'true',
    'false', 'this', 'super', 'new', 'delete', 'typeof', 'instanceof', 'throw',
    'try', 'catch', 'finally', 'for', 'while', 'switch', 'case', 'break', 'continue',
    'else', 'from', 'type', 'interface', 'enum', 'abstract', 'implements', 'extends',
    'static', 'public', 'private', 'protected', 'readonly', 'override',
    // Python
    'def', 'self', 'cls', 'None', 'True', 'False', 'print', 'len', 'range',
    'list', 'dict', 'tuple', 'set', 'str', 'int', 'float', 'bool', 'pass',
    // Go
    'func', 'main', 'init', 'err', 'nil', 'fmt',
    // Common test/util names
    'describe', 'test', 'expect', 'mock', 'jest', 'assert',
    'TODO', 'FIXME', 'NOTE', 'HACK', 'XXX',
  ]);
  return keywords.has(term);
}

/**
 * Categorize terms by grouping related identifiers into domain concepts.
 *
 * @param terms - Array of raw glossary terms.
 * @returns Terms with updated categories and related terms.
 */
function categorizeTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
  // Build a prefix map for grouping: e.g., "User" groups UserProfile, createUser, etc.
  const prefixGroups = new Map<string, GlossaryTerm[]>();

  for (const term of terms) {
    // Split camelCase/PascalCase into words
    const words = splitIdentifier(term.term);
    if (words.length === 0) continue;

    // Use the first meaningful word as the group key
    const key = words[0].toLowerCase();
    if (key.length <= 2) continue;

    if (!prefixGroups.has(key)) {
      prefixGroups.set(key, []);
    }
    prefixGroups.get(key)!.push(term);
  }

  // Assign categories and related terms
  for (const [key, group] of prefixGroups) {
    if (group.length >= 2) {
      const categoryName = key.charAt(0).toUpperCase() + key.slice(1) + '-related';
      const termNames = group.map((t) => t.term);

      for (const term of group) {
        term.category = categoryName;
        term.relatedTerms = termNames.filter((t) => t !== term.term).slice(0, 10);
      }
    }
  }

  return terms;
}

/**
 * Split a camelCase or PascalCase identifier into individual words.
 *
 * @param identifier - The identifier to split.
 * @returns Array of lowercase words.
 */
function splitIdentifier(identifier: string): string[] {
  // Handle snake_case
  if (identifier.includes('_')) {
    return identifier.split('_').filter(Boolean).map((w) => w.toLowerCase());
  }
  // Handle camelCase/PascalCase
  return identifier
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}
