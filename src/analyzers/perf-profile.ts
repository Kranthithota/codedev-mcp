/**
 * Performance Profiling Integration
 * Parses common profiling output: Node.js CPU profiles (.cpuprofile),
 * webpack bundle stats, and performs heuristic analysis on file/dep sizes.
 */

import { listFiles } from '../search/fast-search.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface PerfEntry {
  type: 'hot_function' | 'large_bundle' | 'slow_module' | 'large_file' | 'heavy_dep';
  name: string;
  file?: string;
  metric: string;
  value: number;
  unit: string;
  severity: 'critical' | 'warning' | 'info';
  recommendation?: string;
}

export interface PerfResult {
  entries: PerfEntry[];
  sources: string[];
  profFiles: string[];
  summary: { critical: number; warning: number; info: number };
  bundleSize?: { total: number; largest: { name: string; size: number }[] };
}

/**
 * Parse Node.js .cpuprofile files (V8 CPU profile format).
 * @param content - The raw CPU profile JSON content
 * @returns Array of performance entries for hot functions
 */
function parseCPUProfile(content: string): PerfEntry[] {
  const entries: PerfEntry[] = [];
  try {
    const profile = JSON.parse(content);
    const nodes = profile.nodes || [];
    const funcHits: { name: string; url: string; hitCount: number }[] = [];
    for (const node of nodes) {
      if (node.hitCount > 0 && node.callFrame) {
        funcHits.push({
          name: node.callFrame.functionName || '(anonymous)',
          url: node.callFrame.url || '',
          hitCount: node.hitCount,
        });
      }
    }
    funcHits.sort((a, b) => b.hitCount - a.hitCount);
    const totalHits = funcHits.reduce((sum, f) => sum + f.hitCount, 0);
    for (const func of funcHits.slice(0, 20)) {
      const pct = totalHits > 0 ? ((func.hitCount / totalHits) * 100).toFixed(1) : '0';
      const severity =
        parseFloat(pct) > 10 ? ('critical' as const) : parseFloat(pct) > 3 ? ('warning' as const) : ('info' as const);
      entries.push({
        type: 'hot_function',
        name: func.name,
        file: func.url.replace(/^file:\/\//, ''),
        metric: 'CPU time',
        value: parseFloat(pct),
        unit: '%',
        severity,
        recommendation: parseFloat(pct) > 10 ? `Hot function taking ${pct}% CPU` : undefined,
      });
    }
  } catch {
    /* skip */
  }
  return entries;
}

/**
 * Parse webpack stats.json for bundle analysis.
 * @param content - The raw webpack stats JSON content
 * @param file - The stats file path
 * @returns Array of performance entries for bundle sizes
 */
function parseWebpackStats(content: string, file: string): PerfEntry[] {
  const entries: PerfEntry[] = [];
  try {
    const stats = JSON.parse(content);
    const assets = stats.assets || [];
    const sorted = assets
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => (b.size as number) - (a.size as number))
      .slice(0, 15);
    for (const asset of sorted) {
      const sizeMB = (asset.size / (1024 * 1024)).toFixed(2);
      const severity =
        asset.size > 500_000 ? ('critical' as const) : asset.size > 200_000 ? ('warning' as const) : ('info' as const);
      entries.push({
        type: 'large_bundle',
        name: asset.name,
        file,
        metric: 'Bundle size',
        value: asset.size,
        unit: 'bytes',
        severity,
        recommendation:
          asset.size > 500_000 ? `Bundle ${asset.name} is ${sizeMB}MB — consider code splitting` : undefined,
      });
    }
  } catch {
    /* skip */
  }
  return entries;
}

/**
 * Analyze source file sizes.
 * @param cwd - The working directory
 * @returns Array of performance entries for large files
 */
async function analyzeFileSizes(cwd: string): Promise<PerfEntry[]> {
  const entries: PerfEntry[] = [];
  const files = await listFiles(cwd, { glob: '**/*.{ts,tsx,js,jsx,py,java,go,rs}' });
  for (const file of files.slice(0, 500)) {
    try {
      const st = await stat(path.join(cwd, file));
      const sizeKB = st.size / 1024;
      if (sizeKB > 100) {
        entries.push({
          type: 'large_file',
          name: file,
          file,
          metric: 'File size',
          value: Math.round(sizeKB),
          unit: 'KB',
          severity: sizeKB > 500 ? ('critical' as const) : sizeKB > 200 ? ('warning' as const) : ('info' as const),
          recommendation: sizeKB > 200 ? `File is ${Math.round(sizeKB)}KB — consider splitting` : undefined,
        });
      }
    } catch {
      /* skip */
    }
  }
  return entries.sort((a, b) => b.value - a.value).slice(0, 15);
}

