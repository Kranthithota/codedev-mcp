/**
 * Complexity Heatmap
 * Ranks files and functions by cyclomatic/cognitive complexity.
 */

import { listFiles } from '../search/fast-search.js';
import { extractSymbols } from '../analyzers/symbols.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ComplexityEntry {
  file: string;
  symbol?: string;
  line?: number;
  metrics: { cyclomatic: number; cognitive: number; nesting: number; loc: number; params?: number };
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface HeatmapResult {
  hotspots: ComplexityEntry[];
  fileScores: { file: string; score: number; grade: string; loc: number }[];
  summary: { totalFiles: number; averageScore: number; criticalCount: number; healthyCount: number };
}

function cyclomatic(code: string): number {
  let c = 1;
  const ps = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\bwhile\b/g,
    /\bfor\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /&&/g,
    /\|\|/g,
    /\?[^.?:]/g,
  ];
  for (const p of ps) {
    const m = code.match(p);
    if (m) c += m.length;
  }
  return c;
}

function cognitive(code: string): number {
  let cog = 0,
    nest = 0;
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (/\b(if|elif|while|for|switch|match)\b/.test(t)) cog += 1 + nest;
    if (/\belse\b/.test(t) && !/else\s+if/.test(t)) cog += 1;
    cog += (t.match(/&&|\|\|/g) || []).length;
    nest += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    nest = Math.max(0, nest);
  }
  return cog;
}

function maxNesting(code: string): number {
  let max = 0,
    cur = 0;
  for (const ch of code) {
    if (ch === '{') {
      cur++;
      max = Math.max(max, cur);
    } else if (ch === '}') cur = Math.max(0, cur - 1);
  }
  return max;
}

function grade(s: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (s <= 20) return 'A';
  if (s <= 40) return 'B';
  if (s <= 60) return 'C';
  if (s <= 80) return 'D';
  return 'F';
}

function score(m: ComplexityEntry['metrics']): number {
  return Math.round(
    Math.min(100, (m.cyclomatic / 30) * 100) * 0.3 +
      Math.min(100, (m.cognitive / 50) * 100) * 0.3 +
      Math.min(100, (m.nesting / 8) * 100) * 0.2 +
      Math.min(100, (m.loc / 500) * 100) * 0.2,
  );
}

/**
 *
 * @param cwd
 * @param options
 * @param options.directory
 * @param options.fileGlob
 * @param options.top
 * @param options.granularity
 */
export async function generateHeatmap(
  cwd: string,
  options?: { directory?: string; fileGlob?: string; top?: number; granularity?: 'file' | 'function' },
): Promise<HeatmapResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const files = await listFiles(dir, { glob: options?.fileGlob || '**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,php,cs}' });
  const top = options?.top || 20;
  const hotspots: ComplexityEntry[] = [];
  const fileScores: HeatmapResult['fileScores'] = [];

  for (const file of files.slice(0, 500)) {
    try {
      const absPath = path.resolve(dir, file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');
      const codeLoc = lines.filter((l) => l.trim() && !l.trim().startsWith('//')).length;
      const fm = {
        cyclomatic: cyclomatic(content),
        cognitive: cognitive(content),
        nesting: maxNesting(content),
        loc: codeLoc,
      };
      const fs = score(fm);
      fileScores.push({ file, score: fs, grade: grade(fs), loc: codeLoc });

      if (options?.granularity !== 'file') {
        const symbols = await extractSymbols(absPath);
        for (const fn of symbols.filter((s) => s.kind === 'function' || s.kind === 'class')) {
          const start = fn.line - 1;
          let end = start,
            braces = 0,
            opened = false;
          for (let i = start; i < lines.length && i < start + 200; i++) {
            for (const ch of lines[i]) {
              if (ch === '{') {
                braces++;
                opened = true;
              }
              if (ch === '}') braces--;
            }
            end = i;
            if (opened && braces <= 0) break;
          }
          const body = lines.slice(start, end + 1).join('\n');
          if (end - start < 3) continue;
          const paramMatch = lines[start]?.match(/\(([^)]*)\)/);
          const params = paramMatch ? (paramMatch[1].trim() ? paramMatch[1].split(',').length : 0) : 0;
          const m = {
            cyclomatic: cyclomatic(body),
            cognitive: cognitive(body),
            nesting: maxNesting(body),
            loc: end - start + 1,
            params,
          };
          const s = score(m);
          hotspots.push({ file, symbol: fn.name, line: fn.line, metrics: m, score: s, grade: grade(s) });
        }
      }
    } catch {
      /* skip */
    }
  }

  hotspots.sort((a, b) => b.score - a.score);
  fileScores.sort((a, b) => b.score - a.score);
  const scores = fileScores.map((f) => f.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  return {
    hotspots: hotspots.slice(0, top),
    fileScores: fileScores.slice(0, top),
    summary: {
      totalFiles: fileScores.length,
      averageScore: avg,
      criticalCount: fileScores.filter((f) => f.grade === 'D' || f.grade === 'F').length,
      healthyCount: fileScores.filter((f) => f.grade === 'A' || f.grade === 'B').length,
    },
  };
}
