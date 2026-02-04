import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'dist/',
                '**/*.d.ts',
                'tests/',
                'vitest.config.ts',
                'src/schemas/output-schemas.ts' // Schemas are declarative
            ],

        },
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
        testTimeout: 20000, // 20s for integration tests
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});
