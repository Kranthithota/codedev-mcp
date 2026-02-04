# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - 2026-02-04

### Added
- Health check resource (`health://status`) for monitoring server status
- `--version` and `--help` CLI flags
- Request timeout handling (30s default)
- Output schemas for structured JSON responses
- Graceful error recovery when binaries unavailable
- Streaming responses for large results
- API versioning support
- `scannedPatterns` field in `db_schema` and `api_contracts` for empty result context

### Changed
- Enhanced error messages with fallback suggestions
- Improved documentation
- **file_tree** now shows file sizes, modification dates, and type icons

### Breaking Changes
- **Replaced `git_history`** with 7 discrete tools for better discoverability:
  - `git_log`, `git_diff`, `git_blame`, `git_status`, `git_branches`, `git_show`, `git_contributors`
- **Replaced `find_pattern`** with 8 discrete tools:
  - `find_todos`, `find_debug_logs`, `find_secrets`, `find_empty_catches`, `find_long_functions`, `find_large_files`, `find_duplicates`, `find_dead_code`
- Tool count increased from 29 to 42

## [3.1.0] - 2026-02-01

### Added
- Comprehensive test suite (168 tests)
- Structured logging with `src/utils/logger.ts`
- Analytics persistence to SQLite
- Security hardening (path validation, SQL injection prevention)
- Non-root Docker execution

### Changed
- Modularized tool implementations into `src/tools/` directory
- Enhanced CI/CD pipeline with lint and audit checks

## [3.0.0] - 2026-01-15

### Added
- Dead code detection (`dead_code_scan`)
- Complexity heatmap (`complexity_heatmap`)
- Branch comparison (`branch_compare`)
- Context packing (`context_pack`)
- Type flow analysis (`type_flow`)
- Architecture rules (`architecture_check`)
- DB schema parsing (`db_schema`)
- API contract discovery (`api_contracts`)
- IaC analysis (`iac_scan`)
- CI/CD parsing (`cicd_config`)
- Monorepo support (`monorepo_analyze`)
- Dependency vulnerability scanning (`dep_vuln_scan`)
- Performance profiling (`perf_profile`)
- Code scaffolding (`scaffold`)
- Git hooks management (`git_hooks`)
- Analytics dashboard
- Suggested actions resource

### Changed
- Upgraded to MCP SDK latest
- Improved caching layer

## [2.0.0] - 2026-01-01

### Added
- Tree-sitter AST parsing
- Semantic search
- In-memory caching
- Test coverage integration
- Documentation extraction
- Security scanning
- Impact analysis
- Multi-root workspace support
- Plugin architecture
- Docker packaging

## [1.0.0] - 2025-12-01

### Added
- Initial release
- 12 core tools: search, symbols, git, metrics, patterns, dependencies
- 40+ language support
- Zero-setup: `npx codedev-mcp`
