/**
 * Symbol Extraction & Code Analysis
 * Language-agnostic symbol detection for 40+ languages
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { detectLanguage, getSymbolPatterns, getImportPatterns, getCommentStyle } from '../utils/languages.js';

export interface Symbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'constant' | 'export';
  line: number;
  language: string;
  signature?: string;
}

export interface FileAnalysis {
  path: string;
  language: string;
  size: number;
  lines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
  symbols: Symbol[];
  imports: string[];
  complexity: number; // rough cyclomatic complexity estimate
}

/**
 * Extract all symbols from a file
 * @param filePath
 */
export async function extractSymbols(filePath: string): Promise<Symbol[]> {
  const content = await readFile(filePath, 'utf-8');
  const language = detectLanguage(filePath);
  const patterns = getSymbolPatterns(language);
  const symbols: Symbol[] = [];
  const lines = content.split('\n');

  const kinds: Array<{ key: keyof typeof patterns; kind: Symbol['kind'] }> = [
    { key: 'functions', kind: 'function' },
    { key: 'classes', kind: 'class' },
    { key: 'interfaces', kind: 'interface' },
    { key: 'types', kind: 'type' },
    { key: 'constants', kind: 'constant' },
    { key: 'exports', kind: 'export' },
  ];

  for (const { key, kind } of kinds) {
    for (const pattern of patterns[key]) {
      // Reset regex state
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        if (!name || name.length < 2) continue;
        // Deduplicate
        if (symbols.some((s) => s.name === name && s.kind === kind)) continue;

        // Find line number
        const beforeMatch = content.slice(0, match.index);
        const line = beforeMatch.split('\n').length;

        // Get signature (the full matched line)
        const lineContent = lines[line - 1]?.trim() || '';

        symbols.push({
          name,
          kind,
          line,
          language,
          signature: lineContent.slice(0, 200), // truncate long lines
        });
      }
    }
  }

  // Sort by line number
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}

/**
 * Extract imports from a file
 * @param filePath
 */
export async function extractImports(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, 'utf-8');
  const language = detectLanguage(filePath);
  const patterns = getImportPatterns(language);
  const imports: Set<string> = new Set();

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) imports.add(match[1]);
    }
  }

  return [...imports];
}

/**
 * Count code, comment, and blank lines
 * @param content
 * @param language
 */
function countLineTypes(content: string, language: string): { code: number; comment: number; blank: number } {
  const lines = content.split('\n');
  const style = getCommentStyle(language);
  let code = 0,
    comment = 0,
    blank = 0;
  let inMultiLineComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      blank++;
      continue;
    }

    if (inMultiLineComment) {
      comment++;
      if (style.multiEnd && trimmed.includes(style.multiEnd)) {
        inMultiLineComment = false;
      }
      continue;
    }

    if (style.multiStart && trimmed.startsWith(style.multiStart)) {
      comment++;
      if (!style.multiEnd || !trimmed.includes(style.multiEnd, style.multiStart.length)) {
        inMultiLineComment = true;
      }
      continue;
    }

    if (style.single && trimmed.startsWith(style.single)) {
      comment++;
      continue;
    }

    code++;
  }

  return { code, comment, blank };
}

/**
 * Rough cyclomatic complexity estimate
 * @param content
 * @param language
 */
function estimateComplexity(content: string, language: string): number {
  // Count decision points
  const decisionKeywords = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\belif\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bdo\b/g,
    /\bswitch\b/g,
    /\bcase\b/g,
    /\bmatch\b/g,
    /\bcatch\b/g,
    /\bexcept\b/g,
    /\brescue\b/g,
    /\?\?/g,
    /\?\./g,
    /&&/g,
    /\|\|/g,
    /\bwhen\b/g,
    /\bguard\b/g,
  ];

  let complexity = 1; // base complexity
  for (const pattern of decisionKeywords) {
    const matches = content.match(pattern);
    if (matches) complexity += matches.length;
  }

  return complexity;
}

/**
 * Full file analysis
 * @param filePath
 */
export async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  const content = await readFile(filePath, 'utf-8');
  const fileStat = await stat(filePath);
  const language = detectLanguage(filePath);
  const lines = content.split('\n').length;
  const lineCounts = countLineTypes(content, language);
  const symbols = await extractSymbols(filePath);
  const imports = await extractImports(filePath);
  const complexity = estimateComplexity(content, language);

  return {
    path: filePath,
    language,
    size: fileStat.size,
    lines,
    codeLines: lineCounts.code,
    commentLines: lineCounts.comment,
    blankLines: lineCounts.blank,
    symbols,
    imports,
    complexity,
  };
}

/**
 * Generate a concise outline of a file's structure
 * @param analysis
 */
export function formatFileOutline(analysis: FileAnalysis): string {
  const parts: string[] = [];
  parts.push(`📄 ${analysis.path}`);
  parts.push(
    `   Language: ${analysis.language} | Lines: ${analysis.lines} (code: ${analysis.codeLines}, comments: ${analysis.commentLines}) | Complexity: ${analysis.complexity}`,
  );

  if (analysis.imports.length > 0) {
    parts.push(`   📦 Imports: ${analysis.imports.join(', ')}`);
  }

  const grouped: Record<string, Symbol[]> = {};
  for (const sym of analysis.symbols) {
    if (!grouped[sym.kind]) grouped[sym.kind] = [];
    grouped[sym.kind].push(sym);
  }

  const icons: Record<string, string> = {
    class: '🏗️',
    interface: '📋',
    type: '🔷',
    function: 'ƒ',
    constant: '🔒',
    export: '📤',
  };

  for (const [kind, syms] of Object.entries(grouped)) {
    const icon = icons[kind] || '•';
    parts.push(`   ${icon} ${kind}s: ${syms.map((s) => `${s.name}:${s.line}`).join(', ')}`);
  }

  return parts.join('\n');
}
