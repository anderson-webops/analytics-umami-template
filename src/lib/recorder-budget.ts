import type { Prisma } from '@/generated/prisma/client';

export const RECORDER_VISIT_BUDGET_RETENTION_MS = 38 * 24 * 60 * 60 * 1000;
export const MAX_RECORDER_NEW_VISIT_KEYS_PER_MINUTE = 2_000;
export const MAX_RECORDER_NEW_VISIT_KEYS_PER_DAY = 50_000;

export async function reserveRecorderVisitKeyBudget(
  transaction: Prisma.TransactionClient,
  websiteId: string,
  now: number,
): Promise<number | null> {
  const windows = [
    {
      scope: 'minute',
      key: `recorder-visits:${new Date(Math.floor(now / 60_000) * 60_000).toISOString()}`,
      limit: MAX_RECORDER_NEW_VISIT_KEYS_PER_MINUTE,
      retryAfter: 60,
      expiry: new Date(now + 2 * 60_000),
    },
    {
      scope: 'day',
      key: `recorder-visits:${new Date(Math.floor(now / 86_400_000) * 86_400_000).toISOString()}`,
      limit: MAX_RECORDER_NEW_VISIT_KEYS_PER_DAY,
      retryAfter: 86_400,
      expiry: new Date(now + 2 * 86_400_000),
    },
  ];

  for (const { scope, key, limit, retryAfter, expiry } of windows) {
    const reserved = await transaction.$queryRaw<Array<{ chunks: number }>>`
      INSERT INTO replay_ingest_budget
        (website_id, scope, scope_key, bytes, events, chunks, chunk_indices, expires_at)
      VALUES
        (${websiteId}::uuid, ${scope}, ${key}, 0, 0, 1, ARRAY[]::integer[], ${expiry})
      ON CONFLICT (website_id, scope, scope_key) DO UPDATE SET
        chunks = replay_ingest_budget.chunks + 1,
        expires_at = GREATEST(COALESCE(replay_ingest_budget.expires_at, EXCLUDED.expires_at), EXCLUDED.expires_at)
      WHERE replay_ingest_budget.chunks < ${limit}
      RETURNING chunks
    `;

    if (reserved.length === 0) {
      return retryAfter;
    }
  }

  return null;
}
