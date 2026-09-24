import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each suite spins its own in-memory Postgres; running them in one process
    // keeps memory sane on the low-end hardware CE targets.
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': new URL('./apps/web/src', import.meta.url).pathname,
      '@josi-ce/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@josi-ce/auth': new URL('./packages/auth/src/index.ts', import.meta.url).pathname,
      '@josi-ce/llm': new URL('./packages/llm/src/index.ts', import.meta.url).pathname,
      '@josi-ce/agent': new URL('./packages/agent/src/index.ts', import.meta.url).pathname,
      '@josi-ce/connectors': new URL('./packages/connectors/src/index.ts', import.meta.url).pathname,
      '@josi-ce/mail': new URL('./packages/mail/src/index.ts', import.meta.url).pathname,
      '@josi-ce/channels': new URL('./packages/channels/src/index.ts', import.meta.url).pathname,
    },
  },
});
