
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { outputSchemas } from '../schemas/output-schemas.js';
import { CWD, safePath } from '../config.js';
import { cache } from '../cache/memory-cache.js';
import { readFileRange, listFiles } from '../search/fast-search.js';

/**
 * Format file size in human-readable format
 */
function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format modification time as relative time
 */
function formatRelativeTime(mtime: Date): string {
    const now = Date.now();
    const diff = now - mtime.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}

/**
 * Get file type icon
 */
function getFileIcon(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const iconMap: Record<string, string> = {
        '.ts': '🔷', '.tsx': '🔷', '.js': '🟨', '.jsx': '🟨',
        '.py': '🐍', '.rb': '💎', '.go': '🔵', '.rs': '🦀',
        '.java': '☕', '.kt': '🟣', '.swift': '🍎', '.c': '⚙️',
        '.cpp': '⚙️', '.h': '📋', '.md': '📝', '.json': '📦',
        '.yaml': '📄', '.yml': '📄', '.toml': '📄', '.html': '🌐',
        '.css': '🎨', '.scss': '🎨', '.sql': '🗃️', '.sh': '🖥️',
        '.dockerfile': '🐳', '.lock': '🔒', '.env': '🔐',
    };
    return iconMap[ext] || '📄';
}

export function registerNavTools(server: McpServer) {
    // ═══════════════════════════════════════════════════════════════════════
    // TOOL: read_files — Read one or more files (consolidated)
    // ═══════════════════════════════════════════════════════════════════════
    server.registerTool(
        'read_files',
        {
            description:
                'Read one or more files. Pass a single path or array of paths. Supports line ranges for single files and truncation for batch reads.',
            inputSchema: {
                path: z.string().optional().describe('Single file path relative to project root'),
                paths: z.array(z.string()).optional().describe('Multiple file paths for batch read'),
                start_line: z.number().optional().describe('Start line for single file (1-indexed)'),
                end_line: z.number().optional().describe('End line for single file (inclusive)'),
                max_lines_per_file: z.number().optional().describe('Truncate each file in batch mode (default: 200)'),
            },
            outputSchema: outputSchemas.read_files,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        },
        async (params) => {
            // Single file mode
            if (params.path) {
                try {
                    const filePath = safePath(params.path);
                    const cached = await cache.get<string>(`read:${params.path}:${params.start_line}:${params.end_line}`, filePath);
                    if (cached)
                        return {
                            content: [{ type: 'text', text: cached }],
                            structuredContent: { files: [{ path: params.path, content: cached, lines: cached.split('\n').length }] },
                        };

                    const { content, totalLines } = await readFileRange(filePath, params.start_line, params.end_line);
                    const startNum = params.start_line || 1;
                    const numbered = content
                        .split('\n')
                        .map((line, i) => `${String(startNum + i).padStart(5)} │ ${line}`)
                        .join('\n');

                    const range =
                        params.start_line || params.end_line
                            ? ` (lines ${params.start_line || 1}-${params.end_line || totalLines})`
                            : '';
                    const result = `${params.path}${range} — ${totalLines} total lines\n\n${numbered}`;

                    await cache.set(`read:${params.path}:${params.start_line}:${params.end_line}`, result, 30_000, filePath);
                    return {
                        content: [{ type: 'text', text: result }],
                        structuredContent: { files: [{ path: params.path, content: result, lines: result.split('\n').length }] },
                    };
                } catch (error: any) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `read_files failed: ${error.message}. Verify the file path exists. Use file_tree to discover files or search_code to find files by content.`,
                            },
                        ],
                        isError: true,
                    };
                }
            }

            // Batch mode
            if (params.paths) {
                const maxLines = params.max_lines_per_file || 200;
                const results: string[] = [];

                for (const filePath of params.paths) {
                    try {
                        const fullPath = safePath(filePath);
                        const content = await readFile(fullPath, 'utf-8');
                        const lines = content.split('\n');
                        const truncated = lines.length > maxLines;
                        const displayLines = truncated ? lines.slice(0, maxLines) : lines;
                        const numbered = displayLines.map((line, i) => `${String(i + 1).padStart(5)} │ ${line}`).join('\n');
                        results.push(
                            `\n━━━ ${filePath} (${lines.length} lines${truncated ? `, showing first ${maxLines}` : ''}) ━━━\n${numbered}`,
                        );
                    } catch (error: any) {
                        results.push(`\n━━━ ${filePath} ━━━\nError: ${error.message}`);
                    }
                }

                return {
                    content: [{ type: 'text', text: results.join('\n') }],
                    structuredContent: {
                        files: results.map((r, i) => ({ path: params.paths![i], content: r, lines: r.split('\n').length })),
                    },
                };
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: 'read_files requires either "path" (single file) or "paths" (batch). Use file_tree to discover available files.',
                    },
                ],
                isError: true,
            };
        },
    );

    // ═══════════════════════════════════════════════════════════════════════
    // TOOL: file_tree — Smart directory listing with sizes and dates
    // ═══════════════════════════════════════════════════════════════════════
    server.registerTool(
        'file_tree',
        {
            description:
                'List files and directories with sizes, modification times, and type icons. Automatically excludes node_modules, .git, build artifacts.',
            inputSchema: {
                directory: z.string().optional().describe('Directory to list (default: project root)'),
                glob: z.string().optional().describe('File pattern filter, e.g. "*.ts", "*.py"'),
                max_depth: z.number().optional().describe('Maximum directory depth (default: 3)'),
                type: z.enum(['file', 'dir', 'all']).optional().describe('Show only files, only directories, or all'),
                show_details: z.boolean().optional().describe('Show sizes and dates (default: true)'),
            },
            outputSchema: outputSchemas.file_tree,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                const targetDir = params.directory ? safePath(params.directory) : CWD;
                const showDetails = params.show_details !== false;
                const maxDepth = params.max_depth || 3;

                const files = await listFiles(targetDir, {
                    glob: params.glob,
                    maxDepth: maxDepth,
                    type: params.type as 'file' | 'dir' | 'all' | undefined,
                });

                // Get file stats if details requested
                interface FileInfo {
                    path: string;
                    dir: string;
                    name: string;
                    size?: number;
                    mtime?: Date;
                    depth: number;
                }

                const fileInfos: FileInfo[] = [];

                for (const file of files.slice(0, 200)) { // Limit to 200 files
                    const filePath = path.join(targetDir, file);
                    const depth = file.split(path.sep).length - 1;
                    const info: FileInfo = {
                        path: file,
                        dir: path.dirname(file) || '.',
                        name: path.basename(file),
                        depth,
                    };

                    if (showDetails) {
                        try {
                            const stats = await stat(filePath);
                            info.size = stats.size;
                            info.mtime = stats.mtime;
                        } catch {
                            // Skip stat errors
                        }
                    }

                    fileInfos.push(info);
                }

                // Group by directory
                const byDir: Map<string, FileInfo[]> = new Map();
                for (const info of fileInfos) {
                    const existing = byDir.get(info.dir) || [];
                    existing.push(info);
                    byDir.set(info.dir, existing);
                }

                // Build output
                let output = `📂 ${params.directory || '.'} (${files.length} items${files.length > 200 ? ', showing first 200' : ''})\n\n`;

                const sortedDirs = Array.from(byDir.keys()).sort();

                for (const dir of sortedDirs) {
                    const items = byDir.get(dir)!;
                    const indent = dir === '.' ? '' : '  '.repeat(dir.split(path.sep).length);

                    if (dir !== '.') {
                        output += `${indent}📁 ${dir}/\n`;
                    }

                    const fileIndent = dir === '.' ? '' : '  '.repeat(dir.split(path.sep).length + 1);

                    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
                        const icon = getFileIcon(item.name);
                        const sizePart = item.size !== undefined ? ` ${formatSize(item.size).padStart(8)}` : '';
                        const timePart = item.mtime ? ` ${formatRelativeTime(item.mtime).padStart(10)}` : '';

                        if (showDetails && (sizePart || timePart)) {
                            output += `${fileIndent}${icon} ${item.name}${sizePart}${timePart}\n`;
                        } else {
                            output += `${fileIndent}${icon} ${item.name}\n`;
                        }
                    }
                }

                return {
                    content: [{ type: 'text', text: output }],
                    structuredContent: {
                        tree: output,
                        fileCount: files.length,
                        files: fileInfos.slice(0, 50).map(f => ({
                            path: f.path,
                            size: f.size,
                            modified: f.mtime?.toISOString(),
                        })),
                    },
                };
            } catch (error: any) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `file_tree failed: ${error.message}. Verify the directory path exists and is accessible.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
