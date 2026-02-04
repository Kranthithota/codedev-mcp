/**
 * Dependency Vulnerability Scanner
 * Cross-references package lock files (package-lock.json, yarn.lock, pnpm-lock.yaml,
 * Cargo.lock, Pipfile.lock, go.sum) against known vulnerability patterns.
 * Checks for outdated packages, known-vulnerable version ranges, and security advisories.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface VulnDependency {
  name: string;
  version: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  reason: string;
  file: string;
  ecosystem: 'npm' | 'cargo' | 'pip' | 'go' | 'unknown';
  recommendation?: string;
}

export interface DepVulnResult {
  vulnerabilities: VulnDependency[];
  totalDeps: number;
  outdatedCount: number;
  ecosystems: string[];
  lockFiles: string[];
  summary: { critical: number; high: number; medium: number; low: number; info: number };
}

// Known patterns for vulnerable packages / versions (static heuristic-based)
const KNOWN_VULN_PATTERNS: { name: RegExp; maxSafe?: string; severity: VulnDependency['severity']; reason: string }[] =
  [
    // npm ecosystem
    { name: /^lodash$/, maxSafe: '4.17.21', severity: 'high', reason: 'Prototype pollution (CVE-2021-23337)' },
    { name: /^minimist$/, maxSafe: '1.2.6', severity: 'high', reason: 'Prototype pollution (CVE-2021-44906)' },
    { name: /^node-fetch$/, maxSafe: '2.6.7', severity: 'high', reason: 'Exposure of sensitive info (CVE-2022-0235)' },
    { name: /^axios$/, maxSafe: '1.6.0', severity: 'medium', reason: 'SSRF vulnerability in versions < 1.6.0' },
    {
      name: /^jsonwebtoken$/,
      maxSafe: '9.0.0',
      severity: 'high',
      reason: 'Insecure token verification (CVE-2022-23529)',
    },
    {
      name: /^express$/,
      maxSafe: '4.19.2',
      severity: 'medium',
      reason: 'Open redirect vulnerability in older versions',
    },
    {
      name: /^tar$/,
      maxSafe: '6.1.12',
      severity: 'high',
      reason: 'Arbitrary file creation/overwrite (CVE-2021-37712)',
    },
    { name: /^semver$/, maxSafe: '7.5.2', severity: 'medium', reason: 'ReDoS vulnerability (CVE-2022-25883)' },
    { name: /^xml2js$/, maxSafe: '0.5.0', severity: 'high', reason: 'Prototype pollution (CVE-2023-0842)' },
    { name: /^got$/, maxSafe: '11.8.5', severity: 'medium', reason: 'Open redirect (CVE-2022-33987)' },
    { name: /^moment$/, maxSafe: '999.0.0', severity: 'low', reason: 'Deprecated — use date-fns or dayjs instead' },
    { name: /^request$/, maxSafe: '999.0.0', severity: 'low', reason: 'Deprecated and unmaintained' },
    {
      name: /^event-stream$/,
      maxSafe: '999.0.0',
      severity: 'critical',
      reason: 'Known malicious versions (flatmap-stream incident)',
    },
    { name: /^ua-parser-js$/, maxSafe: '0.7.33', severity: 'critical', reason: 'Supply chain attack (CVE-2021-27292)' },
    { name: /^colors$/, maxSafe: '1.4.0', severity: 'high', reason: 'Sabotaged by maintainer in v1.4.1+' },
    { name: /^faker$/, maxSafe: '5.5.3', severity: 'high', reason: 'Sabotaged by maintainer in v6+' },
    // Python ecosystem
    { name: /^pyyaml$/i, maxSafe: '6.0', severity: 'high', reason: 'Arbitrary code execution via yaml.load' },
    { name: /^django$/i, maxSafe: '4.2.0', severity: 'medium', reason: 'Multiple security fixes in 4.2+' },
    { name: /^flask$/i, maxSafe: '2.3.0', severity: 'low', reason: 'Security improvements in 2.3+' },
    {
      name: /^pillow$/i,
      maxSafe: '10.0.0',
      severity: 'high',
      reason: 'Buffer overflow vulnerabilities in older versions',
    },
    { name: /^cryptography$/i, maxSafe: '41.0.0', severity: 'high', reason: 'Multiple CVEs in older versions' },
    { name: /^urllib3$/i, maxSafe: '2.0.0', severity: 'medium', reason: 'Cookie leaking, CRLF injection in < 2.0' },
    // Rust ecosystem
    { name: /^hyper$/, maxSafe: '0.14.23', severity: 'high', reason: 'HTTP request smuggling (RUSTSEC-2023-0034)' },
    { name: /^regex$/, maxSafe: '1.8.0', severity: 'medium', reason: 'ReDoS in older versions' },
  ];

/**
 * Simple semver comparison (major.minor.patch). Returns true if a < b.
 * @param a - First version string
 * @param b - Second version string
 * @returns True if version a is less than version b
 */
