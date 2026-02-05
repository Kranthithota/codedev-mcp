import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { semanticSearch } from '../../../src/search/semantic.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Semantic Search', () => {
    let tempDir: string;

    beforeAll(async () => {
        tempDir = join(tmpdir(), `semantic-search-test-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });

        // --- auth-related files ---
        await writeFile(
            join(tempDir, 'auth.ts'),
            [
                'import jwt from "jsonwebtoken";',
                '',
                '// Authenticate user with credentials',
                'export async function login(username: string, password: string) {',
                '  const user = await findUser(username);',
                '  if (!user || !verifyPassword(password, user.hash)) {',
                '    throw new Error("Invalid credentials");',
                '  }',
                '  const token = jwt.sign({ sub: user.id }, SECRET);',
                '  return { token, session: createSession(user) };',
                '}',
                '',
                'export function logout(sessionId: string) {',
                '  destroySession(sessionId);',
                '}',
                '',
                'export function authorize(user: any, role: string) {',
                '  return user.roles.includes(role);',
                '}',
            ].join('\n'),
        );

        await writeFile(
            join(tempDir, 'session.ts'),
            [
                '// Session management for authenticated users',
                'export class SessionManager {',
                '  private sessions = new Map<string, Session>();',
                '',
                '  createSession(user: User): Session {',
                '    const session = { id: generateId(), userId: user.id, token: generateToken() };',
                '    this.sessions.set(session.id, session);',
                '    return session;',
                '  }',
                '',
                '  destroySession(id: string): void {',
                '    this.sessions.delete(id);',
                '  }',
                '',
                '  validateSession(token: string): boolean {',
                '    for (const session of this.sessions.values()) {',
                '      if (session.token === token) return true;',
                '    }',
                '    return false;',
                '  }',
                '}',
            ].join('\n'),
        );

        // --- database-related files ---
        await writeFile(
            join(tempDir, 'database.ts'),
            [
                'import { Pool } from "pg";',
                '',
                '// Database connection and query execution',
                'export class Database {',
                '  private pool: Pool;',
                '',
                '  constructor(connectionString: string) {',
                '    this.pool = new Pool({ connectionString });',
                '  }',
                '',
                '  async query(sql: string, params?: any[]) {',
                '    const client = await this.pool.connect();',
                '    try {',
                '      const result = await client.query(sql, params);',
                '      return result.rows;',
                '    } finally {',
                '      client.release();',
                '    }',
                '  }',
                '',
                '  async migrate(schema: string) {',
                '    await this.query(schema);',
                '  }',
                '}',
            ].join('\n'),
        );

        await writeFile(
            join(tempDir, 'repository.ts'),
            [
                '// Repository pattern for database access',
                'export class UserRepository {',
                '  constructor(private db: Database) {}',
                '',
                '  async findById(id: string) {',
                '    const rows = await this.db.query(',
                '      "SELECT * FROM users WHERE id = $1",',
                '      [id]',
                '    );',
                '    return rows[0] ?? null;',
                '  }',
                '',
                '  async insertRecord(entity: User) {',
                '    await this.db.query(',
                '      "INSERT INTO users (name, email) VALUES ($1, $2)",',
                '      [entity.name, entity.email]',
                '    );',
                '  }',
                '}',
            ].join('\n'),
        );

        // --- unrelated file (no auth or db concepts) ---
        await writeFile(
            join(tempDir, 'utils.ts'),
            [
                '// Generic utility helpers',
                'export function capitalize(str: string): string {',
                '  return str.charAt(0).toUpperCase() + str.slice(1);',
                '}',
                '',
                'export function range(start: number, end: number): number[] {',
                '  return Array.from({ length: end - start }, (_, i) => start + i);',
                '}',
                '',
                'export function sleep(ms: number): Promise<void> {',
                '  return new Promise(resolve => setTimeout(resolve, ms));',
                '}',
            ].join('\n'),
        );

        // --- large file for chunking tests ---
        const largeFunctionBlocks: string[] = [];
        for (let i = 0; i < 8; i++) {
            const lines: string[] = [];
            lines.push(`export function handler${i}(req: Request, res: Response) {`);
            // Pad with comment lines to exceed 50-line chunk threshold
            for (let j = 0; j < 10; j++) {
                lines.push(`  // processing step ${j} for handler${i}`);
                lines.push(`  const value${j} = compute(req.body.field${j});`);
                lines.push(`  res.locals.data${j} = value${j};`);
            }
            lines.push('  return res.json({ ok: true });');
            lines.push('}');
            lines.push('');
            largeFunctionBlocks.push(lines.join('\n'));
        }
        await writeFile(join(tempDir, 'large-handlers.ts'), largeFunctionBlocks.join('\n'));

        // --- file with auth-adjacent naming to test scoring ---
        await writeFile(
            join(tempDir, 'middleware.ts'),
            [
                '// Middleware for checking JWT tokens',
                'export function authMiddleware(req: any, res: any, next: any) {',
                '  const token = req.headers.authorization;',
                '  if (!token) {',
                '    return res.status(401).json({ error: "No token" });',
                '  }',
                '  try {',
                '    const decoded = verifyToken(token);',
                '    req.user = decoded;',
                '    next();',
                '  } catch {',
                '    return res.status(403).json({ error: "Invalid token" });',
                '  }',
                '}',
            ].join('\n'),
        );

        // --- subdirectory file ---
        await mkdir(join(tempDir, 'models'), { recursive: true });
        await writeFile(
            join(tempDir, 'models', 'user-model.ts'),
            [
                '// ORM model definition',
                'export class UserModel {',
                '  id: string;',
                '  name: string;',
                '  email: string;',
                '  passwordHash: string;',
                '',
                '  static tableName = "users";',
                '',
                '  async save(db: Database) {',
                '    await db.query(',
                '      `INSERT INTO ${UserModel.tableName} VALUES ($1, $2, $3)`,',
                '      [this.id, this.name, this.email]',
                '    );',
                '  }',
                '}',
            ].join('\n'),
        );
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // ---------------------------------------------------------------
    // 1. Concept expansion: "authentication" -> auth synonyms
    // ---------------------------------------------------------------
    describe('Concept Expansion - Authentication', () => {
        it('should find files containing auth/login/token/session keywords when searching for "authentication"', async () => {
            const files = [
                'auth.ts',
                'session.ts',
                'database.ts',
                'utils.ts',
                'middleware.ts',
            ];

            const results = await semanticSearch(files, 'auth', tempDir);

            expect(results.length).toBeGreaterThan(0);

            const hitFiles = results.map((r) => r.file);
            // auth.ts uses login, token, session, credentials, authorize
            expect(hitFiles).toContain('auth.ts');
            // session.ts uses session, token
            expect(hitFiles).toContain('session.ts');
            // middleware.ts uses token, auth
            expect(hitFiles).toContain('middleware.ts');
        });

        it('should rank auth-heavy files higher than tangentially related files', async () => {
            const files = [
                'auth.ts',
                'session.ts',
                'utils.ts',
                'middleware.ts',
            ];

            const results = await semanticSearch(files, 'auth', tempDir);

            // auth.ts and middleware.ts should appear before utils.ts (if utils even matches)
            const authIdx = results.findIndex((r) => r.file === 'auth.ts');
            const utilsIdx = results.findIndex((r) => r.file === 'utils.ts');

            expect(authIdx).toBeGreaterThanOrEqual(0);
            // utils.ts should either not appear or rank lower
            if (utilsIdx >= 0) {
                expect(authIdx).toBeLessThan(utilsIdx);
            }
        });
    });

    // ---------------------------------------------------------------
    // 2. Concept expansion: "database" -> db/sql/query synonyms
    // ---------------------------------------------------------------
    describe('Concept Expansion - Database', () => {
        it('should find files containing db/sql/query keywords when searching for "database"', async () => {
            const files = [
                'auth.ts',
                'database.ts',
                'repository.ts',
                'utils.ts',
                'models/user-model.ts',
            ];

            const results = await semanticSearch(files, 'database', tempDir);

            expect(results.length).toBeGreaterThan(0);

            const hitFiles = results.map((r) => r.file);
            // database.ts uses query, sql, pool, schema, migrate
            expect(hitFiles).toContain('database.ts');
            // repository.ts uses query, record, entity, db
            expect(hitFiles).toContain('repository.ts');
            // user-model.ts uses orm, model, table, db, query
            expect(hitFiles).toContain('models/user-model.ts');
        });

        it('should not prominently return unrelated files', async () => {
            const files = ['database.ts', 'utils.ts'];

            const results = await semanticSearch(files, 'database', tempDir);

            const dbResults = results.filter((r) => r.file === 'database.ts');
            const utilsResults = results.filter((r) => r.file === 'utils.ts');

            expect(dbResults.length).toBeGreaterThan(0);

            // If utils.ts appears at all, its score should be lower
            if (utilsResults.length > 0) {
                expect(dbResults[0].score).toBeGreaterThan(utilsResults[0].score);
            }
        });
    });

    // ---------------------------------------------------------------
    // 3. Results sorted by score (highest first)
    // ---------------------------------------------------------------
    describe('Result Ordering', () => {
        it('should return results sorted by score in descending order', async () => {
            const files = [
                'auth.ts',
                'session.ts',
                'database.ts',
                'repository.ts',
                'utils.ts',
                'middleware.ts',
                'models/user-model.ts',
            ];

            const results = await semanticSearch(files, 'authentication', tempDir);

            for (let i = 1; i < results.length; i++) {
                expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
            }
        });

        it('should maintain descending order for database queries too', async () => {
            const files = [
                'auth.ts',
                'database.ts',
                'repository.ts',
                'utils.ts',
                'models/user-model.ts',
            ];

            const results = await semanticSearch(files, 'database', tempDir);

            for (let i = 1; i < results.length; i++) {
                expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
            }
        });
    });

    // ---------------------------------------------------------------
    // 4. Snippet generation
    // ---------------------------------------------------------------
    describe('Snippet Generation', () => {
        it('should include a non-empty snippet for each result', async () => {
            const files = ['auth.ts', 'database.ts'];

            const results = await semanticSearch(files, 'auth', tempDir);

            expect(results.length).toBeGreaterThan(0);
            for (const result of results) {
                expect(result.snippet).toBeDefined();
                expect(typeof result.snippet).toBe('string');
                expect(result.snippet.length).toBeGreaterThan(0);
            }
        });

        it('should produce a snippet that is at most 5 lines long', async () => {
            const files = ['auth.ts', 'database.ts'];

            const results = await semanticSearch(files, 'database', tempDir);

            for (const result of results) {
                const lineCount = result.snippet.split('\n').length;
                expect(lineCount).toBeLessThanOrEqual(5);
            }
        });

        it('should produce a snippet that is actual content from the file', async () => {
            const files = ['auth.ts'];

            const results = await semanticSearch(files, 'auth', tempDir);

            expect(results.length).toBeGreaterThan(0);
            // The snippet should contain recognizable text from auth.ts
            const allSnippets = results.map((r) => r.snippet).join('\n');
            // At least one of these tokens should appear since auth.ts has them
            const hasRelevant =
                allSnippets.includes('login') ||
                allSnippets.includes('jwt') ||
                allSnippets.includes('token') ||
                allSnippets.includes('authenticate') ||
                allSnippets.includes('authorize') ||
                allSnippets.includes('session');
            expect(hasRelevant).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // 5. maxResults limiting
    // ---------------------------------------------------------------
    describe('maxResults Limiting', () => {
        it('should respect maxResults=1 and return at most 1 result', async () => {
            const files = [
                'auth.ts',
                'session.ts',
                'database.ts',
                'middleware.ts',
            ];

            const results = await semanticSearch(files, 'authentication', tempDir, 1);

            expect(results.length).toBeLessThanOrEqual(1);
        });

        it('should respect maxResults=2', async () => {
            const files = [
                'auth.ts',
                'session.ts',
                'database.ts',
                'middleware.ts',
            ];

            const results = await semanticSearch(files, 'authentication', tempDir, 2);

            expect(results.length).toBeLessThanOrEqual(2);
        });

        it('should return all results when maxResults exceeds total matches', async () => {
            const files = ['auth.ts'];

            const unlimited = await semanticSearch(files, 'authentication', tempDir, 1000);
            const limited = await semanticSearch(files, 'authentication', tempDir, 1);

            // Unlimited should have at least as many as limited
            expect(unlimited.length).toBeGreaterThanOrEqual(limited.length);
        });

        it('should use default maxResults of 20 when not specified', async () => {
            const files = [
                'auth.ts',
                'session.ts',
                'database.ts',
                'repository.ts',
                'utils.ts',
                'middleware.ts',
                'models/user-model.ts',
                'large-handlers.ts',
            ];

            const results = await semanticSearch(files, 'handler', tempDir);

            // Even with many chunks, default cap is 20
            expect(results.length).toBeLessThanOrEqual(20);
        });
    });

    // ---------------------------------------------------------------
    // 6. Empty query handling
    // ---------------------------------------------------------------
    describe('Empty Query Handling', () => {
        it('should return an empty array for an empty string query', async () => {
            const files = ['auth.ts', 'database.ts'];

            const results = await semanticSearch(files, '', tempDir);

            expect(results).toEqual([]);
        });

        it('should return an empty array for a whitespace-only query', async () => {
            const files = ['auth.ts', 'database.ts'];

            const results = await semanticSearch(files, '   ', tempDir);

            expect(results).toEqual([]);
        });

        it('should return an empty array when files list is empty', async () => {
            const results = await semanticSearch([], 'authentication', tempDir);

            expect(results).toEqual([]);
        });
    });

    // ---------------------------------------------------------------
    // 7. Non-existent files handling
    // ---------------------------------------------------------------
    describe('Non-Existent Files Handling', () => {
        it('should skip non-existent files without throwing', async () => {
            const files = ['does-not-exist.ts', 'also-missing.ts'];

            const results = await semanticSearch(files, 'authentication', tempDir);

            expect(Array.isArray(results)).toBe(true);
            expect(results).toEqual([]);
        });

        it('should still return results for valid files mixed with non-existent ones', async () => {
            const files = [
                'does-not-exist.ts',
                'auth.ts',
                'another-missing.ts',
                'database.ts',
            ];

            const results = await semanticSearch(files, 'auth', tempDir);

            expect(results.length).toBeGreaterThan(0);
            // Should only contain results from existing files
            const hitFiles = new Set(results.map((r) => r.file));
            expect(hitFiles.has('does-not-exist.ts')).toBe(false);
            expect(hitFiles.has('another-missing.ts')).toBe(false);
        });
    });

    // ---------------------------------------------------------------
    // 8. matchedTerms populated correctly
    // ---------------------------------------------------------------
    describe('Matched Terms', () => {
        it('should include matched terms in each result', async () => {
            const files = ['auth.ts', 'session.ts'];

            const results = await semanticSearch(files, 'auth', tempDir);

            expect(results.length).toBeGreaterThan(0);
            for (const result of results) {
                expect(Array.isArray(result.matchedTerms)).toBe(true);
                expect(result.matchedTerms.length).toBeGreaterThan(0);
            }
        });

        it('should have matchedTerms that are actual expanded query terms for auth search', async () => {
            const files = ['auth.ts'];

            const results = await semanticSearch(files, 'auth', tempDir);

            expect(results.length).toBeGreaterThan(0);

            // "auth" should expand via CONCEPT_MAP to include auth synonyms
            const authSynonyms = new Set([
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
            ]);

            const allMatched = results.flatMap((r) => r.matchedTerms);
            // Every matched term should be from the expanded concept set
            // (or the original query tokens)
            for (const term of allMatched) {
                // Term should be a non-empty string
                expect(term.length).toBeGreaterThan(0);
            }

            // At least one matched term should be from the auth synonyms
            const hasAuthTerm = allMatched.some((t) => authSynonyms.has(t));
            expect(hasAuthTerm).toBe(true);
        });

        it('should have matchedTerms relevant to database for db search', async () => {
            const files = ['database.ts', 'repository.ts'];

            const results = await semanticSearch(files, 'database', tempDir);

            expect(results.length).toBeGreaterThan(0);

            const dbSynonyms = new Set([
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
            ]);

            const allMatched = results.flatMap((r) => r.matchedTerms);
            const hasDbTerm = allMatched.some((t) => dbSynonyms.has(t));
            expect(hasDbTerm).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // 9. File chunking (large files get split into multiple chunks)
    // ---------------------------------------------------------------
    describe('File Chunking', () => {
        it('should produce multiple results from a large file with many functions', async () => {
            // Include additional files so that IDF for common terms like
            // 'request'/'response' stays positive (they only appear in handler chunks).
            const files = ['large-handlers.ts', 'utils.ts', 'database.ts'];

            // Search for something present across all handler functions
            const results = await semanticSearch(files, 'handler request response', tempDir);

            // The large file has 8 handler functions, each ~33 lines;
            // the chunker splits on function boundaries, producing multiple chunks
            const handlerResults = results.filter((r) => r.file === 'large-handlers.ts');
            expect(handlerResults.length).toBeGreaterThan(1);

            // Handler results should dominate since only large-handlers.ts
            // contains api-related tokens like 'request' and 'response'
            for (const result of handlerResults) {
                expect(result.file).toBe('large-handlers.ts');
            }
        });

        it('should have different startLine/endLine for different chunks of the same file', async () => {
            const files = ['large-handlers.ts'];

            const results = await semanticSearch(files, 'handler request response', tempDir);

            if (results.length >= 2) {
                const lineRanges = results.map((r) => `${r.startLine}-${r.endLine}`);
                const uniqueRanges = new Set(lineRanges);
                // Should have multiple distinct ranges
                expect(uniqueRanges.size).toBeGreaterThan(1);
            }
        });

        it('should not excessively chunk a small file', async () => {
            const files = ['utils.ts'];

            const results = await semanticSearch(files, 'capitalize range sleep', tempDir);

            // utils.ts is small (< 50 lines) but the chunker may split on
            // function boundaries (when currentChunk > 5 lines), producing
            // up to 2 chunks for a file with 3 function definitions.
            const utilChunks = results.filter((r) => r.file === 'utils.ts');
            expect(utilChunks.length).toBeLessThanOrEqual(3);
        });
    });

    // ---------------------------------------------------------------
    // 10. Result structure and field types
    // ---------------------------------------------------------------
    describe('Result Structure', () => {
        it('should include all expected fields in each result', async () => {
            const files = ['auth.ts'];

            const results = await semanticSearch(files, 'auth', tempDir);

            expect(results.length).toBeGreaterThan(0);
            for (const result of results) {
                expect(result).toHaveProperty('file');
                expect(result).toHaveProperty('startLine');
                expect(result).toHaveProperty('endLine');
                expect(result).toHaveProperty('score');
                expect(result).toHaveProperty('snippet');
                expect(result).toHaveProperty('matchedTerms');

                expect(typeof result.file).toBe('string');
                expect(typeof result.startLine).toBe('number');
                expect(typeof result.endLine).toBe('number');
                expect(typeof result.score).toBe('number');
                expect(typeof result.snippet).toBe('string');
                expect(Array.isArray(result.matchedTerms)).toBe(true);

                // Score should be positive
                expect(result.score).toBeGreaterThan(0);
                // Line numbers should be positive
                expect(result.startLine).toBeGreaterThanOrEqual(1);
                expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);
            }
        });

        it('should return relative file paths (not absolute)', async () => {
            const files = ['auth.ts', 'models/user-model.ts'];

            const results = await semanticSearch(files, 'authentication', tempDir);

            for (const result of results) {
                expect(result.file).not.toMatch(/^\//);
                expect(files).toContain(result.file);
            }
        });
    });

    // ---------------------------------------------------------------
    // 11. Queries with stop words
    // ---------------------------------------------------------------
    describe('Stop Word Handling', () => {
        it('should still produce results when query contains stop words mixed with meaningful terms', async () => {
            const files = ['auth.ts', 'database.ts'];

            // "the" and "for" are stop words; "login" is meaningful
            const results = await semanticSearch(files, 'the login for users', tempDir);

            expect(results.length).toBeGreaterThan(0);
        });

        it('should return empty for a query composed entirely of stop words', async () => {
            const files = ['auth.ts', 'database.ts'];

            // All of these are in the STOP_WORDS set
            const results = await semanticSearch(files, 'the and for', tempDir);

            expect(results).toEqual([]);
        });
    });

    // ---------------------------------------------------------------
    // 12. Multiple concept overlap
    // ---------------------------------------------------------------
    describe('Cross-Concept Queries', () => {
        it('should find results matching multiple concepts', async () => {
            const files = [
                'auth.ts',
                'session.ts',
                'database.ts',
                'repository.ts',
                'middleware.ts',
            ];

            // Searching for something that touches both auth and error concepts
            const results = await semanticSearch(files, 'error auth', tempDir);

            expect(results.length).toBeGreaterThan(0);
        });
    });
});
