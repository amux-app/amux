import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'aumx/core': resolve(__dirname, '../src/core.ts'),
      'aumx/pane-name': resolve(__dirname, '../src/utils/paneName.ts'),
      'aumx/pane-terminal-profile': resolve(__dirname, '../src/utils/paneTerminalProfile.ts'),
    },
  },
  test: {
    root: __dirname,
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    environment: 'node',
    maxWorkers: '50%',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/main/preload.ts',
        'src/shared/ipc-channels.ts',
        '__tests__/**',
        '**/node_modules/**',
        '**/dist/**',
      ],
      all: true,
      thresholds: {
        statements: 68,
        lines: 68,
        functions: 72,
        branches: 76,
      },
    },
  },
});
