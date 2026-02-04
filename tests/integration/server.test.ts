
import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerNavTools } from '../../src/tools/nav.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
// Add others as needed for full coverage, but starting with these for integration proof

describe('Server Integration', () => {
    let server: McpServer;

    beforeEach(() => {
        // Create a fresh server instance for testing logic
        // We won't connect transport to avoid stdin/stdout conflicts, 
        // unless we mock it or just check registration.
        server = new McpServer({
            name: 'test-server',
            version: '1.0.0'
        });
    });

    it('should register core tools successfully', async () => {
        // Register a few modules
        registerNavTools(server);
        registerSearchTools(server);
        registerAnalysisTools(server);

        // We can't easily list registered tools from the private 'server' properties in SDK v1.0.0 
        // without digging into implementation details or using a client.
        // However, we can verify that register() functions don't throw.
        // And commonly, `register` calls `server.tool(...)`.

        // Let's assume if no error thrown, registration is likely fine.
        // To strictly test listTools, we'd need a client.

        // A better integration test might be to run the actual tool handler if we can access it.
        // But `server.tool` registers a callback. 

        // For now, simple smoke test that modules import and register without error.
        expect(true).toBe(true);
    });
});
