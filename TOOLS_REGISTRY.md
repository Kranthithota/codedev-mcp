# codedev-mcp Tool Registry

Complete list of all 42 tools available in codedev-mcp, organized by category.

## Quick Reference: All Tool Names

For Claude Desktop `select:` syntax, use these exact names:

```
search_code
search_symbols
find_references
semantic_search
codebase_map
analyze_file
dependency_graph
call_graph
code_metrics
test_coverage
read_files
file_tree
git_log
git_diff
git_blame
git_status
git_branches
git_show
git_contributors
change_impact
branch_compare
git_hooks
find_todos
find_debug_logs
find_secrets
find_empty_catches
find_long_functions
find_large_files
find_duplicates
find_dead_code
code_docs
security_scan
dep_vuln_scan
notebook_analyze
architecture_check
db_schema
api_contracts
iac_analyze
cicd_analyze
monorepo_analyze
perf_profile
scaffold
```

## Tool Categories

### 🔍 Search Tools (4 tools)

1. **search_code** - Fast text or regex search across the entire codebase
2. **search_symbols** - Find functions, classes, interfaces, types by name pattern
3. **find_references** - Trace where a symbol is used/referenced
4. **semantic_search** - Concept-based search using embeddings ("authentication logic")

### 📊 Analysis Tools (6 tools)

5. **codebase_map** - Generate comprehensive overview: languages, frameworks, structure
6. **analyze_file** - Detailed file analysis with imports, exports, symbols
7. **dependency_graph** - Analyze import relationships and dependencies
8. **call_graph** - Who-calls-what dependency analysis
9. **code_metrics** - Complexity metrics, function lengths, file statistics
10. **test_coverage** - Parse coverage reports and identify untested code

### 📁 Navigation Tools (2 tools)

11. **read_files** - Read one or more files (supports line ranges and batch mode)
12. **file_tree** - Directory listing with sizes, dates, and metadata

### 🔀 Git Tools (10 tools)

13. **git_log** - Commit history with filters (author, date, message pattern)
14. **git_diff** - Show changes between commits, branches, or files
15. **git_blame** - Line-by-line attribution showing who changed what
16. **git_status** - Working tree status (staged, modified, untracked)
17. **git_branches** - List all branches with last commit info
18. **git_show** - Show commit details, file changes, stats
19. **git_contributors** - Contributor statistics and activity
20. **change_impact** - Assess impact of changes (what depends on modified files)
21. **branch_compare** - Structural diff between branches
22. **git_hooks** - Generate pre-commit hook scripts

### ✅ Quality Tools (8 tools)

23. **find_todos** - Find TODO/FIXME/HACK comments
24. **find_debug_logs** - Find console.log/print/debug statements
25. **find_secrets** - Detect hardcoded credentials and secrets
26. **find_empty_catches** - Find empty error handlers
27. **find_long_functions** - Find functions exceeding line threshold
28. **find_large_files** - Find files exceeding line threshold
29. **find_duplicates** - Find duplicate code patterns
30. **find_dead_code** - Find unused exports and orphan files

### 📚 Documentation Tools (1 tool)

31. **code_docs** - Generate documentation from code (undocumented APIs, etc.)

### 🔒 Security Tools (2 tools)

32. **security_scan** - Vulnerability detection and security issues
33. **dep_vuln_scan** - Dependency vulnerability scanning

### 🏗️ Architecture Tools (3 tools)

34. **architecture_check** - Layer boundary verification and architecture analysis
35. **db_schema** - Database schema analysis and model discovery
36. **api_contracts** - API endpoint discovery (OpenAPI, GraphQL, REST)

### 🚀 DevOps Tools (4 tools)

37. **iac_analyze** - Infrastructure-as-Code analysis (Terraform, CloudFormation, K8s)
38. **cicd_analyze** - CI/CD pipeline parsing and analysis
39. **monorepo_analyze** - Monorepo workspace relationships
40. **perf_profile** - Performance profiling and bottleneck detection

### 🛠️ Scaffolding Tools (1 tool)

41. **scaffold** - Generate boilerplate code (returns text, doesn't write files)

### 📓 Notebook Tools (1 tool)

42. **notebook_analyze** - Analyze Jupyter notebooks and extract code cells

## Usage Notes

- All tools are **read-only** - they never modify files
- File paths are relative to project root
- Tools support filtering via `file_glob`, `directory`, and other parameters
- Use `codebase_map` first to understand project structure
- Tools are cached for performance on repeated queries

## Claude Desktop Integration

When using Claude Desktop, tools require exact names with `select:` syntax:

```typescript
select: search_code
select: codebase_map
select: git_log
```

Keyword search may not work - always use the exact tool name from this registry.
