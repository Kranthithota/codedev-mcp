import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { analytics } from '../utils/analytics.js';
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
} from '../analyzers/git.js';
import { analyzeImpact, categorizeChanges } from '../analyzers/impact.js';
import { compareBranches } from '../analyzers/branch-compare.js';
import { manageGitHooks } from '../utils/git-hooks.js';

/**
 * Registers git tools for log viewing, diffing, blaming, branching, contributor stats, change impact, and hook management.
 * @param server - The MCP server instance to register tools on.
 */
export function registerGitTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_log — View commit history
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_log',
    {
      description:
        'View git commit history. Filter by file, author, date range. Shows commit hash, date, author, and message.',
      inputSchema: {
        file: z.string().optional().describe('File path to show history for'),
        count: z.number().optional().describe('Number of commits (default: 15)'),
        author: z.string().optional().describe('Filter by author name/email'),
        since: z.string().optional().describe('Show commits since date, e.g. "2 weeks ago"'),
        with_files: z.boolean().optional().describe('Include changed file names'),
      },
      outputSchema: outputSchemas.git_history,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (!(await isGitRepo(CWD))) {
          return {
            content: [{ type: 'text', text: 'Not a git repository.' }],
            structuredContent: { action: 'log', entries: [], data: 'Not a git repository' },
          };
        }
        const safeFile = params.file ? path.relative(CWD, safePath(params.file)) : undefined;

        if (params.with_files) {
          const entries = await getGitLogWithFiles(CWD, params.count || 15);
          const output = entries
            .map(
              (e) =>
                `${e.hash.slice(0, 8)} ${e.date.split(' ')[0]} ${e.author}\n  ${e.message}${e.files?.length ? '\n  Files: ' + e.files.join(', ') : ''}`,
            )
            .join('\n\n');
          return {
            content: [{ type: 'text', text: output }],
            structuredContent: {
              action: 'log',
              entries: entries.map((e) => ({ hash: e.hash, date: e.date, author: e.author, message: e.message })),
            },
          };
        }

        const entries = await getGitLog(CWD, {
          count: params.count || 15,
          filePath: safeFile,
          author: params.author,
          since: params.since,
        });
        const output = entries
          .map((e) => `${e.hash.slice(0, 8)} ${e.date.split(' ')[0]} ${e.author.padEnd(20)} ${e.message}`)
          .join('\n');
        return {
          content: [{ type: 'text', text: `Git log (${entries.length} commits):\n\n${output}` }],
          structuredContent: {
            action: 'log',
            entries: entries.map((e) => ({ hash: e.hash, date: e.date, author: e.author, message: e.message })),
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_log failed: ${(error as Error).message}` }],
          structuredContent: { action: 'log', entries: [], data: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_diff — Show changes between commits/refs
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_diff',
    {
      description: 'Show git diff. Compare working tree, staged changes, or between refs/commits.',
      inputSchema: {
        file: z.string().optional().describe('File path to diff'),
        staged: z.boolean().optional().describe('Show staged changes'),
        ref: z.string().optional().describe('First git ref (commit/branch)'),
        ref2: z.string().optional().describe('Second ref for comparison'),
        stat: z.boolean().optional().describe('Show file stats only'),
      },
      outputSchema: outputSchemas.git_history,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (!(await isGitRepo(CWD))) {
          return {
            content: [{ type: 'text', text: 'Not a git repository.' }],
            structuredContent: { action: 'log', entries: [], data: 'Not a git repository' },
          };
        }
        const safeFile = params.file ? path.relative(CWD, safePath(params.file)) : undefined;
        const diff = await getGitDiff(CWD, {
          staged: params.staged,
          ref1: params.ref,
          ref2: params.ref2,
          filePath: safeFile,
          stat: params.stat,
        });
        return {
          content: [{ type: 'text', text: diff || 'No changes.' }],
          structuredContent: { action: 'diff', data: diff || '' },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_diff failed: ${(error as Error).message}` }],
          structuredContent: { action: 'diff', data: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_blame — Line-by-line commit attribution
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_blame',
    {
      description: 'Show git blame for a file. See who last modified each line and when.',
      inputSchema: {
        file: z.string().describe('File path to blame (required)'),
        start_line: z.number().optional().describe('Start line number'),
        end_line: z.number().optional().describe('End line number'),
      },
      outputSchema: outputSchemas.git_history,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (!(await isGitRepo(CWD))) {
          return {
            content: [{ type: 'text', text: 'Not a git repository.' }],
            structuredContent: { action: 'log', entries: [], data: 'Not a git repository' },
          };
        }
        const safeFile = path.relative(CWD, safePath(params.file));
        const blame = await getGitBlame(CWD, safeFile, {
          startLine: params.start_line,
          endLine: params.end_line,
        });
        const output = blame
          .map((b) => `${b.hash} ${b.date} ${b.author.padEnd(15)} L${String(b.line).padStart(4)} │ ${b.content}`)
          .join('\n');
        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            action: 'blame',
            entries: blame.map((b) => ({ hash: b.hash, author: b.author, line: b.line })),
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_blame failed: ${(error as Error).message}` }],
          structuredContent: { action: 'blame', entries: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_status — Working tree status
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_status',
    {
      description: 'Show git status: current branch, staged/unstaged changes, untracked files.',
      inputSchema: {},
      outputSchema: outputSchemas.git_history,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (!(await isGitRepo(CWD))) {
          return {
            content: [{ type: 'text', text: 'Not a git repository.' }],
            structuredContent: { action: 'log', entries: [], data: 'Not a git repository' },
          };
        }
        const status = await getGitStatus(CWD);
        const branch = await getGitBranch(CWD);
        return {
          content: [{ type: 'text', text: `Branch: ${branch}\n\n${status || 'Clean working tree.'}` }],
          structuredContent: { action: 'status', data: `${branch}\n${status || ''}` },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_status failed: ${(error as Error).message}` }],
          structuredContent: { action: 'status', data: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_branches — List all branches
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_branches',
    {
      description: 'List all git branches. Shows current branch with asterisk.',
      inputSchema: {},
      outputSchema: outputSchemas.git_history,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (!(await isGitRepo(CWD))) {
          return {
            content: [{ type: 'text', text: 'Not a git repository.' }],
            structuredContent: { action: 'log', entries: [], data: 'Not a git repository' },
          };
        }
        const branches = await getGitBranches(CWD);
        const current = await getGitBranch(CWD);
        const output = branches.map((b) => (b === current ? `* ${b}` : `  ${b}`)).join('\n');
        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            action: 'branches',
            entries: branches.map((b) => ({ name: b, current: b === current })),
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_branches failed: ${(error as Error).message}` }],
          structuredContent: { action: 'branches', entries: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_show — Show commit details
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_show',
    {
      description: 'Show details of a git commit: message, author, date, and diff.',
      inputSchema: {
        ref: z.string().optional().describe('Commit hash or ref (default: HEAD)'),
        stat: z.boolean().optional().describe('Show file stats only'),
      },
      outputSchema: outputSchemas.git_history,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (!(await isGitRepo(CWD))) {
          return {
            content: [{ type: 'text', text: 'Not a git repository.' }],
            structuredContent: { action: 'log', entries: [], data: 'Not a git repository' },
          };
        }
        const ref = params.ref || 'HEAD';
        const output = await getGitShow(CWD, ref, params.stat);
        return {
          content: [{ type: 'text', text: output.slice(0, 50000) }],
          structuredContent: { action: 'show', data: output.slice(0, 10000) },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_show failed: ${(error as Error).message}` }],
          structuredContent: { action: 'show', data: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_contributors — Contributor statistics
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_contributors',
    {
      description: 'List contributors by commit count. Optionally filter by file.',
      inputSchema: {
        file: z.string().optional().describe('File path to get contributors for'),
      },
      outputSchema: outputSchemas.git_history,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (!(await isGitRepo(CWD))) {
          return {
            content: [{ type: 'text', text: 'Not a git repository.' }],
            structuredContent: { action: 'log', entries: [], data: 'Not a git repository' },
          };
        }
        const safeFile = params.file ? path.relative(CWD, safePath(params.file)) : undefined;
        const contribs = await getContributors(CWD, safeFile);
        const output = contribs.map((c) => `${String(c.commits).padStart(5)} commits  ${c.author}`).join('\n');
        return {
          content: [{ type: 'text', text: `Contributors:\n\n${output}` }],
          structuredContent: {
            action: 'contributors',
            entries: contribs.map((c) => ({ author: c.author, commits: c.commits })),
          },
        };
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_contributors failed: ${(error as Error).message}` }],
          structuredContent: { action: 'contributors', entries: [] },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: change_impact — Analyze impact of code changes
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'change_impact',
    {
      description:
        'Analyze the impact of code changes. Given changed files or a git diff, finds affected dependents, tests to re-run, and breaking changes. Assesses risk level.',
      inputSchema: {
        action: z
          .enum(['analyze', 'categorize'])
          .describe('analyze: full impact analysis, categorize: classify change type'),
        files: z.array(z.string()).optional().describe('Changed file paths for impact analysis'),
        use_git_diff: z.boolean().optional().describe('Use current unstaged git diff (default: false)'),
        ref: z.string().optional().describe('Git ref to diff against (default: HEAD)'),
      },
      outputSchema: outputSchemas.change_impact,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        if (params.action === 'categorize') {
          const diff = await getGitDiff(CWD, { ref1: params.ref });
          if (!diff)
            return {
              content: [{ type: 'text', text: 'No changes to categorize. Working tree is clean.' }],
              structuredContent: { risk: 'none', affected: [], summary: 'No changes' },
            };
          const cat = categorizeChanges(diff);
          return {
            content: [
              {
                type: 'text',
                text: `Change category: ${cat.category} (${cat.confidence}% confidence)\nIndicators: ${cat.indicators.join(', ')}`,
              },
            ],
            structuredContent: { risk: cat.category, affected: [], summary: `${cat.category} (${cat.confidence}%)` },
          };
        }

        // Get changed files
        let changedFiles = params.files || [];
        let diff: string | undefined;

        if (params.use_git_diff || changedFiles.length === 0) {
          if (await isGitRepo(CWD)) {
            const statusOutput = await getGitStatus(CWD);
            if (statusOutput) {
              changedFiles = statusOutput
                .split('\n')
                .filter((l) => l.trim())
                .map((l) => l.replace(/^\s*[MADRC?!]+\s+/, '').trim())
                .filter((f) => f.length > 0);
            }
            diff = await getGitDiff(CWD, { ref1: params.ref });
          }
        }

        if (changedFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No changed files detected. Provide file paths via "files" parameter or ensure there are uncommitted changes.',
              },
            ],
            structuredContent: { risk: 'none', affected: [], summary: 'No changes detected' },
          };
        }

        const impact = await analyzeImpact(CWD, changedFiles, diff);

        let output = `## Change Impact Analysis\n\n${impact.summary}\n\n`;

        if (impact.changedSymbols.length > 0) {
          output += `### Changed symbols:\n${impact.changedSymbols.map((s) => `  ${s.changeType}: ${s.name} in ${s.file}${s.oldName ? ` (was: ${s.oldName})` : ''}`).join('\n')}\n\n`;
        }

        if (impact.affectedFiles.length > 0) {
          output += `### Affected files (${impact.affectedFiles.length}):\n${impact.affectedFiles
            .slice(0, 30)
            .map((f) => `  ${f}`)
            .join('\n')}\n\n`;
        }

        if (impact.affectedTests.length > 0) {
          output += `### Tests to re-run (${impact.affectedTests.length}):\n${impact.affectedTests.map((t) => `  ${t}`).join('\n')}\n\n`;
        }

        if (impact.breakingChanges.length > 0) {
          output += `### ⚠️ Breaking changes:\n${impact.breakingChanges.map((b) => `  ${b}`).join('\n')}\n`;
        }

        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            risk: impact.riskLevel || 'unknown',
            affected:
              impact.affectedFiles?.map((f) => ({
                file: typeof f === 'string' ? f : (f as Record<string, string>).file,
                type: typeof f === 'string' ? 'modified' : (f as Record<string, string>).type || 'modified',
              })) || [],
            summary: output.slice(0, 500),
          },
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `change_impact failed: ${(error as Error).message}. Ensure this is a git repository or provide explicit file paths.`,
            },
          ],
          structuredContent: { risk: 'unknown', affected: [], summary: '' },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: branch_compare — Structural diff between git branches
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'branch_compare',
    {
      description:
        'Compare two git branches structurally: added, modified, deleted, renamed files. Shows per-file diff stats, commits ahead/behind, and conflict files.',
      inputSchema: {
        base: z.string().optional().describe('Base branch to compare from (default: main)'),
        compare: z.string().optional().describe('Branch to compare (default: current HEAD)'),
      },
      outputSchema: outputSchemas.branch_compare,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('branch_compare', async () => {
          const result = await compareBranches(CWD, params.base || 'main', params.compare);
          const lines: string[] = [`## Branch Comparison: ${result.base} → ${result.compare}\n`];
          lines.push(
            `Files: +${result.stats.filesAdded} added, ~${result.stats.filesModified} modified, -${result.stats.filesDeleted} deleted, ↔${result.stats.filesRenamed} renamed`,
          );
          lines.push(`Commits: ${result.commitsAhead} ahead, ${result.commitsBehind} behind`);
          if (result.conflictFiles.length > 0) lines.push(`⚠️ Conflicts: ${result.conflictFiles.join(', ')}`);
          if (result.added.length > 0) {
            lines.push(`\n### Added Files`);
            result.added.slice(0, 20).forEach((f) => lines.push(`  + ${f}`));
          }
          if (result.deleted.length > 0) {
            lines.push(`\n### Deleted Files`);
            result.deleted.slice(0, 20).forEach((f) => lines.push(`  - ${f}`));
          }
          if (result.modified.length > 0) {
            lines.push(`\n### Modified Files`);
            result.modified.slice(0, 30).forEach((f) => lines.push(`  ~ ${f}`));
          }
          if (result.renamed.length > 0) {
            lines.push(`\n### Renamed Files`);
            result.renamed.slice(0, 10).forEach((r) => lines.push(`  ${r.from} → ${r.to}`));
          }
          if (result.diffStat.length > 0) {
            lines.push(`\n### Diff Stats`);
            result.diffStat.slice(0, 20).forEach((d) => lines.push(`  ${d.file}: +${d.insertions} -${d.deletions}`));
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              base: result.base,
              compare: result.compare,
              stats: {
                filesAdded: result.stats.filesAdded,
                filesModified: result.stats.filesModified,
                filesDeleted: result.stats.filesDeleted,
              },
              commitsBehind: result.commitsBehind,
              commitsAhead: result.commitsAhead,
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `branch_compare failed: ${(error as Error).message}. Ensure you're in a git repository with the specified branches.`,
            },
          ],
          structuredContent: {
            base: params.base || 'main',
            compare: params.compare || 'HEAD',
            stats: { filesAdded: 0, filesModified: 0, filesDeleted: 0 },
          },
        };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: git_hooks — Generate/preview pre-commit hooks
  // ═══════════════════════════════════════════════════════════════════════
  server.registerTool(
    'git_hooks',
    {
      description:
        'Generate pre-commit git hooks for code quality. Supports actions: "status" to check existing hooks, "preview" to see what a hook would do, "generate" to create a hook script. Hooks can run security_scan, find_todos, or custom commands.',
      inputSchema: {
        action: z
          .enum(['status', 'preview', 'generate'])
          .describe('"status" shows current hooks, "preview" shows what would run, "generate" creates the hook file'),
        checks: z.array(z.string()).optional().describe('Checks to include: "security", "todos", "lint", "test"'),
      },
      outputSchema: outputSchemas.git_hooks,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      try {
        return await analytics.track('git_hooks', async () => {
          const result = await manageGitHooks(CWD, params.action);
          const lines: string[] = [`## Git Hooks — ${result.action}\n`];
          if (result.action === 'status') {
            lines.push(
              result.existingHook
                ? `Existing pre-commit hook found at ${result.hookPath}`
                : 'No pre-commit hook installed.',
            );
          } else {
            lines.push(`Hook path: ${result.hookPath}`);
            if (result.existingHook) lines.push('⚠️  An existing hook is present and would be overwritten.');
            lines.push(`\n### Hook Content\n\`\`\`bash\n${result.hookContent}\n\`\`\``);
            if (result.action === 'generate') {
              lines.push(
                result.installed
                  ? '\n✅ Hook installed successfully!'
                  : '\n⚠️  Hook generated but NOT installed (read-only mode). Copy the content above to .git/hooks/pre-commit',
              );
            }
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              action: params.action,
              hookPath: result.hookPath,
              installed: result.installed,
              data: result.previewFindings || {},
            },
          };
        });
      } catch (error: unknown) {
        return {
          content: [{ type: 'text', text: `git_hooks failed: ${(error as Error).message}` }],
          structuredContent: { action: 'error', hookPath: undefined, installed: false },
        };
      }
    },
  );
}
