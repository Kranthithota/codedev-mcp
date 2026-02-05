export const SERVER_INSTRUCTIONS = `codedev-mcp v4.0 — Universal Code Development MCP Server
Provides comprehensive, read-only access to the local codebase with 90+ tools across 24 categories.
The single point of contact for all developers and technical people.

## Tool Categories

### Search (4 tools)
- **search_code** — Text/regex search across files
- **search_symbols** — Find functions, classes, interfaces
- **find_references** — Trace symbol usage
- **semantic_search** — Concept-based search ("authentication logic")

### Analysis (12 tools)
- **codebase_map** — Project structure, languages, frameworks
- **analyze_file** — Detailed file analysis with imports
- **dependency_graph** — Import relationships and dependencies
- **call_graph** — Who-calls-what analysis
- **code_metrics** — Complexity, function lengths
- **test_coverage** — What's tested
- **complexity_heatmap** — Rank files/functions by cyclomatic/cognitive complexity (A–F grades)
- **type_flow** — Trace where a type is defined, imported, and used
- **context_pack** — Smart context window packing (relevance-scored, token-budgeted)
- **code_ownership** — Git blame-based file ownership, bus factor
- **import_cycles** — Detect circular import chains
- **tech_debt_score** — Aggregate technical debt score (0–100)

### Navigation (2 tools)
- **read_files** — Read files (single or batch)
- **file_tree** — Directory listing with sizes and dates

### Git (10 tools)
- **git_log** — Commit history with filters
- **git_diff** — Show changes between refs
- **git_blame** — Line-by-line attribution
- **git_status** — Working tree status
- **git_branches** — List all branches
- **git_show** — Commit details
- **git_contributors** — Contributor stats
- **change_impact** — Assess change effects
- **branch_compare** — Structural diff between branches
- **git_hooks** — Generate pre-commit hooks

### Quality (8 tools)
- **find_todos** — TODO/FIXME/HACK comments
- **find_debug_logs** — console.log/print statements
- **find_secrets** — Hardcoded credentials
- **find_empty_catches** — Empty error handlers
- **find_long_functions** — Functions over N lines
- **find_large_files** — Files over N lines
- **find_duplicates** — Duplicate code patterns
- **find_dead_code** — Unused exports

### Documentation (1 tool)
- **code_docs** — Generate documentation

### Security (2 tools)
- **security_scan** — Vulnerability detection
- **dep_vuln_scan** — Dependency vulnerabilities

### Architecture (3 tools)
- **architecture_check** — Layer boundary verification
- **db_schema** — Database model analysis
- **api_contracts** — API endpoint discovery

### DevOps (4 tools)
- **iac_analyze** — Infrastructure-as-Code analysis
- **cicd_analyze** — CI/CD pipeline parsing
- **monorepo_analyze** — Workspace relationships
- **perf_profile** — Performance analysis

### Scaffolding (1 tool)
- **scaffold** — Generate boilerplate code

### PR Review Intelligence (3 tools) — NEW
- **pr_review_context** — Generate structured PR review context: what changed, why, blast radius, focus areas
- **review_risk_score** — Score changesets on complexity, test coverage delta, security, blast radius, churn
- **breaking_change_detect** — Detect removed exports, changed signatures, renamed fields, changed routes

### Test Intelligence (4 tools) — NEW
- **test_gap_analysis** — Find source files lacking test coverage, map functions to test files
- **test_impact_analysis** — Determine which tests need to run for changed files
- **test_health_report** — Find flaky patterns, implementation tests, assertion-free tests
- **test_to_code_mapping** — Bidirectional map between source and test files

### Health & Governance (5 tools) — NEW
- **codebase_health_dashboard** — One-command project health: quality, security, testing, architecture, debt
- **governance_rules** — Check custom architectural rules and built-in presets (security, architecture, quality)
- **license_audit** — Scan dependency licenses, flag GPL in MIT projects, unknown licenses
- **supply_chain_risk** — Dependency tree risk: post-install scripts, single-maintainer, deprecated packages
- **secret_rotation_audit** — Audit secret management: .env gitignored, hardcoded secrets, IaC secrets

### Cross-Repo & Architecture (6 tools) — NEW
- **cross_repo_impact** — How changes in one package affect consumers across monorepo
- **contract_drift** — Compare API contracts (OpenAPI, GraphQL, gRPC) vs actual implementations
- **dependency_impact_matrix** — Risk-scored package dependency matrix with coupling and test coverage
- **architecture_drift** — Compare actual deps against declared architecture, detect layer violations
- **migration_tracker** — Detect in-progress migrations: CommonJS→ESM, class→functional, callbacks→async
- **auth_flow_analysis** — Trace auth/authz flows, find unprotected endpoints, detect inconsistencies

### Onboarding & Knowledge (3 tools) — NEW
- **onboarding_guide** — Generate structured onboarding doc: entry points, setup, architecture, key files
- **convention_detector** — Auto-detect naming, imports, error handling, code style conventions
- **codebase_glossary** — Extract domain terminology, group by concept, map to definitions

### Documentation Intelligence (4 tools) — NEW
- **doc_staleness** — Detect stale docs: renamed references, outdated README, unchanged since code changed
- **doc_coverage** — Measure doc coverage: exports without JSDoc, missing README/CONTRIBUTING/CHANGELOG
- **changelog_generator** — Generate changelog from git history using conventional commits
- **api_doc_generator** — Extract REST endpoints, exported functions, types into structured API docs

### Performance Patterns (4 tools) — NEW
- **n_plus_one_detect** — Detect N+1 query patterns in ORM usage, suggest batch alternatives
- **async_pattern_analysis** — Find sequential awaits, missing error handling, dangling promises
- **bundle_analysis** — Large deps, tree-shaking opportunities, dynamic import candidates
- **memory_leak_patterns** — Unbounded collections, event listener leaks, timer leaks, unclosed resources

### Observability (4 tools) — NEW
- **observability_audit** — Check logging, metrics, tracing readiness and blind spots
- **error_handling_analysis** — Map error patterns: swallowed errors, inconsistent types, missing handlers
- **logging_consistency** — Structured vs unstructured, PII leaks, log level consistency
- **feature_flag_audit** — Detect flags (LaunchDarkly, Unleash, custom), find stale flags

### Tech Debt Tracking (3 tools) — NEW
- **tech_debt_burndown** — Track debt metrics over git history, show trend and worst modules
- **code_age_heatmap** — File age × complexity × ownership = risk score, find maintenance hotspots
- **change_pattern_analysis** — Logical coupling, churn hotspots, revert patterns, fix-after-change

### Environment & Config (3 tools) — NEW
- **env_config_analyzer** — Map env vars, compare .env files, check .env.example completeness
- **config_file_intelligence** — Parse tsconfig/webpack/eslint/Docker/K8s configs, detect conflicts
- **dependency_freshness** — Score dependency freshness, flag deprecated and vulnerable packages

### MCP Platform (2 tools) — NEW
- **tool_presets** — List workflow-optimized tool subsets: review, debug, security, quality, architecture, etc.
- **composite_workflow** — Pre-defined multi-tool workflows: pre_commit_check, full_health_audit, pr_readiness

## Recommended Workflow
1. Start with **codebase_map** or **codebase_health_dashboard** to understand the project
2. Use **tool_presets** to load only the tools relevant to your current task
3. For code review: **pr_review_context** → **review_risk_score** → **breaking_change_detect** → **test_gap_analysis**
4. For debugging: **search_code** → **find_references** → **call_graph** → **error_handling_analysis**
5. For security: **security_scan** → **secret_rotation_audit** → **supply_chain_risk** → **license_audit**
6. For onboarding: **onboarding_guide** → **convention_detector** → **codebase_glossary** → **architecture_check**
7. For quality: **codebase_health_dashboard** → **complexity_heatmap** → **tech_debt_burndown** → **test_health_report**
8. Use **composite_workflow** with "pre_commit_check" before committing, "pr_readiness" before PRs

## Key Notes
- All tools are read-only — they never modify files
- All file paths are relative to project root
- Uses ripgrep when available (falls back to grep)
- Tree-sitter AST parsing for accurate symbol extraction
- In-memory cache for fast repeated queries
- Concurrency-limited to prevent resource exhaustion`;
