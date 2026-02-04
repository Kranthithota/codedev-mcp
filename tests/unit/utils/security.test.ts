
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { validatePath, sanitizeInput } from '../../../src/utils/security.js';

describe('Security Utils', () => {
    const MOCK_CWD = '/app/workspace';
    const MOCK_ROOTS = ['/app/workspace', '/app/secondary'];

    describe('validatePath', () => {
        it('should allow paths within CWD', () => {
            expect(validatePath('src/index.ts', MOCK_ROOTS, MOCK_CWD)).toBe(path.resolve(MOCK_CWD, 'src/index.ts'));
        });

        it('should allow paths within secondary root', () => {
            // Assuming absolute path provided or relative to CWD that resolves there? 
            // validatePath resolves relative to CWD. If we want to test secondary root access via relative path, it might be tricky if they aren't nested.
            // Usually user provides relative to CWD or absolute.
            const absPath = '/app/secondary/config.json';
            expect(validatePath(absPath, MOCK_ROOTS, MOCK_CWD)).toBe(absPath);
        });

        it('should normalize paths', () => {
            expect(validatePath('src/../package.json', MOCK_ROOTS, MOCK_CWD)).toBe(path.resolve(MOCK_CWD, 'package.json'));
        });

        it('should block directory traversal relative checking', () => {
            // attempt to go up out of root
            expect(() => validatePath('../../etc/passwd', MOCK_ROOTS, MOCK_CWD)).toThrow(/Security Blocked/);
        });

        it('should block absolute paths outside roots', () => {
            expect(() => validatePath('/etc/passwd', MOCK_ROOTS, MOCK_CWD)).toThrow(/Security Blocked/);
        });

        it('should block partial path matches', () => {
            // /app/workspace-private should not be allowed even if it starts with /app/workspace
            const maliciousPath = '/app/workspace-private/secrets.txt';
            // validatePath implementation uses strict containment check? 
            // The implementation usually uses startsWith but needs to be careful about directory boundaries.
            // Let's rely on the implementation I wrote: 
            // isAllowed = allowedRoots.some(root => !path.relative(root, normalized).startsWith('..') && !path.isAbsolute(path.relative(root, normalized)));
            // Node's path.relative handles the directory boundary correctness usually.

            // If implementation uses strict containment logic properly, this should throw.
            // Let's verify specifically if existing logic handles it.
            // Note: In limited environments, we might not be able to easily mock fs structure, but path logic is pure.
            expect(() => validatePath(maliciousPath, MOCK_ROOTS, MOCK_CWD)).toThrow(/Security Blocked/);
        });

        it('should block null bytes', () => {
            expect(() => validatePath('src/test.ts\0.js', MOCK_ROOTS, MOCK_CWD)).toThrow(/Security Blocked/);
        });
    });

    describe('sanitizeInput', () => {
        it('should pass safe input', () => {
            expect(sanitizeInput('hello world')).toBe('hello world');
        });

        it('should throw on null bytes', () => {
            expect(() => sanitizeInput('hello\0world')).toThrow('Input contains null bytes');
        });
    });
});
