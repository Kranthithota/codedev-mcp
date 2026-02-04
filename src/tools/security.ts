import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD } from '../config.js';
import { securityScan } from '../analyzers/security.js';
import { scanDependencyVulns } from '../analyzers/dep-vuln.js';
import { analytics } from '../utils/analytics.js';

/**
 * Registers security tools for vulnerability scanning and dependency vulnerability detection.
 * @param server - The MCP server instance to register tools on.
 */
export function registerSecurityTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: security_scan — Security vulnerability detection
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'security_scan',
    {
      description:
        'Scan codebase for security issues: hardcoded secrets, SQL injection, XSS, insecure crypto, eval usage, path traversal, and more. SAST-lite with no external dependencies.',
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe('Filter by category: injection, xss, secrets, crypto, config, auth, redirect, error-handling'),
        severity: z.string().optional().describe('Filter by severity: critical, high, medium, low'),
        file_glob: z.string().optional().describe('Filter by file pattern'),
      },
      outputSchema: outputSchemas.security_scan,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const report = await securityScan(CWD, {
          category: params.category,
          severity: params.severity,
          fileGlob: params.file_glob,
        });

        let output = `## Security Scan Report\n\n`;
        output += `Total findings: ${report.totalFindings}\n`;
        output += `Severity breakdown: ${
          Object.entries(report.bySeverity)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ') || 'none'
        }\n`;

        if (report.dependencyInfo) {
          output += `\nDependencies: ${report.dependencyInfo.directDeps} direct, ${report.dependencyInfo.total} total`;
          output += report.dependencyInfo.lockfileFound ? ' (lockfile ✅)' : ' (⚠️ no lockfile found)';
          output += '\n';
        }

        if (report.findings.length > 0) {
          output += '\n### Findings:\n\n';
          output += report.findings
            .slice(0, 50)
            .map((f) => {
              const icon =
                f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : '🔵';
              let line = `${icon} [${f.severity.toUpperCase()}] ${f.message}\n`;
              line += `   ${f.file}${f.line ? `:${f.line}` : ''}\n`;
              if (f.snippet) line += `   ${f.snippet}\n`;
              line += `   💡 ${f.recommendation}\n`;
              return line;
            })
            .join('\n');
        }

        // Ensure all severity fields are present with defaults
        const severity = {
          critical: report.bySeverity.critical || 0,
          high: report.bySeverity.high || 0,
          medium: report.bySeverity.medium || 0,
          low: report.bySeverity.low || 0,
        };

        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            issues: report.findings.map((f) => ({
              file: f.file,
              line: f.line ?? undefined, // Ensure line is number or undefined (not missing)
              type: f.category,
              severity: f.severity,
              message: f.message,
              recommendation: f.recommendation,
            })),
            total: report.totalFindings,
            severity,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `security_scan failed: ${(error as Error).message}. Verify the project directory is accessible.`,
            },
          ],
          structuredContent: { issues: [], total: 0, severity: { critical: 0, high: 0, medium: 0, low: 0 } },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: dep_vuln_scan — Dependency vulnerability scanning
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'dep_vuln_scan',
    {
      description:
        'Scan dependencies for known vulnerabilities. Cross-references package lock files (npm, Cargo, pip, Go) against a database of known-vulnerable packages. Reports severity, CVEs, and recommended upgrades.',
      outputSchema: outputSchemas.dep_vuln_scan,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return await analytics.track('dep_vuln_scan', async () => {
          const result = await scanDependencyVulns(CWD);
          const lines: string[] = [`## Dependency Vulnerability Scan\n`];
          lines.push(`Dependencies scanned: ${result.totalDeps}`);
          lines.push(`Ecosystems: ${result.ecosystems.join(', ') || 'none detected'}`);
          lines.push(`Lock files: ${result.lockFiles.join(', ') || 'none found'}`);
          const s = result.summary;
          lines.push(`Findings: ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low\n`);
          if (result.vulnerabilities.length === 0) {
            lines.push('✅ No known vulnerabilities detected in your dependencies!');
          } else {
            for (const v of result.vulnerabilities) {
              const icon =
                v.severity === 'critical' ? '🔴' : v.severity === 'high' ? '🟠' : v.severity === 'medium' ? '🟡' : '🔵';
              lines.push(`${icon} [${v.severity.toUpperCase()}] ${v.name} @${v.version} — ${v.reason}`);
              if (v.recommendation) lines.push(`   ↳ ${v.recommendation}`);
            }
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              vulnerabilities: (result.vulnerabilities || []).map((v) => ({
                package: v.name,
                severity: v.severity,
                description: v.reason,
              })),
              totalDeps: result.totalDeps || 0,
              outdatedCount: result.outdatedCount || 0,
              summary: result.summary || {},
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `dep_vuln_scan failed: ${(error as Error).message}` }],
          structuredContent: {
            vulnerabilities: [],
            totalDeps: 0,
            outdatedCount: 0,
            summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          },
        };
      }
    },
  );
}
