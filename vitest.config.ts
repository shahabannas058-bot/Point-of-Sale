import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/desktop'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        'packages/core/src/**': { lines: 95, functions: 95, branches: 90, statements: 95 },
      },
    },
  },
});
