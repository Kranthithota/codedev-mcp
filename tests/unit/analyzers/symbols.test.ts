import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    extractSymbols,
    extractImports,
    analyzeFile,
    formatFileOutline,
} from '../../../src/analyzers/symbols.js';
import type { FileAnalysis } from '../../../src/analyzers/symbols.js';

describe('Symbols Module', () => {
    let tempDir: string;

    beforeAll(async () => {
        tempDir = join(tmpdir(), `symbols-test-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // ── Helper ──────────────────────────────────────────────────────────
    async function writeTempFile(name: string, content: string): Promise<string> {
        const filePath = join(tempDir, name);
        await writeFile(filePath, content);
        return filePath;
    }

    // ── extractSymbols ──────────────────────────────────────────────────

    describe('extractSymbols', () => {
        describe('TypeScript symbol kinds', () => {
            it('should extract function declarations', async () => {
                const filePath = await writeTempFile('funcs.ts', [
                    'export function greet(name: string): string {',
                    '    return `Hello, ${name}`;',
                    '}',
                    '',
                    'async function fetchData(url: string) {',
                    '    return fetch(url);',
                    '}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const fns = symbols.filter((s) => s.kind === 'function');

                expect(fns.some((f) => f.name === 'greet')).toBe(true);
                expect(fns.some((f) => f.name === 'fetchData')).toBe(true);
            });

            it('should extract arrow function constants', async () => {
                const filePath = await writeTempFile('arrows.ts', [
                    'export const add = (a: number, b: number) => a + b;',
                    'const multiply = async (a: number, b: number) => a * b;',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const fns = symbols.filter((s) => s.kind === 'function');

                expect(fns.some((f) => f.name === 'add')).toBe(true);
                expect(fns.some((f) => f.name === 'multiply')).toBe(true);
            });

            it('should extract class declarations', async () => {
                const filePath = await writeTempFile('classes.ts', [
                    'export class UserService {',
                    '    constructor() {}',
                    '}',
                    '',
                    'abstract class BaseRepository {',
                    '    abstract findAll(): Promise<any[]>;',
                    '}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const classes = symbols.filter((s) => s.kind === 'class');

                expect(classes.some((c) => c.name === 'UserService')).toBe(true);
                expect(classes.some((c) => c.name === 'BaseRepository')).toBe(true);
            });

            it('should extract interface declarations', async () => {
                const filePath = await writeTempFile('interfaces.ts', [
                    'export interface UserProfile {',
                    '    id: string;',
                    '    name: string;',
                    '}',
                    '',
                    'interface DatabaseConfig {',
                    '    host: string;',
                    '    port: number;',
                    '}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const interfaces = symbols.filter((s) => s.kind === 'interface');

                expect(interfaces.some((i) => i.name === 'UserProfile')).toBe(true);
                expect(interfaces.some((i) => i.name === 'DatabaseConfig')).toBe(true);
            });

            it('should extract type alias declarations', async () => {
                const filePath = await writeTempFile('types.ts', [
                    'export type UserId = string;',
                    'type ResponseStatus = "ok" | "error";',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const types = symbols.filter((s) => s.kind === 'type');

                expect(types.some((t) => t.name === 'UserId')).toBe(true);
                expect(types.some((t) => t.name === 'ResponseStatus')).toBe(true);
            });

            it('should extract uppercase constant declarations', async () => {
                const filePath = await writeTempFile('constants.ts', [
                    'export const MAX_RETRIES = 3;',
                    'const DEFAULT_TIMEOUT: number = 5000;',
                    'const API_BASE_URL = "https://example.com";',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const constants = symbols.filter((s) => s.kind === 'constant');

                expect(constants.some((c) => c.name === 'MAX_RETRIES')).toBe(true);
                expect(constants.some((c) => c.name === 'DEFAULT_TIMEOUT')).toBe(true);
                expect(constants.some((c) => c.name === 'API_BASE_URL')).toBe(true);
            });

            it('should extract export declarations', async () => {
                const filePath = await writeTempFile('exports.ts', [
                    'export function serve() {}',
                    'export class Router {}',
                    'export const handler = () => {};',
                    'export interface Plugin {}',
                    'export type Middleware = () => void;',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const exports = symbols.filter((s) => s.kind === 'export');

                expect(exports.some((e) => e.name === 'serve')).toBe(true);
                expect(exports.some((e) => e.name === 'Router')).toBe(true);
                expect(exports.some((e) => e.name === 'handler')).toBe(true);
                expect(exports.some((e) => e.name === 'Plugin')).toBe(true);
                expect(exports.some((e) => e.name === 'Middleware')).toBe(true);
            });
        });

        describe('all symbol kinds in a single file', () => {
            it('should extract every kind from a mixed file', async () => {
                const filePath = await writeTempFile('mixed.ts', [
                    'export interface Config {',
                    '    debug: boolean;',
                    '}',
                    '',
                    'export type Mode = "dev" | "prod";',
                    '',
                    'export const MAX_SIZE = 100;',
                    '',
                    'export class AppServer {',
                    '    start() {}',
                    '}',
                    '',
                    'export async function bootstrap() {',
                    '    return new AppServer();',
                    '}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const kinds = new Set(symbols.map((s) => s.kind));

                expect(kinds.has('function')).toBe(true);
                expect(kinds.has('class')).toBe(true);
                expect(kinds.has('interface')).toBe(true);
                expect(kinds.has('type')).toBe(true);
                expect(kinds.has('constant')).toBe(true);
                expect(kinds.has('export')).toBe(true);
            });
        });

        describe('symbol metadata', () => {
            it('should include correct line numbers', async () => {
                const filePath = await writeTempFile('lines.ts', [
                    'const placeholder = 1;',        // line 1
                    '',                              // line 2
                    'export function alpha() {}',    // line 3
                    '',                              // line 4
                    'export function beta() {}',     // line 5
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const alpha = symbols.find((s) => s.name === 'alpha');
                const beta = symbols.find((s) => s.name === 'beta');

                expect(alpha).toBeDefined();
                expect(alpha!.line).toBe(3);
                expect(beta).toBeDefined();
                expect(beta!.line).toBe(5);
            });

            it('should set the language field to typescript for .ts files', async () => {
                const filePath = await writeTempFile('langcheck.ts', 'export function check() {}');
                const symbols = await extractSymbols(filePath);

                expect(symbols.length).toBeGreaterThan(0);
                for (const sym of symbols) {
                    expect(sym.language).toBe('typescript');
                }
            });

            it('should set signature from the matched line', async () => {
                const filePath = await writeTempFile('sig.ts', [
                    'export async function processItems(items: string[]): Promise<void> {',
                    '    // body',
                    '}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const fn = symbols.find((s) => s.name === 'processItems');

                expect(fn).toBeDefined();
                expect(fn!.signature).toContain('processItems');
                expect(fn!.signature).toContain('items');
            });
        });

        describe('sorting by line number', () => {
            it('should return symbols sorted ascending by line', async () => {
                const filePath = await writeTempFile('sorted.ts', [
                    'interface Zeta {}',
                    'type Alpha = string;',
                    'class Middle {}',
                    'function omega() {}',
                    'const CONSTANT_VAL = 1;',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                for (let i = 1; i < symbols.length; i++) {
                    expect(symbols[i].line).toBeGreaterThanOrEqual(symbols[i - 1].line);
                }
            });
        });

        describe('deduplication', () => {
            it('should not produce duplicate symbols with the same name and kind', async () => {
                // The function patterns might match the same function name via
                // multiple regex patterns. Deduplication should collapse them.
                const filePath = await writeTempFile('dedup.ts', [
                    'export function render() {',
                    '    return null;',
                    '}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const renderFns = symbols.filter(
                    (s) => s.name === 'render' && s.kind === 'function',
                );

                expect(renderFns.length).toBe(1);
            });

            it('should allow same name with different kinds', async () => {
                const filePath = await writeTempFile('samename.ts', [
                    'export type Logger = { log: (msg: string) => void };',
                    'export function Logger() {}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                const loggerType = symbols.find(
                    (s) => s.name === 'Logger' && s.kind === 'type',
                );
                const loggerFn = symbols.find(
                    (s) => s.name === 'Logger' && s.kind === 'function',
                );

                expect(loggerType).toBeDefined();
                expect(loggerFn).toBeDefined();
            });
        });

        describe('short names are skipped', () => {
            it('should filter out single-character symbol names', async () => {
                const filePath = await writeTempFile('shortnames.ts', [
                    'function x() {}',
                    'function ab() {}',
                ].join('\n'));

                const symbols = await extractSymbols(filePath);
                // 'x' has length 1 so should be filtered out
                expect(symbols.some((s) => s.name === 'x')).toBe(false);
                // 'ab' has length 2 so should be included
                expect(symbols.some((s) => s.name === 'ab')).toBe(true);
            });
        });
    });

    // ── extractImports ──────────────────────────────────────────────────

    describe('extractImports', () => {
        it('should extract ES module imports', async () => {
            const filePath = await writeTempFile('imports-es.ts', [
                "import { readFile } from 'node:fs/promises';",
                "import path from 'node:path';",
                "import type { Config } from './config';",
            ].join('\n'));

            const imports = await extractImports(filePath);

            expect(imports).toContain('node:fs/promises');
            expect(imports).toContain('node:path');
            expect(imports).toContain('./config');
        });

        it('should extract dynamic imports', async () => {
            const filePath = await writeTempFile('imports-dynamic.ts', [
                "const mod = await import('./lazy-module');",
            ].join('\n'));

            const imports = await extractImports(filePath);
            expect(imports).toContain('./lazy-module');
        });

        it('should extract require calls', async () => {
            const filePath = await writeTempFile('imports-require.ts', [
                "const fs = require('fs');",
                "const lodash = require('lodash');",
            ].join('\n'));

            const imports = await extractImports(filePath);
            expect(imports).toContain('fs');
            expect(imports).toContain('lodash');
        });

        it('should deduplicate import paths', async () => {
            const filePath = await writeTempFile('imports-dedup.ts', [
                "import { a } from './shared';",
                "import { b } from './shared';",
            ].join('\n'));

            const imports = await extractImports(filePath);
            const sharedCount = imports.filter((i) => i === './shared').length;
            expect(sharedCount).toBe(1);
        });

        it('should return empty array when there are no imports', async () => {
            const filePath = await writeTempFile('no-imports.ts', [
                'const x = 1;',
                'export default x;',
            ].join('\n'));

            const imports = await extractImports(filePath);
            expect(imports).toEqual([]);
        });

        it('should extract Python imports', async () => {
            const filePath = await writeTempFile('imports.py', [
                'import os',
                'from pathlib import Path',
                'import sys',
                'from collections import defaultdict',
            ].join('\n'));

            const imports = await extractImports(filePath);
            expect(imports).toContain('os');
            expect(imports).toContain('pathlib');
            expect(imports).toContain('sys');
            expect(imports).toContain('collections');
        });
    });

    // ── analyzeFile ─────────────────────────────────────────────────────

    describe('analyzeFile', () => {
        describe('line counts', () => {
            it('should count code, comment, and blank lines for TypeScript', async () => {
                const filePath = await writeTempFile('linecounts.ts', [
                    '// This is a comment',                       // comment
                    'export function hello() {',                  // code
                    '    return "world";',                        // code
                    '}',                                         // code
                    '',                                          // blank
                    '/* block comment */',                        // comment
                    '',                                          // blank
                    'const value = 42;',                          // code
                ].join('\n'));

                const analysis = await analyzeFile(filePath);

                expect(analysis.codeLines).toBe(4);
                expect(analysis.commentLines).toBe(2);
                expect(analysis.blankLines).toBe(2);
                expect(analysis.lines).toBe(8);
            });

            it('should handle multi-line comments spanning several lines', async () => {
                const filePath = await writeTempFile('multicomment.ts', [
                    '/*',                         // comment
                    ' * Multi-line',              // comment
                    ' * comment block',           // comment
                    ' */',                        // comment
                    'const x = 1;',               // code
                ].join('\n'));

                const analysis = await analyzeFile(filePath);

                expect(analysis.commentLines).toBe(4);
                expect(analysis.codeLines).toBe(1);
            });

            it('should return correct total lines', async () => {
                const content = 'line1\nline2\nline3\nline4\nline5';
                const filePath = await writeTempFile('fivelines.ts', content);

                const analysis = await analyzeFile(filePath);
                expect(analysis.lines).toBe(5);
            });
        });

        describe('complexity estimation', () => {
            it('should have base complexity of 1 for trivial files', async () => {
                const filePath = await writeTempFile('trivial.ts', [
                    'const value = 42;',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                expect(analysis.complexity).toBe(1);
            });

            it('should increase complexity for if statements', async () => {
                const filePath = await writeTempFile('ifs.ts', [
                    'function check(x: number) {',
                    '    if (x > 0) {',
                    '        return "positive";',
                    '    }',
                    '    if (x < 0) {',
                    '        return "negative";',
                    '    }',
                    '    return "zero";',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                // Base 1 + 2 ifs = at least 3
                expect(analysis.complexity).toBeGreaterThanOrEqual(3);
            });

            it('should increase complexity for for/while loops', async () => {
                const filePath = await writeTempFile('loops.ts', [
                    'function process(items: number[]) {',
                    '    for (const item of items) {',
                    '        while (item > 0) {',
                    '            // process',
                    '        }',
                    '    }',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                // Base 1 + 1 for + 1 while = at least 3
                expect(analysis.complexity).toBeGreaterThanOrEqual(3);
            });

            it('should increase complexity for switch/case', async () => {
                const filePath = await writeTempFile('switchcase.ts', [
                    'function route(action: string) {',
                    '    switch (action) {',
                    '        case "start":',
                    '            return 1;',
                    '        case "stop":',
                    '            return 2;',
                    '        case "pause":',
                    '            return 3;',
                    '    }',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                // Base 1 + 1 switch + 3 cases = at least 5
                expect(analysis.complexity).toBeGreaterThanOrEqual(5);
            });

            it('should increase complexity for logical operators', async () => {
                const filePath = await writeTempFile('logical.ts', [
                    'function validate(a: boolean, b: boolean, c: boolean) {',
                    '    return (a && b) || c;',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                // Base 1 + 1 && + 1 || = at least 3
                expect(analysis.complexity).toBeGreaterThanOrEqual(3);
            });

            it('should count catch blocks in complexity', async () => {
                const filePath = await writeTempFile('trycatch.ts', [
                    'async function safeFetch(url: string) {',
                    '    try {',
                    '        return await fetch(url);',
                    '    } catch (err) {',
                    '        console.error(err);',
                    '    }',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                // Base 1 + 1 catch = at least 2
                expect(analysis.complexity).toBeGreaterThanOrEqual(2);
            });

            it('should count nullish coalescing and optional chaining', async () => {
                const filePath = await writeTempFile('nullish.ts', [
                    'function getValue(obj: any) {',
                    '    return obj?.nested?.value ?? "default";',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                // Base 1 + 2 ?. + 1 ?? = at least 4
                expect(analysis.complexity).toBeGreaterThanOrEqual(4);
            });

            it('should accumulate complexity from multiple constructs', async () => {
                const filePath = await writeTempFile('complex.ts', [
                    'function complex(items: any[]) {',
                    '    if (items.length === 0) return [];',
                    '    for (const item of items) {',
                    '        if (item.active && item.valid) {',
                    '            while (item.retry > 0) {',
                    '                try {',
                    '                    process(item);',
                    '                } catch (e) {',
                    '                    // retry',
                    '                }',
                    '            }',
                    '        }',
                    '    }',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                // Base(1) + 2 if + 1 for + 1 while + 1 && + 1 catch = 7+
                expect(analysis.complexity).toBeGreaterThanOrEqual(7);
            });
        });

        describe('file metadata', () => {
            it('should include the file path', async () => {
                const filePath = await writeTempFile('meta.ts', 'const x = 1;');
                const analysis = await analyzeFile(filePath);
                expect(analysis.path).toBe(filePath);
            });

            it('should detect the language', async () => {
                const filePath = await writeTempFile('lang.ts', 'const x = 1;');
                const analysis = await analyzeFile(filePath);
                expect(analysis.language).toBe('typescript');
            });

            it('should report file size greater than zero', async () => {
                const filePath = await writeTempFile('size.ts', 'const x = 1;');
                const analysis = await analyzeFile(filePath);
                expect(analysis.size).toBeGreaterThan(0);
            });

            it('should include symbols and imports', async () => {
                const filePath = await writeTempFile('full.ts', [
                    "import { join } from 'node:path';",
                    '',
                    'export function combine(a: string, b: string) {',
                    '    return join(a, b);',
                    '}',
                ].join('\n'));

                const analysis = await analyzeFile(filePath);
                expect(analysis.symbols.length).toBeGreaterThan(0);
                expect(analysis.imports).toContain('node:path');
            });
        });
    });

    // ── formatFileOutline ───────────────────────────────────────────────

    describe('formatFileOutline', () => {
        it('should include the file path in the output', async () => {
            const filePath = await writeTempFile('outline.ts', 'export function hello() {}');
            const analysis = await analyzeFile(filePath);
            const outline = formatFileOutline(analysis);

            expect(outline).toContain(filePath);
        });

        it('should include language, lines, and complexity info', async () => {
            const filePath = await writeTempFile('outline-info.ts', [
                '// comment',
                'export function run() {',
                '    if (true) {}',
                '}',
            ].join('\n'));

            const analysis = await analyzeFile(filePath);
            const outline = formatFileOutline(analysis);

            expect(outline).toContain('Language: typescript');
            expect(outline).toContain('Lines:');
            expect(outline).toContain('code:');
            expect(outline).toContain('comments:');
            expect(outline).toContain('Complexity:');
        });

        it('should list imports when present', async () => {
            const filePath = await writeTempFile('outline-imports.ts', [
                "import { readFile } from 'node:fs/promises';",
                "import path from 'node:path';",
                'export const val = 1;',
            ].join('\n'));

            const analysis = await analyzeFile(filePath);
            const outline = formatFileOutline(analysis);

            expect(outline).toContain('Imports:');
            expect(outline).toContain('node:fs/promises');
            expect(outline).toContain('node:path');
        });

        it('should not include Imports line when there are no imports', async () => {
            const filePath = await writeTempFile('outline-no-imports.ts', 'const x = 1;');
            const analysis = await analyzeFile(filePath);
            const outline = formatFileOutline(analysis);

            expect(outline).not.toContain('Imports:');
        });

        it('should group symbols by kind with name:line format', async () => {
            const filePath = await writeTempFile('outline-grouped.ts', [
                'export interface AppConfig {',
                '    port: number;',
                '}',
                '',
                'export class Server {',
                '    listen() {}',
                '}',
                '',
                'export function start() {}',
            ].join('\n'));

            const analysis = await analyzeFile(filePath);
            const outline = formatFileOutline(analysis);

            // Each kind group should show name:lineNumber
            expect(outline).toContain('AppConfig:');
            expect(outline).toContain('Server:');
            expect(outline).toContain('start:');
        });

        it('should produce a multi-line string', async () => {
            const filePath = await writeTempFile('outline-multiline.ts', [
                'export function foo() {}',
                'export class Bar {}',
            ].join('\n'));

            const analysis = await analyzeFile(filePath);
            const outline = formatFileOutline(analysis);
            const lines = outline.split('\n');

            expect(lines.length).toBeGreaterThanOrEqual(2);
        });

        it('should use correct kind icons', async () => {
            const analysis: FileAnalysis = {
                path: '/test/icons.ts',
                language: 'typescript',
                size: 100,
                lines: 10,
                codeLines: 8,
                commentLines: 1,
                blankLines: 1,
                symbols: [
                    { name: 'MyClass', kind: 'class', line: 1, language: 'typescript' },
                    { name: 'MyInterface', kind: 'interface', line: 2, language: 'typescript' },
                    { name: 'MyType', kind: 'type', line: 3, language: 'typescript' },
                    { name: 'myFunc', kind: 'function', line: 4, language: 'typescript' },
                    { name: 'MY_CONST', kind: 'constant', line: 5, language: 'typescript' },
                    { name: 'myExport', kind: 'export', line: 6, language: 'typescript' },
                ],
                imports: [],
                complexity: 1,
            };

            const outline = formatFileOutline(analysis);

            // Function icon is the special f character
            expect(outline).toContain('\u0192');
            // The outline should contain kind labels
            expect(outline).toContain('classs:');
            expect(outline).toContain('interfaces:');
            expect(outline).toContain('types:');
            expect(outline).toContain('functions:');
            expect(outline).toContain('constants:');
            expect(outline).toContain('exports:');
        });
    });

    // ── Python files ────────────────────────────────────────────────────

    describe('Python file support', () => {
        it('should detect Python functions with def', async () => {
            const filePath = await writeTempFile('module.py', [
                'def greet(name):',
                '    return f"Hello {name}"',
                '',
                'async def fetch_data(url):',
                '    pass',
            ].join('\n'));

            const symbols = await extractSymbols(filePath);
            const fns = symbols.filter((s) => s.kind === 'function');

            expect(fns.some((f) => f.name === 'greet')).toBe(true);
            expect(fns.some((f) => f.name === 'fetch_data')).toBe(true);
        });

        it('should detect Python classes', async () => {
            const filePath = await writeTempFile('classes.py', [
                'class Animal:',
                '    def speak(self):',
                '        pass',
                '',
                'class Dog(Animal):',
                '    def speak(self):',
                '        return "Woof"',
            ].join('\n'));

            const symbols = await extractSymbols(filePath);
            const classes = symbols.filter((s) => s.kind === 'class');

            expect(classes.some((c) => c.name === 'Animal')).toBe(true);
            expect(classes.some((c) => c.name === 'Dog')).toBe(true);
        });

        it('should detect Python uppercase constants', async () => {
            const filePath = await writeTempFile('consts.py', [
                'MAX_RETRIES = 5',
                'API_KEY = "secret"',
                'regular_var = "not a constant"',
            ].join('\n'));

            const symbols = await extractSymbols(filePath);
            const constants = symbols.filter((s) => s.kind === 'constant');

            expect(constants.some((c) => c.name === 'MAX_RETRIES')).toBe(true);
            expect(constants.some((c) => c.name === 'API_KEY')).toBe(true);
        });

        it('should set language to python for .py files', async () => {
            const filePath = await writeTempFile('pylang.py', [
                'def main():',
                '    pass',
            ].join('\n'));

            const symbols = await extractSymbols(filePath);
            expect(symbols.length).toBeGreaterThan(0);
            expect(symbols[0].language).toBe('python');
        });

        it('should count Python comment lines with # syntax', async () => {
            const filePath = await writeTempFile('pycomments.py', [
                '# This is a comment',         // comment
                'def main():',                 // code
                '    # inline comment',        // comment (starts with #)
                '    pass',                    // code
                '',                            // blank
            ].join('\n'));

            const analysis = await analyzeFile(filePath);
            expect(analysis.commentLines).toBe(2);
            expect(analysis.codeLines).toBe(2);
            expect(analysis.blankLines).toBe(1);
        });

        it('should extract Python imports', async () => {
            const filePath = await writeTempFile('pyimports.py', [
                'import os',
                'import sys',
                'from pathlib import Path',
                'from typing import List, Optional',
            ].join('\n'));

            const imports = await extractImports(filePath);
            expect(imports).toContain('os');
            expect(imports).toContain('sys');
            expect(imports).toContain('pathlib');
            expect(imports).toContain('typing');
        });
    });

    // ── Empty files ─────────────────────────────────────────────────────

    describe('empty files', () => {
        it('should return empty symbols for an empty file', async () => {
            const filePath = await writeTempFile('empty.ts', '');
            const symbols = await extractSymbols(filePath);
            expect(symbols).toEqual([]);
        });

        it('should return empty imports for an empty file', async () => {
            const filePath = await writeTempFile('empty-imports.ts', '');
            const imports = await extractImports(filePath);
            expect(imports).toEqual([]);
        });

        it('should return valid analysis for an empty file', async () => {
            const filePath = await writeTempFile('empty-analysis.ts', '');
            const analysis = await analyzeFile(filePath);

            expect(analysis.lines).toBe(1); // split('\n') on '' gives ['']
            expect(analysis.symbols).toEqual([]);
            expect(analysis.imports).toEqual([]);
            expect(analysis.complexity).toBe(1); // base complexity
            expect(analysis.codeLines).toBe(0);
            expect(analysis.commentLines).toBe(0);
        });

        it('should format outline for an empty file without errors', async () => {
            const filePath = await writeTempFile('empty-outline.ts', '');
            const analysis = await analyzeFile(filePath);
            const outline = formatFileOutline(analysis);

            expect(typeof outline).toBe('string');
            expect(outline.length).toBeGreaterThan(0);
        });
    });

    // ── Integration: symbols + analyzeFile consistency ──────────────────

    describe('integration consistency', () => {
        it('should produce the same symbols from extractSymbols and analyzeFile', async () => {
            const filePath = await writeTempFile('consistency.ts', [
                'export interface Repo {',
                '    name: string;',
                '}',
                '',
                'export function clone(repo: Repo) {',
                '    return { ...repo };',
                '}',
                '',
                'export const DEFAULT_BRANCH = "main";',
            ].join('\n'));

            const directSymbols = await extractSymbols(filePath);
            const analysis = await analyzeFile(filePath);

            expect(analysis.symbols).toEqual(directSymbols);
        });

        it('should produce the same imports from extractImports and analyzeFile', async () => {
            const filePath = await writeTempFile('consistency-imports.ts', [
                "import { join } from 'node:path';",
                "import { readFile } from 'node:fs/promises';",
                '',
                'export const combined = join("a", "b");',
            ].join('\n'));

            const directImports = await extractImports(filePath);
            const analysis = await analyzeFile(filePath);

            expect(analysis.imports).toEqual(directImports);
        });

        it('should satisfy lines = codeLines + commentLines + blankLines', async () => {
            const filePath = await writeTempFile('linesum.ts', [
                '// header comment',
                '',
                'export function add(a: number, b: number) {',
                '    // add two numbers',
                '    return a + b;',
                '}',
                '',
                '/*',
                ' * multi-line',
                ' */',
                '',
                'const result = add(1, 2);',
            ].join('\n'));

            const analysis = await analyzeFile(filePath);
            expect(analysis.codeLines + analysis.commentLines + analysis.blankLines)
                .toBe(analysis.lines);
        });
    });
});
