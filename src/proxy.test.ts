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

test('custom collection rewrite does not grant wildcard response access', () => {
  vi.stubEnv('COLLECT_API_ENDPOINT', '/collect');

  const response = middleware(
    new NextRequest('https://analytics.example.com/collect', {
      headers: { Origin: 'https://unrelated.example' },
    }),
  );

  expect(response.headers.get('x-middleware-rewrite')).toBe(
    'https://analytics.example.com/api/send',
  );
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
});

test.each([
  ['', false],
  ['public-test-key', true],
])(
  'login CSP includes the Turnstile script origin only when configured',
  async (siteKey, enabled) => {
    vi.stubEnv('TURNSTILE_SITE_KEY', siteKey);
    vi.resetModules();
    const { default: configuredMiddleware } = await import('./proxy');

    const response = configuredMiddleware(new NextRequest('https://analytics.example.com/login'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp.includes('https://challenges.cloudflare.com')).toBe(enabled);
  },
);

test('runtime frame allowance retains build-time client API origin', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('API_URL', 'https://build-api.example.test');
  vi.stubEnv('ALLOWED_FRAME_URLS', '');
  vi.resetModules();

  const { default: config } = await import('../next.config');
  const routes = await config.headers?.();
  const buildHeaders = routes?.find(route => route.source === '/:path*')?.headers;
  expect(buildHeaders?.find(header => header.key === 'X-Frame-Options')).toBeUndefined();

  vi.stubEnv('API_URL', '');
  vi.stubEnv('apiUrl', 'https://build-api.example.test');
  vi.stubEnv('ALLOWED_FRAME_URLS', 'https://portal.example.test');
  vi.resetModules();

  const { default: runtimeMiddleware } = await import('./proxy');
  const response = runtimeMiddleware(new NextRequest('https://analytics.example.com/login'));
  const policy = response.headers.get('Content-Security-Policy') ?? '';
  expect(policy).toContain("frame-ancestors 'self' https://portal.example.test;");
  expect(policy).toContain('https://build-api.example.test');
  expect(response.headers.get('X-Frame-Options')).toBeNull();
});

test.each([
  ['production', '', 'DENY'],
  ['production', 'https://portal.example.test, https://other.example.test', null],
  ['development', 'http://127.0.0.1:3000', null],
])(
  'build and runtime CSP agree in %s with frame origins %s',
  async (mode, frames, xFrameOptions) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('API_URL', 'https://api.example.test/api');
    vi.stubEnv('CLOUD_URL', 'https://cloud.example.test');
    vi.stubEnv('TURNSTILE_SITE_KEY', 'synthetic-key');
    vi.stubEnv('ALLOWED_FRAME_URLS', frames);
    vi.resetModules();

    const [{ default: config }, { default: configuredMiddleware }] = await Promise.all([
      import('../next.config'),
      import('./proxy'),
    ]);
    const routes = await config.headers?.();
    const configuredHeaders = routes?.find(route => route.source === '/:path*')?.headers;
    const buildPolicy = configuredHeaders?.find(
      header => header.key === 'Content-Security-Policy',
    )?.value;
    const buildFrameHeader = configuredHeaders?.find(header => header.key === 'X-Frame-Options');
    const response = configuredMiddleware(new NextRequest('https://analytics.example.com/login'));

    expect(buildPolicy).toBeTruthy();
    expect(buildFrameHeader).toBeUndefined();
    expect(response.headers.get('Content-Security-Policy')).toBe(buildPolicy);
    expect(response.headers.get('X-Frame-Options')).toBe(xFrameOptions);
  },
);
