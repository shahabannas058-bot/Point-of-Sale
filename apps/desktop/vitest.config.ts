import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@pos/desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
