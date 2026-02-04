import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD } from '../config.js';
import { analyzeIaC } from '../analyzers/iac.js';
import { parseCICD } from '../analyzers/cicd.js';
import { analyzeMonorepo } from '../analyzers/monorepo.js';
import { analytics } from '../utils/analytics.js';

/**
 * Registers DevOps tools for infrastructure-as-code analysis, CI/CD pipeline parsing, and monorepo workspace analysis.
 * @param server - The MCP server instance to register tools on.
 */
export function registerDevOpsTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: iac_analyze — Infrastructure-as-Code analysis
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'iac_analyze',
    {
      description:
        'Analyze infrastructure-as-code definitions. Parses Terraform (.tf), CloudFormation, Kubernetes manifests, and Docker Compose files. Returns resources, providers, and issues.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.iac_analyze,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('iac_analyze', async () => {
          const result = await analyzeIaC(CWD, { directory: params.directory });
          const lines: string[] = [
            `## Infrastructure - as - Code\n`,
            `Resources: ${result.summary.totalResources}`,
            `Platforms: ${result.summary.platforms.join(', ') || 'none detected'}\n`,
          ];
          const rtypes = result.summary.resourceTypes;
          if (Object.keys(rtypes).length > 0) {
            lines.push('### Resource Summary');
            for (const [rtype, count] of Object.entries(rtypes)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .slice(0, 20)) {
              lines.push(`  ${rtype}: ${count}`);
            }
          }
          lines.push('\n### Resources');
          for (const r of result.resources.slice(0, 40)) {
            const props = Object.entries(r.properties)
              .slice(0, 3)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            lines.push(`  [${r.source}] ${r.type} "${r.name}"${props ? ` (${props})` : ''}`);
          }
          if (result.issues.length > 0) {
            lines.push(`\n### Issues(${result.issues.length})`);
            result.issues
              .slice(0, 15)
              .forEach((i) =>
                lines.push(
                  `  ${i.severity === 'error' ? '❌' : '⚠️'} ${i.message} — ${i.file}${i.line ? ':' + i.line : ''}`,
                ),
              );
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              platform: result.platform,
              resources: result.resources?.map((r) => ({ type: r.type, name: r.name })) || [],
              issues:
                result.issues?.map((i) => ({
                  message: i.message,
                  severity: i.severity,
                  file: i.file,
                  line: i.line,
                })) || [],
              summary: result.summary || {},
            },
          };
        });
      } catch (error: unknown) {
        return { content: [{ type: 'text', text: `iac_analyze failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: cicd_analyze — CI/CD pipeline analysis
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'cicd_analyze',
    {
      description:
        'Parse CI/CD pipeline configurations. Supports GitHub Actions, GitLab CI, Jenkins (Jenkinsfile), and CircleCI. Returns pipeline names, jobs, steps, triggers, and dependencies.',
      outputSchema: outputSchemas.cicd_analyze,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return await analytics.track('cicd_analyze', async () => {
          const result = await parseCICD(CWD);
          const lines: string[] = [
            `## CI / CD Pipelines\n`,
            `Pipelines: ${result.summary.totalPipelines}`,
            `Total jobs: ${result.summary.totalJobs}`,
            `Issues: ${result.summary.totalIssues}\n`,
          ];
          for (const pipeline of result.pipelines) {
            lines.push(`### ${pipeline.name || pipeline.file} (${pipeline.platform}) — ${pipeline.file}`);
            if (pipeline.triggers.length > 0) lines.push(`  Triggers: ${pipeline.triggers.join(', ')}`);
            for (const job of pipeline.jobs) {
              const deps = job.dependsOn?.length ? ` (needs: ${job.dependsOn.join(', ')})` : '';
              const runner = job.runsOn ? ` [${job.runsOn}]` : '';
              lines.push(`  📋 ${job.name}${deps}${runner}`);
              job.steps.slice(0, 5).forEach((s) => lines.push(`     → ${s}`));
            }
            if (pipeline.issues.length > 0) {
              pipeline.issues.forEach((i) => lines.push(`  ${i.severity === 'error' ? '❌' : '⚠️'} ${i.message}`));
            }
            lines.push('');
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              pipelines: result.pipelines.map((p) => ({ name: p.name, platform: p.platform, file: p.file })),
              summary: result.summary || {},
            },
          };
        });
      } catch (error: unknown) {
        return { content: [{ type: 'text', text: `cicd_analyze failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: monorepo_analyze — Workspace/package relationship analysis
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'monorepo_analyze',
    {
      description:
        'Analyze monorepo workspace relationships. Supports npm/yarn/pnpm workspaces, Cargo workspaces, Lerna, Nx, and Turborepo. Shows packages, internal dependencies, and issues.',
      outputSchema: outputSchemas.monorepo_analyze,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return await analytics.track('monorepo_analyze', async () => {
          const result = await analyzeMonorepo(CWD);
          if (result.type === 'none') {
            return {
              content: [
                {
                  type: 'text',
                  text: 'This project does not appear to be a monorepo. No workspace configuration detected.',
                },
              ],
              structuredContent: { type: 'none', packages: [], summary: {} },
            };
          }
          const lines: string[] = [
            `## Monorepo Analysis\n`,
            `Type: ${result.type}`,
            `Packages: ${result.summary.totalPackages}`,
            `Cross - dependencies: ${result.summary.crossDeps}`,
            `Root tools: ${result.summary.rootTools.join(', ') || 'none'}\n`,
          ];
          for (const pkg of result.packages) {
            const deps = pkg.dependencies.length > 0 ? ` → depends on: ${pkg.dependencies.join(', ')}` : '';
            lines.push(`  📦 ${pkg.name} (${pkg.path})${pkg.version ? ` v${pkg.version}` : ''}${deps}`);
          }
          if (result.dependencyGraph.length > 0) {
            lines.push(`\n### Dependency Graph(${result.dependencyGraph.length} edges)`);
            result.dependencyGraph.slice(0, 20).forEach((d) => lines.push(`  ${d.from} → ${d.to}`));
          }
          if (result.issues.length > 0) {
            lines.push(`\n### Issues(${result.issues.length})`);
            result.issues.forEach((i) => lines.push(`  ⚠️ ${i}`));
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              type: result.type,
              packages: result.packages.map((p) => ({ name: p.name, path: p.path, version: p.version })),
              summary: result.summary || {},
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `monorepo_analyze failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
