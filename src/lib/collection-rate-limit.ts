import { hash } from '@/lib/crypto';
import { getIpAddress } from '@/lib/ip';
import redis from '@/lib/redis';

interface Counter {
  count: number;
  expiresAt: number;
}

interface CounterStore {
  counters: Map<string, Counter>;
  nextSweepAt: number;
}

type CounterKind = 'ip' | 'source';

export interface CollectionLimit {
  blocked: boolean;
  retryAfter: number;
}

const MEMORY_COUNTERS = 'analytics-collection-rate-limit-counters-v2';
const MAX_MEMORY_COUNTERS = 20_000;
const transferableRequests = new WeakSet<Request>();
const transferredRequests = new WeakSet<Request>();

function getBoundedInteger(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name] || defaultValue);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return defaultValue;
  }

  return value;
}

function getWindowSeconds(): number {
  return getBoundedInteger('COLLECTION_RATE_LIMIT_WINDOW_SECONDS', 60, 10, 300);
}

function getPerIpLimit(): number {
  return getBoundedInteger('COLLECTION_RATE_LIMIT_PER_IP', 1200, 10, 100_000);
}

function getPerSourceLimit(): number {
  return getBoundedInteger('COLLECTION_RATE_LIMIT_PER_SOURCE', 50_000, 100, 1_000_000);
}

function getMemoryCounters(kind: CounterKind): CounterStore {
  const state = globalThis as typeof globalThis & Record<string, any>;

  state[MEMORY_COUNTERS] ??= {
    ip: { counters: new Map<string, Counter>(), nextSweepAt: 0 },
    source: { counters: new Map<string, Counter>(), nextSweepAt: 0 },
  };

  return state[MEMORY_COUNTERS][kind];
}

function getMemoryCounter(kind: CounterKind, key: string): Counter | null {
  const store = getMemoryCounters(kind);
  const { counters } = store;
  const now = Date.now();
  const current = counters.get(key);

  if (current && current.expiresAt > now) {
    return current;
  }

  if (current) {
    counters.delete(key);
  }

  if (counters.size >= MAX_MEMORY_COUNTERS && now >= store.nextSweepAt) {
    store.nextSweepAt = now + 1000;

    for (const [storedKey, counter] of counters) {
      if (counter.expiresAt <= now) {
        counters.delete(storedKey);
      }
    }
  }

  if (counters.size >= MAX_MEMORY_COUNTERS) {
    return null;
  }

  const counter = { count: 0, expiresAt: now + getWindowSeconds() * 1000 };
  counters.set(key, counter);

  return counter;
}

function getSourceKey(sourceId: string): string {
  return `collection-rate:source:${hash(sourceId.toLowerCase()).slice(0, 32)}`;
}

async function getExistingCount(key: string): Promise<number> {
  const memoryCounter = getMemoryCounters('source').counters.get(key);
  let count = memoryCounter && memoryCounter.expiresAt > Date.now() ? memoryCounter.count : 0;

  if (redis.enabled) {
    try {
      const redisCount = await redis.client.get(key);

      if (Number.isSafeInteger(redisCount) && redisCount >= 0) {
        count = Math.max(count, redisCount);
      }
    } catch {
      return count;
    }
  }

  return count;
}

async function increment(kind: CounterKind, key: string): Promise<number | null> {
  if (redis.enabled) {
    try {
      return await redis.client.incrementWithExpiry(key, getWindowSeconds());
    } catch {
      // Fall back to bounded local counters if Redis is unavailable.
    }
  }

  const counter = getMemoryCounter(kind, key);

  if (!counter) {
    return null;
  }

  counter.count += 1;

  return counter.count;
}

export async function getCollectionIpLimit(request: Request): Promise<CollectionLimit> {
  if (transferredRequests.delete(request)) {
    return { blocked: false, retryAfter: getWindowSeconds() };
  }

  transferableRequests.delete(request);
  const ip = getIpAddress(request.headers) || 'unknown';
  const count = await increment('ip', `collection-rate:ip:${hash(ip).slice(0, 32)}`);
  const blocked = count === null || count > getPerIpLimit();

  if (!blocked) {
    transferableRequests.add(request);
  }

  return {
    blocked,
    retryAfter: getWindowSeconds(),
  };
}

export function transferCollectionIpLimit(from: Request, to: Request): void {
  if (!transferableRequests.delete(from)) {
    throw new Error('COLLECTION_IP_LIMIT_NOT_RESERVED');
  }

  transferredRequests.add(to);
}

export async function getCollectionSourceLimit(sourceId: string): Promise<CollectionLimit> {
  const count = await increment('source', getSourceKey(sourceId));

  return {
    blocked: count === null || count > getPerSourceLimit(),
    retryAfter: getWindowSeconds(),
  };
}

export async function getCollectionSourceStatus(sourceId: string): Promise<CollectionLimit> {
  const count = await getExistingCount(getSourceKey(sourceId));

  return {
    blocked: count >= getPerSourceLimit(),
    retryAfter: getWindowSeconds(),
  };
}