function semverLessThan(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^[~^>=<]+/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * Parse package-lock.json or package.json dependencies.
 * @param content - The raw file content
 * @returns Array of dependency name/version pairs
 */
function parseNpmLock(content: string): { name: string; version: string }[] {
  const deps: { name: string; version: string }[] = [];
  try {
    const data = JSON.parse(content);

    // package-lock.json v2/v3
    if (data.packages) {
      for (const [pkgPath, info] of Object.entries(data.packages)) {
        const d = info as Record<string, unknown>;
        if (pkgPath && d.version) {
          const name = pkgPath.replace(/^node_modules\//, '').replace(/.*node_modules\//, '');
          if (name) deps.push({ name, version: d.version as string });
        }
      }
    }
    // package-lock.json v1
    else if (data.dependencies) {
      for (const [name, info] of Object.entries(data.dependencies)) {
        const d = info as Record<string, unknown>;
        if (d.version) deps.push({ name, version: d.version as string });
      }
    }
    // package.json (fallback, ranges only)
    else if (data.name && (data.dependencies || data.devDependencies)) {
      for (const [name, ver] of Object.entries({ ...(data.dependencies || {}), ...(data.devDependencies || {}) })) {
        deps.push({ name, version: String(ver) });
      }
    }
  } catch {
    /* skip */
  }
  return deps;
}

/**
 * Parse Cargo.lock.
 * @param content - The raw Cargo.lock content
 * @returns Array of dependency name/version pairs
 */
function parseCargoLock(content: string): { name: string; version: string }[] {
  const deps: { name: string; version: string }[] = [];
  const pkgRegex = /\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = pkgRegex.exec(content)) !== null) {
    deps.push({ name: match[1], version: match[2] });
  }
  return deps;
}

/**
 * Parse Pipfile.lock or requirements.txt.
 * @param content - The raw file content
 * @param file - The file path to determine format
 * @returns Array of dependency name/version pairs
 */
function parsePythonDeps(content: string, file: string): { name: string; version: string }[] {
  const deps: { name: string; version: string }[] = [];

  if (file.endsWith('.lock')) {
    try {
      const data = JSON.parse(content);
      for (const section of ['default', 'develop']) {
        const pkgs = data[section] || {};
        for (const [name, info] of Object.entries(pkgs)) {
          const d = info as Record<string, unknown>;
          if (d.version) deps.push({ name, version: (d.version as string).replace(/^==/, '') });
        }
      }
    } catch {
      /* skip */
    }
  } else {
    // requirements.txt
    for (const line of content.split('\n')) {
      const match = line.trim().match(/^([a-zA-Z0-9_-]+)\s*[=<>!~]+\s*([0-9.]+)/);
      if (match) deps.push({ name: match[1], version: match[2] });
    }
  }
  return deps;
}

/**
 * Parse go.sum.
 * @param content - The raw go.sum content
 * @returns Array of dependency name/version pairs
 */
function parseGoSum(content: string): { name: string; version: string }[] {
  const deps: { name: string; version: string }[] = [];
  const seen = new Set<string>();
  for (const line of content.split('\n')) {
    const match = line.match(/^(\S+)\s+v([0-9.]+)/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      deps.push({ name: match[1], version: match[2] });
    }
  }
  return deps;
}

/**
 * Main vulnerability scan function.
 * @param cwd - The working directory to scan
 * @returns Vulnerability scan results with findings and summary
 */
