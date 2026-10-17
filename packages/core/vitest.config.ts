import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@pos/core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
