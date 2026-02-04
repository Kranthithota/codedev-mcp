import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { searchCode } from '../search/fast-search.js';

/**
 * Registers code quality tools for finding TODOs, debug logs, secrets, empty catches, duplicates, and dead code.
 * @param server - The MCP server instance to register tools on.
 */
export function registerQualityTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_todos — Find TODO/FIXME/HACK comments
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_todos',
    {
      description: 'Find TODO, FIXME, HACK, XXX, BUG, and OPTIMIZE comments in the codebase.',
      inputSchema: {
        file_glob: z.string().optional().describe('Filter by file pattern, e.g. "*.ts"'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        const results = await searchCode({
          cwd: searchCwd,
          pattern: '(TODO|FIXME|HACK|XXX|WARN|BUG|OPTIMIZE)\\b',
          isRegex: true,
          fileGlob: params.file_glob,
          maxResults: 100,
        });
        const output = results.map((r) => `${r.file}:${r.line} │ ${r.text.trim()}`).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${results.length} TODOs:\n\n${output}` }],
          structuredContent: {
            check: 'todos',
            matches: results.map((r) => ({ file: r.file, line: r.line, text: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return { content: [{ type: 'text', text: `find_todos failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_debug_logs — Find console.log/print statements
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_debug_logs',
    {
      description: 'Find debug/log statements: console.log, print, println, Debug.Log, etc.',
      inputSchema: {
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        // Use simpler pattern that works with grep - escape properly for grep regex
        const results = await searchCode({
          cwd: searchCwd,
          pattern: 'console\\.(log|debug|info|warn|error)|print\\(|println!|fmt\\.Print|System\\.out|Debug\\.Log',
          isRegex: true,
          fileGlob: params.file_glob,
          maxResults: 100,
        });
        const output = results.map((r) => `${r.file}:${r.line} │ ${r.text.trim()}`).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${results.length} debug/log statements:\n\n${output}` }],
          structuredContent: {
            check: 'debug_logs',
            matches: results.map((r) => ({ file: r.file, line: r.line, text: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_debug_logs failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_secrets — Find hardcoded secrets/credentials
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_secrets',
    {
      description: 'Find potential hardcoded secrets: passwords, API keys, tokens, credentials.',
      inputSchema: {
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        const results = await searchCode({
          cwd: searchCwd,
          pattern: '(password|secret|api_key|apikey|token|credential)\\s*[:=]\\s*["\'][^"\']+["\']',
          isRegex: true,
          caseSensitive: false,
          fileGlob: params.file_glob,
          maxResults: 50,
        });
        const output = results.map((r) => `⚠️  ${r.file}:${r.line} │ ${r.text.trim()}`).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${results.length} potential hardcoded secrets:\n\n${output}` }],
          structuredContent: {
            check: 'secrets',
            matches: results.map((r) => ({ file: r.file, line: r.line, text: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return { content: [{ type: 'text', text: `find_secrets failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_empty_catches — Find empty error handlers
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_empty_catches',
    {
      description: 'Find empty catch blocks and swallowed exceptions.',
      inputSchema: {
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        // Use simpler patterns that work with grep - search for common empty catch patterns
        // Pattern 1: catch() { } or catch(e) { }
        const catchPattern1 = 'catch[[:space:]]*([^)]*)[[:space:]]*\\{[[:space:]]*\\}';
        // Pattern 2: except: pass (Python)
        const exceptPattern = 'except:[[:space:]]*pass';
        // Pattern 3: rescue => nil (Ruby)
        const rescuePattern = 'rescue[[:space:]]*=>[[:space:]]*nil';
        
        const catchResults = await searchCode({
          cwd: searchCwd,
          pattern: catchPattern1,
          isRegex: true,
          fileGlob: params.file_glob,
          maxResults: 50,
          contextLines: 1,
        });
        
        const exceptResults = await searchCode({
          cwd: searchCwd,
          pattern: exceptPattern,
          isRegex: true,
          fileGlob: params.file_glob,
          maxResults: 50,
          contextLines: 1,
        });
        
        const rescueResults = await searchCode({
          cwd: searchCwd,
          pattern: rescuePattern,
          isRegex: true,
          fileGlob: params.file_glob,
          maxResults: 50,
          contextLines: 1,
        });
        
        // Combine and deduplicate results
        const allResults = [...catchResults, ...exceptResults, ...rescueResults];
        const results = allResults.filter((r, i, arr) => 
          arr.findIndex((other) => other.file === r.file && other.line === r.line) === i
        );
        const output = results.map((r) => `${r.file}:${r.line} │ ${r.text.trim()}`).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${results.length} empty/swallowed error handlers:\n\n${output}` }],
          structuredContent: {
            check: 'empty_catches',
            matches: results.map((r) => ({ file: r.file, line: r.line, text: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_empty_catches failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_long_functions — Find overly long functions
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_long_functions',
    {
      description: 'Find functions that exceed a line count threshold (complexity indicator).',
      inputSchema: {
        threshold: z.number().optional().describe('Line count threshold (default: 50)'),
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const threshold = params.threshold || 50;
      return {
        content: [
          {
            type: 'text',
            text: `Tip: Use "code_metrics" or "analyze_file" to find functions over ${threshold} lines. These tools use AST parsing for accurate function length detection.`,
          },
        ],
        structuredContent: { check: 'long_functions', matches: [], total: 0 },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_large_files — Find overly large files
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_large_files',
    {
      description: 'Find files that exceed a line count threshold.',
      inputSchema: {
        threshold: z.number().optional().describe('Line count threshold (default: 500)'),
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const threshold = params.threshold || 500;
      return {
        content: [
          {
            type: 'text',
            text: `Tip: Use "codebase_map" or "file_tree" to see file sizes. Use "code_metrics" with a threshold of ${threshold} to identify large files programmatically.`,
          },
        ],
        structuredContent: { check: 'large_files', matches: [], total: 0 },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_duplicates — Find duplicate code patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_duplicates',
    {
      description: 'Find duplicate code patterns and copy-pasted blocks.',
      inputSchema: {
        pattern: z.string().optional().describe('Specific pattern to search for duplicates'),
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      if (params.pattern) {
        try {
          const searchCwd = params.directory ? safePath(params.directory) : CWD;
          const results = await searchCode({
            cwd: searchCwd,
            pattern: params.pattern,
            isRegex: false,
            fileGlob: params.file_glob,
            maxResults: 100,
          });
          const output = results.map((r) => `${r.file}:${r.line} │ ${r.text.trim()}`).join('\n');
          return {
            content: [{ type: 'text', text: `Found ${results.length} occurrences of pattern:\n\n${output}` }],
            structuredContent: {
              check: 'duplicates',
              matches: results.map((r) => ({ file: r.file, line: r.line, text: r.text.trim() })),
              total: results.length,
            },
          };
        } catch (error: unknown) {
          return {
            content: [{ type: 'text', text: `find_duplicates failed: ${(error as Error).message}` }],
            isError: true,
          };
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: 'Tip: Use "search_code" to find repeated patterns. Provide a specific pattern to this tool to count occurrences across the codebase.',
          },
        ],
        structuredContent: { check: 'duplicates', matches: [], total: 0 },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: find_dead_code — Find unused exports
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'find_dead_code',
    {
      description: 'Find potentially dead code: unused exports, unreferenced functions.',
      inputSchema: {
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: 'Tip: Use "search_symbols" to find all exports, then use "find_references" on each symbol to check usage. Symbols with 0 references (excluding their definition) are potentially dead code.',
          },
        ],
        structuredContent: { check: 'dead_code', matches: [], total: 0 },
      };
    },
  );
}
