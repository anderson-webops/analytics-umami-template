import { hash } from '@/lib/crypto';
import { getIpAddress } from '@/lib/ip';
import redis from '@/lib/redis';

interface Counter {
  count: number;
  expiresAt: number;
}

export interface CollectionLimit {
  blocked: boolean;
  retryAfter: number;
}

const MEMORY_COUNTERS = 'analytics-collection-rate-limit-counters';
const MAX_MEMORY_COUNTERS = 20_000;

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

function getMemoryCounters(): Map<string, Counter> {
  const state = globalThis as typeof globalThis & Record<string, any>;

  state[MEMORY_COUNTERS] ??= new Map<string, Counter>();

  return state[MEMORY_COUNTERS];
}

function getMemoryCounter(key: string): Counter {
  const counters = getMemoryCounters();
  const now = Date.now();
  const current = counters.get(key);

  if (current && current.expiresAt > now) {
    return current;
  }

  for (const [storedKey, counter] of counters) {
    if (counter.expiresAt <= now) {
      counters.delete(storedKey);
    }
  }

  while (counters.size >= MAX_MEMORY_COUNTERS) {
    const oldestKey = counters.keys().next().value;

    if (!oldestKey) {
      break;
    }

    counters.delete(oldestKey);
  }

  const counter = { count: 0, expiresAt: now + getWindowSeconds() * 1000 };
  counters.set(key, counter);

  return counter;
}

function getSourceKey(sourceId: string): string {
  return `collection-rate:source:${hash(sourceId.toLowerCase()).slice(0, 32)}`;
}

async function getExistingCount(key: string): Promise<number> {
  const memoryCounter = getMemoryCounters().get(key);
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

async function increment(key: string): Promise<number> {
  if (redis.enabled) {
    try {
      return await redis.client.incrementWithExpiry(key, getWindowSeconds());
    } catch {
      // Fall back to bounded local counters if Redis is unavailable.
    }
  }

  const counter = getMemoryCounter(key);
  counter.count += 1;

  return counter.count;
}

export async function getCollectionIpLimit(request: Request): Promise<CollectionLimit> {
  const ip = getIpAddress(request.headers) || 'unknown';
  const count = await increment(`collection-rate:ip:${hash(ip).slice(0, 32)}`);

  return {
    blocked: count > getPerIpLimit(),
    retryAfter: getWindowSeconds(),
  };
}

export async function getCollectionSourceLimit(sourceId: string): Promise<CollectionLimit> {
  const count = await increment(getSourceKey(sourceId));

  return {
    blocked: count > getPerSourceLimit(),
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
