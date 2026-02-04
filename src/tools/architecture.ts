import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD } from '../config.js';
import { checkArchitecture } from '../analyzers/architecture.js';
import { analyzeDBSchema } from '../analyzers/db-schema.js';
import { analyzeApiContracts } from '../analyzers/api-contract.js';
import { analytics } from '../utils/analytics.js';

/**
 * Registers architecture tools for checking architectural constraints, database schemas, and API contracts.
 * @param server - The MCP server instance to register tools on.
 */
export function registerArchitectureTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: architecture_check — Architectural analysis
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'architecture_check',
    {
      description:
        'Check architectural constraints and patterns. Detects circular dependencies, layered architecture violations, and component isolation issues.',
      inputSchema: {
        check_type: z.enum(['layers', 'circular', 'srp']).optional(),
      },
      outputSchema: outputSchemas.architecture_check,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return await analytics.track('architecture_check', async () => {
          const result = await checkArchitecture(CWD);
          const lines: string[] = [`## Architecture Check\n`];

          if (result.violations && result.violations.length > 0) {
            lines.push(`Found ${result.violations.length} violations:`);
            for (const v of result.violations) {
              lines.push(
                `${v.severity === 'error' ? '🔴' : '⚠️'} [${v.rule}] ${v.file}${v.line ? ':' + v.line : ''} — ${v.message}${v.importPath ? ` (imports ${v.importPath})` : ''}`,
              );
            }
          } else {
            lines.push('✅ No architectural violations found.');
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              violations:
                result.violations?.map((v) => ({
                  rule: v.rule,
                  file: v.file,
                  message: v.message,
                  severity: v.severity,
                })) || [],
              rulesChecked: result.rulesChecked ?? 0,
              passed: result.passed || false,
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `architecture_check failed: ${(error as Error).message}` }],
          structuredContent: { violations: [], rulesChecked: 0 },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: db_schema — Analyze database models and schemas
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'db_schema',
    {
      description:
        'Analyze database schema definitions. Parses Prisma, Drizzle, SQLAlchemy, Django ORM, TypeORM entities, and raw SQL DDL. Returns tables, columns, types, relationships, and migrations.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to search for schema files'),
      },
      outputSchema: outputSchemas.db_schema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('db_schema', async () => {
          const result = await analyzeDBSchema(CWD, { directory: params.directory });
          const lines: string[] = [
            `## Database Schema\n`,
            `Tables: ${result.summary.totalTables}`,
            `Columns: ${result.summary.totalColumns}`,
            `Relationships: ${result.summary.totalRelationships}`,
            `ORMs: ${result.summary.orms.join(', ') || 'none detected'}\n`,
          ];
          if (result.summary.totalTables === 0 && result.scannedPatterns?.length) {
            lines.push(`Scanned patterns (no schemas found):`);
            for (const p of result.scannedPatterns) {
              lines.push(`  - ${p}`);
            }
            lines.push('');
          }
          for (const table of result.tables.slice(0, 30)) {
            lines.push(`### ${table.name} (${table.orm || table.source})`);
            for (const col of table.columns) {
              const flags = [
                col.primary && 'PK',
                col.unique && 'UNIQUE',
                col.nullable === false && 'NOT NULL',
                col.references && `FK→${col.references}`,
              ]
                .filter(Boolean)
                .join(', ');
              lines.push(`  ${col.name}: ${col.type}${flags ? ` (${flags})` : ''}`);
            }
            lines.push('');
          }
          if (result.relationships.length > 0) {
            lines.push(`### Relationships(${result.relationships.length})`);
            result.relationships
              .slice(0, 20)
              .forEach((r) =>
                lines.push(`  ${r.from} → ${r.to} (${r.type})${r.through ? ` through ${r.through}` : ''}`),
              );
          }
          if (result.migrations.length > 0) {
            lines.push(`\n### Migrations(${result.migrations.length})`);
            result.migrations
              .slice(0, 10)
              .forEach((m) => lines.push(`  ${m.file}${m.description ? ` — ${m.description}` : ''}`));
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              tables: result.tables.map((t) => ({ name: t.name, columns: t.columns?.length, source: t.source })),
              relationships: result.relationships?.map((r) => ({ from: r.from, to: r.to, type: r.type })) || [],
              summary: result.summary || {},
              scannedPatterns: result.scannedPatterns || [],
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `db_schema failed: ${(error as Error).message}` }],
          structuredContent: { tables: [], relationships: [], orm: 'unknown' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: api_contracts — Find all API endpoints
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'api_contracts',
    {
      description:
        'Find all API endpoints in the codebase. Parses OpenAPI/Swagger specs, GraphQL schemas, Express/Fastify routes, NestJS controllers, FastAPI decorators. Returns method, path, parameters, and types.',
      outputSchema: outputSchemas.api_contracts,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return await analytics.track('api_contracts', async () => {
          const result = await analyzeApiContracts(CWD);
          const lines: string[] = [
            `## API Contracts\n`,
            `Total endpoints: ${result.totalEndpoints}`,
            `Sources: ${result.sources.join(', ') || 'none detected'}`,
          ];
          if (result.totalEndpoints === 0 && result.scannedPatterns?.length) {
            lines.push(`\nScanned patterns (no endpoints found):`);
            for (const p of result.scannedPatterns) {
              lines.push(`  - ${p}`);
            }
          }
          const { summary } = result;
          lines.push(
            `Methods: GET = ${summary.get} POST = ${summary.post} PUT = ${summary.put} DELETE = ${summary.delete} QUERY = ${summary.query} MUTATION = ${summary.mutation}\n`,
          );
          for (const ep of result.endpoints.slice(0, 50)) {
            const params = ep.parameters?.map((p) => `${p.name}:${p.type}`).join(', ') || '';
            lines.push(
              `  ${ep.method.padEnd(10)} ${ep.path}${params ? ` (${params})` : ''}  — ${ep.file}:${ep.line} [${ep.source}]`,
            );
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              endpoints: result.endpoints.map((ep) => ({ method: ep.method, path: ep.path, source: ep.source })),
              totalEndpoints: result.endpoints.length,
              sources: [...new Set(result.endpoints.map((ep) => ep.source))],
              scannedPatterns: result.scannedPatterns || [],
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `api_contracts failed: ${(error as Error).message}` }],
          structuredContent: { endpoints: [], totalEndpoints: 0 },
        };
      }
    },
  );
}
