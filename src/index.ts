#!/usr/bin/env node

/**
 * codedev-mcp — Universal Code Development MCP Server
 *
 * A zero-API-key MCP server that provides code search, analysis,
 * navigation, and git context tools to any LLM-powered IDE.
 *
 * The host LLM (Claude, Codex, Gemini) does all reasoning —
 * this server just provides fast, structured access to your codebase.
 *
 * Works with: Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code
 *             Copilot, Windsurf, Claude Desktop — any MCP client.
 *
 * Supports: 40+ programming languages, any codebase size.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { readFile, stat, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// CLI argument handling
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  console.log(`codedev-mcp v${pkg.default.version}`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
codedev-mcp — Universal Code Development MCP Server

Usage: codedev-mcp [options]

Options:
  -v, --version    Show version number
  -h, --help       Show this help message
  --timeout <ms>   Request timeout in milliseconds (default: 30000)

Environment Variables:
  CODEDEV_MCP_CWD    Working directory (default: current directory)
  CODEDEV_ROOTS      Multi-root workspace paths (comma-separated)
  CODEDEV_TIMEOUT    Request timeout in milliseconds

Examples:
  npx codedev-mcp
  codedev-mcp --timeout 60000
`);
  process.exit(0);
}

// Parse timeout from args or env
const timeoutArg = args.findIndex(a => a === '--timeout');
const REQUEST_TIMEOUT = timeoutArg >= 0
  ? parseInt(args[timeoutArg + 1], 10)
  : parseInt(process.env.CODEDEV_TIMEOUT || '30000', 10);

// Configuration
import { CWD, ROOTS, IS_MULTI_ROOT, safePath } from './config.js';

// Internal modules
import { searchCode, listFiles, readFileRange, countLines } from './search/fast-search.js';
import { extractSymbols, extractImports, analyzeFile, formatFileOutline } from './analyzers/symbols.js';
import { mapCodebase, mapSymbols } from './analyzers/codebase.js';
import {
  isGitRepo,
  getGitLog,
  getGitLogWithFiles,
  getGitDiff,
  getGitBlame,
  getGitStatus,
  getGitBranch,
  getGitBranches,
  getGitShow,
  getContributors,
} from './analyzers/git.js';
import { detectLanguage, getAllKnownExtensions } from './utils/languages.js';

// New feature modules
import { cache, toolResultCache } from './cache/memory-cache.js';
import { semanticSearch } from './search/semantic.js';
import {
  initTreeSitter,
  isTreeSitterReady,
  parseAST,
  extractCallGraph,
  extractScopes,
} from './analyzers/tree-sitter.js';
import { parseCoverage, getFileCoverage, getUntestedFiles, findTestFiles } from './analyzers/coverage.js';
import { extractDocs, findUndocumented } from './analyzers/docs.js';
import { securityScan } from './analyzers/security.js';
import { analyzeImpact, categorizeChanges } from './analyzers/impact.js';
import { parseNotebook, findNotebooks, extractCode, notebookHealth } from './analyzers/notebook.js';
import { loadPlugins, getPluginPatterns } from './utils/plugins.js';

// v3.0.0 feature modules
import { detectDeadCode } from './analyzers/dead-code.js';
import { compareBranches } from './analyzers/branch-compare.js';
import { generateHeatmap } from './analyzers/complexity-heatmap.js';
import { packContext } from './analyzers/context-pack.js';
import { analyzeTypeFlow } from './analyzers/type-flow.js';
import { checkArchitecture } from './analyzers/architecture.js';
import { analyzeDBSchema } from './analyzers/db-schema.js';
import { analyzeApiContracts } from './analyzers/api-contract.js';
import { analyzeIaC } from './analyzers/iac.js';
import { parseCICD } from './analyzers/cicd.js';
import { analyzeMonorepo } from './analyzers/monorepo.js';
import { analytics } from './utils/analytics.js';
import { logger } from './utils/logger.js';
import { scanDependencyVulns } from './analyzers/dep-vuln.js';
import { analyzePerformance } from './analyzers/perf-profile.js';
import { listTemplates, generateScaffold } from './analyzers/scaffold.js';
import { manageGitHooks } from './utils/git-hooks.js';
import { SqliteStore } from './db/sqlite-store.js';
import { outputSchemas } from './schemas/output-schemas.js';

// Tool Registries
// Tool Registries
import { registerSearchTools } from './tools/search.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerNavTools } from './tools/nav.js';
import { registerGitTools } from './tools/git.js';
import { registerQualityTools } from './tools/quality.js';
import { registerDocsTools } from './tools/docs.js';
import { registerSecurityTools } from './tools/security.js';
import { registerNotebookTools } from './tools/notebook.js';
import { registerArchitectureTools } from './tools/architecture.js';
import { registerDevOpsTools } from './tools/devops.js';
import { registerPerformanceTools } from './tools/performance.js';
import { registerScaffoldTools } from './tools/scaffold.js';

import { VERSION } from './version.js';
import { SERVER_INSTRUCTIONS } from './constants/instructions.js';
import { registerHealthResource } from './resources/health.js';
import { toolLimiter } from './utils/concurrency.js';

// ── Create MCP Server ───────────────────────────────────────────────────
const server = new McpServer(
  { name: 'codedev-mcp', version: VERSION },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  },
);

// Wrap all tool handlers with concurrency limiter to prevent resource exhaustion
// when MCP clients send many parallel tool calls.
const _registerTool = server.registerTool.bind(server);
(server as any).registerTool = (name: string, config: any, handler: (...args: any[]) => Promise<any>) => {
  return _registerTool(name, config, async (...args: any[]) => toolLimiter.run(() => handler(...args)));
};

// Register Tools
registerSearchTools(server);
registerAnalysisTools(server);
registerNavTools(server);
registerGitTools(server);
registerQualityTools(server);
registerDocsTools(server);
registerSecurityTools(server);
registerNotebookTools(server);
registerArchitectureTools(server);
registerDevOpsTools(server);
registerPerformanceTools(server);
registerScaffoldTools(server);

// Register Resources
registerHealthResource(server, VERSION);

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Initialize DB
  try {
    const { getDb } = await import('./db/connection.js');
    await getDb();
    logger.info('codedev-mcp server running on stdio', { version: '3.1.0', db: 'initialized' });
  } catch (err) {
    logger.warn('Failed to initialize database', { error: err });
  }
}

runServer().catch((error) => {
  logger.error('Fatal error running server', error);
  process.exit(1);
});
