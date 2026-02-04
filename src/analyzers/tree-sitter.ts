/**
 * Tree-sitter AST parsing for accurate code analysis.
 * Uses web-tree-sitter (WASM-based, no native compilation).
 * Falls back to regex-based parsing if grammars unavailable.
 *
 * Supported languages: TypeScript, JavaScript, Python, Go, Java, Rust, C/C++
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';

// Dynamic import for web-tree-sitter (may not be available)
let Parser: any = null;
let treeSitterReady = false;
const loadedLanguages = new Map<string, any>();

// Grammar file locations (downloaded on first use)
const GRAMMAR_URLS: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  rust: 'tree-sitter-rust.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
};

export interface ASTSymbol {
  name: string;
  type: 'function' | 'class' | 'method' | 'interface' | 'enum' | 'variable' | 'type' | 'module' | 'struct' | 'trait';
  startLine: number;
  endLine: number;
  exported: boolean;
  params?: string[];
  returnType?: string;
  docComment?: string;
  children?: ASTSymbol[]; // Methods inside classes, etc.
}

export interface CallGraphEntry {
  caller: string;
  callee: string;
  file: string;
  line: number;
}

export interface ScopeInfo {
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  variables: string[];
  children: ScopeInfo[];
}

/**
 * Initialize tree-sitter. Call once at startup.
 */
export async function initTreeSitter(): Promise<boolean> {
  try {
    const TreeSitter = await import('web-tree-sitter');
    Parser = TreeSitter.default || TreeSitter;
    await Parser.init();
    treeSitterReady = true;
    return true;
  } catch {
    treeSitterReady = false;
    return false;
  }
}

/**
 * Check if tree-sitter is available and ready.
 */
export function isTreeSitterReady(): boolean {
  return treeSitterReady;
}

/**
 * Get supported languages for tree-sitter.
 */
export function getTreeSitterLanguages(): string[] {
  return Object.keys(GRAMMAR_URLS);
}

/**
 * Load a language grammar. Returns null if not available.
 * @param language
 */
