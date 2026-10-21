import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import {
  getCollectionIpLimit,
  getCollectionSourceStatus,
  reserveCollectionSourceLimit,
  transferCollectionIpLimit,
} from './collection-rate-limit';

const state = vi.hoisted(() => ({
  redisEnabled: false,
  redisCounters: new Map<string, number>(),
  sharedCounters: new Map<string, bigint>(),
  failDatabase: false,
  queries: [] as string[],
}));

vi.mock('@/lib/redis', () => ({
  default: {
    get enabled() {
      return state.redisEnabled;
    },
    client: {
      get: vi.fn(async (key: string) => state.redisCounters.get(key) ?? null),
      incrementWithExpiry: vi.fn(async (key: string) => {
        const count = (state.redisCounters.get(key) ?? 0) + 1;
        state.redisCounters.set(key, count);
        return count;
      }),
    },
  },
}));

vi.mock('@/lib/prisma', () => {
  function runQuery(
    strings: TemplateStringsArray,
    values: unknown[],
    counters: Map<string, bigint>,
  ) {
    if (state.failDatabase) {
      throw new Error('database unavailable');
    }

    const query = strings.join('?');
    state.queries.push(query);

    if (query.includes('transaction_timestamp() AS "currentTime"')) {
      return [{ currentTime: new Date() }];
    }

    if (query.includes('INSERT INTO collection_ingest_budget')) {
      const [subjectKey, windowStart, , limit] = values as [string, Date, Date, number];
      const key = `${subjectKey}|${windowStart.toISOString()}`;
      const current = counters.get(key) ?? 0n;

      if (current >= BigInt(limit)) {
        return [];
      }

      const next = current + 1n;
      counters.set(key, next);
      return [{ requests: next }];
    }

    if (query.includes('SELECT requests')) {
      const [subjectKey, windowSeconds] = values as [string, number];
      const windowStart = new Date(
        Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
      );
      const count = counters.get(`${subjectKey}|${windowStart.toISOString()}`);
      return count === undefined ? [] : [{ requests: count }];
    }

    throw new Error('unexpected rate-limit query');
  }

  const client = {
    $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
      runQuery(strings, values, state.sharedCounters),
    ),
  };

  return {
    default: {
      client,
      transaction: vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) => {
        const pending = new Map(state.sharedCounters);
        const transaction = {
          $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
            runQuery(strings, values, pending),
          $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
            state.queries.push(strings.join('?'));
            return 0;
          }),
        };
        const result = await operation(transaction);
        state.sharedCounters = pending;
        return result;
      }),
    },
  };
});

const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherSourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function request(ip = '203.0.113.7') {
  return new Request('https://analytics.example.com/api/send', {
    headers: { 'x-real-ip': ip },
  });
}

function sharedKeys(prefix: string) {
  return [...state.sharedCounters.keys()].filter(key => key.startsWith(prefix));
}

function reserveSource(
  id: string,
  reserve: typeof reserveCollectionSourceLimit = reserveCollectionSourceLimit,
) {
  return prisma.transaction(transaction => reserve(transaction, id, 'backend'));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(redis.client.get).mockImplementation(async key => state.redisCounters.get(key) ?? null);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T01:02:03Z'));
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  vi.stubEnv('COLLECTION_RATE_LIMIT_PER_IP', '10');
  vi.stubEnv('COLLECTION_RATE_LIMIT_PER_SOURCE', '100');
  state.redisEnabled = false;
  state.redisCounters.clear();
  state.sharedCounters = new Map();
  state.failDatabase = false;
  state.queries.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('the IP limit uses one shared counter and blocks after its bound', async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect((await getCollectionIpLimit(request())).blocked).toBe(false);
  }

  expect(await getCollectionIpLimit(request())).toEqual({ blocked: true, retryAfter: 60 });
  expect(sharedKeys('rate:ip:')).toHaveLength(1);
  expect(state.sharedCounters.get(sharedKeys('rate:ip:')[0])).toBe(10n);
  expect(sharedKeys('rate:source:')).toHaveLength(0);
});

