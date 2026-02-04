/**
 * Output Schemas for all 33 tools.
 * Used with server.registerTool() to provide typed JSON outputs (structuredContent)
 * alongside human-readable text (content).
 *
 * Agents get typed, parseable JSON; humans get formatted text.
 */

import { z } from 'zod';

// ── Common schemas ──────────────────────────────────────────────────────

const fileMatch = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number().optional(),
  text: z.string(),
});

const symbolEntry = z.object({
  name: z.string(),
  type: z.string(),
  file: z.string(),
  line: z.number(),
  exported: z.boolean().optional(),
});

const securityIssue = z.object({
  file: z.string(),
  line: z.number(),
  type: z.string(),
  severity: z.string(),
  message: z.string(),
  recommendation: z.string().optional(),
});

// ── Per-tool output schemas ─────────────────────────────────────────────

export const outputSchemas = {
  search_code: {
    matches: z.array(fileMatch),
    total: z.number(),
  },
  search_symbols: {
    symbols: z.array(symbolEntry),
    total: z.number(),
  },
  codebase_map: {
    summary: z.string(),
    tree: z.string(),
    roots: z.number().optional(),
  },
  analyze_file: {
    file: z.string(),
    language: z.string(),
    lines: z.number(),
    outline: z.string(),
  },
  read_files: {
    files: z.array(
      z.object({
        path: z.string(),
        content: z.string(),
        lines: z.number(),
      }),
    ),
  },
  find_references: {
    symbol: z.string(),
    references: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        context: z.string(),
      }),
    ),
    total: z.number(),
  },
  dependency_graph: {
    file: z.string(),
    imports: z.array(z.string()),
    importers: z.array(z.string()),
  },
  code_metrics: {
    totalFiles: z.number(),
    totalLines: z.number(),
    languages: z.record(z.number()),
    blankLines: z.number(),
    commentLines: z.number(),
  },
  git_history: {
    action: z.string(),
    entries: z.array(z.record(z.unknown())).optional(),
    data: z.string().optional(),
  },
  file_tree: {
    tree: z.string(),
    fileCount: z.number().optional(),
    files: z
      .array(
        z.object({
          path: z.string(),
          size: z.number().optional(),
          modified: z.string().optional(),
        }),
      )
      .optional(),
  },
  find_pattern: {
    check: z.string(),
    matches: z.array(
      z.object({
        file: z.string(),
        line: z.number().optional(),
        match: z.string(),
        severity: z.string().optional(),
      }),
    ),
    total: z.number(),
  },
  semantic_search: {
    matches: z.array(
      z.object({
        file: z.string(),
        score: z.number(),
        snippet: z.string().optional(),
      }),
    ),
    total: z.number(),
  },
  call_graph: {
    file: z.string(),
    functions: z.array(
      z.object({
        name: z.string(),
        calls: z.array(z.string()),
        calledBy: z.array(z.string()).optional(),
      }),
    ),
  },
  test_coverage: {
    action: z.string(),
    data: z.record(z.unknown()),
  },
  code_docs: {
    action: z.string(),
    data: z.record(z.unknown()),
  },
  security_scan: {
    issues: z.array(securityIssue),
    total: z.number(),
    severity: z
      .object({
        critical: z.number(),
        high: z.number(),
        medium: z.number(),
        low: z.number(),
      })
      .optional(),
  },
  change_impact: {
    risk: z.string(),
    affected: z.array(
      z.object({
        file: z.string(),
        type: z.string(),
      }),
    ),
    summary: z.string(),
  },
  notebook_analyze: {
    action: z.string(),
    data: z.record(z.unknown()),
  },
  dead_code: {
    unusedExports: z.array(z.object({ file: z.string(), name: z.string() })),
    orphanFiles: z.array(z.string()),
    summary: z.object({
      totalUnusedExports: z.number(),
      totalOrphanFiles: z.number(),
    }),
  },
  branch_compare: {
    base: z.string(),
    compare: z.string(),
    stats: z.object({
      filesAdded: z.number(),
      filesModified: z.number(),
      filesDeleted: z.number(),
    }),
    commitsBehind: z.number().optional(),
    commitsAhead: z.number().optional(),
  },
  complexity_heatmap: {
    hotspots: z.array(
      z.object({
        file: z.string(),
        score: z.number(),
        grade: z.string(),
      }),
    ),
    summary: z.object({
      totalFiles: z.number(),
      criticalCount: z.number(),
      averageScore: z.number(),
    }),
  },
  context_pack: {
    items: z.array(
      z.object({
        file: z.string(),
        relevance: z.number(),
        estimatedTokens: z.number(),
      }),
    ),
    totalTokens: z.number(),
    budget: z.number(),
    filesIncluded: z.number(),
  },
  type_flow: {
    typeName: z.string(),
    definedIn: z.string(),
    totalUsages: z.number(),
    importedBy: z.array(z.string()),
  },
  architecture_check: {
    violations: z.array(
      z.object({
        rule: z.string(),
        file: z.string(),
        message: z.string(),
        severity: z.string(),
      }),
    ),
    rulesChecked: z.number(),
    passed: z.boolean(),
  },
  db_schema: {
    tables: z.array(
      z.object({
        name: z.string(),
        columns: z.number().optional(),
        source: z.string().optional(),
      }),
    ),
    relationships: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        type: z.string(),
      }),
    ),
    summary: z.record(z.unknown()),
    scannedPatterns: z.array(z.string()).optional(),
  },
  api_contracts: {
    endpoints: z.array(
      z.object({
        method: z.string(),
        path: z.string(),
        source: z.string().optional(),
      }),
    ),
    totalEndpoints: z.number(),
    sources: z.array(z.string()),
    scannedPatterns: z.array(z.string()).optional(),
  },
  iac_analyze: {
    platform: z.string(),
    resources: z.array(
      z.object({
        type: z.string(),
        name: z.string(),
      }),
    ),
    issues: z.array(
      z.object({
        type: z.string(),
        message: z.string(),
        severity: z.string(),
      }),
    ),
    summary: z.record(z.unknown()),
  },
  cicd_analyze: {
    pipelines: z.array(
      z.object({
        name: z.string(),
        platform: z.string(),
        file: z.string(),
      }),
    ),
    summary: z.record(z.unknown()),
  },
  monorepo_analyze: {
    type: z.string(),
    packages: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        version: z.string().optional(),
      }),
    ),
    summary: z.record(z.unknown()),
  },
  dep_vuln_scan: {
    vulnerabilities: z.array(
      z.object({
        package: z.string(),
        severity: z.string(),
        description: z.string(),
      }),
    ),
    totalDeps: z.number(),
    outdatedCount: z.number(),
    summary: z.record(z.unknown()),
  },
  perf_profile: {
    entries: z.array(
      z.object({
        name: z.string(),
        value: z.number(),
        unit: z.string().optional(),
      }),
    ),
    summary: z.record(z.unknown()),
  },
  scaffold: {
    template: z.string(),
    fileName: z.string(),
    language: z.string(),
    generatedCode: z.string(),
  },
  git_hooks: {
    action: z.string(),
    hookPath: z.string().optional(),
    installed: z.boolean().optional(),
    data: z.record(z.unknown()).optional(),
  },
} as const;

// Type helper: get the schema shape for a tool name
export type ToolOutputSchema<T extends keyof typeof outputSchemas> = (typeof outputSchemas)[T];
