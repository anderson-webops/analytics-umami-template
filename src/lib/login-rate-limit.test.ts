import { afterEach, expect, test, vi } from 'vitest';
import {
  clearFailedLogins,
  getLoginAccountAttemptKey,
  getLoginLimit,
  recordFailedLogin,
  releaseLoginAccountAttempt,
  reserveLoginAccountAttempt,
} from './login-rate-limit';

const mocks = vi.hoisted(() => {
  const counts = new Map<string, number>();

  return {
    counts,
    queryRaw: vi.fn(),
    executeRaw: vi.fn(),
    redis: {
      enabled: false,
      client: {
        incrementWithExpiry: vi.fn(async (key: string) => {
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return count;
        }),
        del: vi.fn(async (key: string) => counts.delete(key)),
        decrementFloorZero: vi.fn(async (key: string) => {
          const count = Math.max(0, (counts.get(key) ?? 0) - 1);

          if (count === 0) {
            counts.delete(key);
          } else {
            counts.set(key, count);
          }

          return count;
        }),
      },
    },
  };
});

vi.mock('@/lib/redis', () => ({ default: mocks.redis }));
vi.mock('@/lib/prisma', () => ({
  default: { client: { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw } },
}));

afterEach(() => {
  const state = globalThis as typeof globalThis & Record<string, any>;
  delete state['analytics-login-rate-limit-counters-v2'];
  mocks.redis.enabled = false;
  mocks.counts.clear();
  mocks.redis.client.incrementWithExpiry.mockClear();
  mocks.redis.client.del.mockClear();
  mocks.redis.client.decrementFloorZero.mockClear();
  mocks.queryRaw.mockReset();
  mocks.executeRaw.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function loginRequest(ip: string) {
  return new Request('http://localhost/api/auth/login', {
    headers: { 'x-real-ip': ip },
  });
}

test.each([false, true])(
  'account failures do not block another IP before password verification (Redis %s)',
  async enabled => {
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
    mocks.redis.enabled = enabled;
    const attacker = loginRequest('192.0.2.10');
    const legitimateUser = loginRequest('198.51.100.20');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await getLoginLimit(attacker, 'Alice')).blocked).toBe(false);
      expect((await recordFailedLogin('alice')).blocked).toBe(false);
    }

    expect((await getLoginLimit(attacker, 'alice')).blocked).toBe(true);
    expect((await getLoginLimit(legitimateUser, 'ALICE')).blocked).toBe(false);
    await clearFailedLogins(legitimateUser, 'alice');
    expect((await recordFailedLogin('ALICE')).blocked).toBe(false);
  },
);

test.each([false, true])(
  'distributed wrong passwords keep the shared account failure response (Redis %s)',
  async enabled => {
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
    mocks.redis.enabled = enabled;

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const source = loginRequest(`192.0.2.${attempt + 1}`);
      expect((await getLoginLimit(source, 'Alice')).blocked).toBe(false);
      expect((await recordFailedLogin(attempt % 2 === 0 ? 'Alice' : 'alice')).blocked).toBe(
        attempt >= 10,
      );
    }

    expect((await getLoginLimit(loginRequest('198.51.100.20'), 'ALICE')).blocked).toBe(false);
  },
);

test.each([false, true])(
  'per-IP budget still rejects excessive guesses (Redis %s)',
  async enabled => {
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
    mocks.redis.enabled = enabled;
    const attacker = loginRequest('192.0.2.10');

    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect((await getLoginLimit(attacker, `user-${attempt}`)).blocked).toBe(false);
    }

    expect((await getLoginLimit(attacker, 'another-user')).blocked).toBe(true);
    expect((await getLoginLimit(loginRequest('198.51.100.20'), 'alice')).blocked).toBe(false);
  },
);

