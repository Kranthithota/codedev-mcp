# codedev-mcp Enhancement Roadmap

## Current State (v3.1.0) ✅
- **33 tools**, 6 resources, 7 prompts — ~10,000+ lines TypeScript
- **Refactored Architecture**: Modular tool setup, SqliteStore persistence, Structured Logging
- **Production Ready**: secured `safePath`, persistent Analytics, stricter CI/CD, non-root Docker
- Zero-setup: `npx codedev-mcp` — no indexing, no Docker, no API keys
- All Phase 1–5 features complete
- Phase 6–9 features implemented: dead code, complexity heatmap, branch compare, context packing, type flow, architecture rules, DB schema, API contracts, IaC, CI/CD, monorepo, dep vulnerability scan, performance profiling, code scaffolding, git hooks, analytics, suggested actions

### Feature Summary by Phase
| Phase | Features | Status |
|-------|----------|--------|
| Phase 1: High-Impact | Prompts, Resources, Output Schemas | ✅ Prompts + Resources done |
| Phase 2: AST + Cache | Tree-sitter, Semantic Search, Caching, File Watcher | ✅ Complete |
| Phase 3: Deep Analysis | Coverage, Docs, Security, Impact Analysis | ✅ Complete |
| Phase 4: Ecosystem | Plugins, Docker | ✅ Complete |
| Phase 5: Special | Notebooks, Security | ✅ Complete |
| Phase 6: Intelligence | Complexity, Dead Code, Type Flow, Branch Compare, Architecture, Dep Vuln | ✅ Complete |
| Phase 7: Agent Optimization | Context Pack, Analytics, Suggested Actions | ✅ Complete |
| Phase 8: Collaboration | Monorepo, Git Hooks, PR Review, Scaffold | ✅ Complete |
| Phase 9: Ecosystem | DB Schema, API Contracts, IaC, CI/CD, Perf Profile | ✅ Complete |

### Remaining / Future
- **Output Schemas (Zod → JSON):** Enhances agent interop — medium effort
- **OAuth 2.1 HTTP Transport:** Remote server deployment — high effort
- **LSP Bridge:** Language Server Protocol integration for type-aware analysis — very high effort
- **Streaming Responses:** Progressive output for large results — medium effort
- **MCP Server Marketplace:** Plugin discovery via npm — low effort

---

## Original Roadmap (v1.0.0 → v2.0.0)
- 12 tools, 2,290 lines TypeScript, 40+ languages
- Zero-setup: `npx codedev-mcp` — no indexing, no Docker, no API keys
- Capabilities: search, symbols, git, metrics, patterns, dependencies

---

## Phase 1: High-Impact, Low-Effort (v1.1.0)

### 1. MCP Prompts (Workflow Macros)
Chain multiple tools behind a single user-facing prompt. The MCP spec supports `server.prompt()` — users trigger complex workflows with one instruction.

**Prompts to add:**
- `onboard_codebase` — Runs codebase_map → file_tree → code_metrics → dependency_graph. Gives a complete project overview in one shot.
- `review_changes` — Runs git_history(status) → git_history(diff) → find_pattern(todos) → find_pattern(console_logs). Full pre-commit review.
- `investigate_symbol` — Runs search_symbols → find_references → dependency_graph → git_history(blame). Deep-dive into any function/class.
- `code_health_check` — Runs code_metrics → find_pattern(large_files) → find_pattern(long_functions) → find_pattern(hardcoded) → find_pattern(error_handling). Full codebase health audit.
- `understand_file` — Runs analyze_file → read_file → dependency_graph(file) → git_history(log, file) → git_history(blame, file). Everything about one file.

**Effort:** ~100 lines. Just wiring existing tools together.

### 2. MCP Resources (Static Content Exposure)
Expose project metadata as MCP resources that clients can subscribe to. Resources are read-only data the model can reference without calling tools.

**Resources to expose:**
- `project://config` — package.json, tsconfig.json, pyproject.toml, Cargo.toml contents
- `project://structure` — Cached file tree (refreshed periodically)
- `project://gitinfo` — Current branch, last 5 commits, dirty file count
- `project://languages` — Language breakdown with file counts and line counts

**Why:** Resources load into context automatically. The model doesn't waste a tool call just to see what language the project uses.

**Effort:** ~150 lines.

