import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { generateReviewContext, calculateReviewRiskScore, detectBreakingChanges } from '../analyzers/pr-review.js';

/**
 * Registers PR review intelligence tools for review context, risk scoring, and breaking change detection.
 * @param server - The MCP server instance to register tools on.
 */
export function registerReviewTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: pr_review_context — Structured PR review context package
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'pr_review_context',
    {
      description:
        'Generate a structured PR review context package. Collects commits, changed files with risk assessment, blast radius, and focus areas between two git refs. Essential for understanding what a PR changes and where to focus review effort.',
      inputSchema: {
        base: z.string().describe('Base git ref (branch or commit SHA) to compare against'),
        compare: z.string().optional().describe('Comparison git ref (default: HEAD)'),
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.pr_review_context,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const compare = params.compare || 'HEAD';
        const result = await generateReviewContext(cwd, params.base, compare);

        // Format readable summary
        const lines: string[] = [`## PR Review Context: ${params.base}...${compare}\n`];

        // Summary section
        const s = result.summary;
        lines.push(`### Summary`);
        lines.push(`  Commits: ${s.totalCommits} | Files changed: ${s.totalFilesChanged} | +${s.insertions} -${s.deletions}`);
        if (Object.keys(s.categories).length > 0) {
          lines.push(`  Categories: ${Object.entries(s.categories).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
        }
        lines.push('');

        // Commits section
        if (result.commits.length > 0) {
          lines.push(`### Commits (${result.commits.length})`);
          for (const c of result.commits.slice(0, 20)) {
            lines.push(`  ${c.hash} ${c.author} — ${c.message}`);
          }
          if (result.commits.length > 20) {
            lines.push(`  ... and ${result.commits.length - 20} more`);
          }
          lines.push('');
        }

        // Changed files section
        if (result.changedFiles.length > 0) {
          lines.push(`### Changed Files (${result.changedFiles.length})`);
          for (const f of result.changedFiles.slice(0, 30)) {
            const riskIcon = f.riskLevel === 'critical' ? '🔴' : f.riskLevel === 'high' ? '🟠' : f.riskLevel === 'medium' ? '🟡' : '🟢';
            lines.push(`  ${riskIcon} [${f.riskLevel.toUpperCase()}] ${f.file} (${f.status}) +${f.insertions} -${f.deletions}`);
            if (f.riskReasons.length > 0) {
              lines.push(`     Reasons: ${f.riskReasons.join('; ')}`);
            }
          }
          if (result.changedFiles.length > 30) {
            lines.push(`  ... and ${result.changedFiles.length - 30} more files`);
          }
          lines.push('');
        }

        // Blast radius section
        if (result.blastRadius.length > 0) {
          lines.push(`### Blast Radius`);
          for (const b of result.blastRadius.slice(0, 15)) {
            lines.push(`  ${b.file} — ${b.dependents.length} dependent(s): ${b.dependents.slice(0, 5).join(', ')}${b.dependents.length > 5 ? '...' : ''}`);
          }
          lines.push('');
        }

        // Focus areas section
        if (result.reviewFocusAreas.length > 0) {
          lines.push(`### Review Focus Areas`);
          for (const area of result.reviewFocusAreas) {
            lines.push(`  * ${area}`);
          }
          lines.push('');
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            summary: result.summary,
            commits: result.commits.map((c) => ({ hash: c.hash, message: c.message, author: c.author })),
            changedFiles: result.changedFiles.map((f) => ({ file: f.file, status: f.status, riskLevel: f.riskLevel })),
            reviewFocusAreas: result.reviewFocusAreas,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `pr_review_context failed: ${(error as Error).message}. Verify that the base ref "${params.base}" exists in the git repository. Use git_history to check available branches and commits.`,
            },
          ],
          structuredContent: { summary: {}, commits: [], changedFiles: [], reviewFocusAreas: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: review_risk_score — Multi-dimensional risk score for a changeset
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'review_risk_score',
    {
      description:
        'Calculate a multi-dimensional risk score (0-100) for a changeset. Evaluates complexity, test coverage gaps, blast radius, security sensitivity, and code churn. Returns a letter grade (A-F), per-dimension breakdown, and actionable recommendations.',
      inputSchema: {
        base: z.string().describe('Base git ref (branch or commit SHA) to compare against'),
        compare: z.string().optional().describe('Comparison git ref (default: HEAD)'),
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.review_risk_score,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const compare = params.compare || 'HEAD';
        const result = await calculateReviewRiskScore(cwd, params.base, compare);

        // Format as score card
        const lines: string[] = [`## Review Risk Score: ${result.overallScore}/100 [${result.grade}]\n`];

        // Score bar
        const barFull = Math.round(result.overallScore / 5);
        const bar = '█'.repeat(barFull) + '░'.repeat(20 - barFull);
        lines.push(`  [${bar}] ${result.overallScore}%\n`);

        // Risk level description
        const riskDesc = result.overallScore <= 20 ? 'Low risk — standard review'
          : result.overallScore <= 40 ? 'Moderate risk — careful review recommended'
          : result.overallScore <= 60 ? 'Elevated risk — thorough review required'
          : result.overallScore <= 80 ? 'High risk — consider splitting PR'
          : 'Critical risk — extensive review and testing mandatory';
        lines.push(`  ${riskDesc}\n`);

        // Dimension breakdown
        lines.push(`### Dimension Breakdown`);
        for (const d of result.dimensions) {
          const icon = d.score <= 20 ? '🟢' : d.score <= 50 ? '🟡' : '🔴';
          lines.push(`  ${icon} ${d.name}: ${d.score}/100 (weight: ${Math.round(d.weight * 100)}%)`);
          lines.push(`     ${d.details}`);
        }
        lines.push('');

        // Recommendations
        if (result.recommendations.length > 0) {
          lines.push(`### Recommendations`);
          for (const rec of result.recommendations) {
            lines.push(`  * ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            overallScore: result.overallScore,
            grade: result.grade,
            dimensions: result.dimensions.map((d) => ({ name: d.name, score: d.score, weight: d.weight })),
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `review_risk_score failed: ${(error as Error).message}. Verify that the base ref "${params.base}" exists. Use pr_review_context first to confirm the changeset is valid.`,
            },
          ],
          structuredContent: { overallScore: 0, grade: 'F', dimensions: [], recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: breaking_change_detect — Detect breaking changes in a changeset
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'breaking_change_detect',
    {
      description:
        'Detect breaking changes between two git refs. Analyzes diffs for removed exports, changed function signatures, removed database fields, changed API routes, removed environment variables, and changed config keys. Lists affected consumers.',
      inputSchema: {
        base: z.string().describe('Base git ref (branch or commit SHA) to compare against'),
        compare: z.string().optional().describe('Comparison git ref (default: HEAD)'),
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.breaking_change_detect,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const compare = params.compare || 'HEAD';
        const result = await detectBreakingChanges(cwd, params.base, compare);

        const lines: string[] = [`## Breaking Change Detection: ${params.base}...${compare}\n`];

        // Summary
        const s = result.summary;
        lines.push(`Total: ${s.total} breaking change(s) — ${s.errors} error(s), ${s.warnings} warning(s)`);
        if (Object.keys(s.byType).length > 0) {
          lines.push(`By type: ${Object.entries(s.byType).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
        }
        lines.push('');

        if (result.breakingChanges.length === 0) {
          lines.push('No breaking changes detected.');
        } else {
          lines.push(`### Breaking Changes`);
          for (const bc of result.breakingChanges.slice(0, 30)) {
            const icon = bc.severity === 'error' ? '🔴' : '🟡';
            lines.push(`  ${icon} [${bc.severity.toUpperCase()}] ${bc.type}`);
            lines.push(`     ${bc.file}:${bc.line} — ${bc.description}`);
            lines.push(`     Before: ${bc.before}`);
            if (bc.after) {
              lines.push(`     After:  ${bc.after}`);
            }
            lines.push('');
          }
          if (result.breakingChanges.length > 30) {
            lines.push(`  ... and ${result.breakingChanges.length - 30} more\n`);
          }
        }

        // Affected consumers
        if (result.affectedConsumers.length > 0) {
          lines.push(`### Affected Consumers (${result.affectedConsumers.length})`);
          for (const c of result.affectedConsumers.slice(0, 20)) {
            lines.push(`  ${c.file} — ${c.usage}`);
          }
          if (result.affectedConsumers.length > 20) {
            lines.push(`  ... and ${result.affectedConsumers.length - 20} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            breakingChanges: result.breakingChanges.map((bc) => ({
              file: bc.file,
              type: bc.type,
              severity: bc.severity,
              description: bc.description,
            })),
            summary: { total: s.total, errors: s.errors, warnings: s.warnings },
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `breaking_change_detect failed: ${(error as Error).message}. Verify that the base ref "${params.base}" exists. Use pr_review_context to validate the changeset first.`,
            },
          ],
          structuredContent: { breakingChanges: [], summary: { total: 0, errors: 0, warnings: 0 } },
        };
      }
    },
  );
}
