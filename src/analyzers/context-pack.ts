/**
 * Smart Context Window Packing
 * Given a question/task, returns the most relevant files and symbols
 * that fit within a given token budget. Helps agents minimize waste.
 */

import { searchCode } from '../search/fast-search.js';
import { extractImports } from './symbols.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ContextItem {
  file: string;
  startLine?: number;
  endLine?: number;
  content: string;
  /** 0-1 score */
  relevance: number;
  /** Why this item was included */
  reason: string;
  estimatedTokens: number;
}

export interface ContextPackResult {
  items: ContextItem[];
  totalTokens: number;
  budget: number;
  filesIncluded: number;
  filesSkipped: number;
  strategy: string;
}

// Rough token estimate: ~4 chars per token for code
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Score a file's relevance to a query based on multiple signals.
 * @param file - The file path.
 * @param query - The search query.
 * @param matchCount - Number of matches found.
 * @returns A relevance score between 0 and 1.
 */
function scoreRelevance(file: string, query: string, matchCount: number): number {
  let score = 0;
  const queryLower = query.toLowerCase();
  const fileLower = file.toLowerCase();

  // Direct filename match
  const queryWords = queryLower.split(/[\s_\-./]+/).filter(Boolean);
  for (const word of queryWords) {
    if (fileLower.includes(word)) score += 0.3;
  }

  // Search hit density
  score += Math.min(matchCount * 0.1, 0.4);

  // Prefer source files over configs/tests for code questions
  if (/\.(ts|js|py|java|go|rs|rb|php|cs)$/.test(file)) score += 0.1;
  if (/test|spec|__test__|_test\./i.test(file)) score -= 0.1;
  if (/config|\.config|\.env/i.test(file)) score -= 0.05;

  // Prefer shorter paths (more specific files)
  score += Math.max(0, 0.1 - file.split('/').length * 0.01);

  return Math.max(0, Math.min(1, score));
}

/**
 * Pack the most relevant context for a given question within a token budget.
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.query - The search query.
 * @param options.maxTokens - Maximum token budget.
 * @param options.includeImports - Whether to include imported files.
 * @param options.includeSymbols - Whether to include symbols.
 * @param options.maxFiles - Maximum number of files to include.
 * @returns The packed context result.
 */
export async function packContext(
  cwd: string,
  options: {
    query: string;
    maxTokens?: number;
    includeImports?: boolean;
    includeSymbols?: boolean;
    maxFiles?: number;
  },
): Promise<ContextPackResult> {
  const budget = options.maxTokens || 8000;
  const maxFiles = options.maxFiles || 20;
  const items: ContextItem[] = [];
  let totalTokens = 0;
  let filesSkipped = 0;

  // Strategy 1: Search for direct matches
  const searchResults = await searchCode({
    cwd,
    pattern: options.query,
    maxResults: 100,
    caseSensitive: false,
  });

  // Group results by file, count matches
  const fileHits = new Map<string, { count: number; lines: number[] }>();
  for (const r of searchResults) {
    const existing = fileHits.get(r.file) || { count: 0, lines: [] };
    existing.count++;
    existing.lines.push(r.line);
    fileHits.set(r.file, existing);
  }

  // Score and sort files by relevance
  const scoredFiles = Array.from(fileHits.entries())
    .map(([file, data]) => ({
      file,
      score: scoreRelevance(file, options.query, data.count),
      lines: data.lines,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  // Pack files within budget
  for (const { file, score, lines } of scoredFiles) {
    if (totalTokens >= budget) {
      filesSkipped++;
      continue;
    }

    try {
      const fullContent = await readFile(path.join(cwd, file), 'utf-8');
      const allLines = fullContent.split('\n');

      // If file is small enough, include it all
      const fileTokens = estimateTokens(fullContent);
      if (fileTokens <= budget - totalTokens && allLines.length <= 300) {
        items.push({
          file,
          content: fullContent,
          relevance: score,
          reason: `${lines.length} matches for "${options.query}"`,
          estimatedTokens: fileTokens,
        });
        totalTokens += fileTokens;
        continue;
      }

      // Otherwise, extract relevant regions (lines around matches)
      const contextRadius = 10;
      const regions: [number, number][] = [];
      for (const line of lines) {
        const start = Math.max(0, line - contextRadius - 1);
        const end = Math.min(allLines.length - 1, line + contextRadius - 1);
        regions.push([start, end]);
      }

      // Merge overlapping regions
      const merged = mergeRegions(regions);
      const snippets: string[] = [];
      for (const [start, end] of merged) {
        const chunk = allLines.slice(start, end + 1).join('\n');
        snippets.push(`// Lines ${start + 1}-${end + 1}\n${chunk}`);
      }

      const content = snippets.join('\n\n...\n\n');
      const tokens = estimateTokens(content);
      if (totalTokens + tokens <= budget) {
        items.push({
          file,
          startLine: merged[0]?.[0],
          endLine: merged[merged.length - 1]?.[1],
          content,
          relevance: score,
          reason: `${lines.length} matches, showing ${merged.length} region(s)`,
          estimatedTokens: tokens,
        });
        totalTokens += tokens;
      } else {
        filesSkipped++;
      }
    } catch {
      filesSkipped++;
    }
  }

  // If we have budget left and includeImports, add imported files
  if (options.includeImports && totalTokens < budget * 0.8 && items.length > 0) {
    const importedFiles = new Set<string>();
    for (const item of items) {
      try {
        const imports = await extractImports(path.join(cwd, item.file));
        for (const imp of imports) {
          const resolved = resolveImport(imp, item.file);
          if (resolved) importedFiles.add(resolved);
        }
      } catch {
        /* skip */
      }
    }

    for (const impFile of importedFiles) {
      if (totalTokens >= budget) break;
      if (items.some((i) => i.file === impFile)) continue;

      try {
        const content = await readFile(path.join(cwd, impFile), 'utf-8');
        const tokens = estimateTokens(content);
        if (totalTokens + tokens <= budget && content.split('\n').length <= 200) {
          items.push({
            file: impFile,
            content,
            relevance: 0.2,
            reason: 'Imported by a relevant file',
            estimatedTokens: tokens,
          });
          totalTokens += tokens;
        }
      } catch {
        /* skip */
      }
    }
  }

  return {
    items: items.sort((a, b) => b.relevance - a.relevance),
    totalTokens,
    budget,
    filesIncluded: items.length,
    filesSkipped,
    strategy: 'search → score → pack → imports',
  };
}

/**
 * Merge overlapping line regions.
 * @param regions - Array of line ranges to merge.
 * @returns Merged non-overlapping line regions.
 */
function mergeRegions(regions: [number, number][]): [number, number][] {
  if (regions.length === 0) return [];
  const sorted = [...regions].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1] + 1) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

/**
 * Resolve a relative import path to a file path.
 * @param source - The import source path.
 * @param fromFile - The file containing the import.
 * @returns The resolved file path, or null if not a relative import.
 */
function resolveImport(source: string, fromFile: string): string | null {
  if (!source.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  const resolved = path.join(dir, source).replace(/\\/g, '/');
  // Try common extensions
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
    const candidate = resolved + ext;
    return candidate;
  }
  return resolved;
}
