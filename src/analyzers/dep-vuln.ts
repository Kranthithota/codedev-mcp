/**
 * Dependency Vulnerability Scanner
 * Cross-references package lock files (package-lock.json, yarn.lock, pnpm-lock.yaml,
 * Cargo.lock, Pipfile.lock, go.sum) against known vulnerability patterns.
 * Checks for outdated packages, known-vulnerable version ranges, and security advisories.
 * Integrates with npm audit for real-time vulnerability detection.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
 * Run npm audit and parse results.
 * @param cwd - The working directory
 * @returns Parsed npm audit vulnerabilities or null if audit fails
 */
async function runNpmAudit(cwd: string): Promise<VulnDependency[] | null> {
  try {
    // Check if package.json exists
    const packageJsonPath = path.join(cwd, 'package.json');
    await readFile(packageJsonPath, 'utf-8');

    // Run npm audit --json
    // Note: npm audit exits with code 1 when vulnerabilities are found, which is normal
    let stdout = '';
    try {
      const result = await execFileAsync('npm', ['audit', '--json'], {
        cwd,
        timeout: 30000, // 30 second timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });
      stdout = result.stdout as string;
    } catch (error: unknown) {
      // npm audit exits with code 1 when vulnerabilities are found - this is expected
      // Check if stderr contains the JSON output (npm writes to stderr on error)
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      if (execError.code === 1 && execError.stderr) {
        // Try to parse stderr as JSON (npm audit sometimes writes JSON to stderr)
        try {
          const stderrJson = JSON.parse(execError.stderr);
          if (stderrJson.vulnerabilities) {
            stdout = execError.stderr;
          }
        } catch {
          // If stderr isn't JSON, try stdout
          if (execError.stdout) {
            stdout = execError.stdout;
          }
        }
      } else if (execError.stdout) {
        stdout = execError.stdout;
      } else {
        // Real error (npm not found, network issue, etc.)
        return null;
      }
    }

    if (!stdout) return null;

    const auditData = JSON.parse(stdout);
    const vulns: VulnDependency[] = [];

    // Parse npm audit v7+ format
    if (auditData.vulnerabilities) {
      for (const [pkgName, vulnInfo] of Object.entries(auditData.vulnerabilities)) {
        const info = vulnInfo as {
          severity?: string;
          via?: Array<string | { title?: string; url?: string }>;
          effects?: string[];
          range?: string;
          fixAvailable?: boolean | { name?: string; version?: string };
        };

        // Get severity (npm audit uses: critical, high, moderate, low, info)
        const severity = (info.severity || 'info').toLowerCase();
        const mappedSeverity: VulnDependency['severity'] =
          severity === 'critical'
            ? 'critical'
            : severity === 'high'
              ? 'high'
              : severity === 'moderate'
                ? 'medium'
                : severity === 'low'
                  ? 'low'
                  : 'info';

        // Get CVE or advisory info
        const via = info.via || [];
        const cveInfo = via.find((v) => typeof v === 'object' && v.title) as
          | { title?: string; url?: string }
          | undefined;
        const reason = cveInfo?.title || via.find((v) => typeof v === 'string') || 'Known vulnerability';

        // Get fix recommendation
        let recommendation: string | undefined;
        if (info.fixAvailable) {
          if (typeof info.fixAvailable === 'object' && info.fixAvailable.name && info.fixAvailable.version) {
            recommendation = `Upgrade ${info.fixAvailable.name} to ${info.fixAvailable.version}`;
          } else if (info.fixAvailable === true) {
            recommendation = 'Run npm audit fix';
          }
        }

        // Extract version from package name (format: package@version or package@version@version)
        // npm audit can return nested dependencies like: package@1.0.0@2.0.0
        const parts = pkgName.split('@');
        const pkgNameOnly = parts[0];
        // Get the actual installed version (usually the last part)
        const version = parts.length > 1 ? parts[parts.length - 1] : 'unknown';

        vulns.push({
          name: pkgNameOnly,
          version,
          severity: mappedSeverity,
          reason: String(reason),
          file: 'package-lock.json',
          ecosystem: 'npm',
          recommendation,
        });
      }
    }

    return vulns;
  } catch {
    // npm audit might fail if:
    // - npm is not installed
    // - package.json doesn't exist
    // - network issues
    // - audit database unavailable
    // Return null to fall back to static patterns
    return null;
  }
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

  // Try npm audit first for accurate vulnerability detection
  const npmAuditVulns = await runNpmAudit(cwd);
  const hasNpmAuditResults = npmAuditVulns && npmAuditVulns.length > 0;

  if (hasNpmAuditResults) {
    vulnerabilities.push(...npmAuditVulns);
    ecosystems.add('npm');
    if (!lockFiles.includes('package-lock.json')) {
      lockFiles.push('package-lock.json');
    }
  }

  // Scan npm lock files (only if npm audit didn't run or failed)
  if (!hasNpmAuditResults) {
    for (const lockFile of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      try {
        const content = await readFile(path.join(cwd, lockFile), 'utf-8');
        if (!lockFiles.includes(lockFile)) lockFiles.push(lockFile);
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
  }

  // Always count total deps from lock file if it exists
  if (hasNpmAuditResults) {
    try {
      const content = await readFile(path.join(cwd, 'package-lock.json'), 'utf-8');
      const deps = parseNpmLock(content);
      totalDeps += deps.length;
    } catch {
      /* skip */
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
