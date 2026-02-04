import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import jsdoc from 'eslint-plugin-jsdoc';
import security from 'eslint-plugin-security';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintPluginPrettierRecommended,
    security.configs.recommended,
    {
        plugins: {
            jsdoc,
        },
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // ── Strict Commenting Standards ─────────────────────────────────────
            'no-inline-comments': 'error', // Use JSDoc instead
            'line-comment-position': ['error', { position: 'above' }], // If simple comments, must be above line
            'jsdoc/require-jsdoc': [
                'error',
                {
                    publicOnly: true,
                    require: {
                        FunctionDeclaration: true,
                        MethodDefinition: true,
                        ClassDeclaration: true,
                        ArrowFunctionExpression: true,
                        FunctionExpression: true,
                    },
                },
            ],
            'jsdoc/require-description': 'error',
            'jsdoc/require-param': 'error',
            'jsdoc/require-returns': 'error',

            // ── Code Quality & Security ─────────────────────────────────────────
            '@typescript-eslint/no-explicit-any': 'error', // No 'any' type
            '@typescript-eslint/no-unused-vars': 'error',
            'no-console': 'error', // Use structured logger instead
            'security/detect-object-injection': 'off', // Too many false positives in analyzers
            'security/detect-non-literal-fs-filename': 'warn', // We use safePath, so warn only
        },
        ignores: ['dist/', 'node_modules/', 'coverage/', 'vitest.config.ts', 'eslint.config.mjs'],
    }
);
