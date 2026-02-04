import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'node:path';
import { searchCode, listFiles } from '../search/fast-search.js';
import { semanticSearch } from '../search/semantic.js';
import { detectLanguage } from '../utils/languages.js';
import { mapSymbols } from '../analyzers/codebase.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, ROOTS, IS_MULTI_ROOT, safePath } from '../config.js';

/**
 * Registers search tools for text/regex search, symbol finding, reference lookup, and semantic search.
 * @param server - The MCP server instance to register tools on.
 */
export function registerSearchTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL 1: search_code — Fast text/regex search across the codebase
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'search_code',
    {
      description:
        'Fast text or regex search across the entire codebase. Uses ripgrep for speed. Returns file paths, line numbers, and matched content. Works with any programming language.',
      inputSchema: {
        pattern: z.string().describe('Search pattern (text or regex)'),
        is_regex: z.boolean().optional().describe('Treat pattern as regex (default: false)'),
        file_glob: z.string().optional().describe('Filter by file pattern, e.g. "*.py", "*.ts", "*.java"'),
        case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false)'),
        whole_word: z.boolean().optional().describe('Match whole words only (default: false)'),
        max_results: z.number().optional().describe('Maximum results to return (default: 50)'),
        context_lines: z.number().optional().describe('Lines of context before/after each match (default: 0)'),
        directory: z.string().optional().describe('Subdirectory to search within'),
      },
      outputSchema: outputSchemas.search_code,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        // In multi-root mode without a specific directory, search all roots
        const cwdsToSearch = !params.directory && IS_MULTI_ROOT ? ROOTS : [searchCwd];
        const allResults: { file: string; line: number; column?: number; text: string }[] = [];

        for (const cwd of cwdsToSearch) {
          const results = await searchCode({
            cwd,
            pattern: params.pattern,
            isRegex: params.is_regex,
            fileGlob: params.file_glob,
            caseSensitive: params.case_sensitive,
            wholeWord: params.whole_word,
            maxResults: params.max_results || 50,
            contextLines: params.context_lines,
          });
          allResults.push(
            ...results.map((r) => (IS_MULTI_ROOT ? { ...r, file: path.join(path.basename(cwd), r.file) } : r)),
          );
        }

        if (allResults.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No matches found for "${params.pattern}". Try broadening the search: use a shorter pattern, remove file_glob filter, or set case_sensitive=false.`,
              },
            ],
            structuredContent: { matches: [], total: 0 },
          };
        }

        const output = allResults
          .slice(0, params.max_results || 50)
          .map((r) => `${r.file}:${r.line}${r.column !== undefined ? ':' + r.column : ''} │ ${r.text}`)
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Found ${allResults.length} matches${IS_MULTI_ROOT ? ` across ${cwdsToSearch.length} roots` : ''}:\n\n${output}`,
            },
          ],
          structuredContent: {
            matches: allResults
              .slice(0, params.max_results || 50)
              .map((r) => ({ file: r.file, line: r.line, column: r.column, text: r.text })),
            total: allResults.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `search_code failed: ${(error as Error).message}. Verify the directory exists and the pattern is valid. For regex, ensure proper escaping.`,
            },
          ],
          structuredContent: { matches: [], total: 0 },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL 2: search_symbols — Find functions, classes, types across codebase
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'search_symbols',
    {
      description:
        'Find functions, classes, interfaces, types, and constants across the codebase. Supports 40+ languages. Returns symbol name, kind, file, and line number.',
      inputSchema: {
        name: z.string().optional().describe('Symbol name to search for (partial match)'),
        kind: z
          .enum(['function', 'class', 'interface', 'type', 'constant', 'export', 'all'])
          .optional()
          .describe('Type of symbol to find (default: all)'),
        language: z.string().optional().describe('Filter by language, e.g. "python", "typescript", "java"'),
        directory: z.string().optional().describe('Subdirectory to search within'),
        max_files: z.number().optional().describe('Max files to scan (default: 200, increase for large codebases)'),
      },
      outputSchema: outputSchemas.search_symbols,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const symbolDir = params.directory ? safePath(params.directory) : undefined;
        // Optimization: mapSymbols already filters by directory and language
        const symbolMap = await mapSymbols(CWD, {
          maxFiles: params.max_files || 200,
          language: params.language,
          directory: symbolDir ? path.relative(CWD, symbolDir) : undefined,
        });

        let allSymbols = symbolMap.flatMap(({ file, symbols }) => symbols.map((s) => ({ ...s, file })));

        // Filter by name
        if (params.name) {
          const lower = params.name.toLowerCase();
          allSymbols = allSymbols.filter((s) => s.name.toLowerCase().includes(lower));
        }

        // Filter by kind
        if (params.kind && params.kind !== 'all') {
          allSymbols = allSymbols.filter((s) => s.kind === params.kind);
        }

        if (allSymbols.length === 0) {
          return {
            content: [{ type: 'text', text: 'No symbols found matching criteria.' }],
            structuredContent: { symbols: [], total: 0 },
          };
        }

        // Group by kind for display
        const grouped: Record<string, typeof allSymbols> = {};
        for (const s of allSymbols) {
          if (!grouped[s.kind]) grouped[s.kind] = [];
          grouped[s.kind].push(s);
        }

        const output = Object.entries(grouped)
          .map(([kind, syms]) => {
            const header = `### ${kind}s (${syms.length})`;
            const list = syms
              .slice(0, 100)
              .map((s) => `  ${s.name.padEnd(35)} ${s.file}:${s.line}  [${s.language}]`)
              .join('\n');
            return `${header}\n${list}`;
          })
          .join('\n\n');

        return {
          content: [
            {
              type: 'text',
              text: `Found ${allSymbols.length} symbols:\n\n${output}`,
            },
          ],
          structuredContent: {
            symbols: allSymbols.slice(0, 200).map((s) => ({ name: s.name, type: s.kind, file: s.file, line: s.line })),
            total: allSymbols.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `search_symbols failed: ${(error as Error).message}. Try increasing max_files for large codebases, or narrow with language/directory filters.`,
            },
          ],
          structuredContent: { symbols: [], total: 0 },
        };
      }
    },
  );
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL 3: find_references — Find all references to a symbol
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_references',
    {
      description:
        'Find all references to a symbol (function, class, variable) across the codebase. Shows every file and line where the symbol is used.',
      inputSchema: {
        symbol: z.string().describe('Symbol name to find references for'),
        file_glob: z.string().optional().describe('Filter by file pattern, e.g. "*.py"'),
        whole_word: z.boolean().optional().describe('Match whole word only (default: true)'),
        context_lines: z.number().optional().describe('Lines of context around each reference (default: 1)'),
      },
      outputSchema: outputSchemas.find_references,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const results = await searchCode({
          cwd: CWD,
          pattern: params.symbol,
          wholeWord: params.whole_word !== false,
          fileGlob: params.file_glob,
          contextLines: params.context_lines || 1,
          maxResults: 100,
        });

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `No references found for "${params.symbol}"` }],
            structuredContent: { symbol: params.symbol, references: [], total: 0 },
          };
        }

        // Group by file
        const byFile: Record<string, typeof results> = {};
        for (const r of results) {
          if (!byFile[r.file]) byFile[r.file] = [];
          byFile[r.file].push(r);
        }

        const output = Object.entries(byFile)
          .map(([file, refs]) => {
            const lines = refs.map((r) => `  L${r.line}: ${r.text}`).join('\n');
            return `📄 ${file} (${refs.length} references)\n${lines}`;
          })
          .join('\n\n');

        return {
          content: [
            {
              type: 'text',
              text: `Found ${results.length} references to "${params.symbol}" in ${Object.keys(byFile).length} files:\n\n${output}`,
            },
          ],
          structuredContent: {
            symbol: params.symbol,
            references: results.map((r) => ({ file: r.file, line: r.line, context: r.text })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `find_references failed: ${(error as Error).message}. Verify the symbol name is correct. Try search_code with a broader pattern.`,
            },
          ],
          structuredContent: { symbol: params.symbol || '', references: [], total: 0 },
        };
      }
    },
  );
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL 4: semantic_search — Concept-based code search
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'semantic_search',
    {
      description:
        'Search code by concept, not just text. Finds "authentication logic" or "error handling code" without needing exact strings. Uses TF-IDF with synonym expansion.',
      inputSchema: {
        query: z
          .string()
          .describe('Natural language query, e.g. "authentication flow" or "database connection handling"'),
        file_glob: z.string().optional().describe('Filter by file pattern, e.g. "*.py"'),
        max_results: z.number().optional().describe('Max results (default: 15)'),
      },
      outputSchema: outputSchemas.semantic_search,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        let files = await listFiles(CWD, { type: 'file' });
        // Filter by language (exclude unknown)
        files = files.filter((f) => detectLanguage(f) !== 'unknown');
        if (params.file_glob) {
          const pattern = new RegExp(params.file_glob.replace(/\*/g, '.*').replace(/\?/g, '.'));
          files = files.filter((f) => pattern.test(f));
        }

        const results = await semanticSearch(files, params.query, CWD, params.max_results || 15);
        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No semantic matches for "${params.query}". Try broader terms or use search_code for exact text search.`,
              },
            ],
            structuredContent: { matches: [], total: 0 },
          };
        }

        const output = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.file}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)}, terms: ${r.matchedTerms.join(', ')})\n${r.snippet
                .split('\n')
                .map((l) => '   ' + l)
                .join('\n')}`,
          )
          .join('\n\n');

        return {
          content: [
            { type: 'text', text: `Semantic search: "${params.query}" — ${results.length} results\n\n${output}` },
          ],
          structuredContent: {
            matches: results.map((r) => ({ file: r.file, score: r.score, snippet: r.snippet })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `semantic_search failed: ${(error as Error).message}. Try search_code for exact text matching.`,
            },
          ],
          structuredContent: { matches: [], total: 0 },
        };
      }
    },
  );
}