test('batch admission transfers to one child without a second charge', async () => {
  const envelope = request();
  const firstChild = request();
  const secondChild = request();

  expect((await getCollectionIpLimit(envelope)).blocked).toBe(false);
  transferCollectionIpLimit(envelope, firstChild);
  expect(() => transferCollectionIpLimit(envelope, secondChild)).toThrow(
    'COLLECTION_IP_LIMIT_NOT_RESERVED',
  );
  expect((await getCollectionIpLimit(firstChild)).blocked).toBe(false);
  expect((await getCollectionIpLimit(secondChild)).blocked).toBe(false);
  expect(state.sharedCounters.get(sharedKeys('rate:ip:')[0])).toBe(2n);
});

test('blocked admission cannot be transferred', async () => {
  const envelope = request();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await getCollectionIpLimit(envelope);
  }

  expect((await getCollectionIpLimit(envelope)).blocked).toBe(true);
  expect(() => transferCollectionIpLimit(envelope, request())).toThrow(
    'COLLECTION_IP_LIMIT_NOT_RESERVED',
  );
});

test('two independent module instances share source enforcement', async () => {
  const first = await import('./collection-rate-limit');
  vi.resetModules();
  const second = await import('./collection-rate-limit');

  expect(await first.getCollectionSourceStatus(sourceId)).toEqual({
    blocked: false,
    retryAfter: 60,
  });
  expect(state.sharedCounters.size).toBe(0);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await reserveSource(sourceId, first.reserveCollectionSourceLimit);
    await reserveSource(sourceId.toUpperCase(), second.reserveCollectionSourceLimit);
  }

  expect(await second.getCollectionSourceStatus(sourceId)).toEqual({
    blocked: true,
    retryAfter: 60,
  });
  await expect(reserveSource(sourceId, first.reserveCollectionSourceLimit)).rejects.toMatchObject({
    retryAfter: 60,
  });
  expect(sharedKeys('rate:source:')).toHaveLength(1);
  expect(state.sharedCounters.get(sharedKeys('rate:source:')[0])).toBe(100n);
});

test('anonymous sources stop at one quarter of the shared minute limit', async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await prisma.transaction(transaction =>
      reserveCollectionSourceLimit(transaction, sourceId, 'anonymous'),
    );
  }

  await expect(
    prisma.transaction(transaction =>
      reserveCollectionSourceLimit(transaction, sourceId, 'anonymous'),
    ),
  ).rejects.toMatchObject({ retryAfter: 60 });

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  await reserveSource(sourceId);
  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  expect(sharedKeys('rate:source:')).toHaveLength(2);
  expect(state.sharedCounters.get(sharedKeys('rate:pool:source|')[0])).toBe(1n);
});

test('anonymous pageviews cannot exhaust the authorized recorder source allowance', async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await prisma.transaction(transaction =>
      reserveCollectionSourceLimit(transaction, sourceId, 'anonymous'),
    );
  }

  await prisma.transaction(transaction =>
    reserveCollectionSourceLimit(transaction, sourceId, 'recorder'),
  );

  for (let attempt = 26; attempt < 100; attempt += 1) {
    await prisma.transaction(transaction =>
      reserveCollectionSourceLimit(transaction, sourceId, 'recorder'),
    );
  }

  await expect(
    prisma.transaction(transaction =>
      reserveCollectionSourceLimit(transaction, sourceId, 'recorder'),
    ),
  ).rejects.toMatchObject({ retryAfter: 60 });
  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: true, retryAfter: 60 });
});

