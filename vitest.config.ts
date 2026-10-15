import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const releaseBuilder = process.env.ANALYTICS_RELEASE_SINGLE_WORKER === '1';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./src/test/server-only.ts', import.meta.url)),
    },
  },
  test: {
    fileParallelism: !releaseBuilder,
    maxWorkers: releaseBuilder ? 1 : undefined,
    testTimeout: releaseBuilder ? 20_000 : undefined,
    env: {
      APP_SECRET: 'unit-test-only-secret-0000000000000000000000',
    },
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/api/coverage/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
