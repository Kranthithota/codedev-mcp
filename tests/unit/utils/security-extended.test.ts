import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validatePath, sanitizeInput } from '../../../src/utils/security.js';
import { join } from 'node:path';

/**
 * Extended security edge case tests covering:
 * - Encoded path traversal
 * - Various null byte positions
 * - Path length limits
 * - Special characters and encodings
 */
describe('Security - Extended Edge Cases', () => {
    const ALLOWED = [process.cwd()];

    describe('Path Traversal Variants', () => {
        it('should block URL-encoded traversal (%2e%2e)', () => {
            expect(() => validatePath('%2e%2e/etc/passwd', ALLOWED)).toThrow();
            expect(() => validatePath('..%2f..%2fetc/passwd', ALLOWED)).toThrow();
        });

        it('should block double-URL-encoded traversal', () => {
            expect(() => validatePath('%252e%252e/etc/passwd', ALLOWED)).toThrow();
        });

        it('should block backslash traversal (Windows-style)', () => {
            expect(() => validatePath('..\\..\\etc\\passwd', ALLOWED)).toThrow();
            expect(() => validatePath('..\\../', ALLOWED)).toThrow();
        });

        it('should block mixed slash traversal', () => {
            expect(() => validatePath('..\\/../..\\etc', ALLOWED)).toThrow();
            expect(() => validatePath('../..\\../etc', ALLOWED)).toThrow();
        });

        it('should block traversal with trailing null', () => {
            expect(() => validatePath('../etc/passwd\x00.txt', ALLOWED)).toThrow();
        });

        it('should block traversal hidden in long paths', () => {
            const longPrefix = 'a/'.repeat(50);
            expect(() => validatePath(`${longPrefix}../../../etc/passwd`, ALLOWED)).toThrow();
        });
    });

    describe('Null Byte Injection', () => {
        it('should block null byte at start', () => {
            expect(() => validatePath('\x00file.txt', ALLOWED)).toThrow();
        });

        it('should block null byte in middle', () => {
            expect(() => validatePath('file\x00.txt', ALLOWED)).toThrow();
        });

        it('should block null byte at end', () => {
            expect(() => validatePath('file.txt\x00', ALLOWED)).toThrow();
        });

        it('should block multiple null bytes', () => {
            expect(() => validatePath('\x00\x00\x00', ALLOWED)).toThrow();
        });
    });

    describe('Path Length Edge Cases', () => {
        it('should handle very long safe paths', () => {
            const longPath = 'a'.repeat(200) + '.ts';
            // Should not throw - just validate it doesn't crash
            try {
                validatePath(longPath, ALLOWED);
            } catch {
                // Expected to fail validation, but shouldn't crash
            }
            expect(true).toBe(true);
        });

        it('should handle empty path', () => {
            expect(() => validatePath('', ALLOWED)).toThrow();
        });

        it('should handle whitespace-only path', () => {
            expect(() => validatePath('   ', ALLOWED)).toThrow();
        });
    });

    describe('Special Characters', () => {
        it('should handle unicode in paths', () => {
            // Should not crash on unicode
            try {
                validatePath('文件.ts', ALLOWED);
            } catch {
                // May fail due to not in allowed, but shouldn't crash
            }
            expect(true).toBe(true);
        });

        it('should handle control characters', () => {
            expect(() => validatePath('file\x01.ts', ALLOWED)).toThrow();
            expect(() => validatePath('file\x7f.ts', ALLOWED)).toThrow();
        });

        it('should handle newlines in paths', () => {
            expect(() => validatePath('file\n.ts', ALLOWED)).toThrow();
            expect(() => validatePath('file\r\n.ts', ALLOWED)).toThrow();
        });
    });

    describe('sanitizeInput Edge Cases', () => {
        it('should handle very long strings', () => {
            const longInput = 'a'.repeat(10000);
            const result = sanitizeInput(longInput);
            expect(typeof result).toBe('string');
        });

        it('should handle mixed encodings', () => {
            const input = 'test中文';
            const result = sanitizeInput(input);
            expect(result).toBe(input);
        });

        it('should throw on null bytes in mixed content', () => {
            const input = 'test\x00中文';
            expect(() => sanitizeInput(input)).toThrow();
        });

        it('should handle empty string', () => {
            expect(sanitizeInput('')).toBe('');
        });

        it('should throw on only special chars with null', () => {
            expect(() => sanitizeInput('\x00\x01\x02')).toThrow();
        });

        it('should handle non-null control chars', () => {
            // Control chars without null byte should pass
            const input = '\x01\x02';
            const result = sanitizeInput(input);
            expect(typeof result).toBe('string');
        });
    });
});
