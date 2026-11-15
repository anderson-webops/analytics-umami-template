import { fileURLToPath } from 'node:url';
import replace from '@rollup/plugin-replace';
import { defineConfig } from 'vitest/config';

const releaseBuilder = process.env.ANALYTICS_RELEASE_SINGLE_WORKER === '1';
const clickhouseIntegration = Boolean(process.env.CLICKHOUSE_TEST_URL);

export default defineConfig({
  plugins: [
    replace({
      __COLLECT_API_HOST__: '',
      __COLLECT_API_ENDPOINT__: '/api/send',
      delimiters: ['', ''],
      preventAssignment: true,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./src/test/server-only.ts', import.meta.url)),
    },
  },
  test: {
    fileParallelism: !releaseBuilder,
    maxWorkers: releaseBuilder ? 1 : undefined,
    testTimeout: releaseBuilder || clickhouseIntegration ? 20_000 : undefined,
    env: {
      APP_SECRET: 'unit-test-only-secret-0000000000000000000000',
    },
    environment: 'jsdom',
    execArgv: ['--no-experimental-webstorage'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/api/coverage/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
