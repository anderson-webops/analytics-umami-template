import type { Prisma } from '@/generated/prisma/client';

export const MAX_REPLAY_CHUNKS = 2048;
export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
export const MAX_REPLAY_STORED_BYTES = MAX_REPLAY_BYTES + 1024 * 1024;
export const MAX_REPLAY_EVENTS = 20_000;

const MAX_SOURCE_MINUTE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_DAY_BYTES = 1024 * 1024 * 1024;
const MAX_SOURCE_MINUTE_CHUNKS = 10_000;
const MAX_SOURCE_DAY_CHUNKS = 1_000_000;
const MAX_SOURCE_MINUTE_EVENTS = 100_000;
const MAX_SOURCE_DAY_EVENTS = 5_000_000;
const CLEANUP_BATCH_SIZE = 64;

export class ReplayBudgetExceededError extends Error {
  constructor(public readonly retryAfter?: number) {
    super('Replay collection budget exceeded.');
  }
}

interface ReserveReplayBudgetArgs {
  websiteId: string;
  visitId: string;
  chunkIndex: number;
  idempotent: boolean;
  bytes: number;
  events: number;
}

export async function reserveReplayBudget(
  transaction: Prisma.TransactionClient,
  { websiteId, visitId, chunkIndex, idempotent, bytes, events }: ReserveReplayBudgetArgs,
): Promise<boolean> {
  if (bytes > MAX_REPLAY_BYTES || events > MAX_REPLAY_EVENTS) {
    throw new ReplayBudgetExceededError();
  }

  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${websiteId}), hashtext(${visitId}))::text`;

  const existing = await transaction.$queryRaw<Array<{ chunkIndices: number[] }>>`
    SELECT chunk_indices AS "chunkIndices"
    FROM replay_ingest_budget
    WHERE website_id = ${websiteId}::uuid AND scope = 'visit' AND scope_key = ${visitId}
  `;

  if (idempotent && existing[0]?.chunkIndices.includes(chunkIndex)) {
    return false;
  }

  const now = Date.now();
  const visitBudget = await transaction.$queryRaw<Array<{ bytes: bigint }>>`
    INSERT INTO replay_ingest_budget
      (website_id, scope, scope_key, bytes, events, chunks, chunk_indices, expires_at)
    VALUES
      (${websiteId}::uuid, 'visit', ${visitId}, ${bytes}::bigint, ${events}, 1,
       CASE WHEN ${idempotent} THEN ARRAY[${chunkIndex}]::integer[]
         ELSE ARRAY[]::integer[] END, NULL)
    ON CONFLICT (website_id, scope, scope_key) DO UPDATE SET
      bytes = replay_ingest_budget.bytes + EXCLUDED.bytes,
      events = replay_ingest_budget.events + EXCLUDED.events,
      chunks = replay_ingest_budget.chunks + 1,
      chunk_indices = CASE WHEN ${idempotent}
        THEN array_append(replay_ingest_budget.chunk_indices, ${chunkIndex})
        ELSE replay_ingest_budget.chunk_indices END
    WHERE replay_ingest_budget.bytes + EXCLUDED.bytes <= ${MAX_REPLAY_BYTES}::bigint
      AND replay_ingest_budget.events + EXCLUDED.events <= ${MAX_REPLAY_EVENTS}
      AND replay_ingest_budget.chunks < ${MAX_REPLAY_CHUNKS}
      AND (NOT ${idempotent} OR NOT ${chunkIndex} = ANY(replay_ingest_budget.chunk_indices))
    RETURNING bytes
  `;

  if (visitBudget.length === 0) {
    throw new ReplayBudgetExceededError();
  }

  const windows = [
    {
      scope: 'minute',
      key: new Date(Math.floor(now / 60_000) * 60_000).toISOString(),
      limit: MAX_SOURCE_MINUTE_BYTES,
      chunkLimit: MAX_SOURCE_MINUTE_CHUNKS,
      eventLimit: MAX_SOURCE_MINUTE_EVENTS,
      retryAfter: 60,
      expiry: new Date(now + 2 * 60_000),
    },
    {
      scope: 'day',
      key: new Date(Math.floor(now / 86_400_000) * 86_400_000).toISOString(),
      limit: MAX_SOURCE_DAY_BYTES,
      chunkLimit: MAX_SOURCE_DAY_CHUNKS,
      eventLimit: MAX_SOURCE_DAY_EVENTS,
      retryAfter: 86_400,
      expiry: new Date(now + 2 * 86_400_000),
    },
  ];

  for (const { scope, key, limit, chunkLimit, eventLimit, retryAfter, expiry } of windows) {
    const sourceBudget = await transaction.$queryRaw<Array<{ bytes: bigint }>>`
      INSERT INTO replay_ingest_budget
        (website_id, scope, scope_key, bytes, events, chunks, chunk_indices, expires_at)
      VALUES
        (${websiteId}::uuid, ${scope}, ${key}, ${bytes}::bigint, ${events}, 1,
         ARRAY[]::integer[], ${expiry})
      ON CONFLICT (website_id, scope, scope_key) DO UPDATE SET
        bytes = replay_ingest_budget.bytes + EXCLUDED.bytes,
        events = replay_ingest_budget.events + EXCLUDED.events,
        chunks = replay_ingest_budget.chunks + 1,
        expires_at = GREATEST(replay_ingest_budget.expires_at, EXCLUDED.expires_at)
      WHERE replay_ingest_budget.bytes + EXCLUDED.bytes <= ${limit}::bigint
        AND replay_ingest_budget.chunks < ${chunkLimit}
        AND replay_ingest_budget.events + EXCLUDED.events <= ${eventLimit}
      RETURNING bytes
    `;

    if (sourceBudget.length === 0) {
      throw new ReplayBudgetExceededError(retryAfter);
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

  return true;
}
