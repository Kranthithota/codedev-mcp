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
  line: z.number().optional(),
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
    action: z.string(),
    data: z.record(z.unknown()),
  },
  git_hooks: {
    action: z.string(),
    hookPath: z.string().optional(),
    installed: z.boolean().optional(),
    data: z.record(z.unknown()).optional(),
  },
  // ── New Category Tools (Categories 1-13) ─────────────────────────────

  // Category 1: PR Review Intelligence
  pr_review_context: {
    summary: z.record(z.unknown()),
    commits: z.array(z.object({ hash: z.string(), message: z.string(), author: z.string() })),
    changedFiles: z.array(z.object({ file: z.string(), status: z.string(), riskLevel: z.string() })),
    reviewFocusAreas: z.array(z.string()),
  },
  review_risk_score: {
    overallScore: z.number(),
    grade: z.string(),
    dimensions: z.array(z.object({ name: z.string(), score: z.number(), weight: z.number() })),
    recommendations: z.array(z.string()),
  },
  breaking_change_detect: {
    breakingChanges: z.array(z.object({ file: z.string(), type: z.string(), severity: z.string(), description: z.string() })),
    summary: z.object({ total: z.number(), errors: z.number(), warnings: z.number() }),
  },

  // Category 2: Test Intelligence
  test_gap_analysis: {
    gaps: z.array(z.object({ sourceFile: z.string(), hasTestFile: z.boolean(), riskLevel: z.string() })),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },
  test_impact_analysis: {
    impacts: z.array(z.object({ changedFile: z.string(), directTests: z.array(z.string()) })),
    allTestsToRun: z.array(z.string()),
    estimatedScope: z.string(),
  },
  test_health_report: {
    totalTestFiles: z.number(),
    antiPatterns: z.array(z.object({ file: z.string(), pattern: z.string(), severity: z.string() })),
    healthScore: z.number(),
    grade: z.string(),
  },
  test_to_code_mapping: {
    mappings: z.array(z.object({ sourceFile: z.string(), testFiles: z.array(z.string()), confidence: z.string() })),
    orphanTests: z.array(z.string()),
    untestedFiles: z.array(z.string()),
    summary: z.record(z.unknown()),
  },

  // Category 3: Codebase Health Dashboard
  codebase_health_dashboard: {
    overallScore: z.number(),
    overallGrade: z.string(),
    dimensions: z.array(z.object({ name: z.string(), score: z.number(), grade: z.string() })),
    topRisks: z.array(z.string()),
    quickWins: z.array(z.string()),
    stats: z.record(z.unknown()),
  },

  // Category 4: Governance & Compliance
  governance_rules: {
    violations: z.array(z.object({ ruleId: z.string(), file: z.string(), severity: z.string(), message: z.string() })),
    summary: z.record(z.unknown()),
  },
  license_audit: {
    projectLicense: z.string(),
    dependencies: z.array(z.object({ package: z.string(), license: z.string(), category: z.string(), risk: z.string() })),
    summary: z.record(z.unknown()),
    issues: z.array(z.string()),
  },
  supply_chain_risk: {
    overallRisk: z.number(),
    grade: z.string(),
    risks: z.array(z.object({ package: z.string(), riskScore: z.number(), riskFactors: z.array(z.string()) })),
    recommendations: z.array(z.string()),
  },
  secret_rotation_audit: {
    findings: z.array(z.object({ file: z.string(), type: z.string(), severity: z.string(), description: z.string() })),
    score: z.number(),
    grade: z.string(),
    summary: z.record(z.unknown()),
  },

  // Category 5: Cross-Repository Intelligence
  cross_repo_impact: {
    impacts: z.array(z.object({ changedPackage: z.string(), affectedPackages: z.array(z.object({ name: z.string(), riskLevel: z.string() })) })),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },
  contract_drift: {
    drifts: z.array(z.object({ type: z.string(), endpoint: z.string(), status: z.string(), severity: z.string() })),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },
  dependency_impact_matrix: {
    packages: z.array(z.object({ package: z.string(), riskScore: z.number(), riskLevel: z.string(), consumers: z.array(z.string()) })),
    hotspots: z.array(z.string()),
    summary: z.record(z.unknown()),
  },

  // Category 6: Architecture Enforcement
  architecture_drift: {
    violations: z.array(z.object({ from: z.record(z.string()), to: z.record(z.string()), type: z.string(), severity: z.string() })),
    layers: z.array(z.object({ name: z.string(), files: z.number() })),
    summary: z.record(z.unknown()),
  },
  migration_tracker: {
    migrations: z.array(z.object({ name: z.string(), completionPercent: z.number(), status: z.string() })),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },
  auth_flow_analysis: {
    endpoints: z.array(z.object({ route: z.string(), method: z.string(), hasAuth: z.boolean() })),
    unprotectedEndpoints: z.array(z.object({ route: z.string(), method: z.string() })),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },

  // Category 7: Onboarding & Knowledge
  onboarding_guide: {
    projectName: z.string(),
    projectType: z.string(),
    techStack: z.array(z.string()),
    sections: z.array(z.object({ title: z.string(), content: z.string() })),
    setupSteps: z.array(z.string()),
  },
  convention_detector: {
    conventions: z.array(z.object({ category: z.string(), name: z.string(), value: z.string(), confidence: z.number() })),
    summary: z.string(),
  },
  codebase_glossary: {
    terms: z.array(z.object({ term: z.string(), category: z.string(), occurrences: z.number() })),
    summary: z.record(z.unknown()),
  },

  // Category 8: Documentation Intelligence
  doc_staleness: {
    staleItems: z.array(z.object({ docFile: z.string(), issue: z.string(), severity: z.string() })),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },
  doc_coverage: {
    undocumented: z.array(z.object({ file: z.string(), name: z.string(), type: z.string() })),
    coverage: z.object({ documented: z.number(), undocumented: z.number(), percentage: z.number() }),
    overallScore: z.number(),
    grade: z.string(),
  },
  changelog_generator: {
    entries: z.array(z.object({ hash: z.string(), type: z.string(), description: z.string() })),
    markdown: z.string(),
    summary: z.record(z.unknown()),
  },
  api_doc_generator: {
    endpoints: z.array(z.object({ method: z.string(), path: z.string(), file: z.string() })),
    exportedFunctions: z.array(z.object({ name: z.string(), file: z.string(), signature: z.string() })),
    markdown: z.string(),
    summary: z.record(z.unknown()),
  },

  // Category 9: Performance & Runtime Patterns
  n_plus_one_detect: {
    patterns: z.array(z.object({ file: z.string(), line: z.number(), ormMethod: z.string(), suggestion: z.string() })),
    summary: z.record(z.unknown()),
  },
  async_pattern_analysis: {
    antiPatterns: z.array(z.object({ file: z.string(), line: z.number(), pattern: z.string(), severity: z.string() })),
    score: z.number(),
    recommendations: z.array(z.string()),
  },
  bundle_analysis: {
    dependencies: z.array(z.object({ name: z.string(), estimatedSize: z.string() })),
    treeShakingOpportunities: z.array(z.object({ file: z.string(), suggestion: z.string() })),
    summary: z.record(z.unknown()),
  },
  memory_leak_patterns: {
    patterns: z.array(z.object({ file: z.string(), line: z.number(), type: z.string(), severity: z.string() })),
    score: z.number(),
    recommendations: z.array(z.string()),
  },

  // Category 10: Observability & Operations
  observability_audit: {
    findings: z.array(z.object({ category: z.string(), status: z.string(), details: z.string() })),
    score: z.number(),
    grade: z.string(),
    recommendations: z.array(z.string()),
  },
  error_handling_analysis: {
    issues: z.array(z.object({ file: z.string(), line: z.number(), type: z.string(), severity: z.string() })),
    score: z.number(),
    grade: z.string(),
    recommendations: z.array(z.string()),
  },
  logging_consistency: {
    issues: z.array(z.object({ file: z.string(), line: z.number(), type: z.string(), severity: z.string() })),
    framework: z.string(),
    score: z.number(),
    grade: z.string(),
  },
  feature_flag_audit: {
    flags: z.array(z.object({ name: z.string(), framework: z.string(), isStale: z.boolean() })),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },

  // Category 11: Tech Debt Tracking
  tech_debt_burndown: {
    snapshots: z.array(z.object({ date: z.string(), totalDebt: z.number() })),
    trend: z.string(),
    summary: z.record(z.unknown()),
    recommendations: z.array(z.string()),
  },
  code_age_heatmap: {
    files: z.array(z.object({ file: z.string(), ageMonths: z.number(), riskScore: z.number(), riskLevel: z.string() })),
    hotspots: z.array(z.object({ file: z.string(), riskScore: z.number() })),
    summary: z.record(z.unknown()),
  },
  change_pattern_analysis: {
    patterns: z.array(z.object({ type: z.string(), files: z.array(z.string()), significance: z.string() })),
    churnHotspots: z.array(z.object({ file: z.string(), changes: z.number() })),
    summary: z.record(z.unknown()),
  },

  // Category 12: MCP-Native Features
  tool_presets: {
    presets: z.array(z.object({ name: z.string(), description: z.string(), toolCount: z.number() })),
    workflows: z.array(z.object({ name: z.string(), description: z.string(), stepCount: z.number() })),
  },
  composite_workflow: {
    workflow: z.string(),
    results: z.array(z.object({ tool: z.string(), status: z.string() })),
    summary: z.string(),
    duration: z.number(),
  },

  // Category 13: Environment & Config Intelligence
  env_config_analyzer: {
    variables: z.array(z.object({ name: z.string(), isSensitive: z.boolean() })),
    envFiles: z.array(z.object({ file: z.string(), gitignored: z.boolean() })),
    score: z.number(),
    summary: z.record(z.unknown()),
  },
  config_file_intelligence: {
    configs: z.array(z.object({ file: z.string(), type: z.string(), purpose: z.string() })),
    conflicts: z.array(z.object({ file1: z.string(), file2: z.string(), description: z.string() })),
    summary: z.record(z.unknown()),
  },
  dependency_freshness: {
    dependencies: z.array(z.object({ name: z.string(), currentVersion: z.string(), freshnessScore: z.number() })),
    overallScore: z.number(),
    grade: z.string(),
    recommendations: z.array(z.string()),
  },
} as const;

// Type helper: get the schema shape for a tool name
export type ToolOutputSchema<T extends keyof typeof outputSchemas> = (typeof outputSchemas)[T];
