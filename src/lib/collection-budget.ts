import type { Prisma } from '@/generated/prisma/client';
import { flattenJSON } from '@/lib/data';
import type { CollectionSourceType } from '@/queries/prisma/collection';

const ROW_OVERHEAD_BYTES = 512;
const CLEANUP_BATCH_SIZE = 64;

export const COLLECTION_BUDGET_LIMITS = {
  source: {
    minute: { bytes: 64 * 1024 * 1024, rows: 100_000, requests: 50_000 },
    day: { bytes: 1024 * 1024 * 1024, rows: 2_000_000, requests: 1_000_000 },
  },
  account: {
    minute: { bytes: 256 * 1024 * 1024, rows: 500_000, requests: 250_000 },
    day: { bytes: 5 * 1024 * 1024 * 1024, rows: 10_000_000, requests: 5_000_000 },
  },
} as const;

export class CollectionBudgetExceededError extends Error {
  constructor(public readonly retryAfter: number) {
    super('Collection storage budget exceeded.');
  }
}

interface CollectionBody {
  type: 'event' | 'identify' | 'performance';
  payload: {
    data?: Record<string, unknown>;
    id?: string;
  };
}

export interface CollectionCost {
  bytes: number;
  rows: number;
  requests: number;
}

interface CollectionIdentity {
  sourceType: CollectionSourceType;
  sourceId: string;
  accountType: 'user' | 'team';
  accountId: string;
}

export function getCollectionCost(body: CollectionBody): CollectionCost {
  const dataRows = body.payload.data ? flattenJSON(body.payload.data).length : 0;
  const rows =
    2 +
    dataRows +
    (body.type === 'identify' ? 2 : body.type === 'event' && body.payload.data?.revenue ? 1 : 0);

  return {
    bytes: Buffer.byteLength(JSON.stringify(body), 'utf8') + rows * ROW_OVERHEAD_BYTES,
    rows,
    requests: 1,
  };
}

export async function reserveCollectionBudget(
  transaction: Prisma.TransactionClient,
  { sourceType, sourceId, accountType, accountId }: CollectionIdentity,
  cost: CollectionCost,
) {
  if (
    ![cost.bytes, cost.rows, cost.requests].every(Number.isSafeInteger) ||
    cost.bytes <= 0 ||
    cost.rows <= 0 ||
    cost.requests !== 1
  ) {
    throw new CollectionBudgetExceededError(60);
  }

  const clock = await transaction.$queryRaw<Array<{ currentTime: Date }>>`
    SELECT transaction_timestamp() AS "currentTime"
  `;
  const now = clock[0]?.currentTime;

  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Collection budget clock is unavailable.');
  }

  const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const dayStart = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
  const subjects = [
    { type: 'source', key: `${sourceType}:${sourceId}`, limits: COLLECTION_BUDGET_LIMITS.source },
    { type: accountType, key: accountId, limits: COLLECTION_BUDGET_LIMITS.account },
  ];
  let cleanup = false;

  for (const subject of subjects) {
    for (const scope of ['minute', 'day'] as const) {
      const limits = subject.limits[scope];
      const retryAfter = scope === 'minute' ? 60 : 86_400;

      if (cost.bytes > limits.bytes || cost.rows > limits.rows || cost.requests > limits.requests) {
        throw new CollectionBudgetExceededError(retryAfter);
      }

      const windowStart = scope === 'minute' ? minuteStart : dayStart;
      const expiry = new Date(windowStart.getTime() + retryAfter * 2_000);
      const reserved = await transaction.$queryRaw<Array<{ requests: bigint }>>`
        INSERT INTO collection_ingest_budget
          (subject_type, subject_key, scope, window_start, bytes, rows, requests, expires_at)
        VALUES
          (${subject.type}, ${subject.key}, ${scope}, ${windowStart},
           ${cost.bytes}::bigint, ${cost.rows}::bigint, 1, ${expiry})
        ON CONFLICT (subject_type, subject_key, scope, window_start) DO UPDATE SET
          bytes = collection_ingest_budget.bytes + EXCLUDED.bytes,
          rows = collection_ingest_budget.rows + EXCLUDED.rows,
          requests = collection_ingest_budget.requests + EXCLUDED.requests
        WHERE collection_ingest_budget.bytes + EXCLUDED.bytes <= ${limits.bytes}::bigint
          AND collection_ingest_budget.rows + EXCLUDED.rows <= ${limits.rows}::bigint
          AND collection_ingest_budget.requests + EXCLUDED.requests <= ${limits.requests}::bigint
        RETURNING requests
      `;

      if (reserved.length === 0) {
        throw new CollectionBudgetExceededError(retryAfter);
      }

      if (subject.type === 'source' && scope === 'minute' && reserved[0].requests === 1n) {
        cleanup = true;
      }
    }
  }

  if (cleanup) {
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
}
