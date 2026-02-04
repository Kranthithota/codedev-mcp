import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { searchCode, listFiles } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAST } from '../analyzers/tree-sitter.js';
import { extractSymbols } from '../analyzers/symbols.js';
import { detectLanguage } from '../utils/languages.js';

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
        // Only match TODO comments, not function calls like logger.warn()
        // Match TODO/FIXME/HACK/XXX/BUG/OPTIMIZE that appear in comments (// or /* */)
        const results = await searchCode({
          cwd: searchCwd,
          pattern: '(//|/\\*|#|<!--).*?(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\\b',
          isRegex: true,
          fileGlob: params.file_glob,
          maxResults: 100,
        });
        const output = results.map((r) => `${r.file}:${r.line} │ ${r.text.trim()}`).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${results.length} TODOs:\n\n${output}` }],
          structuredContent: {
            check: 'todos',
            matches: results.map((r) => ({ file: r.file, line: r.line, match: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_todos failed: ${(error as Error).message}` }],
          structuredContent: { check: 'todos', matches: [], total: 0 },
        };
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
            matches: results.map((r) => ({ file: r.file, line: r.line, match: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_debug_logs failed: ${(error as Error).message}` }],
          structuredContent: { check: 'debug_logs', matches: [], total: 0 },
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
            matches: results.map((r) => ({ file: r.file, line: r.line, match: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_secrets failed: ${(error as Error).message}` }],
          structuredContent: { check: 'secrets', matches: [], total: 0 },
        };
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
        const fileGlob = params.file_glob || '**/*.{ts,tsx,js,jsx,py,rb}';
        const files = await listFiles(searchCwd, { glob: fileGlob });
        const matches: Array<{ file: string; line: number; match: string }> = [];

        // Process files to find empty catch blocks
        for (const file of files.slice(0, 500)) {
          try {
            const filePath = path.join(searchCwd, file);
            const content = await readFile(filePath, 'utf-8');
            const language = detectLanguage(file);

            if (language === 'python') {
              // Python: except: pass or except Exception: pass
              const exceptRegex = /except\s*(?:\([^)]+\))?\s*:\s*pass/g;
              let match;
              while ((match = exceptRegex.exec(content)) !== null) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                matches.push({
                  file,
                  line: lineNum,
                  match: 'Empty except: pass',
                });
              }
            } else if (language === 'ruby') {
              // Ruby: rescue => nil or rescue; end
              const rescueRegex = /rescue\s*(?:=>\s*nil|;?\s*end)/g;
              let match;
              while ((match = rescueRegex.exec(content)) !== null) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                matches.push({
                  file,
                  line: lineNum,
                  match: 'Empty rescue block',
                });
              }
            } else {
              // JavaScript/TypeScript: catch() { } or catch(e) { }
              // Find all catch blocks
              const catchRegex = /catch\s*\([^)]*\)\s*\{/g;
              let catchMatch;
              while ((catchMatch = catchRegex.exec(content)) !== null) {
                const catchStart = catchMatch.index;
                const catchLine = content.substring(0, catchStart).split('\n').length;
                const afterCatch = content.substring(catchStart + catchMatch[0].length);

                // Find the matching closing brace
                let braceCount = 1;
                let pos = 0;
                let foundEnd = false;

                while (pos < afterCatch.length && braceCount > 0) {
                  if (afterCatch[pos] === '{') braceCount++;
                  else if (afterCatch[pos] === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                      foundEnd = true;
                      break;
                    }
                  }
                  pos++;
                }

                if (foundEnd) {
                  const catchBody = afterCatch.substring(0, pos);
                  // Check if body is empty (only whitespace/comments)
                  const trimmedBody = catchBody
                    .replace(/\/\/.*$/gm, '')
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .trim();
                  if (trimmedBody === '') {
                    matches.push({
                      file,
                      line: catchLine,
                      match: 'Empty catch block',
                    });
                  }
                }
              }
            }
          } catch {
            continue;
          }
        }

        const results = matches.map((m) => ({
          file: m.file,
          line: m.line,
          text: m.match,
          column: 0,
        }));
        const output = results.map((r) => `${r.file}:${r.line} │ ${r.text.trim()}`).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${results.length} empty/swallowed error handlers:\n\n${output}` }],
          structuredContent: {
            check: 'empty_catches',
            matches: results.map((r) => ({ file: r.file, line: r.line, match: r.text.trim() })),
            total: results.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_empty_catches failed: ${(error as Error).message}` }],
          structuredContent: { check: 'empty_catches', matches: [], total: 0 },
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
      try {
        const threshold = params.threshold || 50;
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        const fileGlob = params.file_glob || '**/*.{ts,tsx,js,jsx,py,go,java,rs,c,cpp}';

        const files = await listFiles(searchCwd, { glob: fileGlob });
        const matches: Array<{ file: string; line: number; match: string }> = [];

        // Increased limit from 500 to 2000 to handle large projects (949+ files)
        for (const file of files.slice(0, 2000)) {
          try {
            const filePath = path.join(searchCwd, file);
            const language = detectLanguage(file);
            const content = await readFile(filePath, 'utf-8');
            const lines = content.split('\n');

            // Try AST parsing first
            const astSymbols = await parseAST(filePath, language);
            if (astSymbols && astSymbols.length > 0) {
              for (const symbol of astSymbols) {
                if (symbol.type === 'function' && symbol.endLine && symbol.startLine) {
                  const lineCount = symbol.endLine - symbol.startLine + 1;
                  if (lineCount > threshold) {
                    matches.push({
                      file,
                      line: symbol.startLine,
                      match: `${symbol.name || 'anonymous'}() - ${lineCount} lines`,
                    });
                  }
                }
              }
            }

            // Always also try regex-based extraction as fallback/complement
            const symbols = await extractSymbols(filePath);
            const processedFunctions = new Set<string>();

            for (const symbol of symbols.filter((s) => s.kind === 'function')) {
              const key = `${file}:${symbol.line}`;
              if (processedFunctions.has(key)) continue;
              processedFunctions.add(key);

              // Find function start and end by parsing braces
              let braceCount = 0;
              let startLine = symbol.line;
              let endLine = startLine;
              let foundStart = false;

              // Look backwards to find function start
              for (let i = symbol.line - 1; i >= 0 && i >= symbol.line - 10; i--) {
                const line = lines[i];
                if (
                  /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+|^\s*(?:export\s+)?(?:async\s+)?\w+\s*[:=]\s*(?:async\s*)?\(|^\s*(?:export\s+)?(?:async\s+)?\w+\s*[:=]\s*(?:async\s*)?\w+\s*=>/.test(
                    line,
                  )
                ) {
                  startLine = i + 1;
                  foundStart = true;
                  break;
                }
              }

              if (!foundStart) startLine = symbol.line;

              // Find function end by counting braces
              for (let i = startLine - 1; i < lines.length; i++) {
                const line = lines[i];
                const openBraces = (line.match(/\{/g) || []).length;
                const closeBraces = (line.match(/\}/g) || []).length;

                if (i === startLine - 1 || braceCount > 0) {
                  braceCount += openBraces;
                  braceCount -= closeBraces;

                  if (braceCount === 0 && i >= startLine) {
                    endLine = i + 1;
                    break;
                  }
                }
              }

              // If we didn't find the end, estimate from remaining content
              if (endLine === startLine && startLine < lines.length) {
                endLine = lines.length;
              }

              const lineCount = endLine - startLine + 1;
              if (lineCount > threshold) {
                // Check if we already added this from AST
                const alreadyAdded = matches.some((m) => m.file === file && Math.abs(m.line - startLine) <= 2);
                if (!alreadyAdded) {
                  matches.push({
                    file,
                    line: startLine,
                    match: `${symbol.name}() - ${lineCount} lines`,
                  });
                }
              }
            }
          } catch {
            // Skip files that can't be parsed, but log for debugging
            continue;
          }
        }

        const output = matches.map((m) => `${m.file}:${m.line} │ ${m.match}`).join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `Found ${matches.length} functions exceeding ${threshold} lines:\n\n${output || 'None found'}`,
            },
          ],
          structuredContent: {
            check: 'long_functions',
            matches,
            total: matches.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_long_functions failed: ${(error as Error).message}` }],
          structuredContent: { check: 'long_functions', matches: [], total: 0 },
        };
      }
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
        threshold: z.number().optional().describe('Line count threshold (default: 300)'),
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const threshold = params.threshold || 300;
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        const fileGlob = params.file_glob || '**/*';

        const files = await listFiles(searchCwd, { glob: fileGlob });
        const matches: Array<{ file: string; line: number; match: string }> = [];

        // Process more files and ensure we're scanning the right directory
        // Increased limit from 1000 to 2000 to handle large projects (949+ files)
        for (const file of files.slice(0, 2000)) {
          try {
            const filePath = path.join(searchCwd, file);
            // Verify file exists and is readable
            const stats = await import('node:fs/promises').then((fs) => fs.stat(filePath));
            if (!stats.isFile()) continue;

            const content = await readFile(filePath, 'utf-8');
            const lineCount = content.split('\n').length;

            if (lineCount > threshold) {
              matches.push({
                file,
                line: 1,
                match: `${lineCount} lines`,
              });
            }
          } catch {
            // Skip files that can't be read
            continue;
          }
        }

        // Sort by line count descending
        matches.sort((a, b) => {
          const aLines = parseInt(a.match.match(/\d+/)?.[0] || '0', 10);
          const bLines = parseInt(b.match.match(/\d+/)?.[0] || '0', 10);
          return bLines - aLines;
        });

        const output = matches.map((m) => `${m.file}:${m.match}`).join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `Found ${matches.length} files exceeding ${threshold} lines:\n\n${output || 'None found'}`,
            },
          ],
          structuredContent: {
            check: 'large_files',
            matches,
            total: matches.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_large_files failed: ${(error as Error).message}` }],
          structuredContent: { check: 'large_files', matches: [], total: 0 },
        };
      }
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
        min_length: z.number().optional().describe('Minimum length of duplicate block in lines (default: 5)'),
        file_glob: z.string().optional().describe('Filter by file pattern'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.find_pattern,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const searchCwd = params.directory ? safePath(params.directory) : CWD;

        if (params.pattern) {
          // Pattern-based search
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
              matches: results.map((r) => ({ file: r.file, line: r.line, match: r.text.trim() })),
              total: results.length,
            },
          };
        }

        // AST-based duplicate detection
        const minLength = params.min_length || 5;
        const fileGlob = params.file_glob || '**/*.{ts,tsx,js,jsx,py,go,java,rs}';
        const files = await listFiles(searchCwd, { glob: fileGlob });
        const codeBlocks = new Map<string, Array<{ file: string; line: number }>>();
        const matches: Array<{ file: string; line: number; match: string }> = [];

        // Extract function bodies and look for duplicates
        // Increased limit from 100 to 2000 to handle large projects
        for (const file of files.slice(0, 2000)) {
          try {
            const filePath = path.join(searchCwd, file);
            const language = detectLanguage(file);
            const content = await readFile(filePath, 'utf-8');
            const lines = content.split('\n');

            // Try AST parsing first
            const astSymbols = await parseAST(filePath, language);
            if (astSymbols) {
              for (const symbol of astSymbols) {
                if ((symbol.type === 'function' || symbol.type === 'method') && symbol.endLine && symbol.startLine) {
                  const lineCount = symbol.endLine - symbol.startLine + 1;
                  if (lineCount >= minLength) {
                    const body = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
                    // Normalize whitespace for comparison
                    const normalized = body.replace(/\s+/g, ' ').trim();
                    if (normalized.length > 50) {
                      // Only consider substantial blocks
                      const key = normalized.slice(0, 200); // Use first 200 chars as key
                      if (!codeBlocks.has(key)) {
                        codeBlocks.set(key, []);
                      }
                      codeBlocks.get(key)!.push({ file, line: symbol.startLine });
                    }
                  }
                }
              }
            }

            // Also detect structural patterns (e.g., CRUD patterns)
            // Look for common patterns like: getXById, createX, updateX, deleteX
            // These patterns appear across multiple files with similar structure
            const structuralPatterns = [
              {
                pattern:
                  /(?:export\s+)?(?:const|async\s+function|function)\s+get\w+ById\s*=\s*async\s*\([^)]*id[^)]*\)\s*=>[\s\S]{0,500}?return\s+await\s+db\.query\.\w+\.findFirst/,
                name: 'getXById pattern',
              },
              {
                pattern:
                  /return\s+await\s+db\.query\.\w+\.findFirst\s*\(\s*\{[\s\S]{0,200}?where:\s*\([^)]*\)\s*=>\s*eq\([^)]*\)[\s\S]{0,200}?\}\)/,
                name: 'db.query.findFirst with eq pattern',
              },
            ];

            for (const { pattern, name } of structuralPatterns) {
              const patternMatches = content.matchAll(pattern);
              for (const match of patternMatches) {
                const line = content.substring(0, match.index).split('\n').length;
                const key = `structural:${name}`;
                if (!codeBlocks.has(key)) {
                  codeBlocks.set(key, []);
                }
                codeBlocks.get(key)!.push({ file, line });
              }
            }
          } catch {
            continue;
          }
        }

        // Find duplicates (appearing in 2+ files)
        for (const [, locations] of codeBlocks.entries()) {
          if (locations.length >= 2) {
            const uniqueFiles = new Set(locations.map((l) => l.file));
            if (uniqueFiles.size >= 2) {
              for (const loc of locations) {
                matches.push({
                  file: loc.file,
                  line: loc.line,
                  match: `Duplicate code block (found in ${locations.length} locations)`,
                });
              }
            }
          }
        }

        const output = matches
          .slice(0, 50)
          .map((m) => `${m.file}:${m.line} │ ${m.match}`)
          .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `Found ${matches.length} duplicate code blocks (min ${minLength} lines):\n\n${output || 'None found'}`,
            },
          ],
          structuredContent: {
            check: 'duplicates',
            matches: matches.slice(0, 100),
            total: matches.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_duplicates failed: ${(error as Error).message}` }],
          structuredContent: { check: 'duplicates', matches: [], total: 0 },
        };
      }
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
    async (params) => {
      try {
        const searchCwd = params.directory ? safePath(params.directory) : CWD;
        const fileGlob = params.file_glob || '**/*.{ts,tsx,js,jsx,py,go,java,rs}';
        const files = await listFiles(searchCwd, { glob: fileGlob });
        const matches: Array<{ file: string; line: number; match: string }> = [];

        // Collect all exported symbols
        const exportedSymbols: Array<{ file: string; name: string; line: number; kind: string }> = [];

        // Increased limit from 200 to 2000 to handle large projects
        for (const file of files.slice(0, 2000)) {
          try {
            const filePath = path.join(searchCwd, file);
            const symbols = await extractSymbols(filePath);

            for (const symbol of symbols) {
              // Check if it's exported
              if (symbol.kind === 'export' || symbol.signature?.includes('export')) {
                exportedSymbols.push({
                  file,
                  name: symbol.name,
                  line: symbol.line,
                  kind: symbol.kind,
                });
              }
            }
          } catch {
            continue;
          }
        }

        // Check references for each exported symbol
        // Increased limit from 100 to 1000 to handle large projects
        for (const symbol of exportedSymbols.slice(0, 1000)) {
          try {
            // Search for references to this symbol
            const references = await searchCode({
              cwd: searchCwd,
              pattern: symbol.name,
              isRegex: false,
              fileGlob,
              wholeWord: true,
              maxResults: 50,
            });

            // Filter out the definition itself
            const externalRefs = references.filter(
              (r: { file: string; line: number }) => !(r.file === symbol.file && r.line === symbol.line),
            );

            if (externalRefs.length === 0) {
              matches.push({
                file: symbol.file,
                line: symbol.line,
                match: `Unused export: ${symbol.name} (${symbol.kind})`,
              });
            }
          } catch {
            // Skip if reference finding fails
            continue;
          }
        }

        const output = matches.map((m) => `${m.file}:${m.line} │ ${m.match}`).join('\n');
        return {
          content: [
            { type: 'text', text: `Found ${matches.length} potentially unused exports:\n\n${output || 'None found'}` },
          ],
          structuredContent: {
            check: 'dead_code',
            matches,
            total: matches.length,
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `find_dead_code failed: ${(error as Error).message}` }],
          structuredContent: { check: 'dead_code', matches: [], total: 0 },
        };
      }
    },
  );
}
