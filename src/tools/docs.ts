import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { safePath } from '../config.js';
import { detectLanguage } from '../utils/languages.js';
import { extractDocs, findUndocumented } from '../analyzers/docs.js';

/**
 * Registers documentation tools for extracting and analyzing code documentation across multiple languages.
 * @param server - The MCP server instance to register tools on.
 */
export function registerDocsTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: code_docs — Documentation extraction
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'code_docs',
    {
      description:
        'Extract documentation from code: JSDoc, Python docstrings, Rustdoc, Javadoc, Go doc comments. Shows docs for symbols or finds undocumented APIs.',
      inputSchema: {
        action: z
          .enum(['extract', 'undocumented'])
          .describe('extract: get docs for a file, undocumented: find undocumented public APIs'),
        file: z.string().describe('File to analyze'),
        symbol: z.string().optional().describe('Filter to specific symbol name'),
      },
      outputSchema: outputSchemas.code_docs,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const filePath = safePath(params.file);
        const language = detectLanguage(params.file);

        if (params.action === 'undocumented') {
          const undoc = await findUndocumented(filePath, language);
          if (undoc.length === 0)
            return {
              content: [{ type: 'text', text: `All public symbols in ${params.file} are documented. ✅` }],
              structuredContent: { action: 'undocumented', data: { file: params.file, entries: [], total: 0 } },
            };
          const output = undoc.map((u) => `  L${u.line}: ${u.symbol} (${u.type})`).join('\n');
          return {
            content: [
              { type: 'text', text: `${undoc.length} undocumented public symbols in ${params.file}:\n\n${output}` },
            ],
            structuredContent: {
              action: 'undocumented',
              data: {
                file: params.file,
                entries: undoc.map((u) => ({ symbol: u.symbol, type: u.type, line: u.line })),
                total: undoc.length,
              },
            },
          };
        }

        const docs = await extractDocs(filePath, language);
        let filtered = docs;
        if (params.symbol) filtered = docs.filter((d) => d.symbol.includes(params.symbol!));

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No documentation found in ${params.file}${params.symbol ? ` for "${params.symbol}"` : ''}. Use code_docs with action "undocumented" to find undocumented APIs.`,
              },
            ],
            structuredContent: { action: 'extract', data: { file: params.file, entries: [], total: 0 } },
          };
        }

        const output = filtered
          .map((d) => {
            let text = `### ${d.symbolType} ${d.symbol} (L${d.line})${d.deprecated ? ' ⚠️ DEPRECATED' : ''}\n`;
            text += `${d.doc}\n`;
            if (d.params?.length)
              text += `Parameters:\n${d.params.map((p) => `  - ${p.name}${p.type ? ` (${p.type})` : ''}: ${p.description}`).join('\n')}\n`;
            if (d.returns) text += `Returns${d.returns.type ? ` (${d.returns.type})` : ''}: ${d.returns.description}\n`;
            if (d.examples?.length) text += `Examples:\n${d.examples.map((e) => `  ${e}`).join('\n')}\n`;
            return text;
          })
          .join('\n');

        return {
          content: [
            { type: 'text', text: `Documentation for ${params.file} (${filtered.length} symbols):\n\n${output}` },
          ],
          structuredContent: {
            action: 'extract',
            data: {
              file: params.file,
              entries: filtered.map((d) => ({ symbol: d.symbol, type: d.symbolType, line: d.line })),
              total: filtered.length,
            },
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `code_docs failed: ${(error as Error).message}. Verify the file exists and is a supported language.`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
