import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNavTools } from '../../../src/tools/nav.js';
import { registerSearchTools } from '../../../src/tools/search.js';
import { registerAnalysisTools } from '../../../src/tools/analysis.js';
import { registerPerformanceTools } from '../../../src/tools/performance.js';

describe('Tool Registration', () => {
  it('should register nav tools without error', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    expect(() => registerNavTools(server)).not.toThrow();
  });

  it('should register search tools without error', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    expect(() => registerSearchTools(server)).not.toThrow();
  });

  it('should register analysis tools without error', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    expect(() => registerAnalysisTools(server)).not.toThrow();
  });

  it('should register performance tools without error', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    expect(() => registerPerformanceTools(server)).not.toThrow();
  });

  it('should register all tools on a single server', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    expect(() => {
      registerNavTools(server);
      registerSearchTools(server);
      registerAnalysisTools(server);
      registerPerformanceTools(server);
    }).not.toThrow();
  });
});
