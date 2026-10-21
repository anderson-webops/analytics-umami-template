import type { Prisma } from '@/generated/prisma/client';
import {
  type CollectionAdmissionClass,
  CollectionBudgetExceededError,
} from '@/lib/collection-budget';
import { hash } from '@/lib/crypto';
import { getIpAddress } from '@/lib/ip';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';

type CounterKind = 'ip' | 'source';

export interface CollectionLimit {
  blocked: boolean;
  retryAfter: number;
}

const MAX_SHARED_COUNTERS = 20_000;
const CLEANUP_BATCH_SIZE = 64;
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

function getSourceKey(sourceId: string): string {
  return `collection-rate:source:${hash(sourceId.toLowerCase()).slice(0, 32)}`;
}

function getSharedKey(kind: CounterKind, key: string): string {
  return `rate:${kind}:${hash(key).slice(0, 32)}`;
}

async function getLegacySourceCount(key: string): Promise<number | null> {
  if (!redis.enabled) {
    return 0;
  }

  try {
    const count = await redis.client.get(key);
    return count === null ? 0 : Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

async function getExistingCount(key: string): Promise<number | null> {
  const legacyCount = await getLegacySourceCount(key);
  if (legacyCount === null) {
    return null;
  }

  try {
    const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
    const windowSeconds = getWindowSeconds();
    const rows = await client.$queryRaw<Array<{ requests: bigint }>>`
      SELECT requests
      FROM collection_ingest_budget
      WHERE subject_type = 'source'
        AND subject_key = ${getSharedKey('source', key)}
        AND scope = 'minute'
        AND window_start = to_timestamp(
          floor(extract(epoch from clock_timestamp()) / ${windowSeconds}) * ${windowSeconds}
        )
    `;
    const count = (rows[0]?.requests ?? 0n) + BigInt(legacyCount);
    return count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null;
  } catch {
    return null;
  }
}

async function reserveSharedCounter(
  transaction: Prisma.TransactionClient,
  kind: CounterKind,
  key: string,
  overrideLimit?: number,
  countNewKeyInPool = true,
): Promise<number | null> {
  const windowSeconds = getWindowSeconds();
  const limit = overrideLimit ?? (kind === 'ip' ? getPerIpLimit() : getPerSourceLimit());
  const clock = await transaction.$queryRaw<Array<{ currentTime: Date }>>`
        SELECT transaction_timestamp() AS "currentTime"
      `;
  const now = clock[0]?.currentTime;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Collection rate-limit clock is unavailable.');
  }

  const windowStart = new Date(
    Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000,
  );
  const expiresAt = new Date(windowStart.getTime() + windowSeconds * 2000);
  const reserved = await transaction.$queryRaw<Array<{ requests: bigint }>>`
        INSERT INTO collection_ingest_budget
          (subject_type, subject_key, scope, window_start, bytes, rows, requests, expires_at)
        VALUES
          ('source', ${getSharedKey(kind, key)}, 'minute', ${windowStart}, 0, 0, 1, ${expiresAt})
        ON CONFLICT (subject_type, subject_key, scope, window_start) DO UPDATE SET
          requests = collection_ingest_budget.requests + 1
        WHERE collection_ingest_budget.requests < ${limit}::bigint
        RETURNING requests
      `;
  if (reserved.length === 0) {
    return null;
  }

  if (reserved[0].requests === 1n && countNewKeyInPool) {
    const pool = await transaction.$queryRaw<Array<{ requests: bigint }>>`
          INSERT INTO collection_ingest_budget
            (subject_type, subject_key, scope, window_start, bytes, rows, requests, expires_at)
          VALUES
            ('source', ${`rate:pool:${kind}`}, 'minute', ${windowStart}, 0, 0, 1, ${expiresAt})
          ON CONFLICT (subject_type, subject_key, scope, window_start) DO UPDATE SET
            requests = collection_ingest_budget.requests + 1
          WHERE collection_ingest_budget.requests < ${MAX_SHARED_COUNTERS}::bigint
          RETURNING requests
        `;
    if (pool.length === 0) {
      throw new Error('Collection rate-limit key capacity exceeded.');
    }

    await transaction.$executeRaw`
          DELETE FROM collection_ingest_budget
          WHERE ctid IN (
            SELECT ctid
            FROM collection_ingest_budget
            WHERE expires_at < transaction_timestamp()
            ORDER BY expires_at
            LIMIT ${CLEANUP_BATCH_SIZE}
          )
        `;
  }

  return Number(reserved[0].requests);
}

async function incrementIp(key: string): Promise<number | null> {
  if (redis.enabled) {
    try {
      const count = await redis.client.incrementWithExpiry(key, getWindowSeconds());
      return Number.isSafeInteger(count) && count > 0 ? count : null;
    } catch {
      return null;
    }
  }

  try {
    return await prisma.transaction(transaction => reserveSharedCounter(transaction, 'ip', key));
  } catch {
    return null;
  }
}

export async function getCollectionIpLimit(request: Request): Promise<CollectionLimit> {
  if (transferredRequests.delete(request)) {
    return { blocked: false, retryAfter: getWindowSeconds() };
  }

  transferableRequests.delete(request);
  const ip = getIpAddress(request.headers) || 'unknown';
  const count = await incrementIp(`collection-rate:ip:${hash(ip).slice(0, 32)}`);
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

export async function reserveCollectionSourceLimit(
  transaction: Prisma.TransactionClient,
  sourceId: string,
  admissionClass: CollectionAdmissionClass = 'anonymous',
): Promise<void> {
  const sourceKey = getSourceKey(sourceId);
  if (admissionClass !== 'backend') {
    const anonymousLimit = Math.max(1, Math.floor(getPerSourceLimit() / 4));
    const anonymousCount = await reserveSharedCounter(
      transaction,
      'source',
      `anonymous:${sourceKey}`,
      anonymousLimit,
      false,
    ).catch(() => null);
    if (anonymousCount === null) {
      throw new CollectionBudgetExceededError(getWindowSeconds());
    }
  }
  const legacyCount = await getLegacySourceCount(sourceKey);
  const remaining = legacyCount === null ? 0 : getPerSourceLimit() - legacyCount;
  const count =
    remaining > 0
      ? await reserveSharedCounter(transaction, 'source', sourceKey, remaining).catch(() => null)
      : null;
  if (count === null) {
    throw new CollectionBudgetExceededError(getWindowSeconds());
  }
}

export async function getCollectionSourceStatus(sourceId: string): Promise<CollectionLimit> {
  const count = await getExistingCount(getSourceKey(sourceId));

  return {
    blocked: count === null || count >= getPerSourceLimit(),
    retryAfter: getWindowSeconds(),
  };
}
