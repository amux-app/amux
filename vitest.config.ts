import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      '__tests__/**/*.test.ts',
      '__tests__/**/*.test.tsx',
      'scripts/**/*.test.mjs',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.amux/**',
      '**/.aumx/**',
      '**/coverage/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/utils/generated-agents-doc.ts',
        'node_modules',
        'dist',
      ],
      all: true,
      thresholds: {
        branches: 75,
        functions: 65,
        lines: 60,
        statements: 60,
      },
    },
  },
});
