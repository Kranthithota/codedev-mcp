/**
 * Language Detection & Symbol Patterns
 * Supports 40+ programming languages for universal codebase analysis
 */

export interface LanguageConfig {
  name: string;
  extensions: string[];
  commentSingle?: string;
  commentMultiStart?: string;
  commentMultiEnd?: string;
  symbolPatterns: {
    functions: RegExp[];
    classes: RegExp[];
    interfaces: RegExp[];
    types: RegExp[];
    constants: RegExp[];
    exports: RegExp[];
  };
  importPattern?: RegExp;
}

// ── Extension → Language Map ────────────────────────────────────────────
const EXT_MAP: Record<string, string> = {
  // JavaScript/TypeScript
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  // Python
  '.py': 'python',
  '.pyi': 'python',
  '.pyw': 'python',
  // Java/JVM
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.groovy': 'groovy',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  // C Family
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.m': 'objectivec',
  '.mm': 'objectivec',
  // Systems
  '.go': 'go',
  '.rs': 'rust',
  '.zig': 'zig',
  '.nim': 'nim',
  '.swift': 'swift',
  '.d': 'dlang',
  // Scripting
  '.rb': 'ruby',
  '.php': 'php',
  '.pl': 'perl',
  '.pm': 'perl',
  '.lua': 'lua',
  '.r': 'r',
  '.R': 'r',
  '.jl': 'julia',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  // Data / Config
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.ini': 'ini',
  '.env': 'env',
  // Shell
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'fish',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',
  // Mobile
  '.dart': 'dart',
  // Functional
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.fs': 'fsharp',
  '.fsi': 'fsharp',
  '.fsx': 'fsharp',
  // Other
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.thrift': 'thrift',
  '.tf': 'terraform',
  '.hcl': 'hcl',
  '.sol': 'solidity',
  '.vy': 'vyper',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.rst': 'rst',
  '.txt': 'text',
  '.dockerfile': 'dockerfile',
};

/**
 * Detect the programming language of a file based on its extension or filename.
 * @param filePath - The file path to detect language for.
 * @returns The detected language name or 'unknown'.
 */
export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  // Special filenames
  if (lower.endsWith('dockerfile') || lower.includes('dockerfile.')) return 'dockerfile';
  if (lower.endsWith('makefile') || lower.endsWith('gnumakefile')) return 'makefile';
  if (lower.endsWith('cmakelists.txt') || lower.endsWith('.cmake')) return 'cmake';
  if (lower.endsWith('rakefile') || lower.endsWith('gemfile')) return 'ruby';
  if (lower.endsWith('cargo.toml') || lower.endsWith('cargo.lock')) return 'toml';

  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return 'unknown';
  const ext = filePath.slice(lastDot).toLowerCase();
  return EXT_MAP[ext] || 'unknown';
}

/**
 * Get all file extensions associated with a language.
 * @param language - The language name.
 * @returns An array of file extensions for the language.
 */
export function getLanguageExtensions(language: string): string[] {
  return Object.entries(EXT_MAP)
    .filter(([, lang]) => lang === language)
    .map(([ext]) => ext);
}

/**
 * Get all known file extensions from the extension map.
 * @returns An array of all registered file extensions.
 */
export function getAllKnownExtensions(): string[] {
  return Object.keys(EXT_MAP);
}

/**
 * Check if a file is a code file (not data/config/docs).
 * @param filePath - The file path to check.
 * @returns True if the file is a code file.
 */
export function isCodeFile(filePath: string): boolean {
  const lang = detectLanguage(filePath);
  return lang !== 'unknown' && !['text', 'markdown', 'rst', 'json', 'yaml', 'toml', 'xml', 'ini', 'env'].includes(lang);
}

// ── Symbol Extraction Patterns ──────────────────────────────────────────
// These are regex patterns that work across languages for symbol extraction
// They're intentionally broad to catch most definitions

