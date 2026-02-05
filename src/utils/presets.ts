/**
 * Tool Presets & Composite Workflows
 *
 * Provides workflow-specific tool profiles and composite operations
 * that execute multiple analyses in a single call.
 * Reduces context window waste by loading only relevant tools.
 */

/**
 * A tool preset defines a subset of tools optimized for a specific workflow.
 */
export interface ToolPreset {
  name: string;
  description: string;
  tools: string[];
  suggestedOrder: string[];
}

/**
 * Result of running a composite workflow — multiple analyses combined.
 */
export interface WorkflowResult {
  workflow: string;
  results: { tool: string; status: 'success' | 'error'; data?: unknown; error?: string }[];
  summary: string;
  duration: number;
}

/**
 * Get all available tool presets.
 * Each preset is a curated set of tools optimized for a specific developer workflow.
 *
 * @returns Map of preset names to their configurations.
 */
export function getToolPresets(): Record<string, ToolPreset> {
  return {
    review: {
      name: 'Code Review',
      description: 'Tools for reviewing pull requests and code changes',
      tools: [
        'pr_review_context',
        'review_risk_score',
        'breaking_change_detect',
        'git_diff',
        'git_log',
        'branch_compare',
        'change_impact',
        'test_gap_analysis',
        'security_scan',
        'find_debug_logs',
        'find_secrets',
        'architecture_check',
        'search_code',
        'read_files',
      ],
      suggestedOrder: [
        'pr_review_context',
        'review_risk_score',
        'breaking_change_detect',
        'test_gap_analysis',
        'security_scan',
      ],
    },
    debug: {
      name: 'Debugging',
      description: 'Tools for investigating bugs and understanding code flow',
      tools: [
        'search_code',
        'find_references',
        'call_graph',
        'type_flow',
        'read_files',
        'file_tree',
        'git_blame',
        'git_log',
        'git_diff',
        'error_handling_analysis',
        'analyze_file',
        'dependency_graph',
      ],
      suggestedOrder: ['search_code', 'find_references', 'call_graph', 'read_files', 'git_blame'],
    },
    security: {
      name: 'Security Audit',
      description: 'Comprehensive security analysis tools',
      tools: [
        'security_scan',
        'dep_vuln_scan',
        'find_secrets',
        'secret_rotation_audit',
        'supply_chain_risk',
        'license_audit',
        'auth_flow_analysis',
        'governance_rules',
        'search_code',
        'read_files',
      ],
      suggestedOrder: [
        'security_scan',
        'find_secrets',
        'secret_rotation_audit',
        'dep_vuln_scan',
        'supply_chain_risk',
        'license_audit',
        'auth_flow_analysis',
      ],
    },
    onboarding: {
      name: 'Onboarding',
      description: 'Tools for understanding a new codebase',
      tools: [
        'codebase_map',
        'onboarding_guide',
        'convention_detector',
        'codebase_glossary',
        'codebase_health_dashboard',
        'file_tree',
        'architecture_check',
        'dependency_graph',
        'code_docs',
        'api_doc_generator',
        'read_files',
        'search_code',
      ],
      suggestedOrder: [
        'codebase_map',
        'onboarding_guide',
        'codebase_health_dashboard',
        'convention_detector',
        'architecture_check',
      ],
    },
    quality: {
      name: 'Code Quality',
      description: 'Tools for assessing and improving code quality',
      tools: [
        'codebase_health_dashboard',
        'tech_debt_score',
        'tech_debt_burndown',
        'complexity_heatmap',
        'code_age_heatmap',
        'find_long_functions',
        'find_large_files',
        'find_duplicates',
        'find_dead_code',
        'find_empty_catches',
        'test_coverage',
        'test_health_report',
        'governance_rules',
        'code_metrics',
      ],
      suggestedOrder: [
        'codebase_health_dashboard',
        'complexity_heatmap',
        'tech_debt_score',
        'test_coverage',
        'find_dead_code',
      ],
    },
    refactor: {
      name: 'Refactoring',
      description: 'Tools for safe code refactoring',
      tools: [
        'find_references',
        'dependency_graph',
        'call_graph',
        'import_cycles',
        'type_flow',
        'change_impact',
        'test_impact_analysis',
        'search_code',
        'search_symbols',
        'read_files',
        'analyze_file',
        'complexity_heatmap',
        'architecture_drift',
        'migration_tracker',
      ],
      suggestedOrder: [
        'find_references',
        'dependency_graph',
        'call_graph',
        'test_impact_analysis',
        'change_impact',
      ],
    },
    architecture: {
      name: 'Architecture Review',
      description: 'Tools for analyzing and enforcing architecture',
      tools: [
        'architecture_check',
        'architecture_drift',
        'dependency_graph',
        'import_cycles',
        'monorepo_analyze',
        'cross_repo_impact',
        'contract_drift',
        'dependency_impact_matrix',
        'codebase_map',
        'db_schema',
        'api_contracts',
        'change_pattern_analysis',
      ],
      suggestedOrder: [
        'codebase_map',
        'architecture_check',
        'architecture_drift',
        'import_cycles',
        'dependency_graph',
      ],
    },
    performance: {
      name: 'Performance Audit',
      description: 'Tools for finding performance issues',
      tools: [
        'n_plus_one_detect',
        'async_pattern_analysis',
        'bundle_analysis',
        'memory_leak_patterns',
        'perf_profile',
        'complexity_heatmap',
        'find_large_files',
        'search_code',
        'read_files',
      ],
      suggestedOrder: [
        'n_plus_one_detect',
        'async_pattern_analysis',
        'memory_leak_patterns',
        'bundle_analysis',
        'complexity_heatmap',
      ],
    },
    documentation: {
      name: 'Documentation',
      description: 'Tools for documentation analysis and generation',
      tools: [
        'doc_coverage',
        'doc_staleness',
        'changelog_generator',
        'api_doc_generator',
        'code_docs',
        'codebase_glossary',
        'onboarding_guide',
        'read_files',
        'search_code',
      ],
      suggestedOrder: ['doc_coverage', 'doc_staleness', 'api_doc_generator', 'changelog_generator'],
    },
    devops: {
      name: 'DevOps & Operations',
      description: 'Tools for DevOps, CI/CD, and operations analysis',
      tools: [
        'cicd_analyze',
        'iac_analyze',
        'observability_audit',
        'env_config_analyzer',
        'config_file_intelligence',
        'dependency_freshness',
        'feature_flag_audit',
        'logging_consistency',
        'monorepo_analyze',
        'git_hooks',
      ],
      suggestedOrder: [
        'cicd_analyze',
        'iac_analyze',
        'observability_audit',
        'env_config_analyzer',
        'dependency_freshness',
      ],
    },
    testing: {
      name: 'Test Analysis',
      description: 'Tools for analyzing and improving test suites',
      tools: [
        'test_coverage',
        'test_gap_analysis',
        'test_impact_analysis',
        'test_health_report',
        'test_to_code_mapping',
        'find_todos',
        'search_code',
        'read_files',
      ],
      suggestedOrder: [
        'test_coverage',
        'test_gap_analysis',
        'test_health_report',
        'test_impact_analysis',
        'test_to_code_mapping',
      ],
    },
  };
}

