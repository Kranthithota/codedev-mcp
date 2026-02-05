/**
 * Observability & Operations Analyzers
 * Audits logging, metrics, tracing, error handling patterns,
 * logging consistency, and feature flag usage.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectLanguage } from '../utils/languages.js';

// ── Observability Audit ─────────────────────────────────────────────────

export interface ObservabilityFinding {
  category: 'logging' | 'metrics' | 'tracing' | 'alerting';
  status: 'present' | 'partial' | 'missing';
  details: string;
  files: string[];
}

export interface ObservabilityResult {
  findings: ObservabilityFinding[];
  frameworks: { name: string; type: string; files: string[] }[];
  blindSpots: { area: string; description: string; severity: 'info' | 'warning' | 'error' }[];
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  summary: { logging: string; metrics: string; tracing: string; overall: string };
  recommendations: string[];
}

/** Known observability frameworks and libraries to search for. */
const OBSERVABILITY_FRAMEWORKS: {
  name: string;
  type: 'logging' | 'metrics' | 'tracing' | 'alerting';
  patterns: string[];
}[] = [
  // Logging
  { name: 'winston', type: 'logging', patterns: ['winston', 'createLogger'] },
  { name: 'pino', type: 'logging', patterns: ['pino', "require('pino')", "from 'pino'"] },
  { name: 'bunyan', type: 'logging', patterns: ['bunyan', "require('bunyan')", "from 'bunyan'"] },
  { name: 'log4js', type: 'logging', patterns: ['log4js', "require('log4js')", "from 'log4js'"] },
  { name: 'log4j', type: 'logging', patterns: ['org.apache.logging.log4j', 'LogManager.getLogger'] },
  { name: 'logback', type: 'logging', patterns: ['ch.qos.logback', 'LoggerFactory.getLogger'] },
  { name: 'Python logging', type: 'logging', patterns: ['import logging', 'logging.getLogger'] },
  { name: 'slog (Go)', type: 'logging', patterns: ['log/slog', 'slog.New'] },
  { name: 'zerolog', type: 'logging', patterns: ['rs/zerolog', 'zerolog.New'] },
  { name: 'Morgan', type: 'logging', patterns: ['morgan', "require('morgan')", "from 'morgan'"] },
  // Metrics
  { name: 'prom-client', type: 'metrics', patterns: ['prom-client', 'promClient', 'new Counter(', 'new Histogram(', 'new Gauge('] },
  { name: 'Prometheus', type: 'metrics', patterns: ['prometheus', 'prometheus_client', 'PrometheusMetrics'] },
  { name: 'StatsD', type: 'metrics', patterns: ['statsd', 'hot-shots', 'StatsD', 'node-statsd'] },
  { name: 'Datadog', type: 'metrics', patterns: ['dd-trace', 'datadog-metrics', 'dogstatsd', 'DDTrace'] },
  { name: 'New Relic', type: 'metrics', patterns: ['newrelic', 'new-relic', '@newrelic/'] },
  { name: 'OpenTelemetry Metrics', type: 'metrics', patterns: ['@opentelemetry/sdk-metrics', 'MeterProvider'] },
  { name: 'Micrometer', type: 'metrics', patterns: ['io.micrometer', 'MeterRegistry'] },
  // Tracing
  { name: 'OpenTelemetry', type: 'tracing', patterns: ['@opentelemetry', 'opentelemetry-api', 'TracerProvider', 'trace.getTracer'] },
  { name: 'Jaeger', type: 'tracing', patterns: ['jaeger-client', 'jaeger_client', 'JaegerExporter'] },
  { name: 'Zipkin', type: 'tracing', patterns: ['zipkin', 'ZipkinExporter', 'zipkin-transport'] },
  { name: 'dd-trace', type: 'tracing', patterns: ['dd-trace', "require('dd-trace')", "from 'dd-trace'"] },
  { name: 'Sentry', type: 'tracing', patterns: ['@sentry/', 'Sentry.init', 'sentry-sdk', 'sentry_sdk'] },
  { name: 'AWS X-Ray', type: 'tracing', patterns: ['aws-xray-sdk', 'AWSXRay'] },
  // Alerting
  { name: 'PagerDuty', type: 'alerting', patterns: ['pagerduty', 'PagerDuty', '@pagerduty/'] },
  { name: 'Sentry Alerting', type: 'alerting', patterns: ['Sentry.captureException', 'Sentry.captureMessage', 'sentry_sdk.capture'] },
  { name: 'Slack Webhooks', type: 'alerting', patterns: ['hooks.slack.com', 'IncomingWebhook', 'slack-notify'] },
];

/** Critical code paths that should be instrumented. */
const CRITICAL_PATH_PATTERNS: { area: string; patterns: string[]; description: string }[] = [
  { area: 'HTTP handlers', patterns: ['app.get', 'app.post', 'app.put', 'app.delete', 'router.get', 'router.post', '@Get(', '@Post(', '@RequestMapping'], description: 'Request handlers need logging and tracing' },
  { area: 'Error handlers', patterns: ['app.use(err', 'errorHandler', '@ExceptionHandler', 'rescue_from', 'except Exception'], description: 'Error handlers should log and report errors' },
  { area: 'Background jobs', patterns: ['cron.schedule', 'Bull', 'agenda', 'celery', 'sidekiq', '@Scheduled', 'setInterval'], description: 'Background jobs need logging and monitoring' },
  { area: 'Database operations', patterns: ['prisma.', 'sequelize.', 'mongoose.', 'getRepository', 'knex(', 'Pool(', 'createConnection'], description: 'Database operations should have query timing metrics' },
  { area: 'External API calls', patterns: ['axios.', 'fetch(', 'http.request', 'got(', 'request(', 'urllib'], description: 'External API calls need timeout, retry, and latency tracking' },
  { area: 'Authentication', patterns: ['passport.', 'jwt.verify', 'jwt.sign', 'authenticate', 'bcrypt.compare', 'auth.'], description: 'Authentication flows need audit logging' },
];

