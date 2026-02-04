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
import { generateHeatmap } from '../analyzers/complexity-heatmap.js';
import { analyzeTypeFlow } from '../analyzers/type-flow.js';
import { packContext } from '../analyzers/context-pack.js';
import { analytics } from '../utils/analytics.js';

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

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: complexity_heatmap — Rank files/functions by complexity
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'complexity_heatmap',
    {
      description:
        'Rank files and functions by cyclomatic/cognitive complexity. Returns graded hotspots (A–F), nesting depth, LOC, and parameter counts. Identifies the riskiest code at a glance.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze'),
        file_glob: z.string().optional().describe('File pattern, e.g. "**/*.ts"'),
        top: z.number().optional().describe('Number of hotspots to return (default: 20)'),
        granularity: z
          .enum(['file', 'function'])
          .optional()
          .describe('Granularity: file-level or function-level (default: function)'),
      },
      outputSchema: outputSchemas.complexity_heatmap,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('complexity_heatmap', async () => {
          const result = await generateHeatmap(CWD, {
            directory: params.directory,
            fileGlob: params.file_glob,
            top: params.top,
            granularity: params.granularity,
          });
          const lines: string[] = [`## Complexity Heatmap\n`];
          const s = result.summary;
          lines.push(
            `Files analyzed: ${s.totalFiles} | Average score: ${s.averageScore} | Critical: ${s.criticalCount} | Healthy: ${s.healthyCount}\n`,
          );
          if (result.hotspots.length > 0) {
            lines.push(`### Hotspots (function-level)`);
            for (const h of result.hotspots) {
              const icon = h.grade === 'F' ? '🔴' : h.grade === 'D' ? '🟠' : h.grade === 'C' ? '🟡' : '🟢';
              lines.push(
                `  ${icon} [${h.grade}] ${h.file}${h.symbol ? `:${h.line} ${h.symbol}()` : ''} — score ${h.score} (cyclo: ${h.metrics.cyclomatic}, cognitive: ${h.metrics.cognitive}, nesting: ${h.metrics.nesting}, LOC: ${h.metrics.loc}${h.metrics.params !== undefined ? `, params: ${h.metrics.params}` : ''})`,
              );
            }
            lines.push('');
          }
          if (result.fileScores.length > 0) {
            lines.push(`### File Scores`);
            for (const f of result.fileScores) {
              lines.push(`  [${f.grade}] ${f.file} — score ${f.score}, ${f.loc} LOC`);
            }
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              hotspots: result.hotspots.map((h) => ({ file: h.file, score: h.score, grade: h.grade })),
              summary: { totalFiles: s.totalFiles, criticalCount: s.criticalCount, averageScore: s.averageScore },
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `complexity_heatmap failed: ${(error as Error).message}` }],
          structuredContent: { hotspots: [], summary: { totalFiles: 0, criticalCount: 0, averageScore: 0 } },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: type_flow — Track where a type is defined, imported, and used
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'type_flow',
    {
      description:
        'Trace the flow of a type/interface across the codebase: where it is defined, imported, used as parameter, return type, extended, or referenced in generics. Answers "how is this type used everywhere?"',
      inputSchema: {
        type_name: z.string().describe('Name of the type/interface/class to trace'),
        directory: z.string().optional().describe('Subdirectory to search'),
      },
      outputSchema: outputSchemas.type_flow,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('type_flow', async () => {
          const result = await analyzeTypeFlow(CWD, params.type_name, { directory: params.directory });
          const lines: string[] = [`## Type Flow: ${result.typeName}\n`];
          if (result.definition) {
            lines.push(`Defined in: ${result.definition.file}:${result.definition.line}`);
            lines.push(`  \`${result.definition.code}\`\n`);
          } else {
            lines.push(`Definition: not found\n`);
          }
          const fs = result.flowSummary;
          lines.push(`Total usages: ${fs.totalUsages}`);
          if (fs.importedBy.length > 0) lines.push(`Imported by: ${fs.importedBy.join(', ')}`);
          if (fs.usedAsParam.length > 0) lines.push(`Used as parameter in: ${fs.usedAsParam.join(', ')}`);
          if (fs.usedAsReturn.length > 0) lines.push(`Used as return type in: ${fs.usedAsReturn.join(', ')}`);
          if (fs.extendedBy.length > 0) lines.push(`Extended by: ${fs.extendedBy.join(', ')}`);
          lines.push(`\n### All Usages`);
          for (const u of result.usages.slice(0, 50)) {
            lines.push(`  ${u.file}:${u.line} [${u.kind}] ${u.context.substring(0, 120)}`);
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              typeName: result.typeName,
              definedIn: result.definition?.file || 'not found',
              totalUsages: result.flowSummary.totalUsages,
              importedBy: result.flowSummary.importedBy,
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `type_flow failed: ${(error as Error).message}` }],
          structuredContent: { typeName: params.type_name || '', definedIn: '', totalUsages: 0, importedBy: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: context_pack — Smart context window packing for LLMs
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'context_pack',
    {
      description:
        'Pack the most relevant code context for a question within a token budget. Searches, scores by relevance, and assembles a minimal set of files/snippets that fit. Minimizes LLM context waste.',
      inputSchema: {
        query: z.string().describe('The question or task to find context for'),
        max_tokens: z.number().optional().describe('Token budget (default: 8000)'),
        include_imports: z.boolean().optional().describe('Include files imported by matched files (default: false)'),
        max_files: z.number().optional().describe('Max files to include (default: 20)'),
      },
      outputSchema: outputSchemas.context_pack,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('context_pack', async () => {
          const result = await packContext(CWD, {
            query: params.query,
            maxTokens: params.max_tokens,
            includeImports: params.include_imports,
            maxFiles: params.max_files,
          });
          const lines: string[] = [
            `## Context Pack for: "${params.query}"\n`,
            `Strategy: ${result.strategy}`,
            `Budget: ${result.totalTokens}/${result.budget} tokens used`,
            `Files: ${result.filesIncluded} included, ${result.filesSkipped} skipped\n`,
          ];
          for (const item of result.items) {
            const range =
              item.startLine !== undefined ? `:${item.startLine + 1}-${(item.endLine || item.startLine) + 1}` : '';
            lines.push(`### ${item.file}${range} (relevance: ${item.relevance.toFixed(2)}, ~${item.estimatedTokens} tokens)`);
            lines.push(`Reason: ${item.reason}\n`);
            lines.push('```');
            lines.push(item.content.substring(0, 2000));
            if (item.content.length > 2000) lines.push('... (truncated for display)');
            lines.push('```\n');
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              items: result.items.map((i) => ({
                file: i.file,
                relevance: i.relevance,
                estimatedTokens: i.estimatedTokens,
              })),
              totalTokens: result.totalTokens,
              budget: result.budget,
              filesIncluded: result.filesIncluded,
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `context_pack failed: ${(error as Error).message}` }],
          structuredContent: { items: [], totalTokens: 0, budget: 0, filesIncluded: 0 },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: code_ownership — Who owns which files (from git blame)
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'code_ownership',
    {
      description:
        'Determine code ownership per file or directory using git blame data. Shows top contributors, ownership concentration, and bus factor. Helps identify who to ask for code reviews.',
      inputSchema: {
        path: z.string().optional().describe('File or directory to analyze (default: whole project)'),
        top: z.number().optional().describe('Number of top owners to show per file (default: 3)'),
      },
      outputSchema: {
        owners: z.array(
          z.object({
            path: z.string(),
            topContributors: z.array(z.object({ name: z.string(), percentage: z.number() })),
            totalAuthors: z.number(),
          }),
        ),
        summary: z.object({
          totalFiles: z.number(),
          busFactor: z.number(),
          topOwners: z.array(z.object({ name: z.string(), fileCount: z.number() })),
        }),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('code_ownership', async () => {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          const topN = params.top || 3;
          const targetPath = params.path || '.';

          // Get list of files to analyze
          let files: string[];
          try {
            const { stdout } = await execFileAsync(
              'git',
              ['ls-files', '--', targetPath],
              { cwd: CWD, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
            );
            files = stdout.split('\n').filter(Boolean);
          } catch {
            files = await listFiles(CWD, { glob: '**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs}' });
            if (params.path) files = files.filter((f) => f.startsWith(params.path!));
          }

          const codeExts = /\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|cs|c|cpp|h|hpp|swift|kt|scala|vue|svelte)$/;
          files = files.filter((f) => codeExts.test(f)).slice(0, 200);

          const owners: Array<{
            path: string;
            topContributors: Array<{ name: string; percentage: number }>;
            totalAuthors: number;
          }> = [];
          const globalOwnership = new Map<string, number>();

          for (const file of files) {
            try {
              const { stdout } = await execFileAsync(
                'git',
                ['blame', '--line-porcelain', '--', file],
                { cwd: CWD, maxBuffer: 5 * 1024 * 1024, timeout: 10000 },
              );
              const authorCounts = new Map<string, number>();
              let totalLines = 0;
              for (const line of stdout.split('\n')) {
                if (line.startsWith('author ')) {
                  const author = line.substring(7).trim();
                  if (author && author !== 'Not Committed Yet') {
                    authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
                    totalLines++;
                  }
                }
              }

              if (totalLines > 0) {
                const sorted = Array.from(authorCounts.entries())
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, topN)
                  .map(([name, count]) => ({ name, percentage: Math.round((count / totalLines) * 100) }));
                owners.push({ path: file, topContributors: sorted, totalAuthors: authorCounts.size });

                // Track global ownership (who "owns" most files)
                const topAuthor = sorted[0]?.name;
                if (topAuthor) globalOwnership.set(topAuthor, (globalOwnership.get(topAuthor) || 0) + 1);
              }
            } catch {
              continue;
            }
          }

          // Calculate bus factor (how many people own >50% of files)
          const sortedGlobal = Array.from(globalOwnership.entries()).sort(([, a], [, b]) => b - a);
          let busFactor = 0;
          let cumulative = 0;
          const halfFiles = owners.length / 2;
          for (const [, count] of sortedGlobal) {
            cumulative += count;
            busFactor++;
            if (cumulative >= halfFiles) break;
          }

          const lines: string[] = [`## Code Ownership\n`];
          lines.push(`Files analyzed: ${owners.length} | Unique authors: ${sortedGlobal.length} | Bus factor: ${busFactor}\n`);
          lines.push(`### Top Owners (by primary file count)`);
          for (const [name, count] of sortedGlobal.slice(0, 10)) {
            lines.push(`  ${name}: ${count} files (${Math.round((count / owners.length) * 100)}%)`);
          }
          lines.push(`\n### File Ownership`);
          for (const o of owners.slice(0, 30)) {
            const contribs = o.topContributors.map((c) => `${c.name} ${c.percentage}%`).join(', ');
            lines.push(`  ${o.path} — ${contribs} (${o.totalAuthors} author${o.totalAuthors > 1 ? 's' : ''})`);
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              owners: owners.slice(0, 50),
              summary: {
                totalFiles: owners.length,
                busFactor,
                topOwners: sortedGlobal.slice(0, 10).map(([name, fileCount]) => ({ name, fileCount })),
              },
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `code_ownership failed: ${(error as Error).message}` }],
          structuredContent: { owners: [], summary: { totalFiles: 0, busFactor: 0, topOwners: [] } },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: import_cycles — Detect circular import chains
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'import_cycles',
    {
      description:
        'Detect circular import chains in the codebase. Finds A→B→C→A dependency cycles that cause initialization issues, bundler problems, and tight coupling.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to scan'),
        max_depth: z.number().optional().describe('Maximum cycle length to detect (default: 6)'),
      },
      outputSchema: {
        cycles: z.array(z.object({ chain: z.array(z.string()), length: z.number() })),
        totalCycles: z.number(),
        affectedFiles: z.number(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('import_cycles', async () => {
          const targetDir = params.directory ? safePath(params.directory) : CWD;
          const maxDepth = params.max_depth || 6;
          const files = await listFiles(targetDir, { glob: '**/*.{ts,tsx,js,jsx,py,go,java,rs}' });

          // Build adjacency list from imports
          const graph = new Map<string, string[]>();
          for (const file of files.slice(0, 500)) {
            try {
              const imports = await extractImports(path.join(targetDir, file));
              const resolved: string[] = [];
              for (const imp of imports) {
                if (!imp.startsWith('.')) continue;
                const dir = path.dirname(file);
                let candidate = path.join(dir, imp).replace(/\\/g, '/');
                // Try to find matching file
                const match = files.find(
                  (f) =>
                    f === candidate ||
                    f === candidate + '.ts' ||
                    f === candidate + '.tsx' ||
                    f === candidate + '.js' ||
                    f === candidate + '.jsx' ||
                    f === candidate + '/index.ts' ||
                    f === candidate + '/index.js',
                );
                if (match) resolved.push(match);
              }
              if (resolved.length > 0) graph.set(file, resolved);
            } catch {
              continue;
            }
          }

          // DFS-based cycle detection
          const cycles: Array<{ chain: string[]; length: number }> = [];
          const visited = new Set<string>();
          const inStack = new Set<string>();
          const stack: string[] = [];
          const seenCycles = new Set<string>();

          function dfs(node: string, depth: number): void {
            if (depth > maxDepth) return;
            if (inStack.has(node)) {
              // Found a cycle
              const cycleStart = stack.indexOf(node);
              if (cycleStart >= 0) {
                const chain = [...stack.slice(cycleStart), node];
                const key = [...chain].sort().join('|');
                if (!seenCycles.has(key)) {
                  seenCycles.add(key);
                  cycles.push({ chain, length: chain.length - 1 });
                }
              }
              return;
            }
            if (visited.has(node)) return;

            visited.add(node);
            inStack.add(node);
            stack.push(node);

            for (const neighbor of graph.get(node) || []) {
              dfs(neighbor, depth + 1);
            }

            stack.pop();
            inStack.delete(node);
          }

          for (const node of graph.keys()) {
            if (!visited.has(node)) dfs(node, 0);
          }

          // Sort by cycle length
          cycles.sort((a, b) => a.length - b.length);

          const affectedFiles = new Set(cycles.flatMap((c) => c.chain));

          const lines: string[] = [`## Import Cycles\n`];
          lines.push(`Found ${cycles.length} circular import chains affecting ${affectedFiles.size} files\n`);

          if (cycles.length === 0) {
            lines.push('No circular imports detected.');
          } else {
            for (const cycle of cycles.slice(0, 20)) {
              lines.push(`  ${cycle.chain.join(' → ')} (length ${cycle.length})`);
            }
            if (cycles.length > 20) lines.push(`  ... and ${cycles.length - 20} more`);
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              cycles: cycles.slice(0, 50),
              totalCycles: cycles.length,
              affectedFiles: affectedFiles.size,
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `import_cycles failed: ${(error as Error).message}` }],
          structuredContent: { cycles: [], totalCycles: 0, affectedFiles: 0 },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: tech_debt_score — Aggregate code quality into a single score
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'tech_debt_score',
    {
      description:
        'Calculate an aggregate technical debt score (0–100) by combining metrics: complexity hotspots, large files, long functions, TODOs, debug logs, empty catches, and dead code. Provides a single health indicator.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze'),
      },
      outputSchema: {
        score: z.number(),
        grade: z.string(),
        breakdown: z.array(
          z.object({ category: z.string(), score: z.number(), count: z.number(), weight: z.number() }),
        ),
        summary: z.string(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('tech_debt_score', async () => {
          const searchCwd = params.directory ? safePath(params.directory) : CWD;
          const breakdown: Array<{ category: string; score: number; count: number; weight: number }> = [];

          // 1. Complexity hotspots
          const heatmap = await generateHeatmap(searchCwd, { top: 50, granularity: 'file' });
          const complexityScore = Math.min(100, heatmap.summary.criticalCount * 10);
          breakdown.push({ category: 'Complexity hotspots', score: complexityScore, count: heatmap.summary.criticalCount, weight: 25 });

          // 2. TODOs/FIXMEs
          const todos = await searchCode({
            cwd: searchCwd,
            pattern: '(//|/\\*|#|<!--).*?(TODO|FIXME|HACK|XXX|BUG)\\b',
            isRegex: true,
            maxResults: 200,
          });
          const todoScore = Math.min(100, todos.length * 2);
          breakdown.push({ category: 'TODOs/FIXMEs', score: todoScore, count: todos.length, weight: 10 });

          // 3. Debug logs
          const debugLogs = await searchCode({
            cwd: searchCwd,
            pattern: 'console\\.(log|debug)|print\\(|println!|fmt\\.Print|System\\.out',
            isRegex: true,
            maxResults: 200,
          });
          const debugScore = Math.min(100, debugLogs.length * 1);
          breakdown.push({ category: 'Debug logs in source', score: debugScore, count: debugLogs.length, weight: 10 });

          // 4. Large files (>300 lines)
          const fileGlob = '**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs}';
          const allFiles = await listFiles(searchCwd, { glob: fileGlob });
          let largeFileCount = 0;
          for (const file of allFiles.slice(0, 500)) {
            try {
              const content = await readFile(path.join(searchCwd, file), 'utf-8');
              if (content.split('\n').length > 300) largeFileCount++;
            } catch {
              continue;
            }
          }
          const largeFileScore = Math.min(100, largeFileCount * 5);
          breakdown.push({ category: 'Large files (>300 LOC)', score: largeFileScore, count: largeFileCount, weight: 15 });

          // 5. Hardcoded secrets
          const secrets = await searchCode({
            cwd: searchCwd,
            pattern: '(password|secret|api_key|apikey|token|credential)\\s*[:=]\\s*["\'][^"\']+["\']',
            isRegex: true,
            caseSensitive: false,
            maxResults: 50,
          });
          const secretScore = Math.min(100, secrets.length * 10);
          breakdown.push({ category: 'Hardcoded secrets', score: secretScore, count: secrets.length, weight: 20 });

          // 6. Long functions (>50 lines) — approximate by checking heatmap function granularity
          const fnHeatmap = await generateHeatmap(searchCwd, { top: 50, granularity: 'function' });
          const longFunctions = fnHeatmap.hotspots.filter((h) => h.metrics.loc > 50);
          const longFnScore = Math.min(100, longFunctions.length * 5);
          breakdown.push({ category: 'Long functions (>50 LOC)', score: longFnScore, count: longFunctions.length, weight: 20 });

          // Calculate weighted total (0 = perfect, 100 = worst)
          const totalWeight = breakdown.reduce((sum, b) => sum + b.weight, 0);
          const weightedScore = Math.round(
            breakdown.reduce((sum, b) => sum + (b.score * b.weight) / totalWeight, 0),
          );

          // Invert to health score (100 = perfect, 0 = worst)
          const healthScore = 100 - weightedScore;
          const healthGrade =
            healthScore >= 80 ? 'A' : healthScore >= 60 ? 'B' : healthScore >= 40 ? 'C' : healthScore >= 20 ? 'D' : 'F';

          const lines: string[] = [`## Technical Debt Score: ${healthScore}/100 [${healthGrade}]\n`];
          const barFull = Math.round(healthScore / 5);
          const bar = '█'.repeat(barFull) + '░'.repeat(20 - barFull);
          lines.push(`  [${bar}] ${healthScore}%\n`);
          lines.push(`### Breakdown`);
          for (const b of breakdown) {
            const icon = b.score <= 20 ? '🟢' : b.score <= 50 ? '🟡' : '🔴';
            lines.push(`  ${icon} ${b.category}: ${b.count} found (debt: ${b.score}/100, weight: ${b.weight}%)`);
          }
          const summary =
            healthScore >= 80
              ? 'Healthy codebase with low technical debt.'
              : healthScore >= 60
                ? 'Moderate technical debt. Consider addressing critical hotspots.'
                : healthScore >= 40
                  ? 'Significant technical debt. Prioritize cleanup of secrets, complexity, and large files.'
                  : 'High technical debt. Immediate action recommended on security and code quality.';
          lines.push(`\n${summary}`);

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: { score: healthScore, grade: healthGrade, breakdown, summary },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `tech_debt_score failed: ${(error as Error).message}` }],
          structuredContent: { score: 0, grade: 'F', breakdown: [], summary: 'Analysis failed' },
        };
      }
    },
  );
}
