export const SERVER_INSTRUCTIONS = `codedev-mcp provides comprehensive, read-only access to the local codebase with 48 tools across 11 categories.

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
- **type_flow** — Trace where a type is defined, imported, and used across the codebase
- **context_pack** — Smart context window packing for LLMs (relevance-scored, token-budgeted)
- **code_ownership** — Git blame-based file ownership, bus factor analysis
- **import_cycles** — Detect circular import chains (A→B→C→A)
- **tech_debt_score** — Aggregate technical debt score (0–100) combining complexity, secrets, TODOs, etc.

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
- **scaffold** — Generate boilerplate code (returns text, doesn't write)

## Recommended Workflow
1. Start with **codebase_map** to understand the project
2. Run **tech_debt_score** for an instant health check
3. Use **search_code** or **semantic_search** to find relevant code
4. Use **type_flow** to understand how types propagate
5. Use **complexity_heatmap** to find risky hotspots
6. Use **code_ownership** before code reviews to identify reviewers
7. Use **import_cycles** to catch circular dependencies
8. Use **context_pack** to minimize token waste when gathering context

## Resources
- project://config, project://structure, project://gitinfo
- health://status, server://stats

## Key Notes
- All tools are read-only — they never modify files
- All file paths are relative to project root
- Uses ripgrep when available (falls back to grep)
- Tree-sitter AST parsing for accurate symbol extraction
- In-memory cache for fast repeated queries`;