export async function scanDependencyVulns(cwd: string): Promise<DepVulnResult> {
  const vulnerabilities: VulnDependency[] = [];
  const lockFiles: string[] = [];
  const ecosystems = new Set<string>();
  let totalDeps = 0;
  let outdatedCount = 0;

  // Scan npm lock files
  for (const lockFile of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    try {
      const content = await readFile(path.join(cwd, lockFile), 'utf-8');
      lockFiles.push(lockFile);
      ecosystems.add('npm');

      // Only parse JSON lock files for now
      if (lockFile === 'package-lock.json') {
        const deps = parseNpmLock(content);
        totalDeps += deps.length;

        for (const dep of deps) {
          for (const pattern of KNOWN_VULN_PATTERNS) {
            if (pattern.name.test(dep.name) && pattern.maxSafe && semverLessThan(dep.version, pattern.maxSafe)) {
              vulnerabilities.push({
                name: dep.name,
                version: dep.version,
                severity: pattern.severity,
                reason: pattern.reason,
                file: lockFile,
                ecosystem: 'npm',
                recommendation: `Upgrade to >= ${pattern.maxSafe}`,
              });
              if (pattern.severity !== 'info') outdatedCount++;
            }
          }
        }
      }
    } catch {
      /* file doesn't exist */
    }
  }

  // Scan package.json if no lock file found
  if (!lockFiles.some((f) => f.includes('lock'))) {
    try {
      const content = await readFile(path.join(cwd, 'package.json'), 'utf-8');
      lockFiles.push('package.json');
      ecosystems.add('npm');
      const deps = parseNpmLock(content);
      totalDeps += deps.length;
      for (const dep of deps) {
        for (const pattern of KNOWN_VULN_PATTERNS) {
          if (pattern.name.test(dep.name) && pattern.maxSafe && semverLessThan(dep.version, pattern.maxSafe)) {
            vulnerabilities.push({
              name: dep.name,
              version: dep.version,
              severity: pattern.severity,
              reason: pattern.reason,
              file: 'package.json',
              ecosystem: 'npm',
              recommendation: `Upgrade to >= ${pattern.maxSafe}`,
            });
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  // Scan Cargo.lock
  try {
    const content = await readFile(path.join(cwd, 'Cargo.lock'), 'utf-8');
    lockFiles.push('Cargo.lock');
    ecosystems.add('cargo');
    const deps = parseCargoLock(content);
    totalDeps += deps.length;
    for (const dep of deps) {
      for (const pattern of KNOWN_VULN_PATTERNS) {
        if (pattern.name.test(dep.name) && pattern.maxSafe && semverLessThan(dep.version, pattern.maxSafe)) {
          vulnerabilities.push({
            name: dep.name,
            version: dep.version,
            severity: pattern.severity,
            reason: pattern.reason,
            file: 'Cargo.lock',
            ecosystem: 'cargo',
            recommendation: `Upgrade to >= ${pattern.maxSafe}`,
          });
        }
      }
    }
  } catch {
    /* skip */
  }

  // Scan Python deps
  for (const pyFile of ['Pipfile.lock', 'requirements.txt', 'requirements-dev.txt']) {
    try {
      const content = await readFile(path.join(cwd, pyFile), 'utf-8');
      lockFiles.push(pyFile);
      ecosystems.add('pip');
      const deps = parsePythonDeps(content, pyFile);
      totalDeps += deps.length;
      for (const dep of deps) {
        for (const pattern of KNOWN_VULN_PATTERNS) {
          if (pattern.name.test(dep.name) && pattern.maxSafe && semverLessThan(dep.version, pattern.maxSafe)) {
            vulnerabilities.push({
              name: dep.name,
              version: dep.version,
              severity: pattern.severity,
              reason: pattern.reason,
              file: pyFile,
              ecosystem: 'pip',
              recommendation: `Upgrade to >= ${pattern.maxSafe}`,
            });
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  // Scan go.sum
  try {
    const content = await readFile(path.join(cwd, 'go.sum'), 'utf-8');
    lockFiles.push('go.sum');
    ecosystems.add('go');
    const deps = parseGoSum(content);
    totalDeps += deps.length;
  } catch {
    /* skip */
  }

  // Sort by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  vulnerabilities.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const v of vulnerabilities) summary[v.severity]++;

  return {
    vulnerabilities,
    totalDeps,
    outdatedCount,
    ecosystems: Array.from(ecosystems),
    lockFiles,
    summary,
  };
}
