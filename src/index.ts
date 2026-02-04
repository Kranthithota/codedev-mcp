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

// CLI argument handling
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  process.stdout.write(`codedev-mcp v${pkg.default.version}\n`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`
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
\n`);
  process.exit(0);
}

import { logger } from './utils/logger.js';

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

// Create MCP Server
const server = new McpServer(
  { name: 'codedev-mcp', version: VERSION },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  },
);

// Wrap all tool handlers with concurrency limiter to prevent resource exhaustion
// when MCP clients send many parallel tool calls.
const originalRegisterTool = server.registerTool.bind(server);

(
  server as {
    registerTool: (name: string, config: unknown, handler: (...args: unknown[]) => Promise<unknown>) => unknown;
  }
).registerTool = (name: string, config: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
  const wrappedHandler = async (...handlerArgs: unknown[]) => {
    return toolLimiter.run(async () => (handler as (...args: unknown[]) => Promise<unknown>)(...handlerArgs));
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Config type is complex from MCP SDK
  return originalRegisterTool(name, config as any, wrappedHandler as any);
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

/**
 * Starts the MCP server using stdio transport and initializes the database.
 * @returns A promise that resolves when the server is running.
 */
async function runServer(): Promise<void> {
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
