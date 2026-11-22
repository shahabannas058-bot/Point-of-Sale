import { defineConfig } from 'vitest/config';

// Run every test in UTC: the shop's day is Pakistan time whatever zone the PC is in, so a helper that slips back to
// the PC's local time fails here instead of passing by luck on a PC set to PKT (QA S9).
process.env.TZ = 'UTC';

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
