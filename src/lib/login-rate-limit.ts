import { hash } from '@/lib/crypto';
import { getIpAddress } from '@/lib/ip';
import redis from '@/lib/redis';

interface Counter {
  count: number;
  expiresAt: number;
}

interface LoginLimit {
  blocked: boolean;
  retryAfter: number;
}

const MEMORY_COUNTERS = 'analytics-login-rate-limit-counters';
const MAX_MEMORY_COUNTERS = 10_000;

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
  return getBoundedInteger('LOGIN_RATE_LIMIT_WINDOW_SECONDS', 15 * 60, 60, 60 * 60);
}

function getAccountLimit(): number {
  return getBoundedInteger('LOGIN_RATE_LIMIT_ACCOUNT_FAILURES', 10, 3, 100);
}

function getIpLimit(): number {
  return getBoundedInteger('LOGIN_RATE_LIMIT_IP_FAILURES', 50, 5, 500);
}

function getMemoryCounters(): Map<string, Counter> {
  const state = globalThis as typeof globalThis & Record<string, any>;

  state[MEMORY_COUNTERS] ??= new Map<string, Counter>();

  return state[MEMORY_COUNTERS];
}

function getMemoryCount(key: string): Counter {
  const counters = getMemoryCounters();
  const now = Date.now();
  const current = counters.get(key);

  if (!current || current.expiresAt <= now) {
    if (counters.size >= MAX_MEMORY_COUNTERS) {
      for (const [storedKey, counter] of counters) {
        if (counter.expiresAt <= now || counters.size >= MAX_MEMORY_COUNTERS) {
          counters.delete(storedKey);
        }

        if (counters.size < MAX_MEMORY_COUNTERS) {
          break;
        }
      }
    }

    const counter = { count: 0, expiresAt: now + getWindowSeconds() * 1000 };
    counters.set(key, counter);
    return counter;
  }

  return current;
}

function getKeys(request: Request, username: string): { account: string; ip: string } {
  const normalizedUsername = username.trim().toLowerCase();
  const ip = getIpAddress(request.headers) || 'unknown';

  return {
    account: `login-rate:account:${hash(normalizedUsername).slice(0, 32)}`,
    ip: `login-rate:ip:${hash(ip).slice(0, 32)}`,
  };
}

async function increment(key: string): Promise<number> {
  if (redis.enabled) {
    try {
      return await redis.client.incrementWithExpiry(key, getWindowSeconds());
    } catch {
      // Fall back to the local limiter if Redis is temporarily unavailable.
    }
  }

  const counter = getMemoryCount(key);
  counter.count += 1;

  return counter.count;
}

async function remove(key: string): Promise<void> {
  if (redis.enabled) {
    try {
      await redis.client.del(key);
    } catch {
      // The local state is still cleared below.
    }
  }

  getMemoryCounters().delete(key);
}

async function decrement(key: string): Promise<void> {
  if (redis.enabled) {
    try {
      await redis.client.decrementFloorZero(key);
    } catch {
      // The bounded local fallback is adjusted below when present.
    }
  }

  const counters = getMemoryCounters();
  const counter = counters.get(key);

  if (counter) {
    counter.count = Math.max(0, counter.count - 1);

    if (counter.count === 0) {
      counters.delete(key);
    }
  }
}

export async function getLoginLimit(request: Request, username: string): Promise<LoginLimit> {
  const keys = getKeys(request, username);
  const [accountCount, ipCount] = await Promise.all([increment(keys.account), increment(keys.ip)]);

  return {
    blocked: accountCount > getAccountLimit() || ipCount > getIpLimit(),
    retryAfter: getWindowSeconds(),
  };
}

export async function clearFailedLogins(request: Request, username: string): Promise<void> {
  const { account, ip } = getKeys(request, username);

  await Promise.all([remove(account), decrement(ip)]);
}
