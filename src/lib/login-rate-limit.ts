import { createHmac, randomUUID } from 'node:crypto';
import { hash, secret } from '@/lib/crypto';
import { getIpAddress } from '@/lib/ip';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';

interface Counter {
  count: number;
  expiresAt: number;
}

interface CounterStore {
  counters: Map<string, Counter>;
  nextSweepAt: number;
}

type CounterKind = 'ip' | 'accountIp' | 'account';

interface LoginLimit {
  blocked: boolean;
  retryAfter: number;
}

type LoginAccountAttempt =
  | { blocked: false; retryAfter: 0; windowExpiresAt: string }
  | { blocked: true; retryAfter: number };

type LoginOverflowAttempt =
  | { blocked: false; leaseId: string; windowExpiresAt: string }
  | { blocked: true };

interface LoginPasswordWorkLease {
  key: string;
  leaseId: string;
}

const MEMORY_COUNTERS = 'analytics-login-rate-limit-counters-v2';
const MAX_MEMORY_COUNTERS = 10_000;
const LOGIN_ADMISSION_BUCKETS = 1 << 18;
const LOGIN_PASSWORD_WORK_SLOTS = 4;

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

function getMemoryCounters(kind: CounterKind): CounterStore {
  const state = globalThis as typeof globalThis & Record<string, any>;

  state[MEMORY_COUNTERS] ??= {
    ip: { counters: new Map<string, Counter>(), nextSweepAt: 0 },
    accountIp: { counters: new Map<string, Counter>(), nextSweepAt: 0 },
    account: { counters: new Map<string, Counter>(), nextSweepAt: 0 },
  };

  return state[MEMORY_COUNTERS][kind];
}

function getMemoryCount(kind: CounterKind, key: string): Counter | null {
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

function getAccountKey(username: string): string {
  const normalizedUsername = username.trim().toLowerCase();

  return `login-rate:account:${hash(normalizedUsername).slice(0, 32)}`;
}

export function getLoginAccountAttemptKey(username: string): string {
  const normalizedUsername = username.trim().toLowerCase();

  if (!normalizedUsername) {
    throw new Error('Username is required for login admission');
  }

  const digest = createHmac('sha256', secret()).update(normalizedUsername).digest();
  const bucket = digest.readUInt32BE(0) & (LOGIN_ADMISSION_BUCKETS - 1);

  return `login-admission:v2:${bucket.toString(16).padStart(5, '0')}`;
}

function getLegacyLoginAccountAttemptKey(userId: string): string {
  return `login-admission:${hash(userId).slice(0, 32)}`;
}

export async function reserveLoginPasswordWork(): Promise<LoginPasswordWorkLease | null> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const leaseId = randomUUID();
  const startingSlot = Number.parseInt(leaseId[0], 16) % LOGIN_PASSWORD_WORK_SLOTS;

  for (let offset = 0; offset < LOGIN_PASSWORD_WORK_SLOTS; offset += 1) {
    const slot = (startingSlot + offset) % LOGIN_PASSWORD_WORK_SLOTS;
    const key = `login-password-work:${slot}`;
    const rows = await client.$queryRaw<Array<{ key: string }>>`
      INSERT INTO "app_setting" ("key", "value")
      VALUES (
        ${key},
        jsonb_build_object(
          'leaseId', ${leaseId}::text,
          'expiresAt', clock_timestamp() + interval '30 seconds'
        )::text
      )
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
      WHERE COALESCE(
        ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz,
        '-infinity'::timestamptz
      ) <= clock_timestamp()
      RETURNING "key"
    `;

    if (rows.length === 1) {
      return { key, leaseId };
    }
  }

  return null;
}

export async function releaseLoginPasswordWork(lease: LoginPasswordWorkLease): Promise<void> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;

  await client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = '{}'::text
    WHERE "key" = ${lease.key}
      AND "value"::jsonb->>'leaseId' = ${lease.leaseId}
  `;
}

export async function reserveLoginAccountAttempt(username: string): Promise<LoginAccountAttempt> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const key = getLoginAccountAttemptKey(username);
  const limit = getAccountLimit();
  const windowSeconds = Math.min(getWindowSeconds(), 15 * 60);
  const rows = await client.$queryRaw<Array<{ windowExpiresAt: string }>>`
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
        ELSE jsonb_set(
          "app_setting"."value"::jsonb,
          '{attempts}',
          to_jsonb(("app_setting"."value"::jsonb->>'attempts')::integer + 1)
        )::text
      END
    WHERE ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz IS NOT NULL
      AND (
        ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz <= clock_timestamp()
        OR ("app_setting"."value"::jsonb->>'attempts')::integer BETWEEN 0 AND ${limit - 1}
      )
    RETURNING "app_setting"."value"::jsonb->>'expiresAt' AS "windowExpiresAt"
  `;

  if (rows.length === 1) {
    return { blocked: false, retryAfter: 0, windowExpiresAt: rows[0].windowExpiresAt };
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

export async function reserveLoginOverflowAttempt(username: string): Promise<LoginOverflowAttempt> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const leaseId = randomUUID();
  const rows = await client.$queryRaw<Array<{ windowExpiresAt: string }>>`
    UPDATE "app_setting"
    SET "value" = (
      "value"::jsonb || jsonb_build_object(
        'overflowLeaseId', ${leaseId}::text,
        'overflowLeaseUntil', clock_timestamp() + interval '30 seconds',
        'overflowNextAt', clock_timestamp() + interval '30 seconds'
      )
    )::text
    WHERE "key" = ${getLoginAccountAttemptKey(username)}
      AND ("value"::jsonb->>'expiresAt')::timestamptz > clock_timestamp()
      AND ("value"::jsonb->>'attempts')::integer >= ${getAccountLimit()}
      AND COALESCE(("value"::jsonb->>'overflowLeaseUntil')::timestamptz, '-infinity') <= clock_timestamp()
      AND COALESCE(("value"::jsonb->>'overflowNextAt')::timestamptz, '-infinity') <= clock_timestamp()
    RETURNING "value"::jsonb->>'expiresAt' AS "windowExpiresAt"
  `;

  return rows.length === 1
    ? { blocked: false, leaseId, windowExpiresAt: rows[0].windowExpiresAt }
    : { blocked: true };
}

export async function releaseLoginOverflowAttempt(
  username: string,
  windowExpiresAt: string,
  leaseId: string,
): Promise<void> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;

  await client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = ("value"::jsonb - 'overflowLeaseId' - 'overflowLeaseUntil')::text
    WHERE "key" = ${getLoginAccountAttemptKey(username)}
      AND "value"::jsonb->>'expiresAt' = ${windowExpiresAt}
      AND "value"::jsonb->>'overflowLeaseId' = ${leaseId}
  `;
}

