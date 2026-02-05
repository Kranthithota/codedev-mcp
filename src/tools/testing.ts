import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { analyzeTestGaps, analyzeTestImpact, analyzeTestHealth, buildTestCodeMapping } from '../analyzers/test-intelligence.js';

/**
 * Registers test intelligence tools for gap analysis, impact analysis, health reporting, and test-to-code mapping.
 * @param server - The MCP server instance to register tools on.
 */
export function registerTestingTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: test_gap_analysis — Identify source files lacking test coverage
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'test_gap_analysis',
    {
      description:
        'Identify source files that lack adequate test coverage. For each source file, searches for matching test files by naming convention, verifies import relationships, checks exported symbols against test content, and optionally incorporates line-level coverage data. Returns risk-ranked gaps with recommendations.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
        file_glob: z.string().optional().describe('Glob pattern for source files, e.g. "**/*.ts"'),
      },
      outputSchema: outputSchemas.test_gap_analysis,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeTestGaps(cwd, {
          fileGlob: params.file_glob,
        });

        const lines: string[] = [`## Test Gap Analysis\n`];

        // Summary
        const s = result.summary;
        lines.push(`### Summary`);
        lines.push(`  Source files analyzed: ${s.totalSourceFiles}`);
        lines.push(`  Files with tests: ${s.filesWithTests} | Files without tests: ${s.filesWithoutTests}`);
        lines.push(`  Coverage data: ${s.coverageAvailable ? `available (${s.overallCoverage}% overall)` : 'not available'}`);
        lines.push('');

        // Gaps by risk level
        const highRisk = result.gaps.filter((g) => g.riskLevel === 'high');
        const mediumRisk = result.gaps.filter((g) => g.riskLevel === 'medium');
        const lowRisk = result.gaps.filter((g) => g.riskLevel === 'low');

        if (highRisk.length > 0) {
          lines.push(`### High Risk (${highRisk.length} files — no tests)`);
          for (const g of highRisk.slice(0, 20)) {
            lines.push(`  🔴 ${g.sourceFile}`);
            if (g.untestedExports.length > 0) {
              lines.push(`     Untested exports: ${g.untestedExports.slice(0, 5).join(', ')}${g.untestedExports.length > 5 ? '...' : ''}`);
            }
          }
          if (highRisk.length > 20) lines.push(`  ... and ${highRisk.length - 20} more`);
          lines.push('');
        }

        if (mediumRisk.length > 0) {
          lines.push(`### Medium Risk (${mediumRisk.length} files — partial coverage)`);
          for (const g of mediumRisk.slice(0, 15)) {
            const covStr = g.coveragePercent !== undefined ? ` (${g.coveragePercent}% line coverage)` : '';
            lines.push(`  🟡 ${g.sourceFile}${covStr}`);
            if (g.untestedExports.length > 0) {
              lines.push(`     Untested exports: ${g.untestedExports.slice(0, 5).join(', ')}${g.untestedExports.length > 5 ? '...' : ''}`);
            }
          }
          if (mediumRisk.length > 15) lines.push(`  ... and ${mediumRisk.length - 15} more`);
          lines.push('');
        }

        if (lowRisk.length > 0) {
          lines.push(`### Low Risk (${lowRisk.length} files — well tested)`);
          lines.push(`  ${lowRisk.slice(0, 10).map((g) => g.sourceFile).join(', ')}${lowRisk.length > 10 ? '...' : ''}`);
          lines.push('');
        }

        // Recommendations
        if (result.recommendations.length > 0) {
          lines.push(`### Recommendations`);
          for (const rec of result.recommendations) {
            lines.push(`  * ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            gaps: result.gaps.map((g) => ({
              sourceFile: g.sourceFile,
              hasTestFile: g.hasTestFile,
              riskLevel: g.riskLevel,
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
              text: `test_gap_analysis failed: ${(error as Error).message}. Verify the directory contains source files. Use codebase_map to explore project structure.`,
            },
          ],
          structuredContent: { gaps: [], summary: {}, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: test_impact_analysis — Determine which tests to run for changes
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'test_impact_analysis',
    {
      description:
        'Determine which tests to run based on a set of changed files. Finds direct test importers, builds a one-hop reverse import graph for transitive dependents, and checks naming conventions for co-located tests. Returns a prioritized list with scope estimation and suggested test commands.',
      inputSchema: {
        changed_files: z.array(z.string()).describe('List of changed file paths (relative to project root)'),
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.test_impact_analysis,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeTestImpact(cwd, params.changed_files);

        const lines: string[] = [`## Test Impact Analysis\n`];

        // Overview
        lines.push(`Changed files: ${params.changed_files.length}`);
        lines.push(`Tests to run: ${result.allTestsToRun.length} / ${result.totalTestFiles} total test files`);
        lines.push(`Estimated scope: ${result.estimatedScope}`);
        lines.push('');

        // Per-file breakdown
        if (result.impacts.length > 0) {
          lines.push(`### Impact Breakdown`);
          for (const impact of result.impacts) {
            lines.push(`  ${impact.changedFile}`);
            if (impact.directTests.length > 0) {
              lines.push(`    Direct tests (${impact.directTests.length}): ${impact.directTests.slice(0, 5).join(', ')}${impact.directTests.length > 5 ? '...' : ''}`);
            }
            if (impact.transitiveTests.length > 0) {
              lines.push(`    Transitive tests (${impact.transitiveTests.length}): ${impact.transitiveTests.slice(0, 5).join(', ')}${impact.transitiveTests.length > 5 ? '...' : ''}`);
            }
            if (impact.directTests.length === 0 && impact.transitiveTests.length === 0) {
              lines.push(`    No related tests found`);
            }
            if (impact.suggestedTestCommand) {
              lines.push(`    Suggested command: ${impact.suggestedTestCommand}`);
            }
          }
          lines.push('');
        }

        // All tests to run
        if (result.allTestsToRun.length > 0) {
          lines.push(`### All Tests to Run (${result.allTestsToRun.length})`);
          for (const t of result.allTestsToRun.slice(0, 30)) {
            lines.push(`  ${t}`);
          }
          if (result.allTestsToRun.length > 30) {
            lines.push(`  ... and ${result.allTestsToRun.length - 30} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            impacts: result.impacts.map((i) => ({
              changedFile: i.changedFile,
              directTests: i.directTests,
            })),
            allTestsToRun: result.allTestsToRun,
            estimatedScope: result.estimatedScope,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `test_impact_analysis failed: ${(error as Error).message}. Verify the changed file paths are relative to the project root. Use file_tree to confirm file paths.`,
            },
          ],
          structuredContent: { impacts: [], allTestsToRun: [], estimatedScope: 'minimal' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: test_health_report — Assess test suite quality and anti-patterns
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'test_health_report',
    {
      description:
        'Analyze test suite quality by scanning for anti-patterns (setTimeout, unmocked network calls, .skip/.only, empty tests, sleep/delay, console.log). Counts test cases, checks for describe/it nesting and cleanup hooks. Returns a health score (0-100), letter grade (A-F), and categorized findings.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.test_health_report,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeTestHealth(cwd);

        const lines: string[] = [`## Test Health Report: ${result.healthScore}/100 [${result.grade}]\n`];

        // Score bar
        const barFull = Math.round(result.healthScore / 5);
        const bar = '█'.repeat(barFull) + '░'.repeat(20 - barFull);
        lines.push(`  [${bar}] ${result.healthScore}%\n`);

        // Overview
        lines.push(`### Overview`);
        lines.push(`  Test files: ${result.totalTestFiles}`);
        lines.push(`  Test cases: ${result.totalTestCases}`);
        lines.push(`  Anti-patterns found: ${result.antiPatterns.length}`);
        lines.push('');

        // Summary by severity
        const bs = result.summary.bySeverity;
        if (Object.values(bs).some((v) => v > 0)) {
          lines.push(`### By Severity`);
          if (bs.error) lines.push(`  🔴 Errors: ${bs.error}`);
          if (bs.warning) lines.push(`  🟡 Warnings: ${bs.warning}`);
          if (bs.info) lines.push(`  🔵 Info: ${bs.info}`);
          lines.push('');
        }

        // Summary by pattern
        const bp = result.summary.byPattern;
        if (Object.keys(bp).length > 0) {
          lines.push(`### By Pattern`);
          for (const [pattern, count] of Object.entries(bp).sort(([, a], [, b]) => b - a)) {
            lines.push(`  ${pattern}: ${count}`);
          }
          lines.push('');
        }

        // Top anti-patterns
        if (result.antiPatterns.length > 0) {
          lines.push(`### Anti-Patterns (top 25)`);
          for (const ap of result.antiPatterns.slice(0, 25)) {
            const icon = ap.severity === 'error' ? '🔴' : ap.severity === 'warning' ? '🟡' : '🔵';
            lines.push(`  ${icon} ${ap.file}:${ap.line} [${ap.pattern}]`);
            lines.push(`     ${ap.description}`);
            lines.push(`     Fix: ${ap.suggestion}`);
          }
          if (result.antiPatterns.length > 25) {
            lines.push(`  ... and ${result.antiPatterns.length - 25} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            totalTestFiles: result.totalTestFiles,
            antiPatterns: result.antiPatterns.map((ap) => ({
              file: ap.file,
              pattern: ap.pattern,
              severity: ap.severity,
            })),
            healthScore: result.healthScore,
            grade: result.grade,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `test_health_report failed: ${(error as Error).message}. Verify the directory contains test files. Use test_gap_analysis to discover test file locations.`,
            },
          ],
          structuredContent: { totalTestFiles: 0, antiPatterns: [], healthScore: 0, grade: 'F' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: test_to_code_mapping — Bidirectional source-to-test file mapping
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'test_to_code_mapping',
    {
      description:
        'Build a bidirectional mapping between source files and their test files. Uses three strategies: import analysis (high confidence), naming convention matching (medium confidence), and directory structure proximity (low confidence). Also identifies orphan tests and untested source files.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.test_to_code_mapping,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await buildTestCodeMapping(cwd);

        const lines: string[] = [`## Test-to-Code Mapping\n`];

        // Summary
        const s = result.summary;
        lines.push(`### Summary`);
        lines.push(`  Source files: ${s.totalSource} | Test files: ${s.totalTests}`);
        lines.push(`  Mapped: ${s.mapped} | Orphan tests: ${s.orphans} | Untested: ${s.untested}`);
        lines.push('');

        // Mappings
        if (result.mappings.length > 0) {
          lines.push(`### Mappings (${result.mappings.length})`);
          for (const m of result.mappings.slice(0, 30)) {
            const confIcon = m.confidence === 'high' ? '🟢' : m.confidence === 'medium' ? '🟡' : '🔵';
            lines.push(`  ${confIcon} ${m.sourceFile}`);
            lines.push(`     Tests: ${m.testFiles.join(', ')}`);
            lines.push(`     Confidence: ${m.confidence} — ${m.matchReason}`);
          }
          if (result.mappings.length > 30) {
            lines.push(`  ... and ${result.mappings.length - 30} more`);
          }
          lines.push('');
        }

        // Orphan tests
        if (result.orphanTests.length > 0) {
          lines.push(`### Orphan Tests (${result.orphanTests.length} — no matching source file)`);
          for (const t of result.orphanTests.slice(0, 15)) {
            lines.push(`  ${t}`);
          }
          if (result.orphanTests.length > 15) {
            lines.push(`  ... and ${result.orphanTests.length - 15} more`);
          }
          lines.push('');
        }

        // Untested files
        if (result.untestedFiles.length > 0) {
          lines.push(`### Untested Source Files (${result.untestedFiles.length})`);
          for (const f of result.untestedFiles.slice(0, 15)) {
            lines.push(`  ${f}`);
          }
          if (result.untestedFiles.length > 15) {
            lines.push(`  ... and ${result.untestedFiles.length - 15} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            mappings: result.mappings.map((m) => ({
              sourceFile: m.sourceFile,
              testFiles: m.testFiles,
              confidence: m.confidence,
            })),
            orphanTests: result.orphanTests,
            untestedFiles: result.untestedFiles,
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `test_to_code_mapping failed: ${(error as Error).message}. Verify the directory is a valid project with source and test files. Use codebase_map to explore the structure.`,
            },
          ],
          structuredContent: { mappings: [], orphanTests: [], untestedFiles: [], summary: {} },
        };
      }
    },
  );
}
