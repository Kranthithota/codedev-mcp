import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { detectNPlusOneQueries, analyzeAsyncPatterns, analyzeBundleComposition, detectMemoryLeakPatterns } from '../analyzers/perf-patterns.js';
import { auditObservability, analyzeErrorHandling, analyzeLoggingConsistency, auditFeatureFlags } from '../analyzers/observability.js';

/**
 * Registers performance and observability tools for N+1 detection, async analysis,
 * bundle analysis, memory leaks, observability audits, error handling, logging, and feature flags.
 * @param server - The MCP server instance to register tools on.
 */
export function registerPatternTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: n_plus_one_detect — Detect N+1 query patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'n_plus_one_detect',
    {
      description:
        'Detect N+1 query patterns in ORM usage (Prisma, TypeORM, Sequelize, Django, ActiveRecord). Finds database queries inside loops and suggests batch alternatives.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        file_glob: z.string().optional().describe('File pattern to analyze, e.g. "**/*.ts"'),
      },
      outputSchema: outputSchemas.n_plus_one_detect,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await detectNPlusOneQueries(cwd, {
          directory: params.directory,
          fileGlob: params.file_glob,
        });

        const lines: string[] = [`## N+1 Query Detection\n`];
        lines.push(`Found ${result.summary.total} potential N+1 query pattern(s)\n`);

        if (Object.keys(result.summary.byOrm).length > 0) {
          lines.push('### By ORM');
          for (const [orm, count] of Object.entries(result.summary.byOrm)) {
            lines.push(`  ${orm}: ${count} pattern(s)`);
          }
          lines.push('');
        }

        if (result.patterns.length > 0) {
          lines.push('### Patterns');
          for (const p of result.patterns.slice(0, 30)) {
            const icon = p.severity === 'error' ? '[ERROR]' : '[WARN]';
            lines.push(`  ${icon} ${p.file}:${p.line} — ${p.ormMethod} query inside ${p.loopType}`);
            lines.push(`    Context: ${p.context}`);
            lines.push(`    Suggestion: ${p.suggestion}`);
          }
          if (result.patterns.length > 30) {
            lines.push(`  ... and ${result.patterns.length - 30} more`);
          }
        }

        if (result.recommendations.length > 0) {
          lines.push('\n### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            patterns: result.patterns.map((p) => ({
              file: p.file,
              line: p.line,
              ormMethod: p.ormMethod,
              suggestion: p.suggestion,
            })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `n_plus_one_detect failed: ${(error as Error).message}. Ensure the directory contains source files with ORM usage to analyze.`,
            },
          ],
          structuredContent: { patterns: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: async_pattern_analysis — Find async anti-patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'async_pattern_analysis',
    {
      description:
        'Find async anti-patterns: sequential awaits that could be parallelized, missing error handling on promises, dangling promises, callback/promise mixing.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.async_pattern_analysis,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeAsyncPatterns(cwd, { directory: params.directory });

        const lines: string[] = [`## Async Pattern Analysis\n`];
        lines.push(`Score: ${result.score}/100`);
        lines.push(`Total anti-patterns: ${result.summary.total}\n`);

        if (Object.keys(result.summary.byPattern).length > 0) {
          lines.push('### By Pattern');
          for (const [pattern, count] of Object.entries(result.summary.byPattern)) {
            lines.push(`  ${pattern}: ${count}`);
          }
          lines.push('');
        }

        if (result.antiPatterns.length > 0) {
          lines.push('### Issues');
          for (const ap of result.antiPatterns.slice(0, 30)) {
            const icon = ap.severity === 'error' ? '[ERROR]' : ap.severity === 'warning' ? '[WARN]' : '[INFO]';
            lines.push(`  ${icon} ${ap.file}:${ap.line} [${ap.pattern}] ${ap.description}`);
            lines.push(`    Suggestion: ${ap.suggestion}`);
          }
          if (result.antiPatterns.length > 30) {
            lines.push(`  ... and ${result.antiPatterns.length - 30} more`);
          }
        }

        if (result.recommendations.length > 0) {
          lines.push('\n### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            antiPatterns: result.antiPatterns.map((ap) => ({
              file: ap.file,
              line: ap.line,
              pattern: ap.pattern,
              severity: ap.severity,
            })),
            score: result.score,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `async_pattern_analysis failed: ${(error as Error).message}. Ensure the directory contains JavaScript/TypeScript files with async code.`,
            },
          ],
          structuredContent: { antiPatterns: [], score: 0, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: bundle_analysis — Analyze JavaScript bundle composition
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'bundle_analysis',
    {
      description:
        'Analyze JavaScript bundle composition: large dependencies, tree-shaking opportunities, dynamic import candidates, duplicate packages in lockfile.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.bundle_analysis,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeBundleComposition(cwd, { directory: params.directory });

        const lines: string[] = [`## Bundle Analysis\n`];
        lines.push(`Total dependencies: ${result.summary.totalDeps}`);
        lines.push(`Large dependencies (>100KB): ${result.summary.largeDeps}`);
        lines.push(`Tree-shaking opportunities: ${result.summary.treeShakeOps}`);
        lines.push(`Duplicate packages: ${result.summary.duplicates}`);
        lines.push(`Estimated total size: ${result.summary.estimatedTotalSize}\n`);

        if (result.dependencies.length > 0) {
          lines.push('### Dependencies (by size)');
          for (const dep of result.dependencies.slice(0, 20)) {
            const suggestion = dep.suggestion ? ` — ${dep.suggestion}` : '';
            lines.push(`  ${dep.name}@${dep.version}: ${dep.estimatedSize} (imported by ${dep.importedBy.length} files)${suggestion}`);
          }
          lines.push('');
        }

        if (result.treeShakingOpportunities.length > 0) {
          lines.push('### Tree-Shaking Opportunities');
          for (const op of result.treeShakingOpportunities.slice(0, 10)) {
            lines.push(`  ${op.file}:${op.line} — ${op.suggestion}`);
          }
          lines.push('');
        }

        if (result.recommendations.length > 0) {
          lines.push('### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            dependencies: result.dependencies.map((d) => ({ name: d.name, estimatedSize: d.estimatedSize })),
            treeShakingOpportunities: result.treeShakingOpportunities.map((o) => ({
              file: o.file,
              suggestion: o.suggestion,
            })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `bundle_analysis failed: ${(error as Error).message}. Ensure the directory contains a package.json with dependencies.`,
            },
          ],
          structuredContent: { dependencies: [], treeShakingOpportunities: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: memory_leak_patterns — Detect memory leak patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'memory_leak_patterns',
    {
      description:
        'Detect common memory leak patterns: unbounded collections, event listener accumulation, timer leaks without cleanup, unclosed resources.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.memory_leak_patterns,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await detectMemoryLeakPatterns(cwd, { directory: params.directory });

        const lines: string[] = [`## Memory Leak Pattern Detection\n`];
        lines.push(`Score: ${result.score}/100`);
        lines.push(`Total patterns found: ${result.summary.total}\n`);

        if (Object.keys(result.summary.byType).length > 0) {
          lines.push('### By Type');
          for (const [type, count] of Object.entries(result.summary.byType)) {
            lines.push(`  ${type}: ${count}`);
          }
          lines.push('');
        }

        if (result.patterns.length > 0) {
          lines.push('### Detected Patterns');
          for (const p of result.patterns.slice(0, 30)) {
            const icon = p.severity === 'error' ? '[ERROR]' : p.severity === 'warning' ? '[WARN]' : '[INFO]';
            lines.push(`  ${icon} ${p.file}:${p.line} [${p.type}] ${p.description}`);
            lines.push(`    Code: ${p.code}`);
            lines.push(`    Fix: ${p.suggestion}`);
          }
          if (result.patterns.length > 30) {
            lines.push(`  ... and ${result.patterns.length - 30} more`);
          }
        }

        if (result.recommendations.length > 0) {
          lines.push('\n### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            patterns: result.patterns.map((p) => ({
              file: p.file,
              line: p.line,
              type: p.type,
              severity: p.severity,
            })),
            score: result.score,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `memory_leak_patterns failed: ${(error as Error).message}. Ensure the directory contains source files to analyze for memory leak patterns.`,
            },
          ],
          structuredContent: { patterns: [], score: 0, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: observability_audit — Check observability readiness
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'observability_audit',
    {
      description:
        'Check codebase for observability readiness: logging frameworks, metrics libraries, tracing instrumentation, and blind spots in critical paths.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.observability_audit,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await auditObservability(cwd);

        const lines: string[] = [`## Observability Audit\n`];
        lines.push(`Score: ${result.score}/100 [${result.grade}]\n`);

        if (result.findings.length > 0) {
          lines.push('### Findings');
          for (const f of result.findings) {
            const icon = f.status === 'present' ? '[PASS]' : f.status === 'missing' ? '[FAIL]' : '[WARN]';
            lines.push(`  ${icon} [${f.category}] ${f.details}`);
          }
          lines.push('');
        }

        if (result.recommendations.length > 0) {
          lines.push('### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            findings: result.findings.map((f) => ({
              category: f.category,
              status: f.status,
              details: f.details,
            })),
            score: result.score,
            grade: result.grade,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `observability_audit failed: ${(error as Error).message}. Ensure the directory contains a project with observable components to audit.`,
            },
          ],
          structuredContent: { findings: [], score: 0, grade: 'F', recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: error_handling_analysis — Map error handling patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'error_handling_analysis',
    {
      description:
        'Map error handling patterns: swallowed errors, inconsistent error types, missing handlers on async operations, string throws instead of Error objects.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.error_handling_analysis,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeErrorHandling(cwd);

        const lines: string[] = [`## Error Handling Analysis\n`];
        lines.push(`Score: ${result.score}/100 [${result.grade}]`);
        lines.push(`Total issues: ${result.issues.length}\n`);

        if (result.issues.length > 0) {
          lines.push('### Issues');
          for (const issue of result.issues.slice(0, 30)) {
            const icon = issue.severity === 'error' ? '[ERROR]' : issue.severity === 'warning' ? '[WARN]' : '[INFO]';
            lines.push(`  ${icon} ${issue.file}:${issue.line} [${issue.type}]`);
          }
          if (result.issues.length > 30) {
            lines.push(`  ... and ${result.issues.length - 30} more`);
          }
        }

        if (result.recommendations.length > 0) {
          lines.push('\n### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            issues: result.issues.map((i) => ({
              file: i.file,
              line: i.line,
              type: i.type,
              severity: i.severity,
            })),
            score: result.score,
            grade: result.grade,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `error_handling_analysis failed: ${(error as Error).message}. Ensure the directory contains source files with error handling logic to analyze.`,
            },
          ],
          structuredContent: { issues: [], score: 0, grade: 'F', recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: logging_consistency — Analyze logging patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'logging_consistency',
    {
      description:
        'Analyze logging patterns: structured vs unstructured, PII leaks in log statements, log level consistency, request correlation propagation.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.logging_consistency,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeLoggingConsistency(cwd);

        const lines: string[] = [`## Logging Consistency Analysis\n`];
        lines.push(`Score: ${result.score}/100 [${result.grade}]`);
        lines.push(`Logging framework: ${result.framework || 'not detected'}\n`);

        if (result.issues.length > 0) {
          lines.push('### Issues');
          for (const issue of result.issues.slice(0, 30)) {
            const icon = issue.severity === 'error' ? '[ERROR]' : issue.severity === 'warning' ? '[WARN]' : '[INFO]';
            lines.push(`  ${icon} ${issue.file}:${issue.line} [${issue.type}]`);
          }
          if (result.issues.length > 30) {
            lines.push(`  ... and ${result.issues.length - 30} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            issues: result.issues.map((i) => ({
              file: i.file,
              line: i.line,
              type: i.type,
              severity: i.severity,
            })),
            framework: result.framework,
            score: result.score,
            grade: result.grade,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `logging_consistency failed: ${(error as Error).message}. Ensure the directory contains source files with logging statements to analyze.`,
            },
          ],
          structuredContent: { issues: [], framework: 'unknown', score: 0, grade: 'F' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: feature_flag_audit — Detect and audit feature flags
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'feature_flag_audit',
    {
      description:
        'Detect and audit feature flags: LaunchDarkly, Unleash, custom implementations. Find stale flags, map conditional code paths, list all flag names.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.feature_flag_audit,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await auditFeatureFlags(cwd);

        const lines: string[] = [`## Feature Flag Audit\n`];

        if (result.flags.length === 0) {
          lines.push('No feature flags detected in the codebase.');
        } else {
          lines.push(`Found ${result.flags.length} feature flag(s)\n`);

          lines.push('### Flags');
          for (const flag of result.flags.slice(0, 30)) {
            const staleLabel = flag.isStale ? ' [STALE]' : '';
            lines.push(`  ${flag.name} (${flag.framework})${staleLabel}`);
          }
          if (result.flags.length > 30) {
            lines.push(`  ... and ${result.flags.length - 30} more`);
          }
        }

        if (result.recommendations.length > 0) {
          lines.push('\n### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            flags: result.flags.map((f) => ({ name: f.name, framework: f.framework, isStale: f.isStale })),
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `feature_flag_audit failed: ${(error as Error).message}. Ensure the directory contains source files that may use feature flags.`,
            },
          ],
          structuredContent: { flags: [], summary: {}, recommendations: [] },
        };
      }
    },
  );
}
