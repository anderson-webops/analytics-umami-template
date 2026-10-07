import { NextRequest } from 'next/server';
import { afterEach, expect, test, vi } from 'vitest';
import middleware from './proxy';

afterEach(() => {
  vi.unstubAllEnvs();
});

function requestTracker(path = '/script.js') {
  return new NextRequest(`https://analytics.example.com${path}`, {
    headers: {
      Accept: 'text/javascript',
      Authorization: 'Bearer synthetic-token',
      Cookie: 'session=synthetic-token',
      'X-API-Key': 'synthetic-key',
      'X-Forwarded-For': '192.0.2.1',
    },
  });
}

test.each(['/script.js', '/custom.js'])(
  'external tracker rewrite clears all incoming request headers for %s',
  path => {
    vi.stubEnv('TRACKER_SCRIPT_URL', 'https://tracker.example.com/script.js');
    vi.stubEnv('TRACKER_SCRIPT_NAME', 'custom.js');

    const response = middleware(requestTracker(path));

    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://tracker.example.com/script.js',
    );
    expect(response.headers.get('x-middleware-override-headers')).toBe('accept');
    expect(
      [...response.headers.entries()].filter(([name]) => name.startsWith('x-middleware-request-')),
    ).toEqual([['x-middleware-request-accept', '*/*']]);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400, must-revalidate');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  },
);

test('cloud tracker rewrite also clears incoming request headers', () => {
  vi.stubEnv('TRACKER_SCRIPT_URL', '');
  vi.stubEnv('CLOUD_MODE', '1');
  vi.stubEnv('NODE_ENV', 'production');

  const response = middleware(requestTracker());

  expect(response.headers.get('x-middleware-rewrite')).toBe('https://cloud.umami.is/script.js');
  expect(response.headers.get('x-middleware-override-headers')).toBe('accept');
});

test('local tracker does not receive an unnecessary request-header override', () => {
  vi.stubEnv('TRACKER_SCRIPT_URL', '');
  vi.stubEnv('CLOUD_MODE', '');

  const response = middleware(requestTracker());

  expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  expect(response.headers.get('x-middleware-override-headers')).toBeNull();
  expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
});
