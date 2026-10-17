import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@pos/shared',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
