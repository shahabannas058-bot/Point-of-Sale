import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@pos/db',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