### 3. Output Schema (Structured Outputs)
The June 2025 MCP spec added `outputSchema` and `structuredContent`. Instead of returning plain text, tools return typed JSON that clients can render as tables, charts, or structured UI.

**Tools that benefit most:**
- `code_metrics` → Return `{ totalLines, codeLines, commentLines, files: [{path, lines, complexity}] }`
- `search_code` → Return `{ resultCount, files: [{path, matches: [{line, text, context}]}] }`
- `git_history` (log) → Return `{ commits: [{hash, date, author, message, files?}] }`
- `codebase_map` → Return `{ languages: {}, gitInfo: {}, structure: {} }`
- `find_pattern` → Return `{ count, items: [{file, line, text, severity}] }`

**Why:** Clients like Cursor/Claude Desktop can render structured data as rich UI instead of parsing text blobs. Also enables programmatic chaining — one tool's structured output feeds directly into another.

**Effort:** ~200 lines (add outputSchema to tool definitions, return structuredContent alongside text).

### 4. Tool Consolidation
Cursor has a hard limit of 40 tools across ALL MCP servers. Every tool consumes ~2,500-5,000 tokens in the system prompt. Fewer tools = more reasoning budget.

**Consolidation options:**
- Merge `read_file` + `batch_read` → Single `read_files` tool that accepts `path: string | string[]`
- Merge `search_code` + `find_references` → `find_references` is just `search_code` with `wholeWord: true`
- This brings you from 12 → 10 tools (saves ~5,000-10,000 tokens)

**Effort:** ~50 lines of refactoring.

---

## Phase 2: Competitive Parity Features (v1.2.0)

### 5. Tree-sitter AST Parsing
The #1 gap vs competitors (code-index-mcp, search-tools-mcp, mcp-ragex). Regex-based symbol extraction misses edge cases. Tree-sitter gives exact, language-aware parsing.

**What it enables:**
- Exact function/class/method boundaries (start line, end line, body)
- Accurate import resolution (not pattern matching)
- Call graph extraction (who calls what)
- Scope-aware symbol search (distinguish local vs exported)
- Accurate complexity scoring (AST node counting, not line counting)

**Implementation approach:**
- Use `web-tree-sitter` (WASM-based, works in Node.js, no native compilation)
- Start with top 7 languages: TypeScript, JavaScript, Python, Go, Java, Rust, C/C++
- Fall back to current regex approach for other languages
- Tree-sitter grammars are ~50KB WASM each, loaded on demand

**New tools enabled:**
- `call_graph` — Forward/reverse call graphs for any function
- `scope_analysis` — What's visible at any point in a file
- Enhanced `analyze_file` — Exact function boundaries with cyclomatic complexity per function

**Effort:** ~500-700 lines + grammar WASM files. Significant but transformative.

### 6. In-Memory Caching Layer
Currently every tool call re-scans the filesystem. For repeated queries in a conversation, this wastes time.

**Cache strategy:**
- File content cache with mtime-based invalidation
- Symbol cache per file (invalidate when file changes)
- File tree cache (invalidate on any filesystem event)
- Git info cache with 30-second TTL
- Use `Map<string, {data, mtime, timestamp}>` — no external dependencies

**Performance impact:**
- First `codebase_map` call: ~2-5 seconds
- Subsequent calls: ~50ms (100x faster)
- Symbol lookups after first scan: ~10ms vs ~500ms

**Effort:** ~200 lines. Add a `Cache` class and wire into existing tools.

### 7. File Watching (Optional)
Use `fs.watch` or `chokidar` to invalidate caches when files change. This makes the cache always fresh without TTL guessing.

**Effort:** ~100 lines if using chokidar (1 dependency), ~150 lines with native fs.watch.

---

## Phase 3: Differentiation Features (v1.3.0)

### 8. Semantic Code Search
Currently only literal/regex search. Semantic search answers "find the authentication logic" or "where is error handling done" — queries that don't match any specific string.

**Implementation options:**

**Option A: Local embeddings (privacy-first, no API keys)**
- Use `@xenova/transformers` (runs in Node.js, no Python)
- Model: `all-MiniLM-L6-v2` (~23MB, runs on CPU)
- Index files by chunking into functions/blocks, embed each chunk
- Store embeddings in a local SQLite file (via better-sqlite3)
- ~200ms per query after indexing