async function loadLanguage(language: string): Promise<any | null> {
  if (!treeSitterReady || !Parser) return null;
  if (loadedLanguages.has(language)) return loadedLanguages.get(language);

  const grammarFile = GRAMMAR_URLS[language];
  if (!grammarFile) return null;

  try {
    // Try loading from node_modules or local cache
    const possiblePaths = [
      path.join(process.cwd(), 'grammars', grammarFile),
      path.join(process.cwd(), '.codedev-mcp', 'grammars', grammarFile),
      path.join(process.env.HOME || '', '.codedev-mcp', 'grammars', grammarFile),
    ];

    for (const p of possiblePaths) {
      try {
        const lang = await Parser.Language.load(p);
        loadedLanguages.set(language, lang);
        return lang;
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a file into an AST and extract symbols.
 * Falls back to null if tree-sitter isn't available for this language.
 * @param filePath
 * @param language
 */
export async function parseAST(filePath: string, language: string): Promise<ASTSymbol[] | null> {
  const lang = await loadLanguage(language);
  if (!lang || !Parser) return null;

  try {
    const content = await readFile(filePath, 'utf-8');
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);

    const symbols: ASTSymbol[] = [];
    extractSymbolsFromNode(tree.rootNode, symbols, content, language);

    parser.delete();
    tree.delete();

    return symbols;
  } catch {
    return null;
  }
}

/**
 * Recursively extract symbols from AST nodes.
 * @param node
 * @param symbols
 * @param source
 * @param language
 * @param depth
 */
function extractSymbolsFromNode(node: any, symbols: ASTSymbol[], source: string, language: string, depth = 0): void {
  if (depth > 10) return; // Prevent infinite recursion

  const symbolTypes: Record<string, ASTSymbol['type']> = {
    function_declaration: 'function',
    function_definition: 'function',
    method_definition: 'method',
    method_declaration: 'method',
    class_declaration: 'class',
    class_definition: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
    struct_item: 'struct',
    impl_item: 'module',
    trait_item: 'trait',
    variable_declaration: 'variable',
    lexical_declaration: 'variable',
  };

  const nodeType = symbolTypes[node.type];
  if (nodeType) {
    const nameNode =
      node.childForFieldName?.('name') ||
      node.children?.find((c: any) => c.type === 'identifier' || c.type === 'type_identifier');

    if (nameNode) {
      const symbol: ASTSymbol = {
        name: nameNode.text,
        type: nodeType,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        exported: isExported(node, source),
        children: [],
      };

      // Extract params for functions
      const params = node.childForFieldName?.('parameters') || node.childForFieldName?.('formal_parameters');
      if (params) {
        symbol.params = extractParams(params);
      }

      // Extract return type
      const returnType = node.childForFieldName?.('return_type') || node.childForFieldName?.('result');
      if (returnType) {
        symbol.returnType = returnType.text;
      }

      // Extract doc comment (preceding comment node)
      const prevSibling = node.previousNamedSibling;
      if (prevSibling && (prevSibling.type === 'comment' || prevSibling.type === 'block_comment')) {
        symbol.docComment = prevSibling.text;
      }

      // Extract children (methods inside classes)
      if (nodeType === 'class' || nodeType === 'struct' || nodeType === 'trait') {
        const body = node.childForFieldName?.('body');
        if (body) {
          const childSymbols: ASTSymbol[] = [];
          for (const child of body.children || []) {
            extractSymbolsFromNode(child, childSymbols, source, language, depth + 1);
          }
          symbol.children = childSymbols;
        }
      }

      symbols.push(symbol);
      return; // Don't recurse into the same symbol
    }
  }

  // Recurse into children
  for (const child of node.children || []) {
    extractSymbolsFromNode(child, symbols, source, language, depth + 1);
  }
}

function isExported(node: any, source: string): boolean {
  const lineStart = source.lastIndexOf('\n', node.startIndex) + 1;
  const lineText = source.slice(lineStart, node.startIndex + 50);
  return /export\s/.test(lineText) || /^pub\s/.test(lineText);
}

function extractParams(paramsNode: any): string[] {
  return (paramsNode.children || [])
    .filter((c: any) => c.type !== '(' && c.type !== ')' && c.type !== ',')
    .map((c: any) => c.text)
    .filter((t: string) => t.trim().length > 0);
}

/**
 * Extract call graph from a file — which functions call which.
 * @param filePath
 * @param language
 */
export async function extractCallGraph(filePath: string, language: string): Promise<CallGraphEntry[] | null> {
  const lang = await loadLanguage(language);
  if (!lang || !Parser) return null;

  try {
    const content = await readFile(filePath, 'utf-8');
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);

    const calls: CallGraphEntry[] = [];
    const funcStack: string[] = [];

    function walkForCalls(node: any): void {
      // Track function scope
      const isFuncDef = ['function_declaration', 'function_definition', 'method_definition', 'arrow_function'].includes(
        node.type,
      );
      if (isFuncDef) {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) funcStack.push(nameNode.text);
      }

      // Detect function calls
      if (node.type === 'call_expression') {
        const funcNode = node.childForFieldName?.('function') || node.children?.[0];
        if (funcNode) {
          const callee = funcNode.text;
          const caller = funcStack.length > 0 ? funcStack[funcStack.length - 1] : '<module>';
          calls.push({
            caller,
            callee,
            file: filePath,
            line: node.startPosition.row + 1,
          });
        }
      }

      for (const child of node.children || []) {
        walkForCalls(child);
      }

      if (isFuncDef && node.childForFieldName?.('name')) {
        funcStack.pop();
      }
    }

    walkForCalls(tree.rootNode);

    parser.delete();
    tree.delete();

    return calls;
  } catch {
    return null;
  }
}

/**
 * Extract scope information from a file.
 * @param filePath
 * @param language
 */
export async function extractScopes(filePath: string, language: string): Promise<ScopeInfo[] | null> {
  const lang = await loadLanguage(language);
  if (!lang || !Parser) return null;

  try {
    const content = await readFile(filePath, 'utf-8');
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);

    const scopes: ScopeInfo[] = [];

    function walkForScopes(node: any, parent: ScopeInfo | null): void {
      const scopeTypes = [
        'function_declaration',
        'function_definition',
        'method_definition',
        'class_declaration',
        'class_definition',
        'block',
        'if_statement',
        'for_statement',
        'while_statement',
        'try_statement',
      ];

      if (scopeTypes.includes(node.type)) {
        const nameNode = node.childForFieldName?.('name');
        const scope: ScopeInfo = {
          name: nameNode?.text || `<${node.type}>`,
          type: node.type,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          variables: [],
          children: [],
        };

        // Extract variable declarations within this scope
        for (const child of node.children || []) {
          if (['variable_declaration', 'lexical_declaration', 'assignment'].includes(child.type)) {
            const varName = child.childForFieldName?.('name');
            if (varName) scope.variables.push(varName.text);
          }
        }

        if (parent) parent.children.push(scope);
        else scopes.push(scope);

        for (const child of node.children || []) {
          walkForScopes(child, scope);
        }
      } else {
        for (const child of node.children || []) {
          walkForScopes(child, parent);
        }
      }
    }

    walkForScopes(tree.rootNode, null);

    parser.delete();
    tree.delete();

    return scopes;
  } catch {
    return null;
  }
}
