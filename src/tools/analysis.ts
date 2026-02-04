import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { extractCallGraph, isTreeSitterReady } from '../analyzers/tree-sitter.js';
import { parseCoverage, getFileCoverage, getUntestedFiles, findTestFiles } from '../analyzers/coverage.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, ROOTS, IS_MULTI_ROOT, safePath } from '../config.js';
import { mapCodebase } from '../analyzers/codebase.js';
import { analyzeFile, formatFileOutline, extractImports } from '../analyzers/symbols.js';
import { searchCode, listFiles } from '../search/fast-search.js';
import { detectLanguage } from '../utils/languages.js';

/**
 * Registers analysis tools for codebase mapping, file analysis, dependency graphing, metrics, call graphs, and test coverage.
 * @param server - The MCP server instance to register tools on.
 */
export function registerAnalysisTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: codebase_map — Full codebase overview
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'codebase_map',
    {
      description:
        'Generate a comprehensive overview of the entire codebase: languages, frameworks, directory structure, file counts, infrastructure (tests, CI, Docker). Essential first step for understanding any project.',
      outputSchema: outputSchemas.codebase_map,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (IS_MULTI_ROOT) {
          const parts: string[] = [`## Multi-Root Workspace (${ROOTS.length} roots)\n`];
          for (const root of ROOTS) {
            const { tree, summary } = await mapCodebase(root);
            parts.push(`### Root: ${root}\n${summary}\n\n#### Directory Tree\n\`\`\`\n${tree}\n\`\`\`\n`);
          }
          return {
            content: [{ type: 'text', text: parts.join('\n') }],
            structuredContent: { summary: parts.join('\n'), tree: '', roots: ROOTS.length },
          };
        }
        const { tree, summary } = await mapCodebase(CWD);
        return {
          content: [
            {
              type: 'text',
              text: `${summary}\n\n### Directory Tree\n\`\`\`\n${tree}\n\`\`\``,
            },
          ],
          structuredContent: { summary, tree, roots: 1 },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `codebase_map failed: ${(error as Error).message}. Ensure the working directory is a valid project. Check that the path is accessible.`,
            },
          ],
          structuredContent: { summary: '', tree: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: analyze_file — Deep analysis of a single file
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'analyze_file',
    {
      description:
        'Deep analysis of a single file: symbols (functions, classes, types), imports, line counts, complexity score, and full structural outline.',
      inputSchema: {
        path: z.string().describe('File path relative to project root'),
      },
      outputSchema: outputSchemas.analyze_file,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const filePath = safePath(params.path);
        const analysis = await analyzeFile(filePath);
        const outline = formatFileOutline(analysis);
        return {
          content: [{ type: 'text', text: outline }],
          structuredContent: {
            file: params.path,
            language: analysis.language || 'unknown',
            lines: analysis.lines || 0,
            outline,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `analyze_file failed: ${(error as Error).message}. Verify the file path is correct and relative to the project root. Use file_tree to list available files.`,
            },
          ],
          structuredContent: { file: params.path || '', language: 'unknown', lines: 0, outline: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: dependency_graph — Analyze imports and dependencies
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'dependency_graph',
    {
      description:
        'Analyze import relationships and dependencies. Shows what each file imports and what imports it. Useful for understanding code architecture and impact of changes.',
      inputSchema: {
        file: z.string().optional().describe('Analyze dependencies for a specific file'),
        directory: z.string().optional().describe('Analyze all files in a directory'),
        language: z.string().optional().describe('Filter by language'),
        max_files: z.number().optional().describe('Max files to analyze (default: 100)'),
      },
      outputSchema: outputSchemas.dependency_graph,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (params.file) {
          // Single file dependency analysis
          const filePath = safePath(params.file);
          const imports = await extractImports(filePath);

          // Also find what imports this file
          const baseName = path.basename(params.file, path.extname(params.file));
          const importedBy = await searchCode({
            cwd: CWD,
            pattern: baseName,
            isRegex: false,
            maxResults: 50,
          });
          const importers = importedBy
            .filter((r) => r.file !== params.file && r.text.match(/import|require|from|use|include/))
            .map((r) => `  ${r.file}:${r.line}`);

          let output = `📄 ${params.file}\n\n`;
          output += `### Imports (${imports.length}):\n${imports.map((i) => `  → ${i}`).join('\n') || '  (none)'}\n\n`;
          output += `### Imported by (${importers.length}):\n${importers.join('\n') || '  (none)'}`;

          return {
            content: [{ type: 'text', text: output }],
            structuredContent: { file: params.file!, imports, importers: importers.map((i) => i.trim()) },
          };
        }

        // Directory-wide analysis
        let files = await listFiles(CWD, { type: 'file' });
        if (params.directory) files = files.filter((f) => f.startsWith(params.directory!));
        if (params.language) files = files.filter((f) => detectLanguage(f) === params.language);
        files = files.filter((f) => detectLanguage(f) !== 'unknown').slice(0, params.max_files || 100);

        const graph: { file: string; imports: string[] }[] = [];
        for (const file of files) {
          try {
            const imports = await extractImports(path.join(CWD, file));
            if (imports.length > 0) graph.push({ file, imports });
          } catch {
            /* skip */
          }
        }

        const output = graph
          .map(({ file, imports }) => `${file}\n${imports.map((i) => `  → ${i}`).join('\n')}`)
          .join('\n\n');

        return {
          content: [
            {
              type: 'text',
              text: `Dependency graph (${graph.length} files with imports):\n\n${output}`,
            },
          ],
          structuredContent: { file: params.directory || '.', imports: graph.flatMap((g) => g.imports), importers: [] },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `dependency_graph failed: ${(error as Error).message}. Verify file/directory exists. Use file_tree to discover project structure.`,
            },
          ],
          structuredContent: { file: params.file || '', imports: [], importers: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: code_metrics — Codebase-wide metrics and statistics
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'code_metrics',
    {
      description:
        'Calculate code metrics: lines of code, comment ratios, complexity scores, file size distribution. Works per-file, per-directory, or codebase-wide.',
      inputSchema: {
        path: z.string().optional().describe('File or directory to analyze (default: entire codebase)'),
        language: z.string().optional().describe('Filter by language'),
        sort_by: z
          .enum(['lines', 'complexity', 'size', 'name'])
          .optional()
          .describe('Sort files by metric (default: lines)'),
      },
      outputSchema: outputSchemas.code_metrics,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const targetPath = params.path ? safePath(params.path) : CWD;
        const fileStat = await stat(targetPath);

        if (fileStat.isFile()) {
          const analysis = await analyzeFile(targetPath);
          return {
            content: [{ type: 'text', text: formatFileOutline(analysis) }],
            structuredContent: {
              totalFiles: 1,
              totalLines: analysis.lines || 0,
              languages: {},
              blankLines: analysis.blankLines || 0,
              commentLines: analysis.commentLines || 0,
            },
          };
        }

        // Directory metrics
        let files = await listFiles(targetPath, { type: 'file' });
        files = files.filter((f) => detectLanguage(f) !== 'unknown');
        if (params.language) files = files.filter((f) => detectLanguage(f) === params.language);
        // Limit for performance
        files = files.slice(0, 300);

        const analyses: {
          file: string;
          lines: number;
          codeLines: number;
          commentLines: number;
          complexity: number;
          size: number;
        }[] = [];

        for (const file of files) {
          try {
            const analysis = await analyzeFile(path.join(targetPath, file));
            analyses.push({
              file,
              lines: analysis.lines,
              codeLines: analysis.codeLines,
              commentLines: analysis.commentLines,
              complexity: analysis.complexity,
              size: analysis.size,
            });
          } catch {
            /* skip */
          }
        }

        // Sort
        const sortKey = params.sort_by || 'lines';
        analyses.sort((a, b) => {
          if (sortKey === 'name') return a.file.localeCompare(b.file);
          const key = sortKey === 'lines' ? 'codeLines' : sortKey;
          return (b[key as keyof typeof b] as number) - (a[key as keyof typeof a] as number);
        });

        // Totals
        const totals = analyses.reduce(
          (acc, a) => ({
            lines: acc.lines + a.lines,
            code: acc.code + a.codeLines,
            comments: acc.comments + a.commentLines,
            avgComplexity: acc.avgComplexity + a.complexity,
          }),
          { lines: 0, code: 0, comments: 0, avgComplexity: 0 },
        );

        let output = `## Code Metrics${params.path ? ` — ${params.path}` : ''}\n`;
        output += `Total: ${totals.lines} lines (${totals.code} code, ${totals.comments} comments) across ${analyses.length} files\n`;
        output += `Comment ratio: ${totals.lines > 0 ? Math.round((totals.comments / totals.lines) * 100) : 0}%\n`;
        output += `Avg complexity: ${analyses.length > 0 ? Math.round(totals.avgComplexity / analyses.length) : 0}\n\n`;

        output += `### Top files by ${sortKey}\n`;
        output += analyses
          .slice(0, 30)
          .map((a) => `  ${a.file.padEnd(50)} ${String(a.codeLines).padStart(6)} loc  complexity: ${a.complexity}`)
          .join('\n');

        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            totalFiles: analyses.length,
            totalLines: totals.lines,
            languages: {},
            blankLines: 0,
            commentLines: totals.comments,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `code_metrics failed: ${(error as Error).message}. Verify the path exists. For directories, ensure it contains recognized source files.`,
            },
          ],
          structuredContent: { totalFiles: 0, totalLines: 0, languages: {}, blankLines: 0, commentLines: 0 },
        };
      }
    },
  );
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: call_graph — Who calls what (tree-sitter or regex)
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'call_graph',
    {
      description:
        'Extract function call relationships. Shows which functions call which others. Uses tree-sitter AST when available, falls back to regex.',
      inputSchema: {
        file: z.string().describe('File to analyze'),
        function_name: z.string().optional().describe('Filter to calls from/to this function'),
        direction: z
          .enum(['callers', 'callees', 'both'])
          .optional()
          .describe('Direction: who calls it (callers), what it calls (callees), or both (default: both)'),
      },
      outputSchema: outputSchemas.call_graph,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const filePath = safePath(params.file);
        const language = detectLanguage(params.file);
        const direction = params.direction || 'both';

        // Try tree-sitter first
        let calls = await extractCallGraph(filePath, language);

        // Fallback: regex-based call extraction
        if (!calls) {
          const content = await readFile(filePath, 'utf-8');
          const lines = content.split('\n');
          calls = [];
          let currentFunc = '<module>';

          const funcDef = /(?:function|def|fn|func|async\s+function)\s+(\w+)/;
          const callPattern = /(\w+)\s*\(/g;

          for (let i = 0; i < lines.length; i++) {
            const defMatch = lines[i].match(funcDef);
            if (defMatch) currentFunc = defMatch[1];

            let m;
            while ((m = callPattern.exec(lines[i])) !== null) {
              const callee = m[1];
              if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'console'].includes(callee)) {
                calls.push({ caller: currentFunc, callee, file: params.file, line: i + 1 });
              }
            }
          }
        }

        // Filter by function name
        if (params.function_name) {
          if (direction === 'callers' || direction === 'both') {
            const callers = calls.filter((c) => c.callee === params.function_name);
            if (direction === 'callers') calls = callers;
          }
          if (direction === 'callees' || direction === 'both') {
            const callees = calls.filter((c) => c.caller === params.function_name);
            if (direction === 'callees') calls = callees;
            else calls = [...calls.filter((c) => c.callee === params.function_name), ...callees];
          }
        }

        // Deduplicate
        const unique = new Map<string, (typeof calls)[0]>();
        for (const c of calls) unique.set(`${c.caller}->${c.callee}`, c);
        const dedupCalls = [...unique.values()];

        // Format output
        const callerGroups = new Map<string, string[]>();
        for (const c of dedupCalls) {
          if (!callerGroups.has(c.caller)) callerGroups.set(c.caller, []);
          callerGroups.get(c.caller)!.push(`→ ${c.callee} (L${c.line})`);
        }

        let output = `Call graph for ${params.file}${params.function_name ? ` (${params.function_name})` : ''}\n`;
        output += `${dedupCalls.length} call relationships found${isTreeSitterReady() ? ' (tree-sitter AST)' : ' (regex fallback)'}:\n\n`;

        for (const [caller, callees] of callerGroups) {
          output += `${caller}:\n${callees.map((c) => `  ${c}`).join('\n')}\n\n`;
        }

        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            file: params.file,
            functions: Array.from(callerGroups).map(([name, calls]) => ({ name, calls, calledBy: [] })),
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `call_graph failed: ${(error as Error).message}. Verify the file exists. Use file_tree to discover files.`,
            },
          ],
          structuredContent: { file: params.file || '', functions: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: test_coverage — Test coverage analysis
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'test_coverage',
    {
      description:
        'Analyze test coverage. Reads lcov, istanbul, and cobertura formats. Shows covered/uncovered lines, untested functions, and coverage percentages.',
      inputSchema: {
        action: z
          .enum(['summary', 'file', 'untested', 'test_files'])
          .describe(
            'summary: overall coverage stats, file: coverage for specific file, untested: list uncovered files, test_files: find test files',
          ),
        file: z.string().optional().describe('File path for file-specific coverage'),
      },
      outputSchema: outputSchemas.test_coverage,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (params.action === 'test_files') {
          const testFiles = await findTestFiles(CWD);
          return {
            content: [{ type: 'text', text: `Found ${testFiles.length} test files:\n\n${testFiles.join('\n')}` }],
            structuredContent: { action: 'test_files', data: { files: testFiles } },
          };
        }

        const coverage = await parseCoverage(CWD);
        if (!coverage) {
          return {
            content: [
              {
                type: 'text',
                text: 'No coverage data found. Run your test suite with coverage enabled first (e.g. "jest --coverage", "pytest --cov", "go test -coverprofile"). Supported formats: lcov, istanbul JSON, cobertura XML.',
              },
            ],
            structuredContent: { action: 'summary', data: { files: [] } },
          };
        }

        switch (params.action) {
          case 'summary': {
            let output = `## Test Coverage (${coverage.format})\n\n`;
            output += `Files: ${coverage.totalFiles}\n`;
            output += `Lines: ${coverage.lines.covered}/${coverage.lines.total} (${coverage.lines.percentage}%)\n`;
            output += `Functions: ${coverage.functions.covered}/${coverage.functions.total} (${coverage.functions.percentage}%)\n`;
            output += `Branches: ${coverage.branches.covered}/${coverage.branches.total} (${coverage.branches.percentage}%)\n\n`;
            output += `### Lowest coverage files:\n`;
            output += coverage.files
              .slice(0, 15)
              .map(
                (f) =>
                  `  ${f.file.padEnd(50)} ${String(f.lines.percentage).padStart(3)}% lines  ${String(f.functions.percentage).padStart(3)}% funcs`,
              )
              .join('\n');
            return {
              content: [{ type: 'text', text: output }],
              structuredContent: {
                action: 'summary',
                data: {
                  files: coverage.files.slice(0, 15).map((f) => ({
                    file: f.file,
                    linesPercent: f.lines.percentage,
                    funcsPercent: f.functions.percentage,
                  })),
                },
              },
            };
          }

          case 'file': {
            if (!params.file)
              return {
                content: [{ type: 'text', text: 'File path required for file-specific coverage.' }],
                structuredContent: { action: 'file', data: {} },
              };
            const fc = getFileCoverage(coverage, params.file);
            if (!fc)
              return {
                content: [
                  {
                    type: 'text',
                    text: `No coverage data for "${params.file}". Ensure the file is included in coverage reports.`,
                  },
                ],
                structuredContent: { action: 'file', data: { files: [] } },
              };

            let output = `Coverage for ${fc.file}:\n`;
            output += `  Lines: ${fc.lines.covered}/${fc.lines.total} (${fc.lines.percentage}%)\n`;
            output += `  Functions: ${fc.functions.covered}/${fc.functions.total} (${fc.functions.percentage}%)\n`;
            output += `  Branches: ${fc.branches.covered}/${fc.branches.total} (${fc.branches.percentage}%)\n`;
            if (fc.uncoveredLines.length > 0)
              output += `  Uncovered lines: ${fc.uncoveredLines.slice(0, 50).join(', ')}${fc.uncoveredLines.length > 50 ? '...' : ''}\n`;
            if (fc.uncoveredFunctions.length > 0)
              output += `  Untested functions: ${fc.uncoveredFunctions.join(', ')}\n`;
            return {
              content: [{ type: 'text', text: output }],
              structuredContent: {
                action: 'file',
                data: {
                  files: [
                    { file: params.file, linesPercent: fc.lines.percentage, funcsPercent: fc.functions.percentage },
                  ],
                },
              },
            };
          }

          case 'untested': {
            const untested = getUntestedFiles(coverage);
            return {
              content: [{ type: 'text', text: `${untested.length} files with 0% coverage:\n\n${untested.join('\n')}` }],
              structuredContent: { action: 'untested', data: { files: untested } },
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown action: ${params.action}` }],
              structuredContent: { action: params.action || 'unknown', data: {} },
            };
        }
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `test_coverage failed: ${(error as Error).message}. Ensure coverage reports exist in the project.`,
            },
          ],
          structuredContent: { action: params.action || 'error', data: {} },
        };
      }
    },
  );
}
