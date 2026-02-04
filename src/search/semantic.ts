/**
 * Semantic code search using TF-IDF scoring.
 * No external model dependencies — works offline, instant startup.
 *
 * Answers queries like "find authentication logic" or "error handling code"
 * by matching against function names, comments, imports, and string literals.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface SemanticDoc {
  file: string;
  chunk: string; // Code section (function/block)
  startLine: number;
  endLine: number;
  tokens: string[]; // Extracted meaningful tokens
}

interface SemanticResult {
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  matchedTerms: string[];
}

// Concept synonyms for expanding queries
const CONCEPT_MAP: Record<string, string[]> = {
  auth: [
    'auth',
    'login',
    'logout',
    'session',
    'token',
    'jwt',
    'oauth',
    'password',
    'credential',
    'authenticate',
    'authorize',
    'permission',
    'role',
    'rbac',
  ],
  database: [
    'database',
    'db',
    'sql',
    'query',
    'table',
    'schema',
    'migration',
    'model',
    'orm',
    'repository',
    'entity',
    'record',
    'row',
    'column',
    'index',
  ],
  api: [
    'api',
    'endpoint',
    'route',
    'handler',
    'controller',
    'middleware',
    'request',
    'response',
    'rest',
    'graphql',
    'grpc',
    'webhook',
  ],
  error: [
    'error',
    'exception',
    'catch',
    'throw',
    'try',
    'finally',
    'fault',
    'failure',
    'retry',
    'fallback',
    'recovery',
    'panic',
  ],
  test: [
    'test',
    'spec',
    'describe',
    'it',
    'expect',
    'assert',
    'mock',
    'stub',
    'fixture',
    'beforeEach',
    'afterEach',
    'jest',
    'mocha',
    'pytest',
  ],
  config: [
    'config',
    'configuration',
    'settings',
    'env',
    'environment',
    'option',
    'preference',
    'parameter',
    'setup',
    'initialize',
  ],
  cache: ['cache', 'memoize', 'redis', 'memcache', 'ttl', 'invalidate', 'expire', 'store', 'lru'],
  log: [
    'log',
    'logger',
    'logging',
    'debug',
    'trace',
    'info',
    'warn',
    'console',
    'print',
    'output',
    'telemetry',
    'metric',
  ],
  security: [
    'security',
    'encrypt',
    'decrypt',
    'hash',
    'salt',
    'csrf',
    'xss',
    'sanitize',
    'validate',
    'escape',
    'cors',
    'helmet',
  ],
  ui: [
    'ui',
    'component',
    'render',
    'template',
    'view',
    'layout',
    'style',
    'css',
    'html',
    'dom',
    'element',
    'widget',
    'page',
  ],
  network: [
    'network',
    'http',
    'https',
    'fetch',
    'axios',
    'socket',
    'websocket',
    'tcp',
    'udp',
    'connection',
    'client',
    'server',
  ],
  file: ['file', 'filesystem', 'fs', 'read', 'write', 'stream', 'buffer', 'path', 'directory', 'upload', 'download'],
  async: [
    'async',
    'await',
    'promise',
    'callback',
    'event',
    'emitter',
    'observable',
    'future',
    'channel',
    'concurrent',
    'parallel',
    'thread',
    'worker',
  ],
  validation: [
    'validate',
    'validation',
    'schema',
    'check',
    'verify',
    'constraint',
    'rule',
    'sanitize',
    'parse',
    'zod',
    'joi',
    'yup',
  ],
  payment: [
    'payment',
    'stripe',
    'billing',
    'invoice',
    'subscription',
    'charge',
    'refund',
    'checkout',
    'cart',
    'order',
    'price',
  ],
};

/**
 * Tokenize code into meaningful words.
 * Splits camelCase, snake_case, removes noise.
 * @param text
 */
