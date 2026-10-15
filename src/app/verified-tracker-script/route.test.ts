import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function digest(source: string) {
  return createHash('sha256').update(source).digest('hex');
}

async function route() {
  vi.resetModules();
  return import('./route');
}

function configure(source: string) {
  vi.stubEnv('TRACKER_SCRIPT_URL', 'https://tracker.example.test/script.js');
  vi.stubEnv('TRACKER_SCRIPT_SHA256', digest(source));
  vi.stubEnv('CLOUD_MODE', '');
}

test('serves only exact approved bytes and caches the verified script', async () => {
  const source = 'window.umami = { track() {} };';
  configure(source);
  const upstream = vi.fn().mockResolvedValue(
    new Response(source, {
      headers: { 'Set-Cookie': 'remote-session=synthetic' },
    }),
  );
  vi.stubGlobal('fetch', upstream);
  const { GET, HEAD } = await route();

  const response = await GET();
  const repeated = await GET();
  const head = await HEAD();

  expect(response.status).toBe(200);
  expect(await response.text()).toBe(source);
  expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(response.headers.get('Set-Cookie')).toBeNull();
  expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400, must-revalidate');
  expect(await repeated.text()).toBe(source);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream).toHaveBeenCalledWith(
    new URL('https://tracker.example.test/script.js'),
    expect.objectContaining({
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'text/javascript' },
      redirect: 'error',
    }),
  );
});

test('changed remote bytes fail closed without caching the failure', async () => {
  const approved = 'window.umami = true;';
  configure(approved);
  const upstream = vi
    .fn()
    .mockResolvedValueOnce(new Response('window.umami = false;'))
    .mockResolvedValueOnce(new Response(approved));
  vi.stubGlobal('fetch', upstream);
  const { GET } = await route();

  const rejected = await GET();
  const accepted = await GET();

  expect(rejected.status).toBe(503);
  expect(rejected.headers.get('Cache-Control')).toBe('no-store');
  expect(await rejected.text()).toBe('');
  expect(accepted.status).toBe(200);
  expect(await accepted.text()).toBe(approved);
  expect(upstream).toHaveBeenCalledTimes(2);
});

test.each([
  ['missing', ''],
  ['uppercase', 'A'.repeat(64)],
  ['malformed', 'not-a-digest'],
])('rejects %s script approval before fetching', async (_label, value) => {
  configure('approved');
  vi.stubEnv('TRACKER_SCRIPT_SHA256', value);
  const upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
  const { GET } = await route();

  expect((await GET()).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

test('rejects an invalid external tracker URL without fetching', async () => {
  configure('approved');
  vi.stubEnv('TRACKER_SCRIPT_URL', 'http://127.0.0.1/script.js');
  const upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
  const { GET } = await route();

  expect((await GET()).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

test.each([
  ['remote unavailable', () => Promise.reject(new Error('unavailable'))],
  ['redirect', () => Promise.resolve(Response.redirect('https://other.example.test/script.js'))],
  ['oversized body', () => Promise.resolve(new Response('x'.repeat(1024 * 1024 + 1)))],
  [
    'oversized declared length',
    () =>
      Promise.resolve(
        new Response('approved', { headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
      ),
  ],
])('does not serve %s', async (_label, reply) => {
  configure('approved');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(reply));
  const { GET } = await route();

  const response = await GET();

  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test.each([
  [{ TRACKER_SCRIPT_URL: 'https://tracker.example.test/script.js' }, false],
  [
    {
      TRACKER_SCRIPT_URL: 'https://tracker.example.test/script.js',
      TRACKER_SCRIPT_SHA256: digest('approved'),
    },
    true,
  ],
  [{ TRACKER_SCRIPT_URL: '', CLOUD_MODE: '1' }, false],
  [{ TRACKER_SCRIPT_URL: '', CLOUD_MODE: '1', TRACKER_SCRIPT_SHA256: digest('approved') }, true],
])('startup requires a digest for external tracker configuration', (configuration, valid) => {
  const result = spawnSync(process.execPath, ['scripts/check-env.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      NODE_ENV: 'CLOUD_MODE' in configuration ? 'production' : 'development',
      APP_SECRET: 'a'.repeat(32),
      DATABASE_URL: `postgresql://umami:${'b'.repeat(32)}@localhost:5432/umami`,
      PUBLIC_URL: 'https://analytics.example.test',
      CLIENT_IP_HEADER: 'X-Real-IP',
      CLOUD_URL: 'https://cloud.example.test',
      CLICKHOUSE_URL: 'http://localhost:8123',
      REDIS_URL: 'redis://localhost:6379',
      ...configuration,
    },
  });

  expect(result.status).toBe(valid ? 0 : 1);
  if (!valid) {
    expect(result.stderr).toContain('External tracker scripts require TRACKER_SCRIPT_SHA256.');
  }
});
