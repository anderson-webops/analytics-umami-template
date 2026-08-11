import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getReadiness, healthResponse, readyResponse } from './health';

const dependencyState = vi.hoisted(() => ({
  clickhouseConnect: vi.fn(),
  clickhouseEnabled: false,
  clickhousePing: vi.fn(),
  databasePing: vi.fn(),
  redisConnect: vi.fn(),
  redisEnabled: false,
  redisPing: vi.fn(),
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    connect: dependencyState.clickhouseConnect,
    get enabled() {
      return dependencyState.clickhouseEnabled;
    },
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $queryRaw: dependencyState.databasePing,
    },
  },
}));

vi.mock('@/lib/redis', () => ({
  default: {
    client: {
      client: {
        ping: dependencyState.redisPing,
      },
      connect: dependencyState.redisConnect,
    },
    get enabled() {
      return dependencyState.redisEnabled;
    },
  },
}));

beforeEach(() => {
  dependencyState.clickhouseEnabled = false;
  dependencyState.redisEnabled = false;
  dependencyState.clickhouseConnect.mockReset();
  dependencyState.clickhousePing.mockReset();
  dependencyState.databasePing.mockReset();
  dependencyState.redisConnect.mockReset();
  dependencyState.redisPing.mockReset();
  dependencyState.databasePing.mockResolvedValue([]);
  dependencyState.clickhouseConnect.mockResolvedValue({ ping: dependencyState.clickhousePing });
});

async function expectProbe(response: Response, status: number, body: { ok: boolean } | null) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('www-authenticate')).toBeNull();

  if (body) {
    expect(await response.json()).toEqual(body);
  } else {
    expect(await response.text()).toBe('');
  }
}

describe('monitor probes', () => {
  test('returns minimal GET and bodyless HEAD liveness responses', async () => {
    await expectProbe(healthResponse(), 200, { ok: true });
    await expectProbe(healthResponse('HEAD'), 200, null);
  });

  test('returns only readiness state for success and failure', async () => {
    await expectProbe(readyResponse(true), 200, { ok: true });
    await expectProbe(readyResponse(false), 503, { ok: false });
    await expectProbe(readyResponse(false, 'HEAD'), 503, null);
  });

  test('checks each enabled dependency and fails closed without returning its error', async () => {
    dependencyState.redisEnabled = true;
    dependencyState.clickhouseEnabled = true;
    expect(await getReadiness()).toBe(true);

    dependencyState.redisPing.mockRejectedValueOnce(new Error('private redis host'));
    expect(await getReadiness()).toBe(false);

    dependencyState.databasePing.mockRejectedValueOnce(new Error('private database name'));
    expect(await getReadiness()).toBe(false);

    dependencyState.clickhousePing.mockRejectedValueOnce(new Error('private clickhouse host'));
    expect(await getReadiness()).toBe(false);
  });
});