test('a full shared key pool rejects new keys without evicting active ones', async () => {
  await reserveSource(sourceId);
  expect((await getCollectionIpLimit(request())).blocked).toBe(false);

  const sourcePool = sharedKeys('rate:pool:source|')[0];
  state.sharedCounters.set(sourcePool, 20_000n);
  const originalSize = state.sharedCounters.size;

  await expect(reserveSource(otherSourceId)).rejects.toMatchObject({ retryAfter: 60 });
  expect(state.sharedCounters.size).toBe(originalSize);
  await reserveSource(sourceId);
  expect((await getCollectionIpLimit(request())).blocked).toBe(false);
  expect(state.sharedCounters.get(sourcePool)).toBe(20_000n);
});

test('a new fixed window permits fresh counts and bounded cleanup', async () => {
  await reserveSource(sourceId);
  vi.advanceTimersByTime(61_000);
  expect(await getCollectionSourceStatus(sourceId)).toEqual({
    blocked: false,
    retryAfter: 60,
  });
  await reserveSource(sourceId);
  expect(sharedKeys('rate:source:')).toHaveLength(2);
  expect(state.queries.some(query => query.includes('DELETE FROM collection_ingest_budget'))).toBe(
    true,
  );
  expect(vi.mocked(prisma.transaction)).toHaveBeenCalledTimes(2);
});

test('a configured Redis outage blocks IP intake while source admission remains atomic in PostgreSQL', async () => {
  state.redisEnabled = true;
  vi.mocked(redis.client.incrementWithExpiry).mockRejectedValueOnce(new Error('unavailable'));

  expect(await getCollectionIpLimit(request())).toEqual({ blocked: true, retryAfter: 60 });
  await reserveSource(sourceId);
  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  expect(sharedKeys('rate:source:')).toHaveLength(1);
  expect(redis.client.get).toHaveBeenCalled();
});

test('an unexpired Redis source count reduces the new PostgreSQL source allowance', async () => {
  state.redisEnabled = true;
  await getCollectionSourceStatus(sourceId);
  const legacyKey = vi.mocked(redis.client.get).mock.calls[0][0];
  state.redisCounters.set(legacyKey, 99);

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  await reserveSource(sourceId);
  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: true, retryAfter: 60 });
  await expect(reserveSource(sourceId)).rejects.toMatchObject({ retryAfter: 60 });
  expect(state.sharedCounters.get(sharedKeys('rate:source:')[0])).toBe(1n);
});

test('an unavailable legacy Redis source counter fails closed', async () => {
  state.redisEnabled = true;
  vi.mocked(redis.client.get).mockRejectedValue(new Error('unavailable'));

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: true, retryAfter: 60 });
  await expect(reserveSource(sourceId)).rejects.toMatchObject({ retryAfter: 60 });
  expect(sharedKeys('rate:source:')).toHaveLength(0);
});

test('a database outage fails closed when Redis is not configured', async () => {
  state.failDatabase = true;

  expect(await getCollectionIpLimit(request())).toEqual({ blocked: true, retryAfter: 60 });
  await expect(reserveSource(sourceId)).rejects.toMatchObject({ retryAfter: 60 });
  expect(await getCollectionSourceStatus(sourceId)).toEqual({
    blocked: true,
    retryAfter: 60,
  });
});

test('configured Redis remains the IP fast path while source admissions use PostgreSQL', async () => {
  state.redisEnabled = true;

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  expect(state.redisCounters.size).toBe(0);
  await reserveSource(sourceId);
  expect((await getCollectionIpLimit(request())).blocked).toBe(false);
  expect(state.redisCounters.size).toBe(1);
  expect(sharedKeys('rate:source:')).toHaveLength(1);
  expect(prisma.transaction).toHaveBeenCalledOnce();
});

test('source admission rolls back when a later client budget denies the same request', async () => {
  await expect(
    prisma.transaction(async transaction => {
      await reserveCollectionSourceLimit(transaction, sourceId, 'backend');
      throw new Error('client budget denied');
    }),
  ).rejects.toThrow('client budget denied');

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  expect(sharedKeys('rate:source:')).toHaveLength(0);
  await reserveSource(sourceId);
  expect(sharedKeys('rate:source:')).toHaveLength(1);
});
