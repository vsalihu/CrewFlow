import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    globalSetup: ['./packages/test-fixtures/src/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file gets its own cloned database, so files can run in parallel.
    fileParallelism: true,
  },
});