/**
 * Analyze heavy dependencies from package.json.
 * @param cwd - The working directory
 * @returns Array of performance entries for heavy dependencies
 */
async function analyzeHeavyDeps(cwd: string): Promise<PerfEntry[]> {
  const entries: PerfEntry[] = [];
  const HEAVY_DEPS: Record<string, { sizeEstKB: number; alternative?: string }> = {
    moment: { sizeEstKB: 290, alternative: 'date-fns or dayjs (2-7KB)' },
    lodash: { sizeEstKB: 530, alternative: 'lodash-es with tree-shaking' },
    'aws-sdk': { sizeEstKB: 7500, alternative: '@aws-sdk/* v3 modular packages' },
    firebase: { sizeEstKB: 600, alternative: 'firebase/app + only needed modules' },
    antd: { sizeEstKB: 1200, alternative: 'Import individual antd components' },
    '@mui/material': { sizeEstKB: 800, alternative: 'Import individual @mui components' },
    'core-js': { sizeEstKB: 500, alternative: 'Use browserslist for targeted polyfills' },
  };
  try {
    const pkgContent = await readFile(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [name, info] of Object.entries(HEAVY_DEPS)) {
      if (allDeps[name]) {
        entries.push({
          type: 'heavy_dep',
          name,
          metric: 'Estimated bundle impact',
          value: info.sizeEstKB,
          unit: 'KB',
          severity: info.sizeEstKB > 500 ? ('warning' as const) : ('info' as const),
          recommendation: info.alternative ? `Consider: ${info.alternative}` : undefined,
        });
      }
    }
  } catch {
    /* skip */
  }
  return entries.sort((a, b) => b.value - a.value);
}

/**
 * Main performance analysis function.
 * @param cwd - The working directory
 * @returns Performance analysis results with entries and summary
 */
export async function analyzePerformance(cwd: string): Promise<PerfResult> {
  const allEntries: PerfEntry[] = [];
  const sources: string[] = [];
  const profFiles: string[] = [];

  // CPU profiles
  const cpuProfiles = await listFiles(cwd, { glob: '**/*.cpuprofile' });
  for (const f of cpuProfiles.slice(0, 5)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      const entries = parseCPUProfile(content);
      if (entries.length > 0) {
        allEntries.push(...entries);
        profFiles.push(f);
        sources.push('cpuprofile');
      }
    } catch {
      /* skip */
    }
  }

  // Webpack stats
  const statsFiles = await listFiles(cwd, { glob: '**/*stats*.json' });
  for (const f of statsFiles.filter((f) => /stats|bundle/i.test(f)).slice(0, 3)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      if (content.includes('"assets"') || content.includes('"modules"')) {
        const entries = parseWebpackStats(content, f);
        if (entries.length > 0) {
          allEntries.push(...entries);
          profFiles.push(f);
          sources.push('webpack-stats');
        }
      }
    } catch {
      /* skip */
    }
  }

  // File size analysis
  const fileSizeEntries = await analyzeFileSizes(cwd);
  if (fileSizeEntries.length > 0) {
    allEntries.push(...fileSizeEntries);
    sources.push('file-sizes');
  }

  // Heavy deps
  const heavyDepEntries = await analyzeHeavyDeps(cwd);
  if (heavyDepEntries.length > 0) {
    allEntries.push(...heavyDepEntries);
    sources.push('dep-weight');
  }

  const summary = { critical: 0, warning: 0, info: 0 };
  for (const e of allEntries) summary[e.severity]++;

  const bundleEntries = allEntries.filter((e) => e.type === 'large_bundle');
  const bundleSize =
    bundleEntries.length > 0
      ? {
          total: bundleEntries.reduce((sum, e) => sum + e.value, 0),
          largest: bundleEntries.slice(0, 5).map((e) => ({ name: e.name, size: e.value })),
        }
      : undefined;

  return { entries: allEntries, sources: [...new Set(sources)], profFiles, summary, bundleSize };
}
