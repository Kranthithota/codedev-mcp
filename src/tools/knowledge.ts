import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { generateOnboardingGuide, detectConventions, buildCodebaseGlossary } from '../analyzers/onboarding.js';
import { detectDocStaleness, measureDocCoverage, generateChangelog, generateAPIDocs } from '../analyzers/doc-intelligence.js';

/**
 * Registers knowledge tools for onboarding guides, convention detection, glossaries,
 * documentation staleness, doc coverage, changelog generation, and API doc generation.
 * @param server - The MCP server instance to register tools on.
 */
export function registerKnowledgeTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: onboarding_guide — Generate onboarding guide for new developers
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'onboarding_guide',
    {
      description:
        'Generate a comprehensive onboarding guide for new developers. Covers project structure, setup steps, architecture, key files, and common tasks.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.onboarding_guide,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const guide = await generateOnboardingGuide(cwd);

        const lines: string[] = [`# Onboarding Guide: ${guide.projectName}\n`];
        lines.push(`**Project Type:** ${guide.projectType}`);
        lines.push(`**Tech Stack:** ${guide.techStack.join(', ') || 'Not detected'}\n`);

        for (const section of guide.sections) {
          lines.push(`## ${section.title}\n`);
          lines.push(section.content);
          if (section.commands && section.commands.length > 0) {
            lines.push('');
            for (const cmd of section.commands) {
              lines.push(`  $ ${cmd}`);
            }
          }
          if (section.files && section.files.length > 0) {
            lines.push('');
            for (const file of section.files) {
              lines.push(`  - ${file}`);
            }
          }
          lines.push('');
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            projectName: guide.projectName,
            projectType: guide.projectType,
            techStack: guide.techStack,
            sections: guide.sections.map((s) => ({ title: s.title, content: s.content })),
            setupSteps: guide.setupSteps,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `onboarding_guide failed: ${(error as Error).message}. Ensure the directory exists and contains a recognizable project structure.`,
            },
          ],
          structuredContent: { projectName: '', projectType: '', techStack: [], sections: [], setupSteps: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: convention_detector — Auto-detect coding conventions
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'convention_detector',
    {
      description:
        'Auto-detect coding conventions: naming patterns, file organization, import style, code style, error handling patterns. Helps AI match existing project conventions.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.convention_detector,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await detectConventions(cwd);

        const lines: string[] = [`## Coding Conventions\n`];
        lines.push(result.summary);
        lines.push('');

        if (result.conventions.length > 0) {
          lines.push('### Detected Conventions');
          for (const conv of result.conventions) {
            const confidence = Math.round(conv.confidence * 100);
            lines.push(`  [${conv.category}] ${conv.name}: **${conv.value}** (${confidence}% confidence)`);
            for (const ex of conv.examples.slice(0, 2)) {
              lines.push(`    - ${ex.file}:${ex.line} — ${ex.code.slice(0, 100)}`);
            }
          }
          lines.push('');
        }

        if (result.fileNaming.length > 0) {
          lines.push('### File Naming Patterns');
          for (const fn of result.fileNaming) {
            lines.push(`  ${fn.pattern}: ${fn.percentage}% (${fn.examples.slice(0, 3).join(', ')})`);
          }
          lines.push('');
        }

        if (result.importStyle.length > 0) {
          lines.push('### Import Style');
          for (const is of result.importStyle) {
            lines.push(`  ${is.style}: ${is.count} occurrences (${is.percentage}%)`);
          }
          lines.push('');
        }

        if (Object.keys(result.codeStyle).length > 0) {
          lines.push('### Code Style');
          for (const [key, value] of Object.entries(result.codeStyle)) {
            lines.push(`  ${key}: ${value}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            conventions: result.conventions.map((c) => ({
              category: c.category,
              name: c.name,
              value: c.value,
              confidence: c.confidence,
            })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `convention_detector failed: ${(error as Error).message}. Ensure the directory contains source files to analyze.`,
            },
          ],
          structuredContent: { conventions: [], summary: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: codebase_glossary — Extract domain-specific terminology
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'codebase_glossary',
    {
      description:
        'Extract domain-specific terminology and build a glossary mapping technical names to business concepts. Groups related terms by domain.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        max_terms: z.number().optional().describe('Maximum number of terms to return (default: 100)'),
      },
      outputSchema: outputSchemas.codebase_glossary,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await buildCodebaseGlossary(cwd);

        const maxTerms = params.max_terms || 100;
        const terms = result.terms.slice(0, maxTerms);

        const lines: string[] = [`## Codebase Glossary\n`];
        lines.push(`Total terms: ${result.summary.totalTerms} | Categories: ${result.summary.categories}`);
        lines.push(`Documented: ${result.summary.documented} | Undocumented: ${result.summary.undocumented}\n`);

        if (result.categories.length > 0) {
          lines.push('### Categories');
          for (const cat of result.categories.slice(0, 20)) {
            lines.push(`  ${cat.name}: ${cat.termCount} terms`);
          }
          lines.push('');
        }

        lines.push('### Terms');
        for (const term of terms) {
          const defPart = term.definition ? ` — ${term.definition.slice(0, 100)}` : '';
          const relatedPart = term.relatedTerms.length > 0 ? ` (related: ${term.relatedTerms.slice(0, 3).join(', ')})` : '';
          lines.push(`  **${term.term}** [${term.category}] (${term.occurrences} uses)${defPart}${relatedPart}`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            terms: terms.map((t) => ({ term: t.term, category: t.category, occurrences: t.occurrences })),
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `codebase_glossary failed: ${(error as Error).message}. Ensure the directory contains source files with identifiers to extract.`,
            },
          ],
          structuredContent: { terms: [], summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: doc_staleness — Detect stale documentation
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'doc_staleness',
    {
      description:
        'Detect stale documentation: references to renamed/deleted code, outdated README instructions, docs not updated since referenced code changed.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.doc_staleness,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await detectDocStaleness(cwd);

        const lines: string[] = [`## Documentation Staleness Report\n`];

        if (result.staleItems.length === 0) {
          lines.push('No stale documentation detected.');
        } else {
          lines.push(`Found ${result.staleItems.length} stale documentation issue(s):\n`);
          for (const item of result.staleItems) {
            const icon = item.severity === 'error' ? '[ERROR]' : item.severity === 'warning' ? '[WARN]' : '[INFO]';
            lines.push(`  ${icon} ${item.docFile}: ${item.issue}`);
          }
        }

        if (result.recommendations.length > 0) {
          lines.push('\n### Recommendations');
          for (const rec of result.recommendations) {
            lines.push(`  - ${rec}`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            staleItems: result.staleItems.map((s) => ({
              docFile: s.docFile,
              issue: s.issue,
              severity: s.severity,
            })),
            summary: result.summary,
            recommendations: result.recommendations,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `doc_staleness failed: ${(error as Error).message}. Ensure the directory contains documentation files (README, docs/, etc.) to analyze.`,
            },
          ],
          structuredContent: { staleItems: [], summary: {}, recommendations: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: doc_coverage — Measure documentation coverage
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'doc_coverage',
    {
      description:
        'Measure documentation coverage: find exported functions/classes without JSDoc/docstrings, check for README/CONTRIBUTING/CHANGELOG, score overall doc health.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        file_glob: z.string().optional().describe('File pattern to analyze, e.g. "**/*.ts"'),
      },
      outputSchema: outputSchemas.doc_coverage,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await measureDocCoverage(cwd);

        const lines: string[] = [`## Documentation Coverage\n`];
        lines.push(`Score: ${result.overallScore}/100 [${result.grade}]`);
        lines.push(`Documented: ${result.coverage.documented} | Undocumented: ${result.coverage.undocumented} | Coverage: ${result.coverage.percentage}%\n`);

        if (result.undocumented.length > 0) {
          lines.push('### Undocumented Exports');
          for (const item of result.undocumented.slice(0, 30)) {
            lines.push(`  ${item.file}: ${item.type} ${item.name}`);
          }
          if (result.undocumented.length > 30) {
            lines.push(`  ... and ${result.undocumented.length - 30} more`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            undocumented: result.undocumented.map((u) => ({ file: u.file, name: u.name, type: u.type })),
            coverage: result.coverage,
            overallScore: result.overallScore,
            grade: result.grade,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `doc_coverage failed: ${(error as Error).message}. Ensure the directory contains source files with exports to analyze.`,
            },
          ],
          structuredContent: {
            undocumented: [],
            coverage: { documented: 0, undocumented: 0, percentage: 0 },
            overallScore: 0,
            grade: 'F',
          },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: changelog_generator — Generate structured changelog from git history
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'changelog_generator',
    {
      description:
        'Generate a structured changelog from git history between two refs. Parses conventional commits, categorizes changes, highlights breaking changes.',
      inputSchema: {
        from_ref: z.string().describe('Starting git ref (tag, branch, or commit SHA)'),
        to_ref: z.string().optional().describe('Ending git ref (default: HEAD)'),
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
      },
      outputSchema: outputSchemas.changelog_generator,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const fromRef = params.from_ref;
        const toRef = params.to_ref || 'HEAD';
        const result = await generateChangelog(cwd, fromRef, toRef);

        const lines: string[] = [`## Changelog: ${fromRef}...${toRef}\n`];
        lines.push(result.markdown);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            entries: result.entries.map((e) => ({ hash: e.hash, type: e.type, description: e.description })),
            markdown: result.markdown,
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `changelog_generator failed: ${(error as Error).message}. Verify the git refs exist. Use 'git tag' to list available tags or 'git log --oneline' to find commit SHAs.`,
            },
          ],
          structuredContent: { entries: [], markdown: '', summary: {} },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: api_doc_generator — Extract and generate API documentation
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'api_doc_generator',
    {
      description:
        'Extract API surface from code: REST endpoints, exported functions with signatures, types. Generate structured API documentation with parameters and return types.',
      inputSchema: {
        directory: z.string().optional().describe('Subdirectory to analyze (default: project root)'),
        file_glob: z.string().optional().describe('File pattern to analyze, e.g. "**/*.ts"'),
      },
      outputSchema: outputSchemas.api_doc_generator,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const cwd = params.directory ? safePath(params.directory) : CWD;
        const result = await generateAPIDocs(cwd);

        const lines: string[] = [`## API Documentation\n`];
        lines.push(result.markdown);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            endpoints: result.endpoints.map((e) => ({ method: e.method, path: e.path, file: e.file })),
            exportedFunctions: result.exportedFunctions.map((f) => ({
              name: f.name,
              file: f.file,
              signature: f.signature,
            })),
            markdown: result.markdown,
            summary: result.summary,
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `api_doc_generator failed: ${(error as Error).message}. Ensure the directory contains source files with exported functions or API endpoints.`,
            },
          ],
          structuredContent: { endpoints: [], exportedFunctions: [], markdown: '', summary: {} },
        };
      }
    },
  );
}