const SYMBOL_PATTERNS: Record<string, LanguageConfig['symbolPatterns']> = {
  javascript: {
    functions: [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\w*\s*=>/g,
      /(\w+)\s*\(.*?\)\s*\{/g,
    ],
    classes: [/(?:export\s+)?class\s+(\w+)/g],
    interfaces: [],
    types: [],
    constants: [/(?:export\s+)?const\s+([A-Z_][A-Z0-9_]+)\s*=/g],
    exports: [/export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g, /module\.exports\s*=\s*(\w+)/g],
  },
  typescript: {
    functions: [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\w*\s*=>/g,
    ],
    classes: [/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g],
    interfaces: [/(?:export\s+)?interface\s+(\w+)/g],
    types: [/(?:export\s+)?type\s+(\w+)/g],
    constants: [/(?:export\s+)?const\s+([A-Z_][A-Z0-9_]+)\s*[:=]/g],
    exports: [/export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface|enum)\s+(\w+)/g],
  },
  python: {
    functions: [/^(?:async\s+)?def\s+(\w+)/gm],
    classes: [/^class\s+(\w+)/gm],
    interfaces: [],
    types: [/^(\w+)\s*=\s*(?:TypeVar|NewType|Union|Optional|Literal)/gm],
    constants: [/^([A-Z_][A-Z0-9_]+)\s*[:=]/gm],
    exports: [/^__all__\s*=\s*\[(.*?)\]/gms],
  },
  java: {
    functions: [/(?:public|private|protected|static|\s)+[\w<>[[\]]]+\s+(\w+)\s*\(/g],
    classes: [/(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g],
    interfaces: [/(?:public\s+)?interface\s+(\w+)/g],
    types: [/(?:public\s+)?enum\s+(\w+)/g],
    constants: [/(?:public|private|protected)?\s*static\s+final\s+\w+\s+([A-Z_][A-Z0-9_]+)/g],
    exports: [],
  },
  go: {
    functions: [/func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g],
    // Go uses structs instead of classes
    classes: [],
    interfaces: [/type\s+(\w+)\s+interface\s*\{/g],
    types: [/type\s+(\w+)\s+(?:struct|int|string|float|bool|map|chan|[[])/g],
    constants: [/(?:const|var)\s+(\w+)/g],
    // Go uses capitalization for exports
    exports: [],
  },
  rust: {
    functions: [/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g],
    // Rust uses structs instead of classes
    classes: [],
    interfaces: [/(?:pub\s+)?trait\s+(\w+)/g],
    types: [/(?:pub\s+)?(?:struct|enum|type)\s+(\w+)/g],
    constants: [/(?:pub\s+)?(?:const|static)\s+(\w+)/g],
    exports: [/pub\s+(?:use|mod)\s+(\w+)/g],
  },
  cpp: {
    functions: [/(?:\w+[\s*&]+)?(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?(?:noexcept\s*)?[{;]/g],
    classes: [/(?:class|struct)\s+(\w+)/g],
    // C++ uses abstract classes instead of interfaces
    interfaces: [],
    types: [/(?:typedef|using)\s+(\w+)/g, /enum\s+(?:class\s+)?(\w+)/g],
    constants: [/(?:constexpr|const)\s+\w+\s+([A-Z_][A-Z0-9_]+)/g, /#define\s+([A-Z_][A-Z0-9_]+)/g],
    exports: [],
  },
  c: {
    functions: [/(?:\w+[\s*]+)?(\w+)\s*\([^)]*\)\s*[{;]/g],
    classes: [],
    interfaces: [],
    types: [/typedef\s+(?:struct|enum|union)\s+\w*\s*\{[^}]*\}\s*(\w+)/gs, /typedef\s+\w+\s+(\w+)/g],
    constants: [/#define\s+([A-Z_][A-Z0-9_]+)/g],
    exports: [],
  },
  csharp: {
    functions: [/(?:public|private|protected|internal|static|async|virtual|override|\s)+[\w<>[[\]?]+\s+(\w+)\s*[(<]/g],
    classes: [/(?:public\s+)?(?:abstract\s+)?(?:partial\s+)?(?:static\s+)?class\s+(\w+)/g],
    interfaces: [/(?:public\s+)?interface\s+(\w+)/g],
    types: [/(?:public\s+)?(?:enum|struct|record)\s+(\w+)/g],
    constants: [/(?:public|private|protected|internal)\s+(?:static\s+)?(?:readonly\s+)?const\s+\w+\s+(\w+)/g],
    exports: [],
  },
  ruby: {
    functions: [/def\s+(?:self\.)?(\w+[?!=]?)/g],
    classes: [/class\s+(\w+)/g],
    // Ruby uses modules instead of interfaces
    interfaces: [],
    types: [/module\s+(\w+)/g],
    constants: [/([A-Z_][A-Z0-9_]+)\s*=/g],
    exports: [],
  },
  php: {
    functions: [/(?:public|private|protected|static|\s)*function\s+(\w+)/g],
    classes: [/(?:abstract\s+)?class\s+(\w+)/g],
    interfaces: [/interface\s+(\w+)/g],
    types: [/(?:trait|enum)\s+(\w+)/g],
    constants: [/(?:const|define\(')(\w+)/g],
    exports: [],
  },
  swift: {
    functions: [/(?:public\s+)?(?:static\s+)?func\s+(\w+)/g],
    classes: [/(?:public\s+)?(?:final\s+)?class\s+(\w+)/g],
    interfaces: [/(?:public\s+)?protocol\s+(\w+)/g],
    types: [/(?:public\s+)?(?:struct|enum)\s+(\w+)/g],
    constants: [/(?:let|static\s+let)\s+(\w+)/g],
    exports: [],
  },
  kotlin: {
    functions: [/(?:fun|suspend\s+fun)\s+(?:<.*?>\s+)?(\w+)/g],
    classes: [/(?:data\s+)?(?:abstract\s+)?(?:open\s+)?class\s+(\w+)/g],
    interfaces: [/interface\s+(\w+)/g],
    types: [/(?:enum\s+class|typealias|object)\s+(\w+)/g],
    constants: [/(?:const\s+val|val)\s+([A-Z_][A-Z0-9_]+)/g],
    exports: [],
  },
  dart: {
    functions: [/(?:\w+[\s<>]*\s+)?(\w+)\s*\([^)]*\)\s*(?:async\s*)?[{=>]/g],
    classes: [/(?:abstract\s+)?class\s+(\w+)/g],
    // Dart uses abstract classes instead of interfaces
    interfaces: [],
    types: [/(?:enum|mixin|extension)\s+(\w+)/g],
    constants: [/(?:const|final)\s+\w+\s+([A-Z_]\w+)/g],
    exports: [],
  },
  scala: {
    functions: [/def\s+(\w+)/g],
    classes: [/(?:case\s+)?class\s+(\w+)/g],
    interfaces: [/trait\s+(\w+)/g],
    types: [/(?:type|object)\s+(\w+)/g],
    constants: [/val\s+([A-Z_]\w+)/g],
    exports: [],
  },
  elixir: {
    functions: [/def[p]?\s+(\w+)/g],
    classes: [],
    interfaces: [/defprotocol\s+(\w+)/g],
    types: [/defmodule\s+([\w.]+)/g],
    constants: [],
    exports: [],
  },
  haskell: {
    functions: [/^(\w+)\s+::/gm],
    classes: [/^class\s+(\w+)/gm],
    interfaces: [],
    types: [/^(?:data|type|newtype)\s+(\w+)/gm],
    constants: [],
    exports: [/module\s+(\w+(?:\.\w+)*)/g],
  },
  lua: {
    functions: [/(?:local\s+)?function\s+(?:[\w.:]+\.)?(\w+)/g, /(\w+)\s*=\s*function/g],
    classes: [],
    interfaces: [],
    types: [],
    constants: [],
    exports: [],
  },
  sql: {
    functions: [/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(\w+)/gi],
    classes: [],
    interfaces: [],
    types: [/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|TYPE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi],
    constants: [],
    exports: [],
  },
  solidity: {
    functions: [/function\s+(\w+)/g],
    classes: [/contract\s+(\w+)/g],
    interfaces: [/interface\s+(\w+)/g],
    types: [/(?:struct|enum|event)\s+(\w+)/g],
    constants: [],
    exports: [],
  },
  terraform: {
    functions: [],
    classes: [],
    interfaces: [],
    types: [/(?:resource|data|module|variable|output)\s+"(\w+)"/g],
    constants: [/variable\s+"(\w+)"/g],
    exports: [/output\s+"(\w+)"/g],
  },
};

// Fallback: generic patterns that work for most C-like languages
const GENERIC_PATTERNS: LanguageConfig['symbolPatterns'] = {
  functions: [
    /(?:function|func|fn|def|sub|proc|method)\s+(\w+)/g,
    /(?:public|private|protected|static|\s)+[\w<>[[\]*&]+\s+(\w+)\s*\(/g,
  ],
  classes: [/(?:class|struct|record)\s+(\w+)/g],
  interfaces: [/(?:interface|trait|protocol)\s+(\w+)/g],
  types: [/(?:type|typedef|enum|union)\s+(\w+)/g],
  constants: [/(?:const|final|static)\s+[\w<>[[\]]+\s+([A-Z_][A-Z0-9_]+)/g],
  exports: [/(?:export|pub|public)\s+(?:\w+\s+)*(\w+)/g],
};

/**
 * Get symbol extraction patterns for a given language.
 * @param language - The language name.
 * @returns Symbol patterns for the language or generic fallback patterns.
 */
export function getSymbolPatterns(language: string): LanguageConfig['symbolPatterns'] {
  return SYMBOL_PATTERNS[language] || GENERIC_PATTERNS;
}

// ── Import Detection Patterns ───────────────────────────────────────────
const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  javascript: [
    /import\s+.*?\s+from\s+['"](.+?)['"]/g,
    /import\s*\(\s*['"](.+?)['"]\s*\)/g,
    /require\s*\(\s*['"](.+?)['"]\s*\)/g,
  ],
  typescript: [
    /import\s+.*?\s+from\s+['"](.+?)['"]/g,
    /import\s+type\s+.*?\s+from\s+['"](.+?)['"]/g,
    /import\s*\(\s*['"](.+?)['"]\s*\)/g,
    /require\s*\(\s*['"](.+?)['"]\s*\)/g,
  ],
  python: [/^import\s+([\w.]+)/gm, /^from\s+([\w.]+)\s+import/gm],
  java: [/^import\s+(?:static\s+)?([\w.]+)/gm],
  // Inside import blocks
  go: [/["']([\w./]+)["']/g],
  rust: [/use\s+([\w:]+)/g],
  cpp: [/#include\s*[<"]([\w./]+)[>"]/g],
  c: [/#include\s*[<"]([\w./]+)[>"]/g],
  csharp: [/using\s+([\w.]+)/g],
  ruby: [/require(?:_relative)?\s+['"](.+?)['"]/g],
  php: [/(?:use|require|include)(?:_once)?\s+['"]?(.+?)['"]?\s*;/g],
  swift: [/import\s+(\w+)/g],
  kotlin: [/import\s+([\w.]+)/g],
  dart: [/import\s+['"](.+?)['"]/g],
  scala: [/import\s+([\w.{}]+)/g],
  elixir: [/(?:import|alias|use|require)\s+([\w.]+)/g],
  haskell: [/import\s+(?:qualified\s+)?([\w.]+)/g],
  lua: [/require\s*\(?['"](.+?)['"]\)?/g],
};

/**
 * Get import detection patterns for a given language.
 * @param language - The language name.
 * @returns An array of RegExp patterns for detecting imports.
 */
export function getImportPatterns(language: string): RegExp[] {
  return IMPORT_PATTERNS[language] || [];
}

// ── Comment Detection ───────────────────────────────────────────────────
const COMMENT_STYLES: Record<string, { single?: string; multiStart?: string; multiEnd?: string }> = {
  javascript: { single: '//', multiStart: '/*', multiEnd: '*/' },
  typescript: { single: '//', multiStart: '/*', multiEnd: '*/' },
  python: { single: '#', multiStart: '"""', multiEnd: '"""' },
  java: { single: '//', multiStart: '/*', multiEnd: '*/' },
  go: { single: '//', multiStart: '/*', multiEnd: '*/' },
  rust: { single: '//', multiStart: '/*', multiEnd: '*/' },
  cpp: { single: '//', multiStart: '/*', multiEnd: '*/' },
  c: { single: '//', multiStart: '/*', multiEnd: '*/' },
  csharp: { single: '//', multiStart: '/*', multiEnd: '*/' },
  ruby: { single: '#', multiStart: '=begin', multiEnd: '=end' },
  php: { single: '//', multiStart: '/*', multiEnd: '*/' },
  swift: { single: '//', multiStart: '/*', multiEnd: '*/' },
  kotlin: { single: '//', multiStart: '/*', multiEnd: '*/' },
  shell: { single: '#' },
  sql: { single: '--', multiStart: '/*', multiEnd: '*/' },
  lua: { single: '--', multiStart: '--[[', multiEnd: ']]' },
  haskell: { single: '--', multiStart: '{-', multiEnd: '-}' },
  elixir: { single: '#' },
  html: { multiStart: '<!--', multiEnd: '-->' },
  css: { multiStart: '/*', multiEnd: '*/' },
};

/**
 * Get the comment style for a given language.
 * @param language - The language name.
 * @returns The comment style configuration for the language.
 */
export function getCommentStyle(language: string) {
  return COMMENT_STYLES[language] || { single: '//' };
}

// ── Language categories ─────────────────────────────────────────────────
/**
 * Get the category (or categories) a language belongs to.
 * @param language - The language name.
 * @returns A comma-separated string of categories or 'General'.
 */
export function getLanguageCategory(language: string): string {
  const categories: Record<string, string[]> = {
    'Web Frontend': ['javascript', 'typescript', 'html', 'css', 'scss', 'less', 'vue', 'svelte'],
    'Web Backend': ['python', 'java', 'csharp', 'go', 'rust', 'ruby', 'php', 'elixir', 'scala', 'kotlin'],
    Systems: ['c', 'cpp', 'rust', 'zig', 'nim', 'dlang'],
    Mobile: ['swift', 'kotlin', 'dart', 'objectivec'],
    'Data/ML': ['python', 'r', 'julia', 'sql'],
    DevOps: ['shell', 'dockerfile', 'terraform', 'hcl', 'yaml'],
    Functional: ['haskell', 'ocaml', 'fsharp', 'clojure', 'elixir', 'erlang'],
    Blockchain: ['solidity', 'vyper', 'rust'],
  };

  const result: string[] = [];
  for (const [cat, langs] of Object.entries(categories)) {
    if (langs.includes(language)) result.push(cat);
  }
  return result.length > 0 ? result.join(', ') : 'General';
}
