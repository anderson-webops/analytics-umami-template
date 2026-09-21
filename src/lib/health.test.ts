import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getReadiness, healthResponse, readyResponse, resetReadinessStateForTests } from './health';

const dependencyState = vi.hoisted(() => ({
  clickhouseConnect: vi.fn(),
  clickhouseEnabled: false,
  clickhousePing: vi.fn(),
  databasePing: vi.fn(),
  databaseSetTimeout: vi.fn(),
  databaseTransaction: vi.fn(),
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
    transaction: dependencyState.databaseTransaction,
  },
}));

vi.mock('@/lib/redis', () => ({
  default: {
    client: {
      client: {
        ping: dependencyState.redisPing,
        withCommandOptions: vi.fn(() => ({ ping: dependencyState.redisPing })),
      },
      connect: dependencyState.redisConnect,
    },
    get enabled() {
      return dependencyState.redisEnabled;
    },
  },
}));

beforeEach(() => {
  vi.useRealTimers();
  resetReadinessStateForTests();
  dependencyState.clickhouseEnabled = false;
  dependencyState.redisEnabled = false;
  dependencyState.clickhouseConnect.mockReset();
  dependencyState.clickhousePing.mockReset();
  dependencyState.databasePing.mockReset();
  dependencyState.databaseSetTimeout.mockReset();
  dependencyState.databaseTransaction.mockReset();
  dependencyState.redisConnect.mockReset();
  dependencyState.redisPing.mockReset();
  dependencyState.databasePing.mockResolvedValue([]);
  dependencyState.databaseSetTimeout.mockResolvedValue(0);
  dependencyState.databaseTransaction.mockImplementation(
    async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation({
        $executeRawUnsafe: dependencyState.databaseSetTimeout,
        $queryRaw: dependencyState.databasePing,
      }),
  );
  dependencyState.clickhouseConnect.mockResolvedValue({ ping: dependencyState.clickhousePing });
});

afterEach(() => {
  vi.useRealTimers();
  resetReadinessStateForTests();
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
    expect(dependencyState.databaseTransaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 1_000,
      timeout: 1_000,
    });
    expect(dependencyState.databaseSetTimeout).toHaveBeenCalledWith(
      "SET LOCAL statement_timeout = '1000ms'",
    );
    expect(dependencyState.redisConnect).toHaveBeenCalledWith(1_000);
    expect(dependencyState.clickhousePing).toHaveBeenCalledWith({
      select: false,
      abort_signal: expect.any(AbortSignal),
    });

    resetReadinessStateForTests();
    dependencyState.redisPing.mockRejectedValueOnce(new Error('private redis host'));
    expect(await getReadiness()).toBe(false);

    resetReadinessStateForTests();
    dependencyState.databasePing.mockRejectedValueOnce(new Error('private database name'));
    expect(await getReadiness()).toBe(false);

    resetReadinessStateForTests();
    dependencyState.clickhousePing.mockRejectedValueOnce(new Error('private clickhouse host'));
    expect(await getReadiness()).toBe(false);
  });

  test('coalesces concurrent checks and reuses the bounded result cache', async () => {
    let resolveDatabase!: (value: unknown[]) => void;
    dependencyState.databasePing.mockReturnValueOnce(
      new Promise(resolve => {
        resolveDatabase = resolve;
      }),
    );

    const first = getReadiness();
    const second = getReadiness();
    await Promise.resolve();

    expect(dependencyState.databasePing).toHaveBeenCalledTimes(1);
    resolveDatabase([]);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    await expect(getReadiness()).resolves.toBe(true);
    expect(dependencyState.databasePing).toHaveBeenCalledTimes(1);
  });

  test('fails closed on the deadline without starting duplicate dependency work', async () => {
    vi.useFakeTimers();
    let resolveDatabase!: (value: unknown[]) => void;
    dependencyState.databasePing.mockReturnValueOnce(
      new Promise(resolve => {
        resolveDatabase = resolve;
      }),
    );

    const first = getReadiness();
    const concurrent = getReadiness();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    expect(dependencyState.databasePing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toBe(false);
    await expect(concurrent).resolves.toBe(false);

    const second = getReadiness();
    expect(dependencyState.databasePing).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(false);

    resolveDatabase([]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(getReadiness()).resolves.toBe(true);
  });
});
