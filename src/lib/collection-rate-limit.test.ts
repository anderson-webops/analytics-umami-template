import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import redis from '@/lib/redis';
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

interface TestCounter {
  count: number;
  expiresAt: number;
}

interface TestStore {
  counters: Map<string, TestCounter>;
  nextSweepAt: number;
}

const countersKey = 'analytics-collection-rate-limit-counters-v2';
const maxMemoryCounters = 20_000;
let memoryCounters: Record<'ip' | 'source', TestStore>;

beforeEach(() => {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  vi.stubEnv('COLLECTION_RATE_LIMIT_PER_IP', '10');
  vi.stubEnv('COLLECTION_RATE_LIMIT_PER_SOURCE', '100');
  redisState.enabled = false;
  redisState.counters.clear();
  memoryCounters = {
    ip: { counters: new Map(), nextSweepAt: 0 },
    source: { counters: new Map(), nextSweepAt: 0 },
  };
  (globalThis as typeof globalThis & Record<string, unknown>)[countersKey] = memoryCounters;
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
  expect(limit).toEqual({ blocked: true, retryAfter: 60 });
  expect([...memoryCounters.ip.counters.keys()]).toEqual([
    expect.stringMatching(/^collection-rate:ip:/),
  ]);
  expect(memoryCounters.source.counters.size).toBe(0);
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

  expect([...memoryCounters.ip.counters.values()].map(counter => counter.count)).toEqual([2]);
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
  expect(limit).toEqual({ blocked: true, retryAfter: 60 });
  expect([...memoryCounters.source.counters.keys()]).toEqual([
    expect.stringMatching(/^collection-rate:source:/),
  ]);
  expect(memoryCounters.ip.counters.size).toBe(0);
});

test('source saturation rejects new sources without evicting a live IP counter', async () => {
  const request = new Request('https://analytics.example.com/api/send', {
    headers: { 'x-real-ip': '203.0.113.7' },
  });
  expect((await getCollectionIpLimit(request)).blocked).toBe(false);
  const ipKey = [...memoryCounters.ip.counters.keys()][0];
  const expiresAt = Date.now() + 60_000;

  for (let index = 0; index < maxMemoryCounters; index += 1) {
    memoryCounters.source.counters.set(`source-${index}`, { count: 1, expiresAt });
  }

  expect(await getCollectionSourceLimit('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toEqual({
    blocked: true,
    retryAfter: 60,
  });
  expect(memoryCounters.source.counters.size).toBe(maxMemoryCounters);
  expect(memoryCounters.ip.counters.get(ipKey)?.count).toBe(1);
  expect((await getCollectionIpLimit(request)).blocked).toBe(false);
  expect(memoryCounters.ip.counters.get(ipKey)?.count).toBe(2);
});

test('IP saturation rejects new IPs without evicting live counters or blocking sources', async () => {
  const existingRequest = new Request('https://analytics.example.com/api/send', {
    headers: { 'x-real-ip': '203.0.113.7' },
  });
  const newRequest = new Request('https://analytics.example.com/api/send', {
    headers: { 'x-real-ip': '203.0.113.8' },
  });
  expect((await getCollectionIpLimit(existingRequest)).blocked).toBe(false);
  const existingKey = [...memoryCounters.ip.counters.keys()][0];
  const expiresAt = Date.now() + 60_000;

  for (let index = 1; index < maxMemoryCounters; index += 1) {
    memoryCounters.ip.counters.set(`ip-${index}`, { count: 1, expiresAt });
  }

  expect(await getCollectionIpLimit(newRequest)).toEqual({ blocked: true, retryAfter: 60 });
  expect(memoryCounters.ip.counters.size).toBe(maxMemoryCounters);
  expect(memoryCounters.ip.counters.get(existingKey)?.count).toBe(1);
  expect((await getCollectionIpLimit(existingRequest)).blocked).toBe(false);
  expect(memoryCounters.ip.counters.get(existingKey)?.count).toBe(2);
  expect((await getCollectionSourceLimit('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).blocked).toBe(
    false,
  );
});

test('expired counters free capacity for new sources without evicting live counters', async () => {
  const expiresAt = Date.now() + 60_000;
  memoryCounters.source.counters.set('expired-source', {
    count: 1,
    expiresAt: Date.now() - 1,
  });

  for (let index = 1; index < maxMemoryCounters; index += 1) {
    memoryCounters.source.counters.set(`source-${index}`, { count: 1, expiresAt });
  }

  expect((await getCollectionSourceLimit('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).blocked).toBe(
    false,
  );
  expect(memoryCounters.source.counters.size).toBe(maxMemoryCounters);
  expect(memoryCounters.source.counters.has('expired-source')).toBe(false);
  expect(memoryCounters.source.counters.get('source-1')?.count).toBe(1);
});

test('Redis failure still fails closed when local source capacity is full', async () => {
  redisState.enabled = true;
  const expiresAt = Date.now() + 60_000;

  for (let index = 0; index < maxMemoryCounters; index += 1) {
    memoryCounters.source.counters.set(`source-${index}`, { count: 1, expiresAt });
  }

  vi.mocked(redis.client.incrementWithExpiry).mockRejectedValueOnce(new Error('unavailable'));

  expect(await getCollectionSourceLimit('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toEqual({
    blocked: true,
    retryAfter: 60,
  });
  expect(memoryCounters.source.counters.size).toBe(maxMemoryCounters);
  expect(redisState.counters.size).toBe(0);
});

test('checking an unknown source in Redis does not allocate a key', async () => {
  redisState.enabled = true;
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: false, retryAfter: 60 });
  expect(redisState.counters.size).toBe(0);
  expect(memoryCounters.source.counters.size).toBe(0);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    expect((await getCollectionSourceLimit(sourceId.toUpperCase())).blocked).toBe(false);
  }

  expect(await getCollectionSourceStatus(sourceId)).toEqual({ blocked: true, retryAfter: 60 });
  expect(redisState.counters.size).toBe(1);
});
