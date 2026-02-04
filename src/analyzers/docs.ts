/**
 * Documentation extraction from source code.
 * Parses JSDoc, Python docstrings, Rustdoc, Javadoc, Go doc comments.
 * Links documentation to symbols for "show docs for X" queries.
 */

import { readFile } from 'node:fs/promises';

export interface DocEntry {
  symbol: string;
  symbolType: string; // function, class, method, etc.
  file: string;
  line: number;
  doc: string;
  params?: { name: string; type?: string; description: string }[];
  returns?: { type?: string; description: string };
  examples?: string[];
  tags?: { tag: string; value: string }[];
  deprecated?: boolean;
}

/**
 * Extract all documentation from a file.
 * @param filePath
 * @param language
 */
export async function extractDocs(filePath: string, language: string): Promise<DocEntry[]> {
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');

  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx':
      return extractJSDoc(lines, filePath);
    case 'python':
      return extractPythonDocs(lines, filePath);
    case 'java':
    case 'kotlin':
      return extractJavadoc(lines, filePath);
    case 'rust':
      return extractRustdoc(lines, filePath);
    case 'go':
      return extractGoDocs(lines, filePath);
    case 'c':
    case 'cpp':
    case 'csharp':
      return extractCStyleDocs(lines, filePath);
    default:
      return extractGenericDocs(lines, filePath);
  }
}

/**
 * Extract JSDoc comments.
 * @param lines
 * @param filePath
 */
function extractJSDoc(lines: string[], filePath: string): DocEntry[] {
  const docs: DocEntry[] = [];
  let i = 0;

  while (i < lines.length) {
    // Look for /** ... */ blocks
    if (lines[i].trim().startsWith('/**')) {
      const commentLines: string[] = [];
      const startLine = i + 1;

      while (i < lines.length && !lines[i].includes('*/')) {
        commentLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) commentLines.push(lines[i]); // Include closing */
      i++;

      // Next non-empty line should be the symbol definition
      while (i < lines.length && lines[i].trim() === '') i++;

      if (i < lines.length) {
        const symbolInfo = parseJSSymbol(lines[i], i + 1);
        if (symbolInfo) {
          const parsed = parseJSDocComment(commentLines.join('\n'));
          docs.push({
            ...symbolInfo,
            file: filePath,
            doc: parsed.description,
            params: parsed.params,
            returns: parsed.returns,
            examples: parsed.examples,
            tags: parsed.tags,
            deprecated: parsed.deprecated,
          });
        }
      }
    } else {
      i++;
    }
  }

  return docs;
}

function parseJSSymbol(line: string, lineNum: number): { symbol: string; symbolType: string; line: number } | null {
  const patterns = [
    { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: 'function' },
    { regex: /(?:export\s+)?class\s+(\w+)/, type: 'class' },
    { regex: /(?:export\s+)?interface\s+(\w+)/, type: 'interface' },
    { regex: /(?:export\s+)?type\s+(\w+)/, type: 'type' },
    { regex: /(?:export\s+)?enum\s+(\w+)/, type: 'enum' },
    { regex: /(?:export\s+)?const\s+(\w+)/, type: 'variable' },
    { regex: /(\w+)\s*[:(]/, type: 'method' },
  ];

  for (const { regex, type } of patterns) {
    const match = line.match(regex);
    if (match) return { symbol: match[1], symbolType: type, line: lineNum };
  }
  return null;
}

function parseJSDocComment(comment: string): {
  description: string;
  params: { name: string; type?: string; description: string }[];
  returns?: { type?: string; description: string };
  examples: string[];
  tags: { tag: string; value: string }[];
  deprecated: boolean;
} {
  const cleaned = comment
    .replace(/\/\*\*\s*/, '')
    .replace(/\s*\*\//, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();

  const params: { name: string; type?: string; description: string }[] = [];
  const tags: { tag: string; value: string }[] = [];
  const examples: string[] = [];
  let returns: { type?: string; description: string } | undefined;
  let deprecated = false;
  const descLines: string[] = [];
  let inExample = false;
  let currentExample = '';

  for (const line of cleaned.split('\n')) {
    const paramMatch = line.match(/@param\s+\{([^}]+)\}\s+(\w+)\s*(.*)/);
    const paramNoType = line.match(/@param\s+(\w+)\s*(.*)/);
    const returnMatch = line.match(/@returns?\s+\{([^}]+)\}\s*(.*)/);
    const returnNoType = line.match(/@returns?\s+(.*)/);
    const tagMatch = line.match(/@(\w+)\s*(.*)/);

    if (line.trim().startsWith('@example')) {
      if (inExample && currentExample) examples.push(currentExample.trim());
      inExample = true;
      currentExample = '';
    } else if (inExample && tagMatch) {
      if (currentExample) examples.push(currentExample.trim());
      inExample = false;
    } else if (inExample) {
      currentExample += line + '\n';
      continue;
    }

    if (paramMatch) {
      params.push({ name: paramMatch[2], type: paramMatch[1], description: paramMatch[3] });
    } else if (paramNoType && !paramMatch) {
      params.push({ name: paramNoType[1], description: paramNoType[2] });
    } else if (returnMatch) {
      returns = { type: returnMatch[1], description: returnMatch[2] };
    } else if (returnNoType && !returnMatch && line.includes('@return')) {
      returns = { description: returnNoType[1] };
    } else if (line.includes('@deprecated')) {
      deprecated = true;
    } else if (tagMatch && !line.includes('@param') && !line.includes('@return') && !line.includes('@example')) {
      tags.push({ tag: tagMatch[1], value: tagMatch[2] });
    } else if (!tagMatch) {
      descLines.push(line);
    }
  }

  if (inExample && currentExample) examples.push(currentExample.trim());

  return {
    description: descLines.join('\n').trim(),
    params,
    returns,
    examples,
    tags,
    deprecated,
  };
}

