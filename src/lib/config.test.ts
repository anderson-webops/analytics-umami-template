import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GET } from '@/app/api/config/route';
import { parseRequest } from '@/lib/request';
import { getConfig } from './config';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
const names = [
  'CLOUD_MODE',
  'FAVICON_URL',
  'LINKS_URL',
  'PIXELS_URL',
  'PRIVATE_MODE',
  'DISABLE_PUBLIC_SHARES',
  'DISABLE_TELEMETRY',
  'TRACKER_SCRIPT_NAME',
  'DISABLE_UPDATES',
  'ENABLE_UPDATE_CHECKS',
  'DATABASE_URL',
  'CLICKHOUSE_URL',
  'KAFKA_URL',
  'KAFKA_BROKER',
  'CLICKHOUSE_HISTORY_ATTESTED_CLEAN',
  'KAFKA_HISTORY_ATTESTED_CLEAN',
];
beforeEach(() => {
  for (const name of names) vi.stubEnv(name, undefined);
  vi.mocked(parseRequest)
    .mockReset()
    .mockResolvedValue({ error: undefined } as never);
});
afterEach(() => vi.unstubAllEnvs());

test.each(['false', '0', 'off', 'no', ' FALSE '])(
  'explicit disabled flags stay false: %s',
  value => {
    for (const name of [
      'CLOUD_MODE',
      'PRIVATE_MODE',
      'DISABLE_PUBLIC_SHARES',
      'DISABLE_TELEMETRY',
      'DISABLE_UPDATES',
    ]) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv('ENABLE_UPDATE_CHECKS', 'true');
    expect(getConfig()).toMatchObject({
      cloudMode: false,
      privateMode: false,
      publicSharesDisabled: false,
      telemetryDisabled: false,
      updatesDisabled: false,
      sessionDeletionEnabled: false,
    });
  },
);

test.each(['true', '1', 'yes', 'on', ' TRUE '])(
  'enabled runtime flags are preserved: %s',
  value => {
    for (const name of [
      'CLOUD_MODE',
      'PRIVATE_MODE',
      'DISABLE_PUBLIC_SHARES',
      'DISABLE_TELEMETRY',
      'DISABLE_UPDATES',
    ]) {
      vi.stubEnv(name, value);
    }
    expect(getConfig()).toMatchObject({
      cloudMode: true,
      privateMode: true,
      publicSharesDisabled: true,
      telemetryDisabled: true,
      updatesDisabled: true,
    });
  },
);

test('update checks retain explicit opt-in and a disabling override', () => {
  expect(getConfig().updatesDisabled).toBe(true);
  vi.stubEnv('ENABLE_UPDATE_CHECKS', 'true');
  expect(getConfig().updatesDisabled).toBe(false);
  vi.stubEnv('DISABLE_UPDATES', 'true');
  expect(getConfig().updatesDisabled).toBe(true);
});

test('session deletion requires independently reviewed storage history', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1:1/unit');
  expect(getConfig().sessionDeletionEnabled).toBe(false);
  vi.stubEnv('CLICKHOUSE_HISTORY_ATTESTED_CLEAN', 'true');
  expect(getConfig().sessionDeletionEnabled).toBe(false);
  vi.stubEnv('KAFKA_HISTORY_ATTESTED_CLEAN', 'true');
  expect(getConfig().sessionDeletionEnabled).toBe(true);

  for (const name of ['CLICKHOUSE_URL', 'KAFKA_URL', 'KAFKA_BROKER']) {
    vi.stubEnv(name, 'http://127.0.0.1:1');
    expect(getConfig().sessionDeletionEnabled).toBe(false);
    vi.stubEnv(name, undefined);
  }
});

test('configuration is evaluated at request time and exposes only maintained public fields', () => {
  const before = getConfig();
  vi.stubEnv('PRIVATE_MODE', 'true');
  vi.stubEnv('TRACKER_SCRIPT_NAME', 'privacy-script.js');
  vi.stubEnv('FAVICON_URL', 'https://icons.example');
  vi.stubEnv('APP_SECRET', 'synthetic-private-value-that-is-never-output');
  const after = getConfig();
  expect(before.privateMode).toBe(false);
  expect(after).toMatchObject({ privateMode: true, trackerScriptName: 'privacy-script.js' });
  expect(Object.keys(after).sort()).toEqual(
    [
      'cloudMode',
      'faviconUrl',
      'linksUrl',
      'pixelsUrl',
      'privateMode',
      'publicSharesDisabled',
      'sessionDeletionEnabled',
      'telemetryDisabled',
      'trackerScriptName',
      'updatesDisabled',
    ].sort(),
  );
  expect(JSON.stringify(after)).not.toContain('synthetic-private-value-that-is-never-output');
});

test('the compatibility endpoint returns the same maintained configuration without caching', async () => {
  vi.stubEnv('PRIVATE_MODE', 'true');
  vi.stubEnv('DISABLE_PUBLIC_SHARES', 'true');
  const request = new Request('https://analytics.example/api/config');
  const response = await GET(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(JSON.parse(JSON.stringify(getConfig())));
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(parseRequest).toHaveBeenCalledWith(request, null, { skipAuth: true });
});

test('compatibility request rejection remains effective', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    error: () => new Response(null, { status: 429 }),
  } as never);
  expect((await GET(new Request('https://analytics.example/api/config'))).status).toBe(429);
});