/**
 * Get a specific tool preset by name.
 *
 * @param name - Preset name (e.g., 'review', 'security', 'quality').
 * @returns The preset configuration, or undefined if not found.
 */
export function getPreset(name: string): ToolPreset | undefined {
  return getToolPresets()[name];
}

/**
 * List all available preset names with descriptions.
 *
 * @returns Array of preset summaries.
 */
export function listPresets(): { name: string; description: string; toolCount: number }[] {
  const presets = getToolPresets();
  return Object.entries(presets).map(([key, preset]) => ({
    name: key,
    description: preset.description,
    toolCount: preset.tools.length,
  }));
}

/**
 * Pre-defined composite workflows that run multiple tools in sequence.
 */
export interface CompositeWorkflow {
  name: string;
  description: string;
  steps: { tool: string; params: Record<string, unknown> }[];
}

/**
 * Get all available composite workflows.
 *
 * @returns Map of workflow names to their definitions.
 */
export function getCompositeWorkflows(): Record<string, CompositeWorkflow> {
  return {
    pre_commit_check: {
      name: 'Pre-Commit Check',
      description: 'Quick checks before committing: secrets, debug logs, security issues, architectural violations',
      steps: [
        { tool: 'find_secrets', params: {} },
        { tool: 'find_debug_logs', params: {} },
        { tool: 'security_scan', params: {} },
        { tool: 'architecture_check', params: {} },
        { tool: 'import_cycles', params: {} },
      ],
    },
    full_health_audit: {
      name: 'Full Health Audit',
      description: 'Comprehensive codebase health check covering quality, security, testing, and architecture',
      steps: [
        { tool: 'codebase_health_dashboard', params: {} },
        { tool: 'security_scan', params: {} },
        { tool: 'dep_vuln_scan', params: {} },
        { tool: 'test_coverage', params: {} },
        { tool: 'complexity_heatmap', params: {} },
        { tool: 'find_dead_code', params: {} },
        { tool: 'architecture_check', params: {} },
        { tool: 'tech_debt_score', params: {} },
      ],
    },
    pr_readiness: {
      name: 'PR Readiness',
      description: 'Verify a branch is ready for PR: review context, risk score, breaking changes, test gaps',
      steps: [
        { tool: 'pr_review_context', params: {} },
        { tool: 'review_risk_score', params: {} },
        { tool: 'breaking_change_detect', params: {} },
        { tool: 'test_gap_analysis', params: {} },
        { tool: 'find_secrets', params: {} },
        { tool: 'find_debug_logs', params: {} },
      ],
    },
    dependency_audit: {
      name: 'Dependency Audit',
      description: 'Full dependency analysis: vulnerabilities, licenses, supply chain risk, freshness',
      steps: [
        { tool: 'dep_vuln_scan', params: {} },
        { tool: 'license_audit', params: {} },
        { tool: 'supply_chain_risk', params: {} },
        { tool: 'dependency_freshness', params: {} },
      ],
    },
    onboarding_pack: {
      name: 'Onboarding Pack',
      description: 'Generate everything a new developer needs to understand the codebase',
      steps: [
        { tool: 'codebase_map', params: {} },
        { tool: 'onboarding_guide', params: {} },
        { tool: 'convention_detector', params: {} },
        { tool: 'codebase_glossary', params: {} },
        { tool: 'codebase_health_dashboard', params: {} },
        { tool: 'api_doc_generator', params: {} },
      ],
    },
    production_readiness: {
      name: 'Production Readiness',
      description: 'Check if the codebase is production-ready: observability, error handling, security, config',
      steps: [
        { tool: 'observability_audit', params: {} },
        { tool: 'error_handling_analysis', params: {} },
        { tool: 'logging_consistency', params: {} },
        { tool: 'security_scan', params: {} },
        { tool: 'env_config_analyzer', params: {} },
        { tool: 'secret_rotation_audit', params: {} },
      ],
    },
  };
}

/**
 * Get a specific composite workflow by name.
 *
 * @param name - Workflow name (e.g., 'pre_commit_check', 'full_health_audit').
 * @returns The workflow definition, or undefined if not found.
 */
export function getWorkflow(name: string): CompositeWorkflow | undefined {
  return getCompositeWorkflows()[name];
}

/**
 * List all available workflow names with descriptions.
 *
 * @returns Array of workflow summaries.
 */
export function listWorkflows(): { name: string; description: string; stepCount: number }[] {
  const workflows = getCompositeWorkflows();
  return Object.entries(workflows).map(([key, wf]) => ({
    name: key,
    description: wf.description,
    stepCount: wf.steps.length,
  }));
}