/**
 * Extract Python docstrings.
 * @param lines
 * @param filePath
 */
function extractPythonDocs(lines: string[], filePath: string): DocEntry[] {
  const docs: DocEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    const classMatch = line.match(/^(\s*)class\s+(\w+)/);

    if (defMatch || classMatch) {
      const symbolName = (defMatch || classMatch)![2];
      const symbolType = defMatch ? 'function' : 'class';
      const symbolLine = i + 1;

      // Look for docstring on next lines
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      // Skip to after the ):
      while (j < lines.length && !lines[j].includes(':') && j - i < 5) j++;
      j++; // move past the colon line
      while (j < lines.length && lines[j].trim() === '') j++;

      if (j < lines.length) {
        const nextLine = lines[j].trim();
        const quote = nextLine.startsWith('"""') ? '"""' : nextLine.startsWith("'''") ? "'''" : null;

        if (quote) {
          const docLines: string[] = [];
          if (nextLine !== quote && nextLine.endsWith(quote) && nextLine.length > 6) {
            // Single-line docstring
            docLines.push(nextLine.slice(3, -3));
          } else {
            docLines.push(nextLine.slice(3));
            j++;
            while (j < lines.length && !lines[j].trim().endsWith(quote)) {
              docLines.push(lines[j]);
              j++;
            }
            if (j < lines.length) {
              const last = lines[j].trim();
              if (last !== quote) docLines.push(last.slice(0, -3));
            }
          }

          const docText = docLines.join('\n').trim();
          const parsed = parsePythonDocstring(docText);

          docs.push({
            symbol: symbolName,
            symbolType,
            file: filePath,
            line: symbolLine,
            doc: parsed.description,
            params: parsed.params,
            returns: parsed.returns,
            examples: parsed.examples,
            tags: [],
            deprecated: docText.toLowerCase().includes('deprecated'),
          });
        }
      }
    }
  }

  return docs;
}

function parsePythonDocstring(doc: string): {
  description: string;
  params: { name: string; type?: string; description: string }[];
  returns?: { type?: string; description: string };
  examples: string[];
} {
  const params: { name: string; type?: string; description: string }[] = [];
  const examples: string[] = [];
  let returns: { type?: string; description: string } | undefined;
  const descLines: string[] = [];
  let section = 'desc';

  for (const line of doc.split('\n')) {
    const trimmed = line.trim();

    if (/^(Args|Parameters|Params):$/i.test(trimmed)) {
      section = 'params';
      continue;
    }
    if (/^(Returns|Return):$/i.test(trimmed)) {
      section = 'returns';
      continue;
    }
    if (/^(Examples?|Usage):$/i.test(trimmed)) {
      section = 'examples';
      continue;
    }
    if (/^(Raises|Throws|Note|Notes|Attributes):$/i.test(trimmed)) {
      section = 'other';
      continue;
    }

    if (section === 'params') {
      const paramMatch = trimmed.match(/(\w+)\s*(?:\(([^)]+)\))?\s*:\s*(.*)/);
      if (paramMatch) params.push({ name: paramMatch[1], type: paramMatch[2], description: paramMatch[3] });
    } else if (section === 'returns') {
      if (trimmed) returns = { description: trimmed };
    } else if (section === 'examples') {
      examples.push(trimmed);
    } else if (section === 'desc') {
      descLines.push(trimmed);
    }
  }

  return { description: descLines.join('\n').trim(), params, returns, examples };
}

/**
 * Extract Javadoc comments.
 * @param lines
 * @param filePath
 */
function extractJavadoc(lines: string[], filePath: string): DocEntry[] {
  // Javadoc uses same /** */ format as JSDoc
  return extractJSDoc(lines, filePath);
}

/**
 * Extract Rust /// doc comments.
 * @param lines
 * @param filePath
 */
