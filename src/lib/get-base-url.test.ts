import { afterEach, expect, test, vi } from 'vitest';
import { HOMEPAGE_URL } from './constants';
import { getBaseUrl } from './get-base-url';

function createHeaders(entries: Record<string, string>) {
  return {
    get(name: string) {
      return entries[name.toLowerCase()] ?? null;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test('uses the configured public origin in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PUBLIC_URL', 'https://analytics.example.com');

  const url = getBaseUrl(
    createHeaders({
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    }),
  );

  expect(url.toString()).toBe('https://analytics.example.com/');
});

test('does not trust request host headers in production without a valid public origin', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PUBLIC_URL', '');

  const url = getBaseUrl(
    createHeaders({
      host: 'attacker.example',
    }),
  );

  expect(url.toString()).toBe(`${HOMEPAGE_URL}/`);
});

test('prefers forwarded host and protocol', () => {
  const url = getBaseUrl(
    createHeaders({
      'x-forwarded-host': 'umami.is',
      'x-forwarded-proto': 'https',
      host: 'localhost:3000',
    }),
  );

  expect(url.toString()).toBe('https://umami.is/');
});

test('falls back to host header', () => {
  const url = getBaseUrl(
    createHeaders({
      host: 'analytics.example.com',
    }),
  );

  expect(url.toString()).toBe('https://analytics.example.com/');
});

test('uses http for localhost hosts', () => {
  const url = getBaseUrl(
    createHeaders({
      host: 'localhost:3000',
    }),
  );

  expect(url.toString()).toBe('http://localhost:3000/');
});

test('falls back to homepage when host is missing', () => {
  const url = getBaseUrl(createHeaders({}));

  expect(url.toString()).toBe(`${HOMEPAGE_URL}/`);
});
