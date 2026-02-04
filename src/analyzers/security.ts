/**
 * Security scanning module.
 * - Dependency vulnerability checking (lock file analysis)
 * - SAST-lite: common security anti-patterns
 * - Secret/credential detection
 * - No external API dependencies
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

export interface SecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
  file: string;
  line?: number;
  snippet?: string;
  recommendation: string;
}

export interface SecurityReport {
  scanDate: string;
  totalFindings: number;
  bySeverity: Record<string, number>;
  findings: SecurityFinding[];
  dependencyInfo?: { total: number; directDeps: number; lockfileFound: boolean };
}

/**
 * SAST patterns to detect.
 */
const SAST_PATTERNS: {
  name: string;
  category: string;
  severity: SecurityFinding['severity'];
  pattern: RegExp;
  languages?: string[];
  recommendation: string;
}[] = [
  // SQL Injection
  {
    name: 'SQL injection risk',
    category: 'injection',
    severity: 'critical',
    pattern:
      /(?:query|execute|exec|raw)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER).*?\$\{|%s|%d|\+\s*\w/i,
    recommendation: 'Use parameterized queries or an ORM instead of string concatenation in SQL.',
  },
  // Command Injection
  {
    name: 'Command injection risk',
    category: 'injection',
    severity: 'critical',
    pattern: /(?:exec|spawn|system|popen|subprocess\.(?:call|run|Popen))\s*\([^)]*(?:\$\{|\+\s*\w|%s|f['"]\s*\{)/,
    recommendation: 'Avoid passing user input to shell commands. Use parameterized APIs or allowlists.',
  },
  // XSS
  {
    name: 'Potential XSS via innerHTML',
    category: 'xss',
    severity: 'high',
    pattern: /\.innerHTML\s*=|dangerouslySetInnerHTML|v-html\s*=/,
    recommendation: 'Use textContent instead of innerHTML, or sanitize with DOMPurify.',
  },
  // Hardcoded secrets
  {
    name: 'Hardcoded secret/credential',
    category: 'secrets',
    severity: 'critical',
    pattern:
      /(?:password|secret|api_key|apikey|token|private_key|access_key|auth_token|client_secret)\s*[:=]\s*['"]\S{8,}['"]/i,
    recommendation: 'Move secrets to environment variables or a secret manager (AWS Secrets Manager, Vault, etc).',
  },
  // Hardcoded URLs with credentials
  {
    name: 'Credential in URL',
    category: 'secrets',
    severity: 'high',
    pattern: /(?:https?|ftp):\/\/\w+:\w+@/,
    recommendation: 'Remove credentials from URLs. Use environment variables for connection strings.',
  },
  // Insecure randomness
  {
    name: 'Insecure randomness',
    category: 'crypto',
    severity: 'medium',
    pattern: /Math\.random\(\)|random\.random\(\)|rand\(\)/,
    recommendation: 'Use crypto.randomBytes() or secrets module for security-sensitive random values.',
  },
  // Weak hashing
  {
    name: 'Weak hash algorithm (MD5/SHA1)',
    category: 'crypto',
    severity: 'medium',
    pattern: /(?:createHash|hashlib\.md5|hashlib\.sha1|MD5|SHA1)\s*\(/,
    recommendation: 'Use SHA-256 or bcrypt/argon2 for passwords.',
  },
  // Eval usage
  {
    name: 'Dangerous eval() usage',
    category: 'injection',
    severity: 'high',
    pattern: /\beval\s*\((?!['"][^'"]+['"])|new\s+Function\s*\(/,
    recommendation: 'Avoid eval(). Use JSON.parse() for data or a sandboxed environment.',
  },
  // CORS wildcard
  {
    name: 'CORS wildcard origin',
    category: 'config',
    severity: 'medium',
    pattern: /(?:Access-Control-Allow-Origin|cors)\s*[:({]\s*['"]\*['"]/,
    recommendation: 'Restrict CORS to specific trusted origins instead of wildcard *.',
  },
  // Unvalidated redirect
  {
    name: 'Open redirect risk',
    category: 'redirect',
    severity: 'medium',
    pattern: /(?:redirect|location\.href|window\.location)\s*=\s*(?:req\.|request\.|params\.|query\.)/,
    recommendation: 'Validate redirect URLs against an allowlist of trusted domains.',
  },
  // Disabled security features
  {
    name: 'TLS/SSL verification disabled',
    category: 'config',
    severity: 'high',
    pattern: /verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
    recommendation: 'Never disable TLS verification in production.',
  },
  // Debug mode in production
  {
    name: 'Debug mode enabled',
    category: 'config',
    severity: 'medium',
    pattern: /DEBUG\s*=\s*True|debug\s*:\s*true|app\.debug\s*=\s*True/,
    recommendation: 'Ensure debug mode is disabled in production environments.',
  },
  // Empty catch blocks
  {
    name: 'Swallowed security exception',
    category: 'error-handling',
    severity: 'low',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}|except:\s*pass/,
    recommendation: 'Log exceptions properly. Swallowed exceptions can hide security issues.',
  },
  // Path traversal
  {
    name: 'Path traversal risk',
    category: 'injection',
    severity: 'high',
    pattern: /path\.join\s*\([^)]*req\.|path\.resolve\s*\([^)]*req\.|os\.path\.join\s*\([^)]*request\./,
    recommendation: 'Validate and sanitize file paths. Use path.resolve() and check against base directory.',
  },
  // JWT without verification
  {
    name: 'JWT without verification',
    category: 'auth',
    severity: 'high',
    pattern: /jwt\.decode\s*\([^)]*verify\s*=\s*False|algorithms\s*=\s*\[\s*['"]none['"]/,
    recommendation: 'Always verify JWT signatures. Never allow "none" algorithm.',
  },
];

/**
 * Run security scan on codebase.
 * @param cwd
 * @param options
 * @param options.category
 * @param options.severity
 * @param options.fileGlob
 */
export async function securityScan(
  cwd: string,
  options: { category?: string; severity?: string; fileGlob?: string } = {},
): Promise<SecurityReport> {
  const findings: SecurityFinding[] = [];

  // Find all source files
  const files = await glob(options.fileGlob || '**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs}', {
    cwd,
    ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**', 'vendor/**', '__pycache__/**'],
  });

  // Scan each file against SAST patterns
  for (const file of files.slice(0, 1000)) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf-8');
      const lines = content.split('\n');

      for (const pattern of SAST_PATTERNS) {
        if (options.category && pattern.category !== options.category) continue;
        if (options.severity && pattern.severity !== options.severity) continue;

        for (let i = 0; i < lines.length; i++) {
          if (pattern.pattern.test(lines[i])) {
            // Skip if in a comment
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

            findings.push({
              severity: pattern.severity,
              category: pattern.category,
              message: pattern.name,
              file,
              line: i + 1,
              snippet: lines[i].trim().slice(0, 120),
              recommendation: pattern.recommendation,
            });
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  // Check for common insecure files
  const insecureFiles = [
    { file: '.env', message: '.env file should not be committed to version control' },
    { file: 'id_rsa', message: 'Private SSH key should not be in repository' },
    { file: 'id_ed25519', message: 'Private SSH key should not be in repository' },
    { file: '.npmrc', message: 'npm config may contain auth tokens' },
    { file: '.pypirc', message: 'PyPI config may contain auth tokens' },
  ];

  for (const check of insecureFiles) {
    try {
      await access(path.join(cwd, check.file));
      findings.push({
        severity: 'high',
        category: 'secrets',
        message: check.message,
        file: check.file,
        recommendation: `Add ${check.file} to .gitignore and remove from version control.`,
      });
    } catch {
      /* not present, good */
    }
  }

  // Check dependency info
  const depInfo = await analyzeDependencies(cwd);

  // Build severity counts
  const bySeverity: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }

  return {
    scanDate: new Date().toISOString(),
    totalFindings: findings.length,
    bySeverity,
    findings: findings.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return (order[a.severity] || 4) - (order[b.severity] || 4);
    }),
    dependencyInfo: depInfo,
  };
}

/**
 * Analyze dependency files for basic info.
 * @param cwd
 */
async function analyzeDependencies(
  cwd: string,
): Promise<{ total: number; directDeps: number; lockfileFound: boolean }> {
  // Check for lockfiles
  const lockfiles = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Pipfile.lock',
    'poetry.lock',
    'Cargo.lock',
    'go.sum',
  ];
  let lockfileFound = false;

  for (const lf of lockfiles) {
    try {
      await access(path.join(cwd, lf));
      lockfileFound = true;
      break;
    } catch {
      continue;
    }
  }

  // Count deps from package.json / requirements.txt / etc.
  let directDeps = 0;
  let totalDeps = 0;

  try {
    const pkgJson = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    directDeps = Object.keys(pkgJson.dependencies || {}).length + Object.keys(pkgJson.devDependencies || {}).length;
    // Rough total from lock file
    try {
      const lockContent = await readFile(path.join(cwd, 'package-lock.json'), 'utf-8');
      const lockData = JSON.parse(lockContent);
      totalDeps = Object.keys(lockData.packages || lockData.dependencies || {}).length;
    } catch {
      totalDeps = directDeps;
    }
  } catch {
    try {
      const reqs = await readFile(path.join(cwd, 'requirements.txt'), 'utf-8');
      directDeps = reqs.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
      totalDeps = directDeps;
    } catch {
      /* no deps file found */
    }
  }

  return { total: totalDeps, directDeps, lockfileFound };
}
