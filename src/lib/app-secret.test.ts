import { afterEach, expect, test, vi } from 'vitest';
import { getAppSecret } from './app-secret';

afterEach(() => vi.unstubAllEnvs());

test.each(['', '   ', 'replace-me-with-a-random-string', 'short-secret'])(
  'rejects an absent, placeholder or short application secret: %s',
  value => {
    vi.stubEnv('APP_SECRET', value);
    expect(() => getAppSecret()).toThrow('APP_SECRET');
  },
);

test('uses the trimmed secret with the existing minimum byte length', () => {
  const value = 'test-only-secret-with-at-least-32-bytes';
  vi.stubEnv('APP_SECRET', `  ${value}  `);
  expect(getAppSecret()).toBe(value);
});

test('measures the secret as UTF-8 bytes', () => {
  const value = '界'.repeat(11);
  vi.stubEnv('APP_SECRET', value);
  expect(getAppSecret()).toBe(value);
});
