/**
 * Governance & Compliance Analyzers
 *
 * Provides four analysis functions:
 * 1. checkGovernanceRules  - Custom architectural / governance rule enforcement
 * 2. auditLicenses         - Dependency license audit
 * 3. analyzeSupplyChainRisk - Supply-chain risk scoring
 * 4. auditSecretRotation    - Secret management practice audit
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

// ===========================================================================
// Shared helpers
// ===========================================================================

/**
 * Convert a score (0-100) to a letter grade.
 *
 * @param score - Numeric score from 0 to 100.
 * @returns Letter grade (A-F).
 */
function toGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Clamp a number into [0, 100].
 *
 * @param n - Value to clamp.
 * @returns Clamped integer.
 */
function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Safely read and parse a JSON file. Returns null on any error.
 *
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed value or null.
 */
async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Test whether a file path matches a simple glob scope string.
 * Supports leading `**\/`, trailing `*`, and literal path prefixes.
 *
 * @param filePath - Relative file path to test.
 * @param scope    - Glob-like scope string (e.g. "src/**\/*.ts").
 * @returns True if the file matches the scope.
 */
function matchesScope(filePath: string, scope: string): boolean {
  // Normalise separators
  const normalised = filePath.replace(/\\/g, '/');
  const s = scope.replace(/\\/g, '/');

  // Direct extension match (e.g. "*.ts")
  if (s.startsWith('*.')) {
    return normalised.endsWith(s.slice(1));
  }
  // Recursive glob (e.g. "src/**/*.ts")
  if (s.includes('**')) {
    const [prefix, suffix] = s.split('**');
    const prefixMatch = prefix ? normalised.startsWith(prefix.replace(/\/$/, '')) : true;
    const suffixClean = (suffix || '').replace(/^\//, '');
    const suffixMatch = suffixClean
      ? suffixClean.startsWith('*.')
        ? normalised.endsWith(suffixClean.slice(1))
        : normalised.includes(suffixClean)
      : true;
    return prefixMatch && suffixMatch;
  }
  // Plain prefix
  return normalised.startsWith(s.replace(/\/$/, ''));
}

// ===========================================================================
// 1. Governance Rules
// ===========================================================================

/** Definition of a single governance rule. */
export interface GovernanceRule {
  id: string;
  name: string;
  type: 'import-ban' | 'file-pattern' | 'dependency-ban' | 'layer-boundary';
  /** Pattern string whose meaning depends on the rule type:
   *  - import-ban: module specifier to ban (regex-safe)
   *  - file-pattern: regex to search for (or must-not-contain)
   *  - dependency-ban: package name to ban
   *  - layer-boundary: "sourceLayer->targetLayer" forbidden direction
   */
  pattern: string;
  /** Glob-style scope limiting which files are checked. */
  scope?: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** A single rule violation found during governance checking. */
export interface GovernanceViolation {
  ruleId: string;
  ruleName: string;
  file: string;
  line?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
}

/** Aggregated governance check result. */
export interface GovernanceResult {
  violations: GovernanceViolation[];
  passed: string[];
  summary: {
    totalRules: number;
    passed: number;
    failed: number;
    errors: number;
    warnings: number;
    infos: number;
  };
  presets: { name: string; description: string; ruleCount: number }[];
}

/** Options for {@link checkGovernanceRules}. */
export interface GovernanceOptions {
  /** Max source files to scan (default 1000). */
  maxFiles?: number;
  /** Include built-in presets by name. */
  presets?: Array<'security' | 'architecture' | 'quality'>;
}

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

/**
 * Return the three built-in governance rule presets.
 *
 * @returns An array of `{ name, description, rules }` presets.
 */
export function getBuiltInPresets(): {
  name: string;
  description: string;
  rules: GovernanceRule[];
}[] {
  return [
    {
      name: 'security',
      description: 'Detect common security anti-patterns (eval, hardcoded secrets, disabled TLS)',
      rules: [
        {
          id: 'sec-no-eval',
          name: 'No eval()',
          type: 'file-pattern',
          pattern: '\\beval\\s*\\(',
          scope: '*.{ts,tsx,js,jsx}',
          severity: 'error',
          message: 'eval() is forbidden -- use safer alternatives',
        },
        {
          id: 'sec-no-hardcoded-secret',
          name: 'No hardcoded secrets',
          type: 'file-pattern',
          pattern:
            '(?:password|secret|api_key|apikey|token|private_key|access_key)\\s*[:=]\\s*[\'"]\\S{8,}[\'"]',
          scope: '*.{ts,tsx,js,jsx,py,java,go,rb}',
          severity: 'error',
          message: 'Hardcoded secret detected -- move to environment variables or a secrets manager',
        },
        {
          id: 'sec-no-tls-disable',
          name: 'No TLS verification bypass',
          type: 'file-pattern',
          pattern: 'rejectUnauthorized\\s*:\\s*false|NODE_TLS_REJECT_UNAUTHORIZED\\s*=\\s*[\'"]?0',
          scope: '*.{ts,tsx,js,jsx}',
          severity: 'error',
          message: 'TLS verification must not be disabled',
        },
      ],
    },
    {
      name: 'architecture',
      description: 'Enforce layer boundaries and prevent circular imports',
      rules: [
        {
          id: 'arch-no-circular-utils',
          name: 'Utils must not import from tools',
          type: 'import-ban',
          pattern: '../tools/',
          scope: 'src/utils/**/*.ts',
          severity: 'error',
          message: 'Utility modules must not depend on tool modules (circular dependency risk)',
        },
        {
          id: 'arch-no-db-in-tools',
          name: 'Tools must not import DB directly',
          type: 'import-ban',
          pattern: '../db/',
          scope: 'src/tools/**/*.ts',
          severity: 'warning',
          message: 'Tool modules should access data through service or analyzer layers, not DB directly',
        },
      ],
    },
    {
      name: 'quality',
      description: 'Code quality guardrails (no console.log in src, no `any` type)',
      rules: [
        {
          id: 'qual-no-console-log',
          name: 'No console.log in source',
          type: 'file-pattern',
          pattern: '\\bconsole\\.log\\s*\\(',
          scope: 'src/**/*.ts',
          severity: 'warning',
          message: 'Use a structured logger instead of console.log in production source code',
        },
        {
          id: 'qual-no-any',
          name: 'No explicit any type',
          type: 'file-pattern',
          pattern: ':\\s*any\\b|<any>|as\\s+any\\b',
          scope: 'src/**/*.ts',
          severity: 'info',
          message: 'Avoid using the `any` type -- prefer explicit types or `unknown`',
        },
      ],
    },
  ];
}

/**
 * Check custom (and optionally built-in) governance rules against a codebase.
 *
 * @param cwd     - Project root directory.
 * @param rules   - Array of custom governance rules to enforce.
 * @param options - Optional configuration.
 * @returns A {@link GovernanceResult} with violations, pass/fail counts, and preset info.
 */
export async function checkGovernanceRules(
  cwd: string,
  rules: GovernanceRule[],
  options?: GovernanceOptions,
): Promise<GovernanceResult> {
  const maxFiles = options?.maxFiles ?? 1000;
  const allRules = [...rules];

  // Merge requested presets
  const presets = getBuiltInPresets();
  const presetSummary = presets.map((p) => ({
    name: p.name,
    description: p.description,
    ruleCount: p.rules.length,
  }));

  if (options?.presets) {
    for (const presetName of options.presets) {
      const preset = presets.find((p) => p.name === presetName);
      if (preset) {
        // Avoid duplicates by ID
        for (const r of preset.rules) {
          if (!allRules.some((existing) => existing.id === r.id)) {
            allRules.push(r);
          }
        }
      }
    }
  }

  const violations: GovernanceViolation[] = [];
  const passedRules = new Set<string>(allRules.map((r) => r.id));

  // Collect source files once
  let sourceFiles: string[];
  try {
    sourceFiles = await listFiles(cwd, {
      glob: '*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs}',
      type: 'file',
    });
  } catch {
    sourceFiles = [];
  }
  const limitedFiles = sourceFiles.slice(0, maxFiles);

  // Pre-read package.json for dependency-ban rules
  const pkgJson = await readJson<Record<string, unknown>>(path.join(cwd, 'package.json'));

  for (const rule of allRules) {
    try {
      switch (rule.type) {
        // -------------------------------------------------------------------
        case 'import-ban': {
          const filesToCheck = rule.scope
            ? limitedFiles.filter((f) => matchesScope(f, rule.scope!))
            : limitedFiles;

          for (const file of filesToCheck) {
            try {
              const content = await readFile(path.join(cwd, file), 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Match import/require statements containing the banned pattern
                if (
                  (/\bimport\b/.test(line) || /\brequire\s*\(/.test(line)) &&
                  line.includes(rule.pattern)
                ) {
                  violations.push({
                    ruleId: rule.id,
                    ruleName: rule.name,
                    file,
                    line: i + 1,
                    severity: rule.severity,
                    message: rule.message,
                    suggestion: `Remove or replace the import of "${rule.pattern}"`,
                  });
                  passedRules.delete(rule.id);
                }
              }
            } catch {
              /* skip unreadable file */
            }
          }
          break;
        }

        // -------------------------------------------------------------------
        case 'file-pattern': {
          const filesToCheck = rule.scope
            ? limitedFiles.filter((f) => matchesScope(f, rule.scope!))
            : limitedFiles;

          let regex: RegExp;
          try {
            regex = new RegExp(rule.pattern, 'gi');
          } catch {
            // Invalid regex -- skip this rule
            break;
          }

          for (const file of filesToCheck) {
            try {
              const content = await readFile(path.join(cwd, file), 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                regex.lastIndex = 0;
                if (regex.test(lines[i])) {
                  // Skip comment lines
                  const trimmed = lines[i].trim();
                  if (
                    trimmed.startsWith('//') ||
                    trimmed.startsWith('#') ||
                    trimmed.startsWith('*')
                  ) {
                    continue;
                  }
                  violations.push({
                    ruleId: rule.id,
                    ruleName: rule.name,
                    file,
                    line: i + 1,
                    severity: rule.severity,
                    message: rule.message,
                  });
                  passedRules.delete(rule.id);
                }
              }
            } catch {
              /* skip unreadable file */
            }
          }
          break;
        }

        // -------------------------------------------------------------------
        case 'dependency-ban': {
          if (!pkgJson) break;
          const allDeps = {
            ...(pkgJson.dependencies as Record<string, string> | undefined),
            ...(pkgJson.devDependencies as Record<string, string> | undefined),
          };
          if (rule.pattern in allDeps) {
            violations.push({
              ruleId: rule.id,
              ruleName: rule.name,
              file: 'package.json',
              severity: rule.severity,
              message: rule.message,
              suggestion: `Remove "${rule.pattern}" from package.json`,
            });
            passedRules.delete(rule.id);
          }
          break;
        }

        // -------------------------------------------------------------------
        case 'layer-boundary': {
          // pattern format: "sourceLayer->targetLayer" (directory names)
          const [sourceLayer, targetLayer] = rule.pattern.split('->').map((s) => s.trim());
          if (!sourceLayer || !targetLayer) break;

          const layerFiles = limitedFiles.filter((f) => f.includes(`/${sourceLayer}/`) || f.startsWith(`${sourceLayer}/`));
          for (const file of layerFiles) {
            try {
              const content = await readFile(path.join(cwd, file), 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (
                  (/\bimport\b/.test(line) || /\brequire\s*\(/.test(line)) &&
                  (line.includes(`/${targetLayer}/`) || line.includes(`'${targetLayer}/`) || line.includes(`"${targetLayer}/`))
                ) {
                  violations.push({
                    ruleId: rule.id,
                    ruleName: rule.name,
                    file,
                    line: i + 1,
                    severity: rule.severity,
                    message: rule.message,
                    suggestion: `Files in "${sourceLayer}" must not import from "${targetLayer}"`,
                  });
                  passedRules.delete(rule.id);
                }
              }
            } catch {
              /* skip */
            }
          }
          break;
        }
      }
    } catch {
      /* rule processing error -- treat as passed to avoid false positives */
    }
  }

  // Build summary
  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.filter((v) => v.severity === 'warning').length;
  const infos = violations.filter((v) => v.severity === 'info').length;

  return {
    violations,
    passed: Array.from(passedRules),
    summary: {
      totalRules: allRules.length,
      passed: passedRules.size,
      failed: allRules.length - passedRules.size,
      errors,
      warnings,
      infos,
    },
    presets: presetSummary,
  };
}

// ===========================================================================
// 2. License Audit
// ===========================================================================

/** License information for a single dependency. */
export interface LicenseInfo {
  package: string;
  version: string;
  license: string;
  category: 'permissive' | 'copyleft' | 'restrictive' | 'unknown';
  risk: 'low' | 'medium' | 'high';
}

/** Aggregated license audit result. */
export interface LicenseAuditResult {
  projectLicense: string;
  dependencies: LicenseInfo[];
  summary: {
    total: number;
    permissive: number;
    copyleft: number;
    unknown: number;
    risks: number;
  };
  issues: string[];
}

/** Known permissive licenses (case-insensitive match). */
const PERMISSIVE_LICENSES = new Set([
  'mit',
  'apache-2.0',
  'apache 2.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsd',
  'isc',
  '0bsd',
  'unlicense',
  'cc0-1.0',
  'wtfpl',
  'artistic-2.0',
  'zlib',
  'postgresql',
  'python-2.0',
  'bsl-1.0',
]);

/** Known copyleft licenses. */
const COPYLEFT_LICENSES = new Set([
  'gpl-2.0',
  'gpl-2.0-only',
  'gpl-2.0-or-later',
  'gpl-3.0',
  'gpl-3.0-only',
  'gpl-3.0-or-later',
  'lgpl-2.0',
  'lgpl-2.1',
  'lgpl-3.0',
  'agpl-3.0',
  'agpl-3.0-only',
  'agpl-3.0-or-later',
  'mpl-2.0',
  'eupl-1.1',
  'eupl-1.2',
  'osl-3.0',
  'cecill-2.1',
]);

/**
 * Categorise a license string.
 *
 * @param license - SPDX identifier or free-text license name.
 * @returns Category and risk level.
 */
function categorizeLicense(license: string): { category: LicenseInfo['category']; risk: LicenseInfo['risk'] } {
  const normalised = license.toLowerCase().trim();

  // Handle SPDX expressions like "(MIT OR Apache-2.0)"
  const parts = normalised.replace(/[()]/g, '').split(/\s+or\s+|\s+and\s+/i);
  for (const part of parts) {
    const clean = part.trim();
    if (PERMISSIVE_LICENSES.has(clean)) return { category: 'permissive', risk: 'low' };
  }
  for (const part of parts) {
    const clean = part.trim();
    if (COPYLEFT_LICENSES.has(clean)) return { category: 'copyleft', risk: 'medium' };
  }

  // Fallback heuristics
  if (/mit/i.test(normalised)) return { category: 'permissive', risk: 'low' };
  if (/apache/i.test(normalised)) return { category: 'permissive', risk: 'low' };
  if (/bsd/i.test(normalised)) return { category: 'permissive', risk: 'low' };
  if (/isc/i.test(normalised)) return { category: 'permissive', risk: 'low' };
  if (/gpl/i.test(normalised)) return { category: 'copyleft', risk: 'medium' };
  if (/agpl/i.test(normalised)) return { category: 'copyleft', risk: 'high' };
  if (/lgpl/i.test(normalised)) return { category: 'copyleft', risk: 'medium' };
  if (/mpl/i.test(normalised)) return { category: 'copyleft', risk: 'medium' };
  if (/proprietary|commercial|unlicensed/i.test(normalised)) return { category: 'restrictive', risk: 'high' };

  return { category: 'unknown', risk: 'high' };
}

/**
 * Audit dependency licenses by reading each dependency's package.json from
 * node_modules.
 *
 * @param cwd - Project root directory.
 * @returns A {@link LicenseAuditResult} detailing each dependency's license status.
 */
export async function auditLicenses(cwd: string): Promise<LicenseAuditResult> {
  const issues: string[] = [];
  const dependencies: LicenseInfo[] = [];

  // Read project license
  const pkgJson = await readJson<Record<string, unknown>>(path.join(cwd, 'package.json'));
  const projectLicense = pkgJson ? String(pkgJson.license || 'UNKNOWN') : 'UNKNOWN';

  if (!pkgJson) {
    issues.push('No package.json found -- license audit limited');
    return {
      projectLicense,
      dependencies: [],
      summary: { total: 0, permissive: 0, copyleft: 0, unknown: 0, risks: 0 },
      issues,
    };
  }

  // Collect declared dependencies
  const declaredDeps: Record<string, string> = {
    ...(pkgJson.dependencies as Record<string, string> | undefined),
    ...(pkgJson.devDependencies as Record<string, string> | undefined),
  };

  // Read each dependency's package.json from node_modules
  const depEntries = Object.entries(declaredDeps);
  await Promise.all(
    depEntries.map(async ([name, versionRange]) => {
      const depPkgPath = path.join(cwd, 'node_modules', name, 'package.json');
      const depPkg = await readJson<Record<string, unknown>>(depPkgPath);
      const version = depPkg ? String(depPkg.version || versionRange) : versionRange;
      const rawLicense = depPkg
        ? String(
            depPkg.license ||
            (Array.isArray(depPkg.licenses)
              ? (depPkg.licenses as Array<{ type?: string }>).map((l) => l.type || '').join(' OR ')
              : 'UNKNOWN'),
          )
        : 'UNKNOWN';

      const { category, risk } = categorizeLicense(rawLicense);
      dependencies.push({ package: name, version, license: rawLicense, category, risk });
    }),
  );

  // Sort by risk (high first)
  const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  dependencies.sort((a, b) => (riskOrder[a.risk] ?? 3) - (riskOrder[b.risk] ?? 3));

  // Flag incompatibilities
  const projectCategory = categorizeLicense(projectLicense).category;
  if (projectCategory === 'permissive') {
    const copyleftDeps = dependencies.filter((d) => d.category === 'copyleft');
    if (copyleftDeps.length > 0) {
      issues.push(
        `Project is ${projectLicense} (permissive) but depends on ${copyleftDeps.length} copyleft package(s): ${copyleftDeps.map((d) => `${d.package} (${d.license})`).join(', ')}`,
      );
    }
  }

  const unknownDeps = dependencies.filter((d) => d.category === 'unknown');
  if (unknownDeps.length > 0) {
    issues.push(
      `${unknownDeps.length} dependency/dependencies with unknown license: ${unknownDeps.slice(0, 10).map((d) => d.package).join(', ')}`,
    );
  }

  const summary = {
    total: dependencies.length,
    permissive: dependencies.filter((d) => d.category === 'permissive').length,
    copyleft: dependencies.filter((d) => d.category === 'copyleft').length,
    unknown: dependencies.filter((d) => d.category === 'unknown').length,
    risks: dependencies.filter((d) => d.risk === 'high' || d.risk === 'medium').length,
  };

  return { projectLicense, dependencies, summary, issues };
}

// ===========================================================================
// 3. Supply Chain Risk
// ===========================================================================

/** Risk assessment for a single package. */
export interface SupplyChainRisk {
  package: string;
  riskFactors: string[];
  riskScore: number;
}

/** Aggregated supply-chain risk result. */
export interface SupplyChainResult {
  overallRisk: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  totalDependencies: number;
  directDependencies: number;
  risks: SupplyChainRisk[];
  summary: {
    withPostInstall: number;
    singleMaintainer: number;
    noRepository: number;
    deprecated: number;
  };
  recommendations: string[];
}

/**
 * Analyse the dependency tree for supply-chain risk indicators.
 *
 * Checks for:
 * - Total vs direct dependency count (lockfile bloat)
 * - Packages with lifecycle scripts (preinstall, postinstall)
 * - Missing repository field
 * - Deprecated packages
 *
 * @param cwd - Project root directory.
 * @returns A {@link SupplyChainResult} with risk scores and recommendations.
 */
export async function analyzeSupplyChainRisk(cwd: string): Promise<SupplyChainResult> {
  const risks: SupplyChainRisk[] = [];
  const recommendations: string[] = [];
  let totalDeps = 0;
  let directDeps = 0;
  let withPostInstall = 0;
  let singleMaintainer = 0;
  let noRepository = 0;
  let deprecated = 0;

  // Read project package.json
  const pkgJson = await readJson<Record<string, unknown>>(path.join(cwd, 'package.json'));
  if (!pkgJson) {
    return {
      overallRisk: 0,
      grade: 'A',
      totalDependencies: 0,
      directDependencies: 0,
      risks: [],
      summary: { withPostInstall: 0, singleMaintainer: 0, noRepository: 0, deprecated: 0 },
      recommendations: ['No package.json found -- supply chain analysis not applicable'],
    };
  }

  const declaredDeps = Object.keys({
    ...(pkgJson.dependencies as Record<string, string> | undefined),
    ...(pkgJson.devDependencies as Record<string, string> | undefined),
  });
  directDeps = declaredDeps.length;

  // Count transitive dependencies from lockfile
  const lockPath = path.join(cwd, 'package-lock.json');
  const lockJson = await readJson<Record<string, unknown>>(lockPath);
  if (lockJson) {
    const packages = lockJson.packages as Record<string, unknown> | undefined;
    const deps = lockJson.dependencies as Record<string, unknown> | undefined;
    if (packages) {
      totalDeps = Object.keys(packages).filter((k) => k !== '').length;
    } else if (deps) {
      totalDeps = Object.keys(deps).length;
    }
  } else {
    totalDeps = directDeps; // fallback
  }

  if (totalDeps === 0) totalDeps = directDeps;

  // Transitive ratio
  if (directDeps > 0 && totalDeps > directDeps * 10) {
    recommendations.push(
      `High transitive dependency ratio (${totalDeps} total for ${directDeps} direct). Consider pruning unused packages.`,
    );
  }

  // Inspect each direct dependency's node_modules package.json
  await Promise.all(
    declaredDeps.map(async (depName) => {
      const depPkgPath = path.join(cwd, 'node_modules', depName, 'package.json');
      const depPkg = await readJson<Record<string, unknown>>(depPkgPath);
      if (!depPkg) return;

      const riskFactors: string[] = [];
      let depRisk = 0;

      // Check for lifecycle scripts
      const scripts = depPkg.scripts as Record<string, string> | undefined;
      if (scripts) {
        const dangerousScripts = ['preinstall', 'postinstall', 'install', 'preuninstall', 'postuninstall'];
        const found = dangerousScripts.filter((s) => s in scripts);
        if (found.length > 0) {
          riskFactors.push(`Lifecycle scripts: ${found.join(', ')}`);
          depRisk += 25;
          withPostInstall++;
        }
      }

      // Check for missing repository
      if (!depPkg.repository) {
        riskFactors.push('No repository field');
        depRisk += 15;
        noRepository++;
      }

      // Check for deprecated
      if (depPkg.deprecated) {
        riskFactors.push(`Deprecated: ${String(depPkg.deprecated).slice(0, 100)}`);
        depRisk += 30;
        deprecated++;
      }

      // Check maintainers count
      const maintainers = depPkg.maintainers as Array<unknown> | undefined;
      if (Array.isArray(maintainers) && maintainers.length <= 1) {
        riskFactors.push('Single maintainer');
        depRisk += 10;
        singleMaintainer++;
      }
      // Also check author-only (no maintainers field means sole author)
      if (!maintainers && depPkg.author && !depPkg.contributors) {
        riskFactors.push('Single maintainer (author only)');
        depRisk += 10;
        singleMaintainer++;
      }

      // Check if package has very few keywords or no description (indicator of low quality)
      if (!depPkg.description || (depPkg.description as string).length < 5) {
        riskFactors.push('Minimal package metadata');
        depRisk += 5;
      }

      if (riskFactors.length > 0) {
        risks.push({
          package: depName,
          riskFactors,
          riskScore: clamp(depRisk),
        });
      }
    }),
  );

  // Sort risks by score descending
  risks.sort((a, b) => b.riskScore - a.riskScore);

  // Compute overall risk score (inverse: high score = bad)
  let overallRisk = 0;
  if (directDeps > 0) {
    // Base risk from dependency count
    overallRisk += Math.min(20, Math.round((totalDeps / 500) * 20));
    // Risk from flagged packages
    const avgPackageRisk =
      risks.length > 0 ? risks.reduce((sum, r) => sum + r.riskScore, 0) / risks.length : 0;
    overallRisk += Math.round((avgPackageRisk / 100) * 30);
    // Risk from specific categories
    overallRisk += Math.min(15, withPostInstall * 5);
    overallRisk += Math.min(10, deprecated * 5);
    overallRisk += Math.min(10, noRepository * 2);
  }
  overallRisk = clamp(overallRisk);

  // Grade (inverted: low risk = A)
  const safetyScore = 100 - overallRisk;
  const grade = toGrade(safetyScore);

  // Build recommendations
  if (withPostInstall > 0) {
    recommendations.push(
      `${withPostInstall} package(s) have postinstall scripts -- review them for malicious behaviour`,
    );
  }
  if (deprecated > 0) {
    recommendations.push(`${deprecated} deprecated package(s) -- replace with maintained alternatives`);
  }
  if (noRepository > 0) {
    recommendations.push(
      `${noRepository} package(s) lack a repository field -- harder to audit provenance`,
    );
  }
  if (directDeps > 50) {
    recommendations.push('Consider reducing direct dependencies to lower attack surface');
  }

  return {
    overallRisk,
    grade,
    totalDependencies: totalDeps,
    directDependencies: directDeps,
    risks: risks.slice(0, 50),
    summary: { withPostInstall, singleMaintainer, noRepository, deprecated },
    recommendations,
  };
}

// ===========================================================================
// 4. Secret Rotation Audit
// ===========================================================================

/** A single finding from the secret audit. */
export interface SecretFinding {
  file: string;
  line: number;
  type: 'hardcoded-secret' | 'unignored-env' | 'inconsistent-env' | 'iac-secret';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  recommendation: string;
}

/** Aggregated secret audit result. */
export interface SecretAuditResult {
  findings: SecretFinding[];
  envFiles: { file: string; gitignored: boolean; variables: string[] }[];
  summary: {
    totalFindings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

/** Secret detection patterns with severity. */
const SECRET_PATTERNS: {
  name: string;
  pattern: RegExp;
  severity: SecretFinding['severity'];
  description: string;
  recommendation: string;
}[] = [
  {
    name: 'AWS Access Key',
    pattern: /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/,
    severity: 'critical',
    description: 'AWS access key ID detected',
    recommendation: 'Use IAM roles or AWS Secrets Manager instead of hardcoded keys',
  },
  {
    name: 'Generic API Key',
    pattern: /(?:api_key|apikey|api-key)\s*[:=]\s*['"][A-Za-z0-9_\-/.]{20,}['"]/i,
    severity: 'high',
    description: 'Hardcoded API key detected',
    recommendation: 'Move API keys to environment variables or a secrets manager',
  },
  {
    name: 'Generic Password',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    severity: 'critical',
    description: 'Hardcoded password detected',
    recommendation: 'Never store passwords in source code -- use environment variables or vaults',
  },
  {
    name: 'Generic Token',
    pattern: /(?:token|auth_token|access_token|bearer)\s*[:=]\s*['"][A-Za-z0-9_\-/.]{20,}['"]/i,
    severity: 'high',
    description: 'Hardcoded token detected',
    recommendation: 'Store tokens in environment variables and rotate regularly',
  },
  {
    name: 'Private Key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    severity: 'critical',
    description: 'Private key embedded in source code',
    recommendation: 'Remove private keys from source and use a secure key store',
  },
  {
    name: 'Generic Secret',
    pattern: /(?:secret|client_secret|secret_key)\s*[:=]\s*['"][A-Za-z0-9_\-/.]{10,}['"]/i,
    severity: 'high',
    description: 'Hardcoded secret value detected',
    recommendation: 'Move secrets to a vault or environment variables',
  },
  {
    name: 'Connection String',
    pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/\w+:\w+@/i,
    severity: 'high',
    description: 'Connection string with embedded credentials',
    recommendation: 'Use environment variables for database connection strings',
  },
];

/** IaC secret patterns. */
const IAC_SECRET_PATTERNS: {
  pattern: RegExp;
  description: string;
}[] = [
  {
    pattern: /(?:password|secret|token|api_key)\s*[:=]\s*"[^"$]{8,}"/i,
    description: 'Hardcoded secret in IaC configuration',
  },
  {
    pattern: /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*"[^"$]+"/i,
    description: 'AWS credentials in IaC configuration',
  },
];

/**
 * Parse a .env file and extract variable names.
 *
 * @param content - Raw .env file content.
 * @returns Array of variable names.
 */
function parseEnvVarNames(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=');
      return eq > 0 ? line.slice(0, eq).trim() : '';
    })
    .filter(Boolean);
}

/**
 * Audit secret management practices in a codebase.
 *
 * Checks:
 * - Whether .env files are listed in .gitignore
 * - Hardcoded secrets in source files
 * - Secret references in Infrastructure-as-Code files
 * - Consistent secret naming across environment files
 *
 * @param cwd - Project root directory.
 * @returns A {@link SecretAuditResult} with findings and score.
 */
export async function auditSecretRotation(cwd: string): Promise<SecretAuditResult> {
  const findings: SecretFinding[] = [];
  const envFileResults: SecretAuditResult['envFiles'] = [];

  // -----------------------------------------------------------------------
  // 1. Check .gitignore for .env entries
  // -----------------------------------------------------------------------
  let gitignoreContent = '';
  try {
    gitignoreContent = await readFile(path.join(cwd, '.gitignore'), 'utf-8');
  } catch {
    /* no .gitignore */
  }

  const gitignoreLines = gitignoreContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  /**
   * Check whether a filename is covered by .gitignore entries.
   */
  function isGitignored(filename: string): boolean {
    for (const pattern of gitignoreLines) {
      if (pattern === filename) return true;
      if (pattern === '.env*' || pattern === '.env.*') return true;
      if (pattern.endsWith('*') && filename.startsWith(pattern.slice(0, -1))) return true;
      // Normalise and compare
      if (pattern.replace(/^\//, '') === filename) return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // 2. Discover .env files
  // -----------------------------------------------------------------------
  const envFileNames = ['.env', '.env.local', '.env.development', '.env.production', '.env.staging', '.env.test'];
  for (const envFile of envFileNames) {
    const envPath = path.join(cwd, envFile);
    if (!existsSync(envPath)) continue;

    const gitignored = isGitignored(envFile);
    let variables: string[] = [];

    try {
      const content = await readFile(envPath, 'utf-8');
      variables = parseEnvVarNames(content);
    } catch {
      /* skip unreadable */
    }

    envFileResults.push({ file: envFile, gitignored, variables });

    if (!gitignored) {
      findings.push({
        file: envFile,
        line: 0,
        type: 'unignored-env',
        severity: 'critical',
        description: `${envFile} is not listed in .gitignore and may be committed to version control`,
        recommendation: `Add "${envFile}" (or ".env*") to .gitignore immediately`,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 3. Check consistency across env files
  // -----------------------------------------------------------------------
  if (envFileResults.length > 1) {
    const referenceFile = envFileResults[0];
    const referenceVars = new Set(referenceFile.variables);

    for (const envEntry of envFileResults.slice(1)) {
      const entryVars = new Set(envEntry.variables);
      const missing = [...referenceVars].filter((v) => !entryVars.has(v));
      const extra = [...entryVars].filter((v) => !referenceVars.has(v));

      if (missing.length > 0) {
        findings.push({
          file: envEntry.file,
          line: 0,
          type: 'inconsistent-env',
          severity: 'medium',
          description: `${envEntry.file} is missing variables present in ${referenceFile.file}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`,
          recommendation: 'Ensure all environment files define the same variables to avoid runtime errors',
        });
      }
      if (extra.length > 0) {
        findings.push({
          file: envEntry.file,
          line: 0,
          type: 'inconsistent-env',
          severity: 'low',
          description: `${envEntry.file} has extra variables not in ${referenceFile.file}: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ` (+${extra.length - 5} more)` : ''}`,
          recommendation: 'Review whether extra variables are intentional or indicate configuration drift',
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4. Scan source files for hardcoded secrets
  // -----------------------------------------------------------------------
  let sourceFiles: string[];
  try {
    sourceFiles = await listFiles(cwd, {
      glob: '*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs,yaml,yml,json,toml,cfg,ini,conf}',
      type: 'file',
    });
  } catch {
    sourceFiles = [];
  }

  // Limit scanning to prevent long running times
  const filesToScan = sourceFiles.slice(0, 1000);

  await Promise.all(
    filesToScan.map(async (file) => {
      // Skip known safe files
      const base = path.basename(file);
      if (
        base === 'package-lock.json' ||
        base === 'yarn.lock' ||
        base.endsWith('.min.js') ||
        base.endsWith('.map') ||
        file.includes('node_modules') ||
        file.includes('.git/')
      ) {
        return;
      }

      try {
        const content = await readFile(path.join(cwd, file), 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // Skip comments
          if (
            trimmed.startsWith('//') ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('<!--')
          ) {
            continue;
          }

          // Check source-file secret patterns
          for (const sp of SECRET_PATTERNS) {
            if (sp.pattern.test(line)) {
              findings.push({
                file,
                line: i + 1,
                type: 'hardcoded-secret',
                severity: sp.severity,
                description: sp.description,
                recommendation: sp.recommendation,
              });
              break; // Only report one pattern per line
            }
          }
        }
      } catch {
        /* skip unreadable */
      }
    }),
  );

  // -----------------------------------------------------------------------
  // 5. Scan IaC files for secrets
  // -----------------------------------------------------------------------
  const iacGlobs = ['*.tf', '*.tfvars', '*.yaml', '*.yml'];
  const iacDirs = ['terraform', 'infra', 'infrastructure', 'deploy', 'k8s', 'helm', 'ansible'];

  for (const iacDir of iacDirs) {
    const dirPath = path.join(cwd, iacDir);
    if (!existsSync(dirPath)) continue;

    let iacFiles: string[];
    try {
      iacFiles = await listFiles(dirPath, {
        glob: '*.{tf,tfvars,yaml,yml,json}',
        type: 'file',
      });
    } catch {
      continue;
    }

    for (const file of iacFiles.slice(0, 200)) {
      try {
        const content = await readFile(path.join(dirPath, file), 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

          for (const ip of IAC_SECRET_PATTERNS) {
            if (ip.pattern.test(line)) {
              findings.push({
                file: path.join(iacDir, file),
                line: i + 1,
                type: 'iac-secret',
                severity: 'high',
                description: ip.description,
                recommendation: 'Use variable references, secret stores, or sealed secrets in IaC files',
              });
              break;
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6. Compute score and grade
  // -----------------------------------------------------------------------
  // Sort findings by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));

  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high').length;
  const medium = findings.filter((f) => f.severity === 'medium').length;
  const low = findings.filter((f) => f.severity === 'low').length;

  // Weighted score: critical=10, high=5, medium=2, low=1
  const penalty = critical * 10 + high * 5 + medium * 2 + low * 1;
  const score = clamp(100 - penalty);
  const grade = toGrade(score);

  return {
    findings,
    envFiles: envFileResults,
    summary: {
      totalFindings: findings.length,
      critical,
      high,
      medium,
      low,
    },
    score,
    grade,
  };
}