function extractRustdoc(lines: string[], filePath: string): DocEntry[] {
  const docs: DocEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Collect consecutive /// lines
    if (lines[i].trim().startsWith('///')) {
      const docLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('///')) {
        docLines.push(lines[j].trim().replace(/^\/\/\/\s?/, ''));
        j++;
      }

      // Next non-empty line should be the symbol
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length) {
        const rustSymbol = parseRustSymbol(lines[j], j + 1);
        if (rustSymbol) {
          docs.push({
            ...rustSymbol,
            file: filePath,
            doc: docLines.join('\n').trim(),
            tags: [],
            deprecated: docLines.some((l) => l.includes('deprecated')),
          });
        }
      }
      i = j;
    }
  }

  return docs;
}

function parseRustSymbol(line: string, lineNum: number): { symbol: string; symbolType: string; line: number } | null {
  const patterns = [
    { regex: /pub\s+(?:async\s+)?fn\s+(\w+)/, type: 'function' },
    { regex: /pub\s+struct\s+(\w+)/, type: 'struct' },
    { regex: /pub\s+enum\s+(\w+)/, type: 'enum' },
    { regex: /pub\s+trait\s+(\w+)/, type: 'trait' },
    { regex: /pub\s+type\s+(\w+)/, type: 'type' },
    { regex: /fn\s+(\w+)/, type: 'function' },
    { regex: /struct\s+(\w+)/, type: 'struct' },
  ];

  for (const { regex, type } of patterns) {
    const match = line.match(regex);
    if (match) return { symbol: match[1], symbolType: type, line: lineNum };
  }
  return null;
}

/**
 * Extract Go doc comments (comments directly preceding declarations).
 * @param lines
 * @param filePath
 */
function extractGoDocs(lines: string[], filePath: string): DocEntry[] {
  const docs: DocEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('//')) {
      const docLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('//')) {
        docLines.push(lines[j].trim().replace(/^\/\/\s?/, ''));
        j++;
      }

      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length) {
        const goSymbol = parseGoSymbol(lines[j], j + 1);
        if (goSymbol) {
          docs.push({
            ...goSymbol,
            file: filePath,
            doc: docLines.join('\n').trim(),
            tags: [],
          });
        }
      }
      i = j;
    }
  }

  return docs;
}

function parseGoSymbol(line: string, lineNum: number): { symbol: string; symbolType: string; line: number } | null {
  const patterns = [
    { regex: /func\s+(\w+)/, type: 'function' },
    { regex: /func\s+\([^)]+\)\s+(\w+)/, type: 'method' },
    { regex: /type\s+(\w+)\s+struct/, type: 'struct' },
    { regex: /type\s+(\w+)\s+interface/, type: 'interface' },
    { regex: /type\s+(\w+)/, type: 'type' },
  ];

  for (const { regex, type } of patterns) {
    const match = line.match(regex);
    if (match) return { symbol: match[1], symbolType: type, line: lineNum };
  }
  return null;
}

/**
 * Extract C-style block comment and line comment docs.
 * @param lines
 * @param filePath
 */
function extractCStyleDocs(lines: string[], filePath: string): DocEntry[] {
  return extractJSDoc(lines, filePath);
}

/**
 * Generic doc extraction for unsupported languages.
 * Looks for any comment blocks before definitions.
 * @param lines
 * @param filePath
 */
function extractGenericDocs(lines: string[], filePath: string): DocEntry[] {
  const docs: DocEntry[] = [];
  const commentBlock: string[] = [];
  let commentStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) {
      if (commentBlock.length === 0) commentStart = i;
      commentBlock.push(trimmed.replace(/^[/#-]+\s?/, ''));
    } else if (commentBlock.length > 0 && trimmed) {
      // Check if this line looks like a definition
      const defMatch = trimmed.match(/(?:function|def|fn|func|class|struct|module|sub|procedure)\s+(\w+)/);
      if (defMatch) {
        docs.push({
          symbol: defMatch[1],
          symbolType: 'function',
          file: filePath,
          line: i + 1,
          doc: commentBlock.join('\n').trim(),
          tags: [],
        });
      }
      commentBlock.length = 0;
    } else if (!trimmed) {
      commentBlock.length = 0;
    }
  }

  return docs;
}

/**
 * Find undocumented public symbols in a file.
 * @param filePath
 * @param language
 */
export async function findUndocumented(
  filePath: string,
  language: string,
): Promise<{ symbol: string; line: number; type: string }[]> {
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const documented = await extractDocs(filePath, language);
  const docSymbols = new Set(documented.map((d) => d.symbol));

  const undocumented: { symbol: string; line: number; type: string }[] = [];

  const exportPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /(?:export\s+)?class\s+(\w+)/,
    /(?:export\s+)?interface\s+(\w+)/,
    /pub\s+fn\s+(\w+)/,
    /pub\s+struct\s+(\w+)/,
    /func\s+(\w+)/,
    /def\s+(\w+)/,
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of exportPatterns) {
      const match = lines[i].match(pattern);
      if (match && !docSymbols.has(match[1]) && !match[1].startsWith('_')) {
        undocumented.push({ symbol: match[1], line: i + 1, type: 'public' });
      }
    }
  }

  return undocumented;
}