test('username churn cannot reset an already blocked IP', async () => {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  const attacker = loginRequest('192.0.2.10');

  for (let attempt = 0; attempt < 50; attempt += 1) {
    expect((await getLoginLimit(attacker, `existing-user-${attempt}`)).blocked).toBe(false);
  }

  const state = globalThis as typeof globalThis & Record<string, any>;
  const accountIpCount = state['analytics-login-rate-limit-counters-v2'].accountIp.counters.size;
  expect((await getLoginLimit(attacker, 'different-user')).blocked).toBe(true);
  expect(state['analytics-login-rate-limit-counters-v2'].accountIp.counters.size).toBe(
    accountIpCount,
  );

  for (let attempt = 0; attempt < 5001; attempt += 1) {
    const ip = `198.51.${Math.floor(attempt / 256)}.${attempt % 256}`;
    expect((await getLoginLimit(loginRequest(ip), `new-user-${attempt}`)).blocked).toBe(false);
  }

  expect((await getLoginLimit(attacker, 'another-user')).blocked).toBe(true);
}, 30_000);

test('Redis failure denies login instead of weakening to a local counter', async () => {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  mocks.redis.enabled = true;
  mocks.redis.client.incrementWithExpiry.mockRejectedValueOnce(new Error('Redis unavailable'));

  expect((await getLoginLimit(loginRequest('192.0.2.10'), 'alice')).blocked).toBe(true);
});

test('a full account fallback rejects new keys without erasing existing failures', async () => {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    expect((await recordFailedLogin(`new-user-${attempt}`)).blocked).toBe(false);
  }

  expect((await recordFailedLogin('overflow-user')).blocked).toBe(true);
  expect((await recordFailedLogin('new-user-0')).blocked).toBe(false);
}, 30_000);

test('a full IP fallback denies new clients but preserves and expires existing counters', async () => {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T00:00:00.000Z'));
  const attacker = loginRequest('192.0.2.10');

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await getLoginLimit(attacker, `existing-user-${attempt}`);
  }

  for (let attempt = 0; attempt < 9999; attempt += 1) {
    const ip = `198.51.${Math.floor(attempt / 256)}.${attempt % 256}`;
    await getLoginLimit(loginRequest(ip), `new-user-${attempt}`);
  }

  expect((await getLoginLimit(loginRequest('203.0.113.1'), 'new-user')).blocked).toBe(true);
  expect((await getLoginLimit(attacker, 'another-user')).blocked).toBe(true);

  vi.advanceTimersByTime(900_000);
  expect((await getLoginLimit(loginRequest('203.0.113.1'), 'new-user')).blocked).toBe(false);
}, 30_000);

test('account failure window expires without extending an existing lockout', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));

  for (let attempt = 0; attempt < 11; attempt += 1) {
    await recordFailedLogin('alice');
  }

  vi.advanceTimersByTime(900_000);
  expect((await recordFailedLogin('alice')).blocked).toBe(false);
});

test('account admission uses stable user keys and admits only a successful database reservation', async () => {
  mocks.queryRaw.mockResolvedValueOnce([{ windowExpiresAt: '2030-01-01T00:00:00Z' }]);

  expect(getLoginAccountAttemptKey('user-1')).toBe(getLoginAccountAttemptKey('user-1'));
  expect(getLoginAccountAttemptKey('user-1')).not.toBe(getLoginAccountAttemptKey('user-2'));
  expect(getLoginAccountAttemptKey()).toBe('login-admission:unknown');
  expect(await reserveLoginAccountAttempt('user-1')).toEqual({
    blocked: false,
    retryAfter: 0,
    windowExpiresAt: '2030-01-01T00:00:00Z',
  });
  expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  expect(mocks.queryRaw.mock.calls[0]).toContain(getLoginAccountAttemptKey('user-1'));
});

test('a successful password check releases only its reserved account window', async () => {
  await releaseLoginAccountAttempt('user-1', '2030-01-01T00:00:00Z');

  expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
  expect(mocks.executeRaw.mock.calls[0]).toContain(getLoginAccountAttemptKey('user-1'));
  expect(mocks.executeRaw.mock.calls[0]).toContain('2030-01-01T00:00:00Z');
});

test('account admission denies at capacity with a bounded remaining wait', async () => {
  mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ retryAfter: 83 }]);

  expect(await reserveLoginAccountAttempt('user-1')).toEqual({ blocked: true, retryAfter: 83 });
  expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
});

test('account admission fails closed when the shared database is unavailable', async () => {
  mocks.queryRaw.mockRejectedValueOnce(new Error('database unavailable'));

  await expect(reserveLoginAccountAttempt('user-1')).rejects.toThrow('database unavailable');
});
