import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { trackTechDebtBurndown, generateCodeAgeHeatmap, analyzeChangePatterns } from '../analyzers/debt-tracking.js';
import { analyzeEnvConfig, analyzeConfigFiles, analyzeDependencyFreshness } from '../analyzers/env-config.js';

/**
 * Registers tech debt tracking and environment/config intelligence tools.
 * Covers debt burndown, code age heatmaps, change patterns, env config,
 * config file intelligence, and dependency freshness.
 * @param server - The MCP server instance to register tools on.
 */
export function registerTrackingTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: tech_debt_burndown — Track tech debt metrics over git history
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'tech_debt_burndown',
    {
      description:
        'Track tech debt metrics over git history: TODO count, long functions, large files, complexity. Shows trend (increasing/stable/decreasing) and worst modules.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        months: z.number().optional().describe('Number of months of history to analyze (default: 6)'),
      },
      outputSchema: outputSchemas.tech_debt_burndown,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const months = params.months || 6;
        const result = await trackTechDebtBurndown(cwd, { months });

        const lines: string[] = [`## Tech Debt Burndown\n`];
        lines.push(`Trend: ${result.trend}`);
        lines.push(`Analysis period: ${months} months\n`);

        if (result.snapshots.length > 0) {
          lines.push('### Debt Over Time');
          for (const snap of result.snapshots) {
            lines.push(`  ${snap.date}: debt score ${snap.totalDebt}`);
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
            snapshots: result.snapshots.map((s) => ({ date: s.date, totalDebt: s.totalDebt })),
            trend: result.trend,
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `tech_debt_burndown failed: ${(error as Error).message}. Ensure the directory is a git repository with commit history to analyze.`,
            },
          ],
          structuredContent: { snapshots: [], trend: 'unknown', summary: {}, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: code_age_heatmap — Overlay file age with complexity and ownership
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'code_age_heatmap',
    {
      description:
        'Overlay file age with complexity and ownership. Old, complex, ownerless code is highest risk. Identifies maintenance hotspots.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        max_files: z.number().optional().describe('Maximum files to analyze (default: 200)'),
      },
      outputSchema: outputSchemas.code_age_heatmap,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const maxFiles = params.max_files || 200;
        const result = await generateCodeAgeHeatmap(cwd, { maxFiles });

        const lines: string[] = [`## Code Age Heatmap\n`];

        if (result.hotspots.length > 0) {
          lines.push('### Highest Risk Files (old + complex + few owners)');
          for (const hotspot of result.hotspots.slice(0, 20)) {
            lines.push(`  ${hotspot.file}: risk score ${hotspot.riskScore}`);
          }
          lines.push('');
        }

        if (result.files.length > 0) {
          lines.push('### File Details');
          for (const f of result.files.slice(0, 30)) {
            lines.push(`  ${f.file}: ${f.ageMonths} months old, risk ${f.riskScore} [${f.riskLevel}]`);
          }
          if (result.files.length > 30) {
            lines.push(`  ... and ${result.files.length - 30} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            files: result.files.map((f) => ({
              file: f.file,
              ageMonths: f.ageMonths,
              riskScore: f.riskScore,
              riskLevel: f.riskLevel,
            })),
            hotspots: result.hotspots.map((h) => ({ file: h.file, riskScore: h.riskScore })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `code_age_heatmap failed: ${(error as Error).message}. Ensure the directory is a git repository with file history.`,
            },
          ],
          structuredContent: { files: [], hotspots: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: change_pattern_analysis — Identify recurring change patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'change_pattern_analysis',
    {
      description:
        'Identify recurring change patterns: logical coupling (files that always change together), churn hotspots, revert patterns, fix-after-change cycles.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        days: z.number().optional().describe('Number of days of history to analyze (default: 90)'),
      },
      outputSchema: outputSchemas.change_pattern_analysis,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const days = params.days || 90;
        const result = await analyzeChangePatterns(cwd, { days });

        const lines: string[] = [`## Change Pattern Analysis\n`];
        lines.push(`Analysis period: ${days} days\n`);

        if (result.patterns.length > 0) {
          lines.push('### Detected Patterns');
          for (const pattern of result.patterns.slice(0, 20)) {
            lines.push(`  [${pattern.type}] (${pattern.significance}) ${pattern.files.join(', ')}`);
          }
          lines.push('');
        }

        if (result.churnHotspots.length > 0) {
          lines.push('### Churn Hotspots (most frequently changed files)');
          for (const hotspot of result.churnHotspots.slice(0, 15)) {
            lines.push(`  ${hotspot.file}: ${hotspot.changes} changes`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            patterns: result.patterns.map((p) => ({
              type: p.type,
              files: p.files,
              significance: p.significance,
            })),
            churnHotspots: result.churnHotspots.map((h) => ({ file: h.file, changes: h.changes })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `change_pattern_analysis failed: ${(error as Error).message}. Ensure the directory is a git repository with sufficient commit history.`,
            },
          ],
          structuredContent: { patterns: [], churnHotspots: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: env_config_analyzer — Map environment variables across the codebase
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'env_config_analyzer',
    {
      description:
        'Map all environment variables across the codebase. Compare across .env files, check .env.example completeness, flag sensitive variables without defaults.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.env_config_analyzer,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeEnvConfig(cwd);

        const lines: string[] = [`## Environment Configuration Analysis\n`];
        lines.push(`Score: ${result.score}/100\n`);

        if (result.envFiles.length > 0) {
          lines.push('### Environment Files');
          for (const f of result.envFiles) {
            const gitignored = f.gitignored ? ' (gitignored)' : ' [NOT gitignored - SECURITY RISK]';
            lines.push(`  ${f.file}${gitignored}`);
          }
          lines.push('');
        }

        if (result.variables.length > 0) {
          lines.push('### Variables');
          for (const v of result.variables.slice(0, 30)) {
            const sensitive = v.isSensitive ? ' [SENSITIVE]' : '';
            lines.push(`  ${v.name}${sensitive}`);
          }
          if (result.variables.length > 30) {
            lines.push(`  ... and ${result.variables.length - 30} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            variables: result.variables.map((v) => ({ name: v.name, isSensitive: v.isSensitive })),
            envFiles: result.envFiles.map((f) => ({ file: f.file, gitignored: f.gitignored })),
            score: result.score,
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `env_config_analyzer failed: ${(error as Error).message}. Ensure the directory contains environment files or source code referencing environment variables.`,
            },
          ],
          structuredContent: { variables: [], envFiles: [], score: 0, summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: config_file_intelligence — Parse and understand all config files
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'config_file_intelligence',
    {
      description:
        'Parse and understand all config files: tsconfig, webpack/vite, eslint, prettier, Docker, K8s, CI. Detect conflicts between configs.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.config_file_intelligence,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeConfigFiles(cwd);

        const lines: string[] = [`## Configuration File Intelligence\n`];

        if (result.configs.length > 0) {
          lines.push('### Config Files');
          for (const config of result.configs) {
            lines.push(`  ${config.file} [${config.type}]: ${config.purpose}`);
          }
          lines.push('');
        }

        if (result.conflicts.length > 0) {
          lines.push('### Detected Conflicts');
          for (const conflict of result.conflicts) {
            lines.push(`  ${conflict.file1} <-> ${conflict.file2}: ${conflict.description}`);
          }
          lines.push('');
        }

        if (result.configs.length === 0) {
          lines.push('No configuration files detected in the directory.');
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            configs: result.configs.map((c) => ({ file: c.file, type: c.type, purpose: c.purpose })),
            conflicts: result.conflicts.map((c) => ({
              file1: c.file1,
              file2: c.file2,
              description: c.description,
            })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `config_file_intelligence failed: ${(error as Error).message}. Ensure the directory contains configuration files to analyze.`,
            },
          ],
          structuredContent: { configs: [], conflicts: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: dependency_freshness — Score dependency freshness
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'dependency_freshness',
    {
      description:
        'Score dependency freshness: compare installed versions against latest, flag deprecated and vulnerable packages, calculate overall freshness grade.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.dependency_freshness,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeDependencyFreshness(cwd);

        const lines: string[] = [`## Dependency Freshness\n`];
        lines.push(`Overall Score: ${result.overallScore}/100 [${result.grade}]\n`);

        if (result.dependencies.length > 0) {
          lines.push('### Dependencies');
          for (const dep of result.dependencies.slice(0, 30)) {
            const freshness = dep.freshnessScore >= 80 ? 'fresh' : dep.freshnessScore >= 50 ? 'aging' : 'stale';
            lines.push(`  ${dep.name}@${dep.currentVersion}: ${dep.freshnessScore}/100 (${freshness})`);
          }
          if (result.dependencies.length > 30) {
            lines.push(`  ... and ${result.dependencies.length - 30} more`);
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
            dependencies: result.dependencies.map((d) => ({
              name: d.name,
              currentVersion: d.currentVersion,
              freshnessScore: d.freshnessScore,
            })),
            overallScore: result.overallScore,
            grade: result.grade,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `dependency_freshness failed: ${(error as Error).message}. Ensure the directory contains a package.json or equivalent dependency manifest.`,
            },
          ],
          structuredContent: { dependencies: [], overallScore: 0, grade: 'F', recommendations: [] },
        };
      }
    },
  );
}
