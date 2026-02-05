import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { generateHealthDashboard } from '../analyzers/health-dashboard.js';
import { checkGovernanceRules, getBuiltInPresets, auditLicenses, analyzeSupplyChainRisk, auditSecretRotation, type GovernanceRule } from '../analyzers/governance.js';

/**
 * Registers health dashboard and governance tools for codebase health scoring, governance rules,
 * license auditing, supply chain risk analysis, and secret rotation auditing.
 * @param server - The MCP server instance to register tools on.
 */
export function registerHealthTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: codebase_health_dashboard — Unified codebase health overview
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'codebase_health_dashboard',
    {
      description:
        'Generate a unified health dashboard combining eight dimensions: code quality, test health, security posture, dependency health, documentation, git health, CI/CD, and tech debt. Returns an overall score (0-100), letter grade (A-F), per-dimension breakdowns, top risks, and quick wins.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.codebase_health_dashboard,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await generateHealthDashboard(cwd);

        const lines: string[] = [`## Codebase Health Dashboard: ${result.overallScore}/100 [${result.overallGrade}]\n`];

        // Score bar
        const barFull = Math.round(result.overallScore / 5);
        const bar = '█'.repeat(barFull) + '░'.repeat(20 - barFull);
        lines.push(`  [${bar}] ${result.overallScore}%\n`);

        // Stats
        const st = result.stats;
        lines.push(`### Project Stats`);
        lines.push(`  Files: ${st.totalFiles} total, ${st.totalCodeFiles} code files, ${st.totalLines} lines`);
        lines.push(`  Languages: ${Object.entries(st.languages).sort(([, a], [, b]) => b - a).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
        lines.push(`  Test ratio: ${st.testRatio} | Doc coverage: ${st.docCoverage}`);
        lines.push(`  Last commit: ${st.lastCommitDaysAgo} day(s) ago | Contributors: ${st.contributors}`);
        lines.push('');

        // Dimension scores
        lines.push(`### Dimension Scores`);
        for (const d of result.dimensions) {
          const icon = d.grade === 'A' || d.grade === 'B' ? '🟢' : d.grade === 'C' ? '🟡' : '🔴';
          lines.push(`  ${icon} [${d.grade}] ${d.name}: ${d.score}/100`);
          for (const f of d.findings.slice(0, 2)) {
            lines.push(`      ${f}`);
          }
        }
        lines.push('');

        // Top risks
        if (result.topRisks.length > 0) {
          lines.push(`### Top Risks`);
          for (const risk of result.topRisks) {
            lines.push(`  🔴 ${risk}`);
          }
          lines.push('');
        }

        // Quick wins
        if (result.quickWins.length > 0) {
          lines.push(`### Quick Wins`);
          for (const win of result.quickWins) {
            lines.push(`  💡 ${win}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            overallScore: result.overallScore,
            overallGrade: result.overallGrade,
            dimensions: result.dimensions.map((d) => ({ name: d.name, score: d.score, grade: d.grade })),
            topRisks: result.topRisks,
            quickWins: result.quickWins,
            stats: result.stats,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `codebase_health_dashboard failed: ${(error as Error).message}. Verify the directory is a valid project. Use codebase_map to confirm the project structure.`,
            },
          ],
          structuredContent: { overallScore: 0, overallGrade: 'F', dimensions: [], topRisks: [], quickWins: [], stats: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: governance_rules — Check codebase against governance policies
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'governance_rules',
    {
      description:
        'Check codebase against governance rules and policies. Supports built-in presets (security, architecture, quality) or custom rule definitions. Reports violations with file locations, severity, and fix guidance.',
      inputSchema: {
        preset: z
          .enum(['security', 'architecture', 'quality'])
          .optional()
          .describe('Built-in rule preset to use: security, architecture, or quality'),
        custom_rules: z
          .array(
            z.object({
              id: z.string().describe('Unique rule identifier'),
              name: z.string().describe('Human-readable rule name'),
              pattern: z.string().describe('Regex pattern to search for violations'),
              message: z.string().describe('Violation message to display'),
              severity: z.enum(['error', 'warning', 'info']).describe('Severity level'),
              file_glob: z.string().optional().describe('File pattern to restrict rule to'),
            }),
          )
          .optional()
          .describe('Custom governance rules to check'),
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.governance_rules,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;

        // Resolve rules from preset and/or custom rules
        let rules: GovernanceRule[] = [];

        if (params.preset) {
          const presets = getBuiltInPresets();
          const matched = presets.find((p) => p.name === params.preset);
          if (matched) {
            rules = [...matched.rules];
          }
        }

        if (params.custom_rules && params.custom_rules.length > 0) {
          rules = [...rules, ...params.custom_rules.map((r) => ({
            ...r,
            type: ('type' in r ? r.type : 'file-pattern') as GovernanceRule['type'],
          }))];
        }

        if (rules.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No governance rules specified. Provide a preset (security, architecture, quality) or custom_rules array. Use governance_rules with preset "security" to get started.',
              },
            ],
            structuredContent: { violations: [], summary: { totalRules: 0, totalViolations: 0 } },
          };
        }

        const result = await checkGovernanceRules(cwd, rules);

        const lines: string[] = [`## Governance Rules Check\n`];

        // Summary
        lines.push(`Rules checked: ${rules.length}${params.preset ? ` (preset: ${params.preset})` : ''}`);
        lines.push(`Violations: ${result.violations.length}`);
        lines.push('');

        if (result.violations.length === 0) {
          lines.push('All governance rules passed.');
        } else {
          // Group by severity
          const errors = result.violations.filter((v: { severity: string }) => v.severity === 'error');
          const warnings = result.violations.filter((v: { severity: string }) => v.severity === 'warning');
          const infos = result.violations.filter((v: { severity: string }) => v.severity === 'info');

          if (errors.length > 0) {
            lines.push(`### Errors (${errors.length})`);
            for (const v of errors.slice(0, 20)) {
              lines.push(`  🔴 [${v.ruleId}] ${v.file}${v.line ? `:${v.line}` : ''}`);
              lines.push(`     ${v.message}`);
            }
            if (errors.length > 20) lines.push(`  ... and ${errors.length - 20} more`);
            lines.push('');
          }

          if (warnings.length > 0) {
            lines.push(`### Warnings (${warnings.length})`);
            for (const v of warnings.slice(0, 20)) {
              lines.push(`  🟡 [${v.ruleId}] ${v.file}${v.line ? `:${v.line}` : ''}`);
              lines.push(`     ${v.message}`);
            }
            if (warnings.length > 20) lines.push(`  ... and ${warnings.length - 20} more`);
            lines.push('');
          }

          if (infos.length > 0) {
            lines.push(`### Info (${infos.length})`);
            for (const v of infos.slice(0, 10)) {
              lines.push(`  🔵 [${v.ruleId}] ${v.file}${v.line ? `:${v.line}` : ''}`);
              lines.push(`     ${v.message}`);
            }
            if (infos.length > 10) lines.push(`  ... and ${infos.length - 10} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            violations: result.violations.map((v: { ruleId: string; file: string; severity: string; message: string }) => ({
              ruleId: v.ruleId,
              file: v.file,
              severity: v.severity,
              message: v.message,
            })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `governance_rules failed: ${(error as Error).message}. Verify the directory contains source files. Try using a built-in preset with preset: "security" to get started.`,
            },
          ],
          structuredContent: { violations: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: license_audit — Audit dependency licenses for compliance
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'license_audit',
    {
      description:
        'Audit dependency licenses for compliance risks. Identifies the project license and categorizes each dependency license as permissive, weak-copyleft, strong-copyleft, or unknown. Flags high-risk licenses (GPL, AGPL) and missing license declarations.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.license_audit,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await auditLicenses(cwd);

        const lines: string[] = [`## License Audit\n`];

        lines.push(`Project license: ${result.projectLicense || 'not specified'}`);
        lines.push(`Dependencies audited: ${result.dependencies.length}`);
        lines.push('');

        // Summary by category
        const categories: Record<string, number> = {};
        const risks: Record<string, number> = {};
        for (const dep of result.dependencies) {
          categories[dep.category] = (categories[dep.category] || 0) + 1;
          risks[dep.risk] = (risks[dep.risk] || 0) + 1;
        }

        lines.push(`### By Category`);
        for (const [cat, count] of Object.entries(categories).sort(([, a], [, b]) => b - a)) {
          lines.push(`  ${cat}: ${count}`);
        }
        lines.push('');

        lines.push(`### By Risk Level`);
        for (const [risk, count] of Object.entries(risks).sort(([, a], [, b]) => b - a)) {
          const icon = risk === 'high' ? '🔴' : risk === 'medium' ? '🟡' : risk === 'low' ? '🟢' : '🔵';
          lines.push(`  ${icon} ${risk}: ${count}`);
        }
        lines.push('');

        // High-risk dependencies
        const highRisk = result.dependencies.filter((d: { risk: string }) => d.risk === 'high');
        if (highRisk.length > 0) {
          lines.push(`### High-Risk Dependencies`);
          for (const dep of highRisk) {
            lines.push(`  🔴 ${dep.package} — ${dep.license} (${dep.category})`);
          }
          lines.push('');
        }

        // Issues
        if (result.issues.length > 0) {
          lines.push(`### Issues`);
          for (const issue of result.issues) {
            lines.push(`  * ${issue}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            projectLicense: result.projectLicense,
            dependencies: result.dependencies.map((d: { package: string; license: string; category: string; risk: string }) => ({
              package: d.package,
              license: d.license,
              category: d.category,
              risk: d.risk,
            })),
            summary: result.summary,
            issues: result.issues,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `license_audit failed: ${(error as Error).message}. Verify the project has a package.json or equivalent dependency manifest. Use codebase_map to explore project structure.`,
            },
          ],
          structuredContent: { projectLicense: 'unknown', dependencies: [], summary: {}, issues: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: supply_chain_risk — Analyze dependency supply chain risks
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'supply_chain_risk',
    {
      description:
        'Analyze supply chain risk of project dependencies. Evaluates maintainer count, publish frequency, typosquatting risk, deprecated status, install scripts, and other supply chain attack indicators. Returns per-package risk scores and overall assessment.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.supply_chain_risk,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await analyzeSupplyChainRisk(cwd);

        const lines: string[] = [`## Supply Chain Risk Analysis\n`];

        // Overall
        lines.push(`Overall risk score: ${result.overallRisk}/100 [${result.grade}]`);
        const barFull = Math.round(result.overallRisk / 5);
        const bar = '█'.repeat(barFull) + '░'.repeat(20 - barFull);
        lines.push(`  [${bar}] ${result.overallRisk}%\n`);

        // High-risk packages
        const sorted = [...result.risks].sort((a: { riskScore: number }, b: { riskScore: number }) => b.riskScore - a.riskScore);
        const highRisk = sorted.filter((r: { riskScore: number }) => r.riskScore >= 50);

        if (highRisk.length > 0) {
          lines.push(`### High-Risk Packages (${highRisk.length})`);
          for (const r of highRisk.slice(0, 20)) {
            const icon = r.riskScore >= 75 ? '🔴' : '🟠';
            lines.push(`  ${icon} ${r.package} — risk score: ${r.riskScore}/100`);
            lines.push(`     Factors: ${r.riskFactors.join(', ')}`);
          }
          if (highRisk.length > 20) lines.push(`  ... and ${highRisk.length - 20} more`);
          lines.push('');
        }

        // Moderate-risk packages
        const medRisk = sorted.filter((r: { riskScore: number }) => r.riskScore >= 25 && r.riskScore < 50);
        if (medRisk.length > 0) {
          lines.push(`### Moderate-Risk Packages (${medRisk.length})`);
          for (const r of medRisk.slice(0, 10)) {
            lines.push(`  🟡 ${r.package} — risk score: ${r.riskScore}/100`);
            lines.push(`     Factors: ${r.riskFactors.join(', ')}`);
          }
          if (medRisk.length > 10) lines.push(`  ... and ${medRisk.length - 10} more`);
          lines.push('');
        }

        // Recommendations
        if (result.recommendations.length > 0) {
          lines.push(`### Recommendations`);
          for (const rec of result.recommendations) {
            lines.push(`  * ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            overallRisk: result.overallRisk,
            grade: result.grade,
            risks: result.risks.map((r: { package: string; riskScore: number; riskFactors: string[] }) => ({
              package: r.package,
              riskScore: r.riskScore,
              riskFactors: r.riskFactors,
            })),
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `supply_chain_risk failed: ${(error as Error).message}. Verify the project has dependency manifests (package.json, Cargo.toml, etc.). Use dep_vuln_scan for vulnerability-specific analysis.`,
            },
          ],
          structuredContent: { overallRisk: 0, grade: 'F', risks: [], recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: secret_rotation_audit — Audit secret hygiene and rotation
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'secret_rotation_audit',
    {
      description:
        'Audit secret management practices: detects hardcoded secrets, checks for .env files in git, evaluates secret rotation patterns, and assesses overall secret hygiene. Returns findings with severity, a hygiene score, and remediation guidance.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (relative to project root)'),
      },
      outputSchema: outputSchemas.secret_rotation_audit,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await auditSecretRotation(cwd);

        const lines: string[] = [`## Secret Rotation Audit: ${result.score}/100 [${result.grade}]\n`];

        // Score bar
        const barFull = Math.round(result.score / 5);
        const bar = '█'.repeat(barFull) + '░'.repeat(20 - barFull);
        lines.push(`  [${bar}] ${result.score}%\n`);

        // Summary
        lines.push(`Total findings: ${result.findings.length}`);
        const bySeverity: Record<string, number> = {};
        for (const f of result.findings) {
          bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
        }
        if (Object.keys(bySeverity).length > 0) {
          lines.push(`By severity: ${Object.entries(bySeverity).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
        }
        lines.push('');

        // Findings
        if (result.findings.length === 0) {
          lines.push('No secret hygiene issues detected.');
        } else {
          lines.push(`### Findings`);
          for (const f of result.findings.slice(0, 30)) {
            const icon = f.severity === 'critical' || f.severity === 'high' ? '🔴'
              : f.severity === 'medium' ? '🟡'
              : '🔵';
            lines.push(`  ${icon} [${f.severity.toUpperCase()}] ${f.type}`);
            lines.push(`     ${f.file} — ${f.description}`);
          }
          if (result.findings.length > 30) {
            lines.push(`  ... and ${result.findings.length - 30} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            findings: result.findings.map((f: { file: string; type: string; severity: string; description: string }) => ({
              file: f.file,
              type: f.type,
              severity: f.severity,
              description: f.description,
            })),
            score: result.score,
            grade: result.grade,
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `secret_rotation_audit failed: ${(error as Error).message}. Verify the directory is a valid project. Use security_scan for broader security analysis, or find_secrets to locate hardcoded secrets.`,
            },
          ],
          structuredContent: { findings: [], score: 0, grade: 'F', summary: {} },
        };
      }
    },
  );
}