export async function releaseLoginAccountAttempt(
  username: string,
  windowExpiresAt: string,
): Promise<void> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;

  await client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = jsonb_set(
      "value"::jsonb,
      '{attempts}',
      to_jsonb(GREATEST(0, ("value"::jsonb->>'attempts')::integer - 1))
    )::text
    WHERE "key" = ${getLoginAccountAttemptKey(username)}
      AND "value"::jsonb->>'expiresAt' = ${windowExpiresAt}
      AND ("value"::jsonb->>'attempts')::integer >= 1
  `;
}

export async function releaseLoginAccountAttemptOnce(
  username: string,
  windowExpiresAt: string,
  attemptId: string,
  legacyUserId?: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(attemptId)) {
    return false;
  }

  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const key = legacyUserId
    ? getLegacyLoginAccountAttemptKey(legacyUserId)
    : getLoginAccountAttemptKey(username);
  const updated = await client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = jsonb_set(
      jsonb_set(
        "value"::jsonb,
        '{attempts}',
        to_jsonb(GREATEST(0, ("value"::jsonb->>'attempts')::integer - 1))
      ),
      '{releasedIds}',
      COALESCE("value"::jsonb->'releasedIds', '[]'::jsonb) || to_jsonb(${attemptId}::text)
    )::text
    WHERE "key" = ${key}
      AND "value"::jsonb->>'expiresAt' = ${windowExpiresAt}
      AND ("value"::jsonb->>'attempts')::integer >= 1
      AND COALESCE(jsonb_typeof("value"::jsonb->'releasedIds'), 'array') = 'array'
      AND jsonb_array_length(COALESCE("value"::jsonb->'releasedIds', '[]'::jsonb)) < 100
      AND NOT COALESCE("value"::jsonb->'releasedIds', '[]'::jsonb)
        @> jsonb_build_array(${attemptId}::text)
  `;

  return updated === 1;
}

function getSourceKeys(request: Request, username: string): { ip: string; accountIp: string } {
  const ip = getIpAddress(request.headers) || 'unknown';
  const accountIp = JSON.stringify([username.trim().toLowerCase(), ip]);

  return {
    ip: `login-rate:ip:${hash(ip).slice(0, 32)}`,
    accountIp: `login-rate:account-ip:${hash(accountIp).slice(0, 32)}`,
  };
}

async function increment(kind: CounterKind, key: string): Promise<number | null> {
  if (redis.enabled) {
    try {
      return await redis.client.incrementWithExpiry(key, getWindowSeconds());
    } catch {
      return null;
    }
  }

  const counter = getMemoryCount(kind, key);

  if (!counter) {
    return null;
  }

  counter.count += 1;

  return counter.count;
}

async function remove(kind: CounterKind, key: string): Promise<void> {
  if (redis.enabled) {
    try {
      await redis.client.del(key);
    } catch {
      // The local state is still cleared below.
    }
  }

  getMemoryCounters(kind).counters.delete(key);
}

async function decrement(kind: CounterKind, key: string): Promise<void> {
  if (redis.enabled) {
    try {
      await redis.client.decrementFloorZero(key);
    } catch {
      // The bounded local fallback is adjusted below when present.
    }
  }

  const counters = getMemoryCounters(kind).counters;
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
  const ipCount = await increment('ip', ip);

  if (ipCount === null || ipCount > getIpLimit()) {
    return { blocked: true, retryAfter: getWindowSeconds() };
  }

  const accountIpCount = await increment('accountIp', accountIp);

  return {
    blocked: accountIpCount === null || accountIpCount > getAccountLimit(),
    retryAfter: getWindowSeconds(),
  };
}

export async function recordFailedLogin(username: string): Promise<LoginLimit> {
  const accountCount = await increment('account', getAccountKey(username));

  return {
    blocked: accountCount === null || accountCount > getAccountLimit(),
    retryAfter: getWindowSeconds(),
  };
}

export async function clearFailedLogins(request: Request, username: string): Promise<void> {
  const { ip, accountIp } = getSourceKeys(request, username);

  await Promise.all([
    remove('account', getAccountKey(username)),
    remove('accountIp', accountIp),
    decrement('ip', ip),
  ]);
}
