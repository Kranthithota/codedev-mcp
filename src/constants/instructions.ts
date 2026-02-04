export const SERVER_INSTRUCTIONS = `codedev-mcp provides comprehensive, read-only access to the local codebase with 42 tools across 9 categories.

## Tool Categories

### Search (4 tools)
- **search_code** — Text/regex search across files
- **search_symbols** — Find functions, classes, interfaces
- **find_references** — Trace symbol usage
- **semantic_search** — Concept-based search ("authentication logic")

### Analysis (5 tools)
- **codebase_map** — Project structure, languages, frameworks
- **analyze_file** — Detailed file analysis with imports
- **call_graph** — Who-calls-what analysis
- **code_metrics** — Complexity, function lengths
- **test_coverage** — What's tested

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
2. Use **search_code** or **semantic_search** to find relevant code
3. Use **read_files** to inspect contents
4. Use **git_log**/**git_blame** for history context
5. Use **find_todos**/**find_secrets** for code quality

## Resources
- project://config, project://structure, project://gitinfo
- health://status, server://stats

## Key Notes
- All tools are read-only — they never modify files
- All file paths are relative to project root
- Uses ripgrep when available (falls back to grep)
- Tree-sitter AST parsing for accurate symbol extraction
- In-memory cache for fast repeated queries`;
