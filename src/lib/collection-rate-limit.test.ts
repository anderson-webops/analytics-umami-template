import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  getCollectionIpLimit,
  getCollectionSourceLimit,
  getCollectionSourceStatus,
  transferCollectionIpLimit,
} from './collection-rate-limit';

const redisState = vi.hoisted(() => ({ enabled: false, counters: new Map<string, number>() }));

vi.mock('@/lib/redis', () => ({
  default: {
    get enabled() {
      return redisState.enabled;
    },
    client: {
      get: vi.fn(async (key: string) => redisState.counters.get(key) ?? null),
      incrementWithExpiry: vi.fn(async (key: string) => {
        const count = (redisState.counters.get(key) ?? 0) + 1;
        redisState.counters.set(key, count);
        return count;
      }),
    },
  },
}));

const countersKey = 'analytics-collection-rate-limit-counters';

beforeEach(() => {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  vi.stubEnv('COLLECTION_RATE_LIMIT_PER_IP', '10');
  vi.stubEnv('COLLECTION_RATE_LIMIT_PER_SOURCE', '100');
  redisState.enabled = false;
  redisState.counters.clear();
  (globalThis as typeof globalThis & Record<string, unknown>)[countersKey] = new Map();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as typeof globalThis & Record<string, unknown>)[countersKey];
});

test('the IP gate has one stable counter and blocks before any source is charged', async () => {
  const request = new Request('https://analytics.example.com/api/send', {
    headers: { 'x-real-ip': '203.0.113.7' },
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect((await getCollectionIpLimit(request)).blocked).toBe(false);
  }

  const limit = await getCollectionIpLimit(request);
  const counters = (globalThis as typeof globalThis & Record<string, Map<string, unknown>>)[
    countersKey
  ];

  expect(limit).toEqual({ blocked: true, retryAfter: 60 });
  expect([...counters.keys()]).toEqual([expect.stringMatching(/^collection-rate:ip:/)]);
});

test('a batch admission transfers to exactly one child without a second charge', async () => {
  const envelope = new Request('https://analytics.example.com/api/batch', {
    headers: { 'x-real-ip': '203.0.113.7' },
  });
  const firstChild = new Request('https://analytics.example.com/api/send', {
    headers: { 'x-real-ip': '203.0.113.7' },
  });
  const secondChild = new Request('https://analytics.example.com/api/send', {
    headers: { 'x-real-ip': '203.0.113.7' },
  });

  expect((await getCollectionIpLimit(envelope)).blocked).toBe(false);
  transferCollectionIpLimit(envelope, firstChild);
  expect(() => transferCollectionIpLimit(envelope, secondChild)).toThrow(
    'COLLECTION_IP_LIMIT_NOT_RESERVED',
  );
  expect((await getCollectionIpLimit(firstChild)).blocked).toBe(false);
  expect((await getCollectionIpLimit(secondChild)).blocked).toBe(false);

  const counters = (
    globalThis as typeof globalThis & Record<string, Map<string, { count: number }>>
  )[countersKey];
  expect([...counters.values()].map(counter => counter.count)).toEqual([2]);
});

test('a blocked admission cannot be transferred to a child', async () => {
  const envelope = new Request('https://analytics.example.com/api/batch', {
    headers: { 'x-real-ip': '203.0.113.7' },
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await getCollectionIpLimit(envelope);
  }

  expect((await getCollectionIpLimit(envelope)).blocked).toBe(true);
  expect(() =>
    transferCollectionIpLimit(
      envelope,
      new Request('https://analytics.example.com/api/send', {
        headers: { 'x-real-ip': '203.0.113.7' },
      }),
    ),
  ).toThrow('COLLECTION_IP_LIMIT_NOT_RESERVED');
});

test('a verified source uses one shared counter across requests', async () => {
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    expect((await getCollectionSourceLimit(sourceId.toUpperCase())).blocked).toBe(false);
  }

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: true, retryAfter: 60 });
  const limit = await getCollectionSourceLimit(sourceId);
  const counters = (globalThis as typeof globalThis & Record<string, Map<string, unknown>>)[
    countersKey
  ];

  expect(limit).toEqual({ blocked: true, retryAfter: 60 });
  expect([...counters.keys()]).toEqual([expect.stringMatching(/^collection-rate:source:/)]);
});

test('checking an unknown source in Redis does not allocate a key', async () => {
  redisState.enabled = true;
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  expect(redisState.counters.size).toBe(0);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    expect((await getCollectionSourceLimit(sourceId.toUpperCase())).blocked).toBe(false);
  }

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: true, retryAfter: 60 });
  expect(redisState.counters.size).toBe(1);
});
