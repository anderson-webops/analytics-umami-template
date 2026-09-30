import { defineConfig } from '@playwright/test';
import config from '../../playwright.api.config';
import { BASE_URL } from './paths';

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE_URL).hostname)) {
  throw new Error('Authentication boundary tests require an isolated loopback fixture.');
}

export default defineConfig({
  ...config,
  testDir: '.',
  testMatch: 'auth-boundaries.spec.ts',
  globalSetup: undefined,
  outputDir: '../../test-results/auth-boundaries',
  reporter: 'list',
});
