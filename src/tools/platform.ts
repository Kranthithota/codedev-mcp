import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { listPresets, getPreset, listWorkflows, getWorkflow } from '../utils/presets.js';
import { analyzeCrossRepoImpact, detectContractDrift, buildDependencyImpactMatrix } from '../analyzers/cross-repo.js';
import { detectArchitectureDrift, trackMigrations, analyzeAuthFlows } from '../analyzers/arch-enforcement.js';

/**
 * Registers platform tools: MCP-native preset/workflow features and
 * cross-repo/architecture enforcement tools including contract drift,
 * dependency impact matrices, architecture drift, migration tracking,
 * and auth flow analysis.
 * @param server - The MCP server instance to register tools on.
 */
export function registerPlatformTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: tool_presets — List available tool presets and workflows
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'tool_presets',
    {
      description:
        'List available tool presets (workflow-optimized tool subsets) and composite workflows. Presets reduce context waste by loading only relevant tools for a task.',
      inputSchema: {
        preset: z.string().optional().describe("Preset name to get details for (e.g. 'review', 'security'). If omitted, lists all presets."),
        workflow: z.string().optional().describe("Workflow name to get details for (e.g. 'pre_commit_check'). If omitted, lists all workflows."),
      },
      outputSchema: outputSchemas.tool_presets,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        // If a specific preset is requested
        if (params.preset) {
          const preset = getPreset(params.preset);
          if (!preset) {
            const available = listPresets().map((p) => p.name).join(', ');
            return {
              content: [{ type: 'text', text: `Preset '${params.preset}' not found. Available presets: ${available}` }],
              structuredContent: { presets: [], workflows: [] },
            };
          }
          const lines: string[] = [
            `## Preset: ${preset.name}\n`,
            preset.description,
            `\n### Tools (${preset.tools.length})`,
            ...preset.tools.map((t) => `  - ${t}`),
            `\n### Suggested Order`,
            ...preset.suggestedOrder.map((t, i) => `  ${i + 1}. ${t}`),
          ];
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              presets: [{ name: params.preset, description: preset.description, tools: preset.tools }],
              workflows: [],
            },
          };
        }

        // If a specific workflow is requested
        if (params.workflow) {
          const workflow = getWorkflow(params.workflow);
          if (!workflow) {
            const available = listWorkflows().map((w) => w.name).join(', ');
            return {
              content: [{ type: 'text', text: `Workflow '${params.workflow}' not found. Available workflows: ${available}` }],
              structuredContent: { presets: [], workflows: [] },
            };
          }
          const lines: string[] = [
            `## Workflow: ${workflow.name}\n`,
            workflow.description,
            `\n### Steps (${workflow.steps.length})`,
            ...workflow.steps.map((s, i) => `  ${i + 1}. ${s.tool}`),
          ];
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              presets: [],
              workflows: [{ name: params.workflow, description: workflow.description, steps: workflow.steps }],
            },
          };
        }

        // List all presets and workflows
        const presets = listPresets();
        const workflows = listWorkflows();

        const lines: string[] = [`## Tool Presets & Workflows\n`];

        lines.push('### Presets');
        for (const p of presets) {
          lines.push(`  **${p.name}**: ${p.description} (${p.toolCount} tools)`);
        }
        lines.push('');

        lines.push('### Composite Workflows');
        for (const w of workflows) {
          lines.push(`  **${w.name}**: ${w.description} (${w.stepCount} steps)`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            presets: presets.map((p) => ({ name: p.name, description: p.description, toolCount: p.toolCount })),
            workflows: workflows.map((w) => ({ name: w.name, description: w.description, stepCount: w.stepCount })),
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `tool_presets failed: ${(error as Error).message}. This is an internal error retrieving preset definitions.`,
            },
          ],
          structuredContent: { presets: [], workflows: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: composite_workflow — Run a pre-defined composite workflow
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'composite_workflow',
    {
      description:
        'Run a pre-defined composite workflow that executes multiple analyses in sequence. Available: pre_commit_check, full_health_audit, pr_readiness, dependency_audit, onboarding_pack, production_readiness.',
      inputSchema: {
        workflow: z.string().describe("Workflow name: 'pre_commit_check', 'full_health_audit', 'pr_readiness', 'dependency_audit', 'onboarding_pack', 'production_readiness'"),
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        base: z.string().optional().describe("Base branch for PR workflows (e.g. 'main')"),
      },
      outputSchema: outputSchemas.composite_workflow,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const workflow = getWorkflow(params.workflow);
        if (!workflow) {
          const available = listWorkflows().map((w) => w.name).join(', ');
          return {
            content: [
              {
                type: 'text',
                text: `Workflow '${params.workflow}' not found. Available workflows: ${available}`,
              },
            ],
            structuredContent: { workflow: params.workflow, steps: [], summary: '' },
          };
        }

        const steps = workflow.steps.map((step) => {
          const stepParams = { ...step.params };
          if (params.directory) stepParams.directory = params.directory;
          if (params.base) stepParams.base = params.base;
          return { tool: step.tool, params: stepParams };
        });

        const lines: string[] = [
          `## Composite Workflow: ${workflow.name}\n`,
          workflow.description,
          '',
          `This workflow consists of ${steps.length} steps. Execute each tool in order:\n`,
        ];

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const paramsStr = Object.keys(step.params).length > 0 ? ` with params: ${JSON.stringify(step.params)}` : '';
          lines.push(`  ${i + 1}. **${step.tool}**${paramsStr}`);
        }

        lines.push('\nNote: This tool returns the workflow definition and suggested execution order.');
        lines.push('Execute each tool sequentially to complete the workflow.');

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            workflow: params.workflow,
            name: workflow.name,
            description: workflow.description,
            steps,
            summary: `Workflow '${workflow.name}' has ${steps.length} steps. Execute each tool in the listed order.`,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `composite_workflow failed: ${(error as Error).message}. This is an internal error retrieving workflow definitions.`,
            },
          ],
          structuredContent: { workflow: params.workflow, steps: [], summary: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: cross_repo_impact — Analyze cross-package change impact
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'cross_repo_impact',
    {
      description:
        'Analyze how changes in one package affect consumers across a monorepo. Traces dependency graph to identify affected packages and risk levels.',
      inputSchema: {
        changed_files: z.array(z.string()).describe('Array of changed file paths (relative to project root)'),
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.cross_repo_impact,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeCrossRepoImpact(cwd, params.changed_files);

        const lines: string[] = [`## Cross-Repo Impact Analysis\n`];
        lines.push(`Total packages: ${result.summary.totalPackages}`);
        lines.push(`Affected packages: ${result.summary.affectedPackages}`);
        lines.push(`High-risk changes: ${result.summary.highRiskChanges}`);
        lines.push(`Public API changes: ${result.summary.publicAPIChanges}\n`);

        if (result.impacts.length > 0) {
          lines.push('### Impact Details');
          for (const impact of result.impacts.slice(0, 20)) {
            const apiLabel = impact.isPublicAPI ? ' [PUBLIC API]' : '';
            lines.push(`  ${impact.changedFile} (${impact.changedPackage})${apiLabel}`);
            for (const affected of impact.affectedPackages) {
              lines.push(`    -> ${affected.name} [${affected.dependencyType}] risk: ${affected.riskLevel}`);
            }
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
            impacts: result.impacts.map((i) => ({
              changedPackage: i.changedPackage,
              changedFile: i.changedFile,
              isPublicAPI: i.isPublicAPI,
              affectedPackages: i.affectedPackages,
            })),
            dependencyGraph: result.dependencyGraph,
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `cross_repo_impact failed: ${(error as Error).message}. Ensure the directory is a monorepo or workspace with multiple packages.`,
            },
          ],
          structuredContent: { impacts: [], dependencyGraph: [], summary: {}, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: contract_drift — Compare API contracts vs implementations
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'contract_drift',
    {
      description:
        'Compare API contracts (OpenAPI, GraphQL, gRPC) between declared specs and actual implementations. Find undocumented endpoints and unimplemented specs.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.contract_drift,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await detectContractDrift(cwd);

        const lines: string[] = [`## Contract Drift Analysis\n`];
        lines.push(`Total endpoints: ${result.summary.totalEndpoints}`);
        lines.push(`Documented: ${result.summary.documented} | Implemented: ${result.summary.implemented}`);
        lines.push(`Drifts detected: ${result.summary.drifts}\n`);

        if (result.contracts.length > 0) {
          lines.push('### Contracts Found');
          for (const contract of result.contracts) {
            lines.push(`  ${contract.file} [${contract.type}]: ${contract.endpointCount} endpoints`);
          }
          lines.push('');
        }

        if (result.drifts.length > 0) {
          lines.push('### Drifts');
          for (const drift of result.drifts.slice(0, 30)) {
            const icon = drift.severity === 'error' ? '[ERROR]' : drift.severity === 'warning' ? '[WARN]' : '[INFO]';
            lines.push(`  ${icon} [${drift.status}] ${drift.method || ''} ${drift.endpoint}`);
            lines.push(`    ${drift.details}`);
          }
          if (result.drifts.length > 30) {
            lines.push(`  ... and ${result.drifts.length - 30} more`);
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
            drifts: result.drifts.map((d) => ({
              type: d.type,
              endpoint: d.endpoint,
              status: d.status,
              severity: d.severity,
            })),
            contracts: result.contracts,
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `contract_drift failed: ${(error as Error).message}. Ensure the directory contains API contract files (OpenAPI, GraphQL schemas, or Proto files).`,
            },
          ],
          structuredContent: { drifts: [], contracts: [], summary: {}, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: dependency_impact_matrix — Build risk-scored dependency matrix
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'dependency_impact_matrix',
    {
      description:
        'Build a risk-scored matrix of package dependencies. Combines coupling depth, change frequency, and test coverage to identify high-risk dependency chains.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.dependency_impact_matrix,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await buildDependencyImpactMatrix(cwd);

        const lines: string[] = [`## Dependency Impact Matrix\n`];
        lines.push(`Total packages: ${result.summary.totalPackages}`);
        lines.push(`High-risk packages: ${result.summary.highRisk}`);
        lines.push(`Average coupling depth: ${result.summary.avgCoupling}`);
        lines.push(`Maximum coupling depth: ${result.summary.maxCoupling}\n`);

        if (result.hotspots.length > 0) {
          lines.push('### Hotspots (highest risk)');
          for (const hotspot of result.hotspots) {
            lines.push(`  ${hotspot}`);
          }
          lines.push('');
        }

        if (result.packages.length > 0) {
          lines.push('### Package Risk Scores');
          for (const pkg of result.packages.slice(0, 20)) {
            lines.push(
              `  ${pkg.package}: ${pkg.riskScore}/100 [${pkg.riskLevel}] (${pkg.consumers.length} consumers, depth ${pkg.couplingDepth}, tests: ${pkg.hasTests ? 'yes' : 'no'})`,
            );
          }
          if (result.packages.length > 20) {
            lines.push(`  ... and ${result.packages.length - 20} more`);
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
            packages: result.packages.map((p) => ({
              package: p.package,
              riskScore: p.riskScore,
              riskLevel: p.riskLevel,
            })),
            hotspots: result.hotspots,
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `dependency_impact_matrix failed: ${(error as Error).message}. Ensure the directory is a monorepo or workspace with multiple packages.`,
            },
          ],
          structuredContent: { packages: [], hotspots: [], summary: {}, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: architecture_drift — Compare actual vs declared architecture
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'architecture_drift',
    {
      description:
        'Compare actual dependency graph against declared architecture. Detect layer violations, boundary crosses, and abstraction bypasses.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.architecture_drift,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await detectArchitectureDrift(cwd);

        const lines: string[] = [`## Architecture Drift Detection\n`];
        lines.push(`Architecture: ${result.declaredArchitecture}`);
        lines.push(`Layers: ${result.summary.layerCount} | Violations: ${result.summary.totalViolations} | Worst: ${result.summary.worstLayer || 'none'}\n`);

        if (result.layers.length > 0) {
          lines.push('### Layers');
          for (const l of result.layers) {
            lines.push(`  ${l.name} — ${l.files} files, ${l.inbound} inbound, ${l.outbound} outbound`);
          }
          lines.push('');
        }

        if (result.violations.length > 0) {
          lines.push('### Violations');
          for (const v of result.violations.slice(0, 30)) {
            const icon = v.severity === 'error' ? '[ERROR]' : '[WARN]';
            lines.push(`  ${icon} [${v.type}] ${v.from.file} (${v.from.layer}) -> ${v.to.file} (${v.to.layer})`);
            lines.push(`    ${v.description}`);
          }
          if (result.violations.length > 30) {
            lines.push(`  ... and ${result.violations.length - 30} more`);
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
            violations: result.violations.map((v) => ({
              from: { file: v.from.file, layer: v.from.layer },
              to: { file: v.to.file, layer: v.to.layer },
              type: v.type,
              severity: v.severity,
            })),
            layers: result.layers.map((l) => ({ name: l.name, files: l.files })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `architecture_drift failed: ${(error as Error).message}. Ensure the directory contains a layered project structure with recognizable boundaries.`,
            },
          ],
          structuredContent: { violations: [], layers: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: migration_tracker — Detect in-progress code migrations
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'migration_tracker',
    {
      description:
        'Detect in-progress code migrations: CommonJS->ESM, class->functional components, callbacks->async/await, var->let/const. Shows completion percentage.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.migration_tracker,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await trackMigrations(cwd);

        const lines: string[] = [`## Migration Tracker\n`];

        if (result.migrations.length === 0) {
          lines.push('No active migrations detected.');
        } else {
          lines.push(`Found ${result.migrations.length} migration(s):\n`);
          for (const m of result.migrations) {
            lines.push(`  **${m.name}**: ${m.completionPercent.toFixed(1)}% complete [${m.status}]`);
            lines.push(`    Old usages: ${m.oldUsages.length} | New usages: ${m.newUsages.length}`);
            if (m.oldUsages.length > 0) {
              const remaining = m.oldUsages.slice(0, 5).map((u) => u.file);
              lines.push(`    Remaining: ${remaining.join(', ')}${m.oldUsages.length > 5 ? ` (+${m.oldUsages.length - 5} more)` : ''}`);
            }
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
            migrations: result.migrations.map((m) => ({
              name: m.name,
              completionPercent: m.completionPercent,
              status: m.status,
            })),
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `migration_tracker failed: ${(error as Error).message}. Ensure the directory contains source files to scan for migration patterns.`,
            },
          ],
          structuredContent: { migrations: [], summary: {}, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: auth_flow_analysis — Trace authentication/authorization flows
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'auth_flow_analysis',
    {
      description:
        'Trace authentication and authorization flows. Map which endpoints have auth checks, detect inconsistencies, find unprotected routes.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.auth_flow_analysis,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeAuthFlows(cwd);

        const lines: string[] = [`## Auth Flow Analysis\n`];
        lines.push(`Total endpoints: ${result.summary.totalEndpoints}`);
        lines.push(`Protected: ${result.summary.protected} | Unprotected: ${result.summary.unprotected}`);
        lines.push(`Auth methods: ${result.summary.authMethods.join(', ') || 'none detected'}\n`);

        if (result.unprotectedEndpoints.length > 0) {
          lines.push('### Unprotected Endpoints');
          for (const ep of result.unprotectedEndpoints.slice(0, 20)) {
            lines.push(`  🔓 ${ep.method.toUpperCase()} ${ep.route} — ${ep.file}:${ep.line}`);
          }
          if (result.unprotectedEndpoints.length > 20) {
            lines.push(`  ... and ${result.unprotectedEndpoints.length - 20} more`);
          }
          lines.push('');
        }

        if (result.inconsistencies.length > 0) {
          lines.push('### Inconsistencies');
          for (const issue of result.inconsistencies.slice(0, 15)) {
            lines.push(`  ${issue.group}: ${issue.protected} protected, ${issue.unprotected} unprotected in ${issue.files.length} files`);
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
            endpoints: result.endpoints.map((ep) => ({
              route: ep.route,
              method: ep.method,
              hasAuth: ep.hasAuth,
            })),
            unprotectedEndpoints: result.unprotectedEndpoints.map((ep) => ({
              route: ep.route,
              method: ep.method,
            })),
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `auth_flow_analysis failed: ${(error as Error).message}. Ensure the directory contains source files with route definitions and auth middleware.`,
            },
          ],
          structuredContent: { endpoints: [], unprotectedEndpoints: [], summary: {}, recommendations: [] },
        };
      }
    },
  );
}