**Option B: LLM-assisted search (leverage the host model)**
- No embedding model needed
- Return expanded search results and let the calling LLM filter
- Less accurate but zero dependencies

**Option C: Hybrid**
- Keyword search (ripgrep) + re-ranking by embedding similarity
- Best accuracy with reasonable setup

**New tool:** `semantic_search` — "Find code related to: user authentication flow"

**Effort:** Option A: ~400 lines + 1 dependency. Option B: ~100 lines. Option C: ~500 lines.

### 9. Code Change Analysis
Go beyond `git diff` — analyze what changed semantically, not just textually.

**Capabilities:**
- `change_impact` — Given a file/function change, find all affected callers and dependents
- `change_summary` — Categorize changes as refactor/bugfix/feature/breaking
- `breaking_changes` — Detect removed/renamed exports, changed function signatures
- `pr_review_prep` — Combine diff + impact + patterns for a complete review context

**Effort:** ~300 lines. Builds on dependency_graph + git_history.

### 10. Multi-Root Workspace Support
Currently locked to a single CWD. Many developers work in monorepos or multi-project setups.

**Enhancement:**
- Accept `--workspace` flag with multiple directories
- Tools accept optional `workspace` parameter to target specific project
- `codebase_map` shows all workspaces
- Cross-workspace search and dependency analysis

**Effort:** ~200 lines. Refactor CWD to `workspaces: string[]`.

### 11. Test Coverage Integration
Developers constantly need to know "is this code tested?"

**Capabilities:**
- Parse coverage reports (lcov, istanbul JSON, cobertura XML)
- `test_coverage` tool — Show coverage for a file/function/directory
- Identify untested functions
- Link test files to source files via naming conventions

**New tool:** `test_coverage` — "What's the coverage for src/auth/?"

**Effort:** ~250 lines. Parser for lcov/istanbul formats + new tool.

### 12. Documentation Extraction
Extract and serve documentation from code.

**Capabilities:**
- Parse JSDoc, docstrings, Rustdoc, Javadoc, Go doc comments
- `get_docs` tool — Get documentation for any function/class/module
- Generate API surface from exported symbols + their docs
- Detect undocumented public APIs

**New tool:** `code_docs` — "Show docs for the UserService class"

**Effort:** ~300 lines. Language-specific doc comment parsers.

---

## Phase 4: Enterprise/Power Features (v2.0.0)

### 13. Persistent Index with SQLite
Replace on-the-fly scanning with a persistent index for large codebases (50K+ files).

**Architecture:**
- Use `better-sqlite3` (fast, zero-config, single file)
- Tables: files, symbols, imports, git_commits
- Background indexing on startup, incremental updates via file watching
- First run: index in background while serving queries from filesystem
- Subsequent runs: serve from index, update changed files only

**Performance on large codebases:**
- Without index: `search_symbols` on 50K files → 30-60 seconds
- With index: `search_symbols` on 50K files → 50ms

**Effort:** ~600 lines. New `db/index.ts` module + migration to indexed queries.

### 14. Docker Packaging
The Anthropic/Docker best practice: containerize MCP servers for security and reproducibility.

**Deliverables:**
- `Dockerfile` with multi-stage build (build → slim runtime)
- `docker-compose.yml` for easy setup
- SBOM generation, image signing
- Published to Docker Hub / GitHub Container Registry
- Security scanning in CI

**Effort:** ~50 lines of Docker config + CI pipeline.

### 15. OAuth 2.1 HTTP Transport
The March 2025 MCP spec mandates OAuth 2.1 for HTTP transport. Currently stdio-only.

**When needed:** If you want to serve codedev-mcp as a remote server (not just local stdio).

**Capabilities:**
- SSE (Server-Sent Events) or Streamable HTTP transport
- OAuth 2.1 with PKCE
- Resource Indicators (RFC 8707) to prevent token misuse
- Rate limiting, request validation

**Effort:** ~400 lines. Significant but only needed for remote deployment.

### 16. Plugin Architecture
Allow users to extend codedev-mcp with custom analyzers without forking.

**Design:**
- `~/.codedev-mcp/plugins/` directory
- Each plugin exports: `{ name, tools: [], analyzers: [] }`
- Plugins can add new tools, new language support, or custom pattern checks
- Plugin manifest in `package.json` under `codedevPlugins`

