import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import security from 'eslint-plugin-security';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintPluginPrettierRecommended,
    security.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // ── Code Quality & Security ─────────────────────────────────────────
            '@typescript-eslint/no-explicit-any': 'warn', // Allow 'any' with warning
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], // Allow unused vars prefixed with _
            'no-console': 'warn', // Warn but don't error on console usage
            'security/detect-object-injection': 'off', // Too many false positives in analyzers
            'security/detect-non-literal-fs-filename': 'warn', // We use safePath, so warn only
        },
        ignores: ['dist/', 'node_modules/', 'coverage/', 'vitest.config.ts', 'eslint.config.mjs'],
    }
);