function tokenize(text: string): string[] {
  // Remove string contents, keep identifiers
  const cleaned = text
    .replace(/(['"`])[\s\S]*?\1/g, '') // Remove string literals
    .replace(/\/\/.*$/gm, (m) => m) // Keep comments (useful signals)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m); // Keep block comments

  // Extract words, split camelCase and snake_case
  const words = cleaned
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .replace(/[_\-./\\]/g, ' ') // snake_case → snake case
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  return [...new Set(words)]; // Deduplicate
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'its',
  'let',
  'var',
  'const',
  'new',
  'this',
  'that',
  'with',
  'from',
  'will',
  'have',
  'been',
  'more',
  'when',
  'who',
  'than',
  'them',
  'some',
  'what',
  'then',
  'each',
  'make',
  'like',
  'just',
  'use',
  'null',
  'void',
  'true',
  'false',
  'else',
  'case',
  'return',
  'import',
  'export',
  'default',
  'require',
  'module',
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'type',
  'interface',
  'class',
  'function',
  'extends',
  'implements',
  'public',
  'private',
  'protected',
  'static',
  'abstract',
  'override',
  'readonly',
  'any',
  'undefined',
]);

/**
 * Chunk a file into logical blocks (functions, classes, or fixed-size blocks).
 * @param content
 * @param filePath
 */
function chunkFile(content: string, filePath: string): { chunk: string; startLine: number; endLine: number }[] {
  const lines = content.split('\n');
  const chunks: { chunk: string; startLine: number; endLine: number }[] = [];

  // Simple heuristic: split on function/class definitions or every 30 lines
  let currentChunk: string[] = [];
  let startLine = 1;

  const funcPattern =
    /^(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func|pub\s+fn|pub\s+async\s+fn|module|impl)\b/;
  const methodPattern = /^\s+(?:async\s+)?(?:public|private|protected|static)?\s*(?:function|def|fn)?\s*\w+\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isDefinition = funcPattern.test(line.trim()) || methodPattern.test(line);

    if (isDefinition && currentChunk.length > 5) {
      // Save current chunk and start new one
      chunks.push({
        chunk: currentChunk.join('\n'),
        startLine,
        endLine: i,
      });
      currentChunk = [line];
      startLine = i + 1;
    } else {
      currentChunk.push(line);
      // Also split if chunk is too large
      if (currentChunk.length >= 50) {
        chunks.push({
          chunk: currentChunk.join('\n'),
          startLine,
          endLine: i + 1,
        });
        currentChunk = [];
        startLine = i + 2;
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({
      chunk: currentChunk.join('\n'),
      startLine,
      endLine: lines.length,
    });
  }

  return chunks;
}

/**
 * Expand query using concept synonyms.
 * @param query
 */
function expandQuery(query: string): string[] {
  const queryTokens = tokenize(query);
  const expanded = new Set(queryTokens);

  for (const token of queryTokens) {
    for (const [concept, synonyms] of Object.entries(CONCEPT_MAP)) {
      if (synonyms.includes(token) || concept === token) {
        for (const syn of synonyms) {
          expanded.add(syn);
        }
      }
    }
  }

  return [...expanded];
}

/**
 * Calculate TF-IDF score for a chunk against expanded query terms.
 * @param chunkTokens
 * @param queryTerms
 * @param idf
 */
function scoreTfIdf(
  chunkTokens: string[],
  queryTerms: string[],
  idf: Map<string, number>,
): { score: number; matched: string[] } {
  const tf = new Map<string, number>();
  for (const token of chunkTokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  let score = 0;
  const matched: string[] = [];

  for (const term of queryTerms) {
    const termTf = tf.get(term) || 0;
    if (termTf > 0) {
      const termIdf = idf.get(term) || 1;
      score += (1 + Math.log(termTf)) * termIdf;
      matched.push(term);
    }
  }

  return { score, matched };
}

/**
 * Perform semantic search across files.
 * @param files
 * @param query
 * @param cwd
 * @param maxResults
 */
export async function semanticSearch(
  files: string[],
  query: string,
  cwd: string,
  maxResults = 20,
): Promise<SemanticResult[]> {
  const expandedQuery = expandQuery(query);

  // Index all chunks
  const docs: SemanticDoc[] = [];
  const docFreq = new Map<string, number>(); // Document frequency for IDF

  for (const file of files.slice(0, 500)) {
    try {
      const fullPath = path.join(cwd, file);
      const content = await readFile(fullPath, 'utf-8');
      const chunks = chunkFile(content, file);

      for (const { chunk, startLine, endLine } of chunks) {
        const tokens = tokenize(chunk);
        docs.push({ file, chunk, startLine, endLine, tokens });

        // Update document frequency
        const uniqueTokens = new Set(tokens);
        for (const token of uniqueTokens) {
          docFreq.set(token, (docFreq.get(token) || 0) + 1);
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  if (docs.length === 0) return [];

  // Calculate IDF
  const idf = new Map<string, number>();
  const N = docs.length;
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log(N / (1 + df)));
  }

  // Score each chunk
  const scored: SemanticResult[] = [];
  for (const doc of docs) {
    const { score, matched } = scoreTfIdf(doc.tokens, expandedQuery, idf);
    if (score > 0 && matched.length > 0) {
      // Get a snippet (first few lines of the chunk)
      const snippetLines = doc.chunk.split('\n').slice(0, 5);
      scored.push({
        file: doc.file,
        startLine: doc.startLine,
        endLine: doc.endLine,
        score,
        snippet: snippetLines.join('\n'),
        matchedTerms: matched,
      });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults);
}
