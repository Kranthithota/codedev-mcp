import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { findNotebooks, parseNotebook, extractCode, notebookHealth } from '../analyzers/notebook.js';

/**
 * Registers notebook analysis tools for parsing and inspecting Jupyter notebooks.
 * @param server - The MCP server instance to register tools on.
 */
export function registerNotebookTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: notebook_analyze — Jupyter notebook analysis
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'notebook_analyze',
    {
      description:
        'Analyze Jupyter notebooks (.ipynb): extract code cells, check execution order, find imports/functions, assess notebook health.',
      inputSchema: {
        action: z
          .enum(['analyze', 'list', 'code', 'health'])
          .describe(
            'analyze: full notebook breakdown, list: find all notebooks, code: extract code cells, health: quality assessment',
          ),
        file: z.string().optional().describe('Notebook file path (required for analyze/code/health)'),
      },
      outputSchema: outputSchemas.notebook_analyze,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (params.action === 'list') {
          const notebooks = await findNotebooks(CWD);
          if (notebooks.length === 0)
          return {
            content: [{ type: 'text', text: 'No Jupyter notebooks (.ipynb) found in the project.' }],
            structuredContent: { action: 'list', data: { notebooks: [], count: 0 } },
          };
          return {
            content: [{ type: 'text', text: `Found ${notebooks.length} notebooks:\n\n${notebooks.join('\n')}` }],
            structuredContent: { action: 'list', data: { notebooks, count: notebooks.length } },
          };
        }

        if (!params.file)
          return {
            content: [{ type: 'text', text: 'File path required. Use action "list" to find notebooks.' }],
            isError: true,
          };
        const filePath = safePath(params.file);
        const notebook = await parseNotebook(filePath);

        switch (params.action) {
          case 'analyze': {
            let output = `## Notebook: ${params.file}\n`;
            output += `Kernel: ${notebook.kernelDisplayName} (${notebook.kernelLanguage})\n`;
            output += `Cells: ${notebook.totalCells} (${notebook.codeCells} code, ${notebook.markdownCells} markdown)\n`;
            output += `Execution order: ${notebook.executedInOrder ? '✅ sequential' : '⚠️ out of order'}\n`;
            if (notebook.hasUnexecutedCells) output += `⚠️ Has unexecuted cells\n`;
            if (notebook.imports.length > 0)
              output += `\nImports:\n${notebook.imports.map((i) => `  ${i}`).join('\n')}\n`;
            if (notebook.functions.length > 0)
              output += `\nFunctions:\n${notebook.functions.map((f) => `  ${f}`).join('\n')}\n`;

            output += `\n### Cells:\n`;
            for (const cell of notebook.cells.slice(0, 30)) {
              const preview = cell.source.split('\n')[0]?.slice(0, 80) || '(empty)';
              const errorMark = cell.hasError ? ' ❌' : '';
              output += `  [${cell.index}] ${cell.cellType} ${cell.executionCount ? `(${cell.executionCount})` : ''}${errorMark}: ${preview}\n`;
            }
            return {
              content: [{ type: 'text', text: output }],
              structuredContent: { action: 'analyze', data: { notebook: params.file, summary: output } },
            };
          }

          case 'code': {
            const code = extractCode(notebook);
            return { content: [{ type: 'text', text: code }], structuredContent: { action: 'code', data: { code } } };
          }

          case 'health': {
            const health = notebookHealth(notebook);
            let output = `Notebook health score: ${health.score}/100\n`;
            if (health.issues.length > 0) {
              output += `\nIssues:\n${health.issues.map((i) => `  - ${i}`).join('\n')}\n`;
            } else {
              output += `\nNo issues found! ✅\n`;
            }
            return {
              content: [{ type: 'text', text: output }],
              structuredContent: { action: 'health', data: { score: health.score, issues: health.issues } },
            };
          }

          default:
            return { content: [{ type: 'text', text: `Unknown action: ${params.action}` }], isError: true };
        }
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `notebook_analyze failed: ${(error as Error).message}. Verify the file is a valid .ipynb notebook.`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
