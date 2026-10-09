import { hash } from '@/lib/crypto';
import { getIpAddress } from '@/lib/ip';
import prisma from '@/lib/prisma';
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

function getAccountKey(username: string): string {
  const normalizedUsername = username.trim().toLowerCase();

  return `login-rate:account:${hash(normalizedUsername).slice(0, 32)}`;
}

export function getLoginAccountAttemptKey(userId?: string): string {
  return `login-admission:${userId ? hash(userId).slice(0, 32) : 'unknown'}`;
}

export async function reserveLoginAccountAttempt(userId?: string): Promise<LoginLimit> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const key = getLoginAccountAttemptKey(userId);
  const limit = getAccountLimit();
  const windowSeconds = Math.min(getWindowSeconds(), 15 * 60);
  const rows = await client.$queryRaw<Array<{ retryAfter: number }>>`
    INSERT INTO "app_setting" ("key", "value")
    VALUES (
      ${key},
      jsonb_build_object(
        'attempts', 1,
        'expiresAt', clock_timestamp() + (${windowSeconds} * interval '1 second')
      )::text
    )
    ON CONFLICT ("key") DO UPDATE SET
      "value" = CASE
        WHEN ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz <= clock_timestamp()
          THEN jsonb_build_object(
            'attempts', 1,
            'expiresAt', clock_timestamp() + (${windowSeconds} * interval '1 second')
          )::text
        ELSE jsonb_build_object(
          'attempts', ("app_setting"."value"::jsonb->>'attempts')::integer + 1,
          'expiresAt', "app_setting"."value"::jsonb->>'expiresAt'
        )::text
      END
    WHERE ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz IS NOT NULL
      AND (
        ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz <= clock_timestamp()
        OR ("app_setting"."value"::jsonb->>'attempts')::integer BETWEEN 1 AND ${limit - 1}
      )
    RETURNING 0::integer AS "retryAfter"
  `;

  if (rows.length === 1) {
    return { blocked: false, retryAfter: 0 };
  }

  const lock = await client.$queryRaw<Array<{ retryAfter: number }>>`
    SELECT GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (("value"::jsonb->>'expiresAt')::timestamptz - clock_timestamp())))::integer
    ) AS "retryAfter"
    FROM "app_setting"
    WHERE "key" = ${key}
  `;

  return {
    blocked: true,
    retryAfter: Math.min(windowSeconds, Math.max(1, lock[0]?.retryAfter ?? windowSeconds)),
  };
}

function getSourceKeys(request: Request, username: string): { ip: string; accountIp: string } {
  const ip = getIpAddress(request.headers) || 'unknown';
  const accountIp = JSON.stringify([username.trim().toLowerCase(), ip]);

  return {
    ip: `login-rate:ip:${hash(ip).slice(0, 32)}`,
    accountIp: `login-rate:account-ip:${hash(accountIp).slice(0, 32)}`,
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
  const { ip, accountIp } = getSourceKeys(request, username);
  const [ipCount, accountIpCount] = await Promise.all([increment(ip), increment(accountIp)]);

  return {
    blocked: ipCount > getIpLimit() || accountIpCount > getAccountLimit(),
    retryAfter: getWindowSeconds(),
  };
}

export async function recordFailedLogin(username: string): Promise<LoginLimit> {
  const accountCount = await increment(getAccountKey(username));

  return {
    blocked: accountCount > getAccountLimit(),
    retryAfter: getWindowSeconds(),
  };
}

export async function clearFailedLogins(request: Request, username: string): Promise<void> {
  const { ip, accountIp } = getSourceKeys(request, username);

  await Promise.all([remove(getAccountKey(username)), remove(accountIp), decrement(ip)]);
}