/**
 * Audit codebase for observability readiness: logging, metrics, tracing, and alerting.
 * Detects installed frameworks, identifies blind spots in critical paths,
 * and provides an overall observability score and grade.
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @param options.fileGlob - Custom glob pattern for files to scan.
 * @returns Observability audit results with findings, score, grade, and recommendations.
 */
export async function auditObservability(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<ObservabilityResult> {
  const dir = path.resolve(cwd, options?.directory || '.');

  const findings: ObservabilityFinding[] = [];
  const frameworks: ObservabilityResult['frameworks'] = [];
  const blindSpots: ObservabilityResult['blindSpots'] = [];
  const recommendations: string[] = [];

  const detectedTypes = new Set<string>();

  // 1. Detect observability frameworks
  for (const fw of OBSERVABILITY_FRAMEWORKS) {
    const matchedFiles: string[] = [];
    for (const pattern of fw.patterns) {
      try {
        const results = await searchCode({
          cwd: dir,
          pattern,
          maxResults: 10,
        });
        for (const r of results) {
          if (!matchedFiles.includes(r.file)) {
            matchedFiles.push(r.file);
          }
        }
      } catch {
        /* search failure is non-fatal */
      }
    }

    if (matchedFiles.length > 0) {
      frameworks.push({
        name: fw.name,
        type: fw.type,
        files: matchedFiles.slice(0, 10),
      });
      detectedTypes.add(fw.type);
    }
  }

  // 2. Build findings per category
  const categories: ('logging' | 'metrics' | 'tracing' | 'alerting')[] = ['logging', 'metrics', 'tracing', 'alerting'];
  for (const category of categories) {
    const categoryFrameworks = frameworks.filter((f) => f.type === category);
    const allFiles = categoryFrameworks.flatMap((f) => f.files);

    if (categoryFrameworks.length === 0) {
      findings.push({
        category,
        status: 'missing',
        details: `No ${category} framework detected`,
        files: [],
      });
    } else if (allFiles.length < 3) {
      findings.push({
        category,
        status: 'partial',
        details: `${category} framework found (${categoryFrameworks.map((f) => f.name).join(', ')}) but limited usage`,
        files: allFiles,
      });
    } else {
      findings.push({
        category,
        status: 'present',
        details: `${category} framework(s): ${categoryFrameworks.map((f) => f.name).join(', ')}`,
        files: allFiles,
      });
    }
  }

  // 3. Check for console.log usage (indicates missing structured logging)
  try {
    const consoleResults = await searchCode({
      cwd: dir,
      pattern: 'console.log',
      maxResults: 20,
    });
    if (consoleResults.length > 10) {
      blindSpots.push({
        area: 'Unstructured logging',
        description: `Found ${consoleResults.length}+ console.log statements - replace with structured logging framework`,
        severity: 'warning',
      });
    }
  } catch {
    /* non-fatal */
  }

  // 4. Check critical paths for instrumentation
  for (const critPath of CRITICAL_PATH_PATTERNS) {
    let found = false;
    for (const pattern of critPath.patterns) {
      try {
        const results = await searchCode({
          cwd: dir,
          pattern,
          maxResults: 3,
        });
        if (results.length > 0) {
          found = true;
          break;
        }
      } catch {
        /* non-fatal */
      }
    }

    if (found) {
      // Check if these paths have logging/tracing
      const hasLogging = frameworks.some((f) => f.type === 'logging');
      const hasTracing = frameworks.some((f) => f.type === 'tracing');

      if (!hasLogging && !hasTracing) {
        blindSpots.push({
          area: critPath.area,
          description: `${critPath.description} but no logging/tracing framework detected`,
          severity: 'error',
        });
      } else if (!hasTracing && critPath.area !== 'Error handlers') {
        blindSpots.push({
          area: critPath.area,
          description: `${critPath.description} - consider adding distributed tracing`,
          severity: 'info',
        });
      }
    }
  }

  // 5. Check for health check endpoint
  try {
    const healthResults = await searchCode({
      cwd: dir,
      pattern: 'health',
      maxResults: 5,
    });
    const hasHealthEndpoint = healthResults.some((r) =>
      /(?:\/health|healthcheck|health_check|readiness|liveness)/i.test(r.text),
    );
    if (!hasHealthEndpoint) {
      blindSpots.push({
        area: 'Health checks',
        description: 'No health check endpoint detected - important for orchestrator probes',
        severity: 'warning',
      });
    }
  } catch {
    /* non-fatal */
  }

  // 6. Calculate score and grade
  let score = 0;
  const categoryScores: Record<string, number> = {
    logging: 0,
    metrics: 0,
    tracing: 0,
    alerting: 0,
  };

  for (const finding of findings) {
    const baseScore = finding.status === 'present' ? 25 : finding.status === 'partial' ? 12 : 0;
    categoryScores[finding.category] = baseScore;
    score += baseScore;
  }

  // Penalty for blind spots
  for (const spot of blindSpots) {
    const penalty = spot.severity === 'error' ? 5 : spot.severity === 'warning' ? 3 : 1;
    score = Math.max(0, score - penalty);
  }

  score = Math.min(100, score);

  const grade: ObservabilityResult['grade'] =
    score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';

  // 7. Build summary strings
  const statusLabel = (cat: string) => {
    const f = findings.find((fi) => fi.category === cat);
    return f ? f.status : 'missing';
  };

  const summary = {
    logging: statusLabel('logging') === 'present'
      ? `Logging configured (${frameworks.filter((f) => f.type === 'logging').map((f) => f.name).join(', ')})`
      : statusLabel('logging') === 'partial'
        ? 'Logging framework detected but limited usage'
        : 'No logging framework detected',
    metrics: statusLabel('metrics') === 'present'
      ? `Metrics configured (${frameworks.filter((f) => f.type === 'metrics').map((f) => f.name).join(', ')})`
      : statusLabel('metrics') === 'partial'
        ? 'Metrics framework detected but limited usage'
        : 'No metrics framework detected',
    tracing: statusLabel('tracing') === 'present'
      ? `Tracing configured (${frameworks.filter((f) => f.type === 'tracing').map((f) => f.name).join(', ')})`
      : statusLabel('tracing') === 'partial'
        ? 'Tracing framework detected but limited usage'
        : 'No tracing framework detected',
    overall: `Observability score: ${score}/100 (Grade: ${grade})`,
  };

  // 8. Build recommendations
  if (!detectedTypes.has('logging')) {
    recommendations.push('Add a structured logging framework (winston, pino for Node.js; logback for Java; zerolog for Go).');
  }
  if (!detectedTypes.has('metrics')) {
    recommendations.push('Add application metrics (prom-client with Prometheus, or Datadog/StatsD for custom metrics).');
  }
  if (!detectedTypes.has('tracing')) {
    recommendations.push('Implement distributed tracing with OpenTelemetry for cross-service request tracking.');
  }
  if (!detectedTypes.has('alerting')) {
    recommendations.push('Configure alerting (Sentry for errors, PagerDuty/Slack for operational alerts).');
  }
  if (blindSpots.length > 0) {
    recommendations.push(`Address ${blindSpots.length} observability blind spot(s) in critical code paths.`);
  }

  return {
    findings,
    frameworks,
    blindSpots,
    score,
    grade,
    summary,
    recommendations,
  };
}

// ── Error Handling Analysis ─────────────────────────────────────────────

export interface ErrorHandlingIssue {
  file: string;
  line: number;
  type: 'swallowed-error' | 'inconsistent-type' | 'missing-handler' | 'string-throw' | 'generic-catch' | 'no-error-boundary';
  severity: 'info' | 'warning' | 'error';
  description: string;
  code: string;
  suggestion: string;
}

export interface ErrorHandlingResult {
  issues: ErrorHandlingIssue[];
  patterns: { pattern: string; count: number; files: string[] }[];
  globalHandlers: { type: string; file: string; line: number }[];
  summary: { totalIssues: number; swallowed: number; inconsistent: number; missing: number };
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  recommendations: string[];
}

/** Patterns for detecting error handling issues. */
const ERROR_HANDLING_PATTERNS: {
  type: ErrorHandlingIssue['type'];
  pattern: RegExp;
  severity: ErrorHandlingIssue['severity'];
  description: string;
  suggestion: string;
  /** Multi-line detection: if true, needs special multiline handling. */
  multiline?: boolean;
}[] = [
  // Swallowed errors: empty catch blocks
  {
    type: 'swallowed-error',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    severity: 'error',
    description: 'Empty catch block swallows errors silently',
    suggestion: 'Log the error, re-throw, or handle it explicitly. At minimum add a comment explaining why.',
    multiline: true,
  },
  // Swallowed errors: catch with only console.log
  {
    type: 'swallowed-error',
    pattern: /catch\s*\([^)]*\)\s*\{\s*console\.log/,
    severity: 'warning',
    description: 'Catch block only logs to console - error may be lost in production',
    suggestion: 'Use a proper logging framework and consider re-throwing or returning an error result.',
    multiline: true,
  },
  // Python: bare except:pass
  {
    type: 'swallowed-error',
    pattern: /except:\s*pass/,
    severity: 'error',
    description: 'Bare except:pass swallows all exceptions silently',
    suggestion: 'Catch specific exceptions and handle them. At minimum, log the exception.',
  },
  // Python: broad except Exception
  {
    type: 'generic-catch',
    pattern: /except\s+Exception\s*(?:as\s+\w+)?\s*:/,
    severity: 'warning',
    description: 'Catching broad Exception type may mask specific errors',
    suggestion: 'Catch specific exception types (ValueError, IOError, etc.) for better error handling.',
  },
  // String throws
  {
    type: 'string-throw',
    pattern: /throw\s+['"][^'"]+['"]/,
    severity: 'warning',
    description: 'Throwing a string instead of an Error object - loses stack trace',
    suggestion: "Throw Error objects: throw new Error('message') for proper stack traces.",
  },
  // Generic catch-all without type
  {
    type: 'generic-catch',
    pattern: /catch\s*\(\s*(?:e|err|error|ex)\s*\)\s*\{/,
    severity: 'info',
    description: 'Generic catch without type narrowing',
    suggestion: 'Consider using instanceof checks to handle different error types appropriately.',
  },
  // Missing handler: async without try/catch
  {
    type: 'missing-handler',
    pattern: /async\s+(?:function\s+\w+|\w+\s*=\s*async)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{(?:(?!try\s*\{).)*\}/s,
    severity: 'info',
    description: 'Async function without try/catch - unhandled rejection risk',
    suggestion: 'Wrap async function body in try/catch or ensure caller handles rejections.',
    multiline: true,
  },
];

/** Global error handler patterns. */
const GLOBAL_HANDLER_PATTERNS: { type: string; pattern: string }[] = [
  { type: 'process.uncaughtException', pattern: "process.on('uncaughtException" },
  { type: 'process.unhandledRejection', pattern: "process.on('unhandledRejection" },
  { type: 'window.onerror', pattern: 'window.onerror' },
  { type: 'window.onunhandledrejection', pattern: 'window.onunhandledrejection' },
  { type: 'Express error middleware', pattern: 'app.use(err' },
  { type: 'Express error middleware', pattern: 'function(err, req, res, next)' },
  { type: 'Express error middleware', pattern: '(err: Error, req: Request' },
  { type: 'React ErrorBoundary', pattern: 'componentDidCatch' },
  { type: 'React ErrorBoundary', pattern: 'ErrorBoundary' },
  { type: 'Vue errorHandler', pattern: 'app.config.errorHandler' },
  { type: 'Angular ErrorHandler', pattern: 'implements ErrorHandler' },
  { type: 'Django middleware', pattern: 'process_exception' },
  { type: 'Spring @ExceptionHandler', pattern: '@ExceptionHandler' },
  { type: 'Spring @ControllerAdvice', pattern: '@ControllerAdvice' },
];

/**
 * Analyze error handling patterns across the codebase.
 * Detects swallowed errors, inconsistent error types, missing handlers,
 * string throws, and checks for global error handlers and error boundaries.
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @param options.fileGlob - Custom glob pattern for files to scan.
 * @returns Error handling analysis with issues, patterns, global handlers, score, and grade.
 */
export async function analyzeErrorHandling(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<ErrorHandlingResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const glob = options?.fileGlob || '*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs}';
  const files = await listFiles(dir, { glob, type: 'file' });
  const sourceFiles = files.filter((f) => !/(node_modules|dist|build|\.d\.ts)/i.test(f)).slice(0, 300);

  const issues: ErrorHandlingIssue[] = [];
  const patternCounts: Record<string, { count: number; files: Set<string> }> = {};
  const globalHandlers: ErrorHandlingResult['globalHandlers'] = [];

  let totalCatchBlocks = 0;
  let swallowed = 0;
  let inconsistent = 0;
  let missing = 0;

  // 1. Detect global error handlers
  for (const handler of GLOBAL_HANDLER_PATTERNS) {
    try {
      const results = await searchCode({
        cwd: dir,
        pattern: handler.pattern,
        maxResults: 5,
      });
      for (const r of results) {
        // Avoid duplicates
        if (!globalHandlers.some((g) => g.file === r.file && g.line === r.line)) {
          globalHandlers.push({
            type: handler.type,
            file: r.file,
            line: r.line,
          });
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  // 2. Scan files for error handling issues
  for (const file of sourceFiles) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

        // Count catch blocks
        if (/\bcatch\s*\(/.test(line) || /\bexcept\s/.test(line) || /\brescue\b/.test(line)) {
          totalCatchBlocks++;
        }

        // Empty catch block detection (look at current + next few lines)
        if (/catch\s*\([^)]*\)\s*\{/.test(line)) {
          const nextLines = lines.slice(i, Math.min(i + 4, lines.length)).join(' ');
          const catchBody = nextLines.match(/catch\s*\([^)]*\)\s*\{([^}]*)}/);
          if (catchBody) {
            const body = catchBody[1].trim();
            if (body === '' || body === '/* skip */' || body === '// skip') {
              issues.push({
                file,
                line: i + 1,
                type: 'swallowed-error',
                severity: 'error',
                description: 'Empty catch block swallows errors silently',
                code: trimmed.slice(0, 120),
                suggestion: 'Log the error, re-throw, or handle explicitly.',
              });
              swallowed++;
              trackPattern(patternCounts, 'swallowed-error', file);
            } else if (/^\s*console\.log\b/.test(body) && !/throw\b/.test(body)) {
              issues.push({
                file,
                line: i + 1,
                type: 'swallowed-error',
                severity: 'warning',
                description: 'Catch block only uses console.log - error may be lost in production',
                code: trimmed.slice(0, 120),
                suggestion: 'Use proper logging framework and consider re-throwing.',
              });
              swallowed++;
              trackPattern(patternCounts, 'swallowed-error', file);
            }
          }
        }

        // Python bare except:pass
        if (/except:\s*pass/.test(line)) {
          issues.push({
            file,
            line: i + 1,
            type: 'swallowed-error',
            severity: 'error',
            description: 'Bare except:pass swallows all exceptions silently',
            code: trimmed.slice(0, 120),
            suggestion: 'Catch specific exceptions and handle them.',
          });
          swallowed++;
          trackPattern(patternCounts, 'swallowed-error', file);
        }

        // String throws
        if (/throw\s+['"]/.test(line)) {
          issues.push({
            file,
            line: i + 1,
            type: 'string-throw',
            severity: 'warning',
            description: 'Throwing a string instead of Error object - loses stack trace',
            code: trimmed.slice(0, 120),
            suggestion: "Use: throw new Error('message') for proper stack traces.",
          });
          inconsistent++;
          trackPattern(patternCounts, 'string-throw', file);
        }

        // Python: raise with string
        if (/raise\s+['"]/.test(line)) {
          issues.push({
            file,
            line: i + 1,
            type: 'string-throw',
            severity: 'warning',
            description: 'Raising a string instead of an Exception subclass',
            code: trimmed.slice(0, 120),
            suggestion: "Use: raise ValueError('message') or a custom exception class.",
          });
          inconsistent++;
          trackPattern(patternCounts, 'string-throw', file);
        }

        // Broad exception catching
        if (/except\s+Exception\s*(?:as\s+\w+)?\s*:/.test(line)) {
          issues.push({
            file,
            line: i + 1,
            type: 'generic-catch',
            severity: 'warning',
            description: 'Catching broad Exception type may mask specific errors',
            code: trimmed.slice(0, 120),
            suggestion: 'Catch specific exception types for better error handling.',
          });
          trackPattern(patternCounts, 'generic-catch', file);
        }

        // .then() without .catch()
        if (/\.then\s*\(/.test(line) && !/\.catch\s*\(/.test(line)) {
          const nearbyLines = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
          if (!/\.catch\s*\(/.test(nearbyLines)) {
            issues.push({
              file,
              line: i + 1,
              type: 'missing-handler',
              severity: 'warning',
              description: 'Promise .then() without .catch() handler',
              code: trimmed.slice(0, 120),
              suggestion: 'Add .catch() handler or use async/await with try/catch.',
            });
            missing++;
            trackPattern(patternCounts, 'missing-handler', file);
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  // 3. Check for React error boundaries
  const lang = detectLanguage(sourceFiles[0] || 'index.ts');
  if (lang === 'typescript' || lang === 'javascript') {
    const hasJSX = sourceFiles.some((f) => /\.(tsx|jsx)$/.test(f));
    if (hasJSX) {
      const hasErrorBoundary = globalHandlers.some((g) => g.type === 'React ErrorBoundary');
      if (!hasErrorBoundary) {
        issues.push({
          file: '',
          line: 0,
          type: 'no-error-boundary',
          severity: 'warning',
          description: 'React project without ErrorBoundary - unhandled render errors crash the entire app',
          code: '',
          suggestion: 'Add React ErrorBoundary components to catch and handle render errors gracefully.',
        });
        trackPattern(patternCounts, 'no-error-boundary', '(project-level)');
      }
    }
  }

  // 4. Calculate score
  const issueWeights: Record<string, number> = { info: 0.5, warning: 2, error: 5 };
  const totalWeight = issues.reduce((sum, issue) => sum + (issueWeights[issue.severity] || 1), 0);
  const maxPenalty = Math.max(totalCatchBlocks * 3, 50);
  const hasGlobalHandlers = globalHandlers.length > 0;
  const globalBonus = hasGlobalHandlers ? 10 : 0;
  const score = Math.min(100, Math.max(0, Math.round(100 - (totalWeight / maxPenalty) * 100 + globalBonus)));

  const grade: ErrorHandlingResult['grade'] =
    score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';

  // 5. Build pattern summary
  const patterns = Object.entries(patternCounts).map(([pattern, data]) => ({
    pattern,
    count: data.count,
    files: Array.from(data.files),
  }));

  // 6. Build recommendations
  const recommendations: string[] = [];
  if (swallowed > 0) {
    recommendations.push(`Fix ${swallowed} swallowed error(s) - empty catch blocks hide bugs and make debugging difficult.`);
  }
  if (inconsistent > 0) {
    recommendations.push('Standardize error types - throw Error objects instead of strings for consistent stack traces.');
  }
  if (missing > 0) {
    recommendations.push('Add error handling to unhandled promises - use .catch() or try/catch with await.');
  }
  if (!hasGlobalHandlers) {
    recommendations.push('Add global error handlers (process.on("unhandledRejection"), window.onerror) as safety nets.');
  }
  if (issues.length === 0) {
    recommendations.push('Error handling patterns look good. Consider runtime error monitoring (Sentry, Bugsnag) for production.');
  }

  return {
    issues: issues.slice(0, 200),
    patterns,
    globalHandlers,
    summary: {
      totalIssues: issues.length,
      swallowed,
      inconsistent,
      missing,
    },
    score,
    grade,
    recommendations,
  };
}

/**
 * Track a pattern occurrence in the pattern count map.
 * @param map - The pattern tracking map.
 * @param pattern - The pattern name.
 * @param file - The file where the pattern was found.
 */
function trackPattern(
  map: Record<string, { count: number; files: Set<string> }>,
  pattern: string,
  file: string,
): void {
  if (!map[pattern]) map[pattern] = { count: 0, files: new Set() };
  map[pattern].count++;
  map[pattern].files.add(file);
}

// ── Logging Consistency Analysis ────────────────────────────────────────

export interface LoggingIssue {
  file: string;
  line: number;
  type: 'pii-leak' | 'wrong-level' | 'unstructured' | 'no-context' | 'inconsistent-framework';
  severity: 'info' | 'warning' | 'error' | 'critical';
  description: string;
  code: string;
}

export interface LoggingConsistencyResult {
  issues: LoggingIssue[];
  framework: string;
  patterns: { structured: number; unstructured: number; withContext: number; withoutContext: number };
  piiFindings: number;
  summary: { totalLogStatements: number; issues: number; piiLeaks: number };
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  recommendations: string[];
}

/** PII patterns to detect in log statements. */
const PII_PATTERNS: { name: string; pattern: RegExp; severity: 'error' | 'critical' }[] = [
  { name: 'email', pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, severity: 'error' },
  { name: 'password field', pattern: /(?:password|passwd|pwd)\s*[:=]/i, severity: 'critical' },
  { name: 'token/secret', pattern: /(?:token|secret|api_?key|auth_?key|access_?key)\s*[:=]/i, severity: 'critical' },
  { name: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/, severity: 'critical' },
  { name: 'credit card', pattern: /\b(?:\d{4}[- ]?){3}\d{4}\b/, severity: 'critical' },
  { name: 'phone number', pattern: /(?:phone|mobile|tel)\s*[:=]\s*['"]\+?\d/, severity: 'error' },
  { name: 'IP address', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, severity: 'error' },
  { name: 'bearer token', pattern: /[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/,  severity: 'critical' },
];

/** Known logging framework patterns for detection. */
const LOG_FRAMEWORK_PATTERNS: { name: string; patterns: RegExp[] }[] = [
  { name: 'winston', patterns: [/logger\.(?:info|warn|error|debug|verbose)\s*\(/, /winston\.\w+/] },
  { name: 'pino', patterns: [/logger\.(?:info|warn|error|debug|trace|fatal)\s*\(/, /pino\s*\(/] },
  { name: 'bunyan', patterns: [/log\.(?:info|warn|error|debug|trace|fatal)\s*\(/, /bunyan\.\w+/] },
  { name: 'log4js', patterns: [/logger\.(?:info|warn|error|debug|trace|fatal)\s*\(/, /log4js\.\w+/] },
  { name: 'console', patterns: [/console\.(?:log|warn|error|info|debug)\s*\(/] },
  { name: 'Python logging', patterns: [/logging\.(?:info|warning|error|debug|critical)\s*\(/, /logger\.(?:info|warning|error|debug|critical)\s*\(/] },
  { name: 'Go log', patterns: [/log\.(?:Print|Printf|Println|Fatal|Fatalf)\s*\(/, /slog\.(?:Info|Warn|Error|Debug)\s*\(/] },
];

/** Regex for detecting log statements (any framework). */
const LOG_STATEMENT_PATTERN = /(?:logger|log|console|logging|slog)\.(?:info|warn|warning|error|debug|trace|fatal|verbose|critical|log|Print|Printf|Println)\s*\(/i;

/** Patterns that indicate structured logging (JSON, key-value). */
const STRUCTURED_LOG_PATTERN = /(?:\{[^}]*\}|"[^"]*"\s*:\s*|'\w+'\s*:\s*|\w+\s*=\s*[^,;]+(?:,\s*\w+\s*=))/;

/** Patterns that indicate correlation/request context. */
const CONTEXT_PATTERNS = /(?:requestId|traceId|correlationId|spanId|x-request-id|req\.id|ctx\.id|trace_id|request_id)/i;

/**
 * Analyze logging patterns for consistency, PII leaks, structured formatting,
 * and request correlation across the codebase.
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @param options.fileGlob - Custom glob pattern for files to scan.
 * @returns Logging consistency analysis with issues, patterns, scores, and recommendations.
 */
export async function analyzeLoggingConsistency(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<LoggingConsistencyResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const glob = options?.fileGlob || '*.{ts,tsx,js,jsx,py,java,go,rs,rb,php}';
  const files = await listFiles(dir, { glob, type: 'file' });
  const sourceFiles = files.filter((f) => !/(node_modules|dist|build|\.d\.ts|\.test\.|\.spec\.)/i.test(f)).slice(0, 300);

  const issues: LoggingIssue[] = [];
  let piiFindings = 0;
  let totalLogStatements = 0;
  let structuredCount = 0;
  let unstructuredCount = 0;
  let withContextCount = 0;
  let withoutContextCount = 0;

  // Detect primary logging framework
  const frameworkHits: Record<string, number> = {};

  // Track which frameworks are used across files
  const frameworksInFiles: Record<string, Set<string>> = {};

  for (const file of sourceFiles) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');

      // Detect frameworks used in this file
      const fileFrameworks = new Set<string>();
      for (const fw of LOG_FRAMEWORK_PATTERNS) {
        for (const p of fw.patterns) {
          if (p.test(content)) {
            fileFrameworks.add(fw.name);
            frameworkHits[fw.name] = (frameworkHits[fw.name] || 0) + 1;
            if (!frameworksInFiles[fw.name]) frameworksInFiles[fw.name] = new Set();
            frameworksInFiles[fw.name].add(file);
            break;
          }
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip actual comments
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

        // Is this a log statement?
        if (!LOG_STATEMENT_PATTERN.test(line)) continue;
        totalLogStatements++;

        // Check for PII
        for (const pii of PII_PATTERNS) {
          if (pii.pattern.test(line)) {
            issues.push({
              file,
              line: i + 1,
              type: 'pii-leak',
              severity: pii.severity,
              description: `Potential ${pii.name} logged - PII data in logs violates privacy regulations`,
              code: trimmed.slice(0, 120),
            });
            piiFindings++;
            break; // Only report first PII match per line
          }
        }

        // Check structured vs unstructured
        if (STRUCTURED_LOG_PATTERN.test(line)) {
          structuredCount++;
        } else {
          unstructuredCount++;
          // Only flag as issue if there's a mix (some structured, some not)
          if (structuredCount > 0 && unstructuredCount > 3) {
            // Limit noise - only flag first few
            if (issues.filter((iss) => iss.type === 'unstructured' && iss.file === file).length < 3) {
              issues.push({
                file,
                line: i + 1,
                type: 'unstructured',
                severity: 'info',
                description: 'Unstructured log statement - use JSON/key-value format for consistent parsing',
                code: trimmed.slice(0, 120),
              });
            }
          }
        }

        // Check for correlation context
        if (CONTEXT_PATTERNS.test(line)) {
          withContextCount++;
        } else {
          withoutContextCount++;
        }

        // Check for wrong log level (error-like messages at info level)
        if (/\.(?:info|log|debug)\s*\(/.test(line) && /(?:error|failed|failure|exception|crash|critical)/i.test(line)) {
          issues.push({
            file,
            line: i + 1,
            type: 'wrong-level',
            severity: 'warning',
            description: 'Error/failure message logged at info/debug level - should use error/warn level',
            code: trimmed.slice(0, 120),
          });
        }

        // Check for success messages at error level
        if (/\.error\s*\(/.test(line) && /(?:success|completed|started|ready|connected)/i.test(line) && !/(?:error|fail|exception)/i.test(line)) {
          issues.push({
            file,
            line: i + 1,
            type: 'wrong-level',
            severity: 'warning',
            description: 'Success message logged at error level - should use info level',
            code: trimmed.slice(0, 120),
          });
        }
      }

      // Check for inconsistent framework usage within a file
      if (fileFrameworks.size > 1 && !fileFrameworks.has('console')) {
        issues.push({
          file,
          line: 1,
          type: 'inconsistent-framework',
          severity: 'warning',
          description: `Multiple logging frameworks in one file: ${Array.from(fileFrameworks).join(', ')}`,
          code: '',
        });
      }
    } catch {
      /* skip unreadable files */
    }
  }

  // Detect primary framework
  const sortedFrameworks = Object.entries(frameworkHits).sort((a, b) => b[1] - a[1]);
  const primaryFramework = sortedFrameworks.length > 0 ? sortedFrameworks[0][0] : 'none';

  // Check for inconsistent framework usage across the project
  const nonConsoleFrameworks = sortedFrameworks.filter(([name]) => name !== 'console');
  if (nonConsoleFrameworks.length > 1) {
    // Multiple logging frameworks across the project
    const frameworkNames = nonConsoleFrameworks.map(([name]) => name).join(', ');
    issues.push({
      file: '',
      line: 0,
      type: 'inconsistent-framework',
      severity: 'warning',
      description: `Multiple logging frameworks detected across project: ${frameworkNames}`,
      code: '',
    });
  }

  // Calculate score
  let score = 100;
  const piiPenalty = piiFindings * 15;
  const wrongLevelPenalty = issues.filter((i) => i.type === 'wrong-level').length * 3;
  const inconsistentPenalty = issues.filter((i) => i.type === 'inconsistent-framework').length * 5;
  const unstructuredRatio = totalLogStatements > 0 ? unstructuredCount / totalLogStatements : 0;
  const structurePenalty = unstructuredRatio > 0.5 ? 15 : unstructuredRatio > 0.2 ? 5 : 0;
  const contextRatio = totalLogStatements > 0 ? withoutContextCount / totalLogStatements : 0;
  const contextPenalty = contextRatio > 0.8 ? 10 : contextRatio > 0.5 ? 5 : 0;

  score = Math.max(0, score - piiPenalty - wrongLevelPenalty - inconsistentPenalty - structurePenalty - contextPenalty);

  const grade: LoggingConsistencyResult['grade'] =
    score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';

  // Build recommendations
  const recommendations: string[] = [];
  if (piiFindings > 0) {
    recommendations.push(`CRITICAL: Remove ${piiFindings} PII leak(s) from log statements immediately. Use data masking/redaction.`);
  }
  if (primaryFramework === 'console' || primaryFramework === 'none') {
    recommendations.push('Adopt a structured logging framework (winston, pino, bunyan) instead of console.log.');
  }
  if (nonConsoleFrameworks.length > 1) {
    recommendations.push(`Standardize on a single logging framework (currently using: ${nonConsoleFrameworks.map(([n]) => n).join(', ')}).`);
  }
  if (unstructuredRatio > 0.3) {
    recommendations.push('Use structured logging (JSON format) for consistent log parsing and aggregation.');
  }
  if (contextRatio > 0.5 && totalLogStatements > 5) {
    recommendations.push('Add request correlation IDs (traceId/requestId) to log statements for distributed tracing.');
  }
  if (issues.filter((i) => i.type === 'wrong-level').length > 0) {
    recommendations.push('Review log levels: errors at error/warn, routine operations at info, verbose data at debug.');
  }

  return {
    issues: issues.slice(0, 200),
    framework: primaryFramework,
    patterns: {
      structured: structuredCount,
      unstructured: unstructuredCount,
      withContext: withContextCount,
      withoutContext: withoutContextCount,
    },
    piiFindings,
    summary: {
      totalLogStatements,
      issues: issues.length,
      piiLeaks: piiFindings,
    },
    score,
    grade,
    recommendations,
  };
}

// ── Feature Flag Audit ──────────────────────────────────────────────────

export interface FeatureFlag {
  name: string;
  framework: string;
  usages: { file: string; line: number; context: string }[];
  isStale: boolean;
  staleReason?: string;
}

export interface FeatureFlagResult {
  flags: FeatureFlag[];
  frameworks: string[];
  staleFlags: FeatureFlag[];
  summary: { totalFlags: number; stale: number; frameworks: string[] };
  recommendations: string[];
}

/** Feature flag framework detection patterns. */
const FLAG_FRAMEWORK_PATTERNS: {
  framework: string;
  searchPatterns: string[];
  /** Regex to extract flag name from a matched line. */
  nameExtractor: RegExp;
}[] = [
  // LaunchDarkly
  {
    framework: 'LaunchDarkly',
    searchPatterns: ['ldClient.variation', 'ldClient.boolVariation', 'ldClient.stringVariation', 'ldClient.jsonVariation'],
    nameExtractor: /(?:variation|boolVariation|stringVariation|jsonVariation|numberVariation)\s*\(\s*['"]([^'"]+)['"]/,
  },
  // Unleash
  {
    framework: 'Unleash',
    searchPatterns: ['isEnabled(', 'unleash.isEnabled'],
    nameExtractor: /isEnabled\s*\(\s*['"]([^'"]+)['"]/,
  },
  // Split.io
  {
    framework: 'Split.io',
    searchPatterns: ['getTreatment(', 'client.getTreatment'],
    nameExtractor: /getTreatment\s*\(\s*['"]([^'"]+)['"]/,
  },
  // Flagsmith
  {
    framework: 'Flagsmith',
    searchPatterns: ['flagsmith.hasFeature', 'flagsmith.getValue'],
    nameExtractor: /(?:hasFeature|getValue)\s*\(\s*['"]([^'"]+)['"]/,
  },
  // ConfigCat
  {
    framework: 'ConfigCat',
    searchPatterns: ['getValueAsync(', 'configCatClient.getValueAsync'],
    nameExtractor: /getValueAsync\s*\(\s*['"]([^'"]+)['"]/,
  },
  // Custom patterns - environment variables
  {
    framework: 'environment',
    searchPatterns: ['process.env.FEATURE_', 'FEATURE_FLAG_', 'os.environ.get("FEATURE_'],
    nameExtractor: /(?:process\.env\.|os\.environ\.get\s*\(\s*['"])?(FEATURE_\w+)/,
  },
  // Custom patterns - config objects
  {
    framework: 'custom-config',
    searchPatterns: ['featureFlags.', 'config.features.', 'features.is', 'feature_flags.'],
    nameExtractor: /(?:featureFlags|config\.features|features|feature_flags)\.(\w+)/,
  },
];

/**
 * Detect and audit feature flags across the codebase.
 * Identifies feature flag frameworks in use, extracts flag names and usage locations,
 * and detects potentially stale flags (always true/false, or referenced but not toggled).
 *
 * @param cwd - The working directory to scan.
 * @param options - Optional configuration.
 * @param options.directory - Subdirectory to limit the scan.
 * @param options.fileGlob - Custom glob pattern for files to scan.
 * @returns Feature flag audit results with flags, frameworks, stale flags, and recommendations.
 */
export async function auditFeatureFlags(
  cwd: string,
  options?: { directory?: string; fileGlob?: string },
): Promise<FeatureFlagResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const detectedFrameworks = new Set<string>();
  const flagMap: Record<string, FeatureFlag> = {};

  // 1. Search for feature flag patterns
  for (const fw of FLAG_FRAMEWORK_PATTERNS) {
    for (const pattern of fw.searchPatterns) {
      try {
        const results = await searchCode({
          cwd: dir,
          pattern,
          maxResults: 50,
        });

        if (results.length === 0) continue;
        detectedFrameworks.add(fw.framework);

        for (const result of results) {
          // Skip test files, node_modules, dist
          if (/(node_modules|dist|build|\.test\.|\.spec\.|__test__|__mock__)/i.test(result.file)) continue;

          // Extract flag name
          const nameMatch = result.text.match(fw.nameExtractor);
          if (!nameMatch) continue;

          const flagName = nameMatch[1];
          if (!flagMap[flagName]) {
            flagMap[flagName] = {
              name: flagName,
              framework: fw.framework,
              usages: [],
              isStale: false,
            };
          }

          flagMap[flagName].usages.push({
            file: result.file,
            line: result.line,
            context: result.text.trim().slice(0, 120),
          });
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  // 2. Detect stale flags
  const flags = Object.values(flagMap);
  const staleFlags: FeatureFlag[] = [];

  for (const flag of flags) {
    // Check if flag is always used with a hardcoded value
    const alwaysTrue = flag.usages.every((u) => {
      const ctx = u.context;
      // Pattern: flag is compared to true or set to true
      return /=\s*true\b/.test(ctx) || /true\s*[&|]/.test(ctx);
    });

    const alwaysFalse = flag.usages.every((u) => {
      const ctx = u.context;
      return /=\s*false\b/.test(ctx) || /false\s*[&|]/.test(ctx);
    });

    // Check if flag is only used in one place (likely dead or forgotten)
    const uniqueFiles = new Set(flag.usages.map((u) => u.file));

    if (alwaysTrue) {
      flag.isStale = true;
      flag.staleReason = 'Flag appears to always evaluate to true - can likely be removed and code path made permanent';
      staleFlags.push(flag);
    } else if (alwaysFalse) {
      flag.isStale = true;
      flag.staleReason = 'Flag appears to always evaluate to false - code path may be dead and removable';
      staleFlags.push(flag);
    } else if (uniqueFiles.size === 1 && flag.usages.length === 1) {
      flag.isStale = true;
      flag.staleReason = 'Flag is only referenced once - may be a leftover from a completed rollout';
      staleFlags.push(flag);
    }
  }

  // 3. Also detect flags defined in config/env files that may not be referenced in code
  try {
    const envFiles = await listFiles(dir, { glob: '*.env*', type: 'file' });
    for (const envFile of envFiles.slice(0, 10)) {
      try {
        const absPath = path.resolve(dir, envFile);
        const content = await readFile(absPath, 'utf-8');
        const envLines = content.split('\n');

        for (let i = 0; i < envLines.length; i++) {
          const match = envLines[i].match(/^(FEATURE_\w+)\s*=/);
          if (match) {
            const name = match[1];
            if (!flagMap[name]) {
              // Flag defined in env but not found in code search
              const flag: FeatureFlag = {
                name,
                framework: 'environment',
                usages: [{ file: envFile, line: i + 1, context: envLines[i].trim().slice(0, 120) }],
                isStale: true,
                staleReason: 'Flag defined in environment file but not referenced in source code',
              };
              flagMap[name] = flag;
              flags.push(flag);
              staleFlags.push(flag);
              detectedFrameworks.add('environment');
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* non-fatal */
  }

  // 4. Build recommendations
  const frameworkList = Array.from(detectedFrameworks);
  const recommendations: string[] = [];

  if (flags.length === 0) {
    recommendations.push('No feature flags detected. Consider adopting feature flags for safer deployments and A/B testing.');
  }
  if (staleFlags.length > 0) {
    recommendations.push(`${staleFlags.length} potentially stale flag(s) found - review and remove completed feature flags.`);
  }
  if (frameworkList.length > 1 && !frameworkList.every((f) => f === 'environment' || f === 'custom-config')) {
    recommendations.push(`Multiple feature flag frameworks detected (${frameworkList.join(', ')}) - consider standardizing on one.`);
  }
  if (flags.length > 20) {
    recommendations.push('High number of feature flags - implement a flag lifecycle policy to regularly audit and clean up.');
  }
  if (frameworkList.includes('environment') && !frameworkList.some((f) => ['LaunchDarkly', 'Unleash', 'Split.io', 'Flagsmith', 'ConfigCat'].includes(f))) {
    recommendations.push('Using environment variables for flags limits runtime toggling - consider a dedicated feature flag service.');
  }

  return {
    flags,
    frameworks: frameworkList,
    staleFlags,
    summary: {
      totalFlags: flags.length,
      stale: staleFlags.length,
      frameworks: frameworkList,
    },
    recommendations,
  };
}