**Effort:** ~300 lines for plugin loader + API definition.

### 17. Language Server Protocol (LSP) Bridge
Connect to running LSP servers for accurate go-to-definition, find-references, completions.

**What it enables:**
- Exact type-aware symbol resolution (not regex)
- Cross-file type inference
- Rename refactoring support
- Real-time diagnostics (errors/warnings)

**Why cautious:** Adds significant complexity and requires language servers to be installed. Best as an optional enhancement that falls back to current regex approach.

**Effort:** ~500 lines + requires LSP servers installed.

---

## Phase 5: Ecosystem Features (v2.x)

### 18. Project Templates & Scaffolding
- `scaffold_project` tool — Generate project structure from templates
- This would be the first **write** tool (destructiveHint: true)
- Templates for common setups: Express API, React app, Python FastAPI, etc.

### 19. CI/CD Integration
- Parse GitHub Actions, GitLab CI, Jenkins pipeline files
- `ci_status` tool — Show recent build status, failing tests
- Requires API access (optional feature with API key)

### 20. AI-Powered Code Review
- Use the calling LLM to review diffs against project conventions
- `review_prompt` — Generates a structured review prompt from git changes
- Not a tool itself, but a prompt that chains tools intelligently

### 21. Notebook/REPL Support
- Parse Jupyter notebooks (.ipynb)
- Extract code cells, markdown cells, outputs
- `notebook_analyze` tool — Analyze notebook structure and dependencies

### 22. Security Scanning
- Dependency vulnerability checking (parse lock files against known CVEs)
- SAST-lite: detect common security patterns (SQL injection patterns, XSS sinks)
- `security_scan` tool — Quick security overview

---

## Priority Matrix

| Feature | Impact | Effort | Dependencies | Recommended Version |
|---------|--------|--------|-------------|-------------------|
| MCP Prompts | High | Low | None | v1.1.0 |
| MCP Resources | High | Low | None | v1.1.0 |
| Tool Consolidation | Medium | Low | None | v1.1.0 |
| Output Schema | High | Medium | None | v1.1.0 |
| In-Memory Cache | High | Medium | None | v1.2.0 |
| Tree-sitter AST | Very High | High | web-tree-sitter | v1.2.0 |
| Semantic Search | High | High | @xenova/transformers | v1.3.0 |
| Change Impact Analysis | High | Medium | None | v1.3.0 |
| Multi-Root Workspace | Medium | Medium | None | v1.3.0 |
| Test Coverage | Medium | Medium | None | v1.3.0 |
| Doc Extraction | Medium | Medium | None | v1.3.0 |
| SQLite Index | Very High | High | better-sqlite3 | v2.0.0 |
| Docker Packaging | Medium | Low | Docker | v2.0.0 |
| OAuth HTTP Transport | Medium | High | MCP SDK | v2.0.0 |
| Plugin Architecture | Medium | High | None | v2.0.0 |
| LSP Bridge | Very High | Very High | LSP servers | v2.0.0 |
| Security Scanning | High | Medium | None | v2.x |
| Notebook Support | Low | Medium | None | v2.x |

---

## Recommended Implementation Order

**Sprint 1 (v1.1.0) — 2-3 days:**
Prompts + Resources + Tool Consolidation + Output Schema
→ Zero new dependencies, maximum spec compliance, better UX

**Sprint 2 (v1.2.0) — 1 week:**
In-Memory Cache + Tree-sitter for top 7 languages
→ Performance + accuracy leap, competitive parity with code-index-mcp

**Sprint 3 (v1.3.0) — 1 week:**
Semantic Search + Change Impact + Test Coverage
→ Differentiation features no competitor has in one package

**Sprint 4 (v2.0.0) — 2 weeks:**
SQLite Index + Docker + HTTP Transport
→ Enterprise-ready, large codebase support, remote deployment

---

## Dependency Budget

Current: 3 dependencies (MCP SDK, Zod, glob)

| Feature | New Dependency | Size |
|---------|---------------|------|
| Tree-sitter | web-tree-sitter + grammars | ~400KB |
| Semantic Search | @xenova/transformers | ~50MB (model) |
| SQLite Index | better-sqlite3 | ~2MB |
| File Watching | chokidar | ~50KB |
| Docker | (build-time only) | 0 |

Recommended limit: Keep runtime deps under 10 for npx startup speed.
