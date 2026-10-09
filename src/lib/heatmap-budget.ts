import type { Prisma } from '@/generated/prisma/client';
import { reserveCollectionAccountBudget } from '@/lib/collection-budget';
import {
  RECORDER_VISIT_BUDGET_RETENTION_MS,
  type RecorderAccount,
  reserveRecorderVisitKeyBudget,
} from '@/lib/recorder-budget';

export const MAX_HEATMAP_VISIT_BYTES = 4 * 1024 * 1024;
export const MAX_HEATMAP_VISIT_EVENTS = 5_000;

const MAX_HEATMAP_VISIT_REQUESTS = 128;
const MAX_HEATMAP_SOURCE_MINUTE_BYTES = 8 * 1024 * 1024;
const MAX_HEATMAP_SOURCE_MINUTE_EVENTS = 20_000;
const MAX_HEATMAP_SOURCE_MINUTE_REQUESTS = 5_000;
const MAX_HEATMAP_SOURCE_DAY_BYTES = 256 * 1024 * 1024;
const MAX_HEATMAP_SOURCE_DAY_EVENTS = 500_000;
const MAX_HEATMAP_SOURCE_DAY_REQUESTS = 100_000;
const CLEANUP_BATCH_SIZE = 64;

export class HeatmapBudgetExceededError extends Error {
  constructor(public readonly retryAfter?: number) {
    super('Heatmap collection budget exceeded.');
  }
}

interface ReserveHeatmapBudgetArgs extends RecorderAccount {
  websiteId: string;
  visitId: string;
  bytes: number;
  events: number;
}

export async function reserveHeatmapBudget(
  transaction: Prisma.TransactionClient,
  { websiteId, visitId, bytes, events, accountType, accountId }: ReserveHeatmapBudgetArgs,
) {
  if (
    !Number.isSafeInteger(bytes) ||
    !Number.isSafeInteger(events) ||
    bytes <= 0 ||
    events <= 0 ||
    bytes > MAX_HEATMAP_VISIT_BYTES ||
    events > MAX_HEATMAP_VISIT_EVENTS
  ) {
    throw new HeatmapBudgetExceededError();
  }

  const now = Date.now();
  const visitKey = `heatmap:${visitId}`;
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${websiteId}), hashtext(${visitKey}))::text`;
  const existing = await transaction.$queryRaw<Array<{ present: boolean }>>`
    SELECT true AS present
    FROM replay_ingest_budget
    WHERE website_id = ${websiteId}::uuid AND scope = 'visit' AND scope_key = ${visitKey}
  `;
  const windows = [
    {
      scope: 'visit',
      key: visitKey,
      byteLimit: MAX_HEATMAP_VISIT_BYTES,
      eventLimit: MAX_HEATMAP_VISIT_EVENTS,
      requestLimit: MAX_HEATMAP_VISIT_REQUESTS,
      expiry: new Date(now + RECORDER_VISIT_BUDGET_RETENTION_MS),
      retryAfter: undefined,
    },
    {
      scope: 'minute',
      key: `heatmap:${new Date(Math.floor(now / 60_000) * 60_000).toISOString()}`,
      byteLimit: MAX_HEATMAP_SOURCE_MINUTE_BYTES,
      eventLimit: MAX_HEATMAP_SOURCE_MINUTE_EVENTS,
      requestLimit: MAX_HEATMAP_SOURCE_MINUTE_REQUESTS,
      expiry: new Date(now + 2 * 60_000),
      retryAfter: 60,
    },
    {
      scope: 'day',
      key: `heatmap:${new Date(Math.floor(now / 86_400_000) * 86_400_000).toISOString()}`,
      byteLimit: MAX_HEATMAP_SOURCE_DAY_BYTES,
      eventLimit: MAX_HEATMAP_SOURCE_DAY_EVENTS,
      requestLimit: MAX_HEATMAP_SOURCE_DAY_REQUESTS,
      expiry: new Date(now + 2 * 86_400_000),
      retryAfter: 86_400,
    },
  ];

  for (const { scope, key, byteLimit, eventLimit, requestLimit, expiry, retryAfter } of windows) {
    const reserved = await transaction.$queryRaw<Array<{ bytes: bigint }>>`
      INSERT INTO replay_ingest_budget
        (website_id, scope, scope_key, bytes, events, chunks, chunk_indices, expires_at)
      VALUES
        (${websiteId}::uuid, ${scope}, ${key}, ${bytes}::bigint, ${events}, 1,
         ARRAY[]::integer[], ${expiry})
      ON CONFLICT (website_id, scope, scope_key) DO UPDATE SET
        bytes = replay_ingest_budget.bytes + EXCLUDED.bytes,
        events = replay_ingest_budget.events + EXCLUDED.events,
        chunks = replay_ingest_budget.chunks + 1,
        expires_at = GREATEST(COALESCE(replay_ingest_budget.expires_at, EXCLUDED.expires_at), EXCLUDED.expires_at)
      WHERE replay_ingest_budget.bytes + EXCLUDED.bytes <= ${byteLimit}::bigint
        AND replay_ingest_budget.events + EXCLUDED.events <= ${eventLimit}
        AND replay_ingest_budget.chunks < ${requestLimit}
      RETURNING bytes
    `;

    if (reserved.length === 0) {
      throw new HeatmapBudgetExceededError(retryAfter);
    }
  }

  await reserveCollectionAccountBudget(
    transaction,
    { accountType, accountId },
    { bytes: bytes + events * 512, rows: events, requests: 1 },
  );

  if (existing.length === 0) {
    const retryAfter = await reserveRecorderVisitKeyBudget(transaction, websiteId, now, {
      accountType,
      accountId,
    });

    if (retryAfter !== null) {
      throw new HeatmapBudgetExceededError(retryAfter);
    }
  }

  await transaction.$executeRaw`
    DELETE FROM replay_ingest_budget
    WHERE ctid IN (
      SELECT ctid
      FROM replay_ingest_budget
      WHERE expires_at < now()
      ORDER BY expires_at
      LIMIT ${CLEANUP_BATCH_SIZE}
    )
  `;
}
