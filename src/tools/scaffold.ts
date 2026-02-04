import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD } from '../config.js';
import { listTemplates, generateScaffold } from '../analyzers/scaffold.js';
import { analytics } from '../utils/analytics.js';

/**
 * Registers scaffold tools for generating boilerplate code based on project conventions.
 * @param server - The MCP server instance to register tools on.
 */
export function registerScaffoldTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: scaffold — Code generation from project conventions
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'scaffold',
    {
      description:
        'Generate boilerplate code based on detected project conventions. Returns generated code as text output — does NOT write files to disk. Templates: component (React), route (Express), test, service, hook, util. Auto-detects TypeScript, testing framework, CSS framework, and ORM.',
      inputSchema: {
        action: z.enum(['list', 'generate']).describe('"list" to see available templates, "generate" to create code'),
        template: z.string().optional().describe('Template name: component, test, route, service, hook, util'),
        name: z.string().optional().describe('Name for the generated code (e.g. "UserProfile", "auth")'),
        target_file: z.string().optional().describe('For test template: path to the file being tested'),
      },
      outputSchema: outputSchemas.scaffold,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('scaffold', async () => {
          if (params.action === 'list') {
            const result = await listTemplates(CWD);
            const lines: string[] = [
              `## Scaffold Templates\n`,
              `Project type: ${result.projectType}`,
              `Detected: ${result.detectedPatterns.join(', ') || 'no patterns'}\n`,
              `### Available Templates`,
            ];
            for (const t of result.templates) {
              lines.push(`  📝 ${t.name} — ${t.description} (${t.language})`);
            }
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              structuredContent: {
                template: 'list',
                fileName: '',
                language: result.projectType,
                generatedCode: JSON.stringify({ projectType: result.projectType, templates: result.templates }, null, 2),
              },
            };
          }

          if (params.action === 'generate') {
            if (!params.template || !params.name) {
              throw new Error('Template and name are required for "generate" action');
            }
            const result = await generateScaffold(CWD, {
              template: params.template,
              name: params.name,
              targetFile: params.target_file,
            });
            const lines: string[] = [
              `## Generated: ${result.fileName}\n`,
              `Template: ${result.template}`,
              `Conventions applied: ${result.conventions.join(', ') || 'none'}\n`,
              '```' + result.language,
              result.generatedCode,
              '```',
            ];
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              structuredContent: {
                template: result.template,
                fileName: result.fileName,
                language: result.language,
                generatedCode: result.generatedCode,
              },
            };
          }

          return { content: [{ type: 'text', text: 'Invalid action' }], isError: true };
        });
      } catch (error: unknown) {
        return { content: [{ type: 'text', text: `scaffold failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
