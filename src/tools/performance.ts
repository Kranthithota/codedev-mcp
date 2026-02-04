import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD } from '../config.js';
import { analyzePerformance } from '../analyzers/perf-profile.js';
import { analytics } from '../utils/analytics.js';

/**
 * Registers performance tools for profiling, bundle analysis, and dependency weight detection.
 * @param server - The MCP server instance to register tools on.
 */
export function registerPerformanceTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: perf_profile — Performance profiling & bundle analysis
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'perf_profile',
    {
      description:
        'Analyze performance: parses V8 CPU profiles (.cpuprofile), webpack bundle stats, detects large source files, and flags heavy npm dependencies with lighter alternatives. Returns severity-ranked findings.',
      outputSchema: outputSchemas.perf_profile,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return await analytics.track('perf_profile', async () => {
          const result = await analyzePerformance(CWD);
          const lines: string[] = [`## Performance Analysis\n`];
          lines.push(`Sources: ${result.sources.join(', ') || 'file sizes + dependency weights'}`);
          const s = result.summary;
          lines.push(`Findings: ${s.critical} critical, ${s.warning} warnings, ${s.info} info\n`);
          if (result.bundleSize) {
            lines.push(`### Bundle Size: ${(result.bundleSize.total / (1024 * 1024)).toFixed(2)} MB total`);
            result.bundleSize.largest.forEach((b) => lines.push(`  ${b.name}: ${(b.size / 1024).toFixed(0)} KB`));
            lines.push('');
          }
          const grouped = new Map<string, typeof result.entries>();
          result.entries.forEach((e) => {
            if (!grouped.has(e.type)) grouped.set(e.type, []);
            grouped.get(e.type)!.push(e);
          });
          for (const [type, entries] of grouped) {
            const label = type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
            lines.push(`### ${label} (${entries.length})`);
            for (const e of entries.slice(0, 10)) {
              const icon = e.severity === 'critical' ? '🔴' : e.severity === 'warning' ? '🟡' : '🔵';
              lines.push(
                `  ${icon} ${e.name} — ${e.value} ${e.unit}${e.recommendation ? ` (${e.recommendation})` : ''}`,
              );
            }
            lines.push('');
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              entries: result.entries.map((e) => ({ name: e.name, value: e.value, unit: e.unit })),
              summary: result.summary || {},
            },
          };
        });
      } catch (error: unknown) {
        return { content: [{ type: 'text', text: `perf_profile failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
