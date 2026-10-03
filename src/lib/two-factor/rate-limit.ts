import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function lockExpiry(epoch?: number | null) {
  return epoch == null ? undefined : new Date(epoch * 1000);
}

export async function reserveTwoFactorAttempt(
  userId: string,
): Promise<{ allowed: boolean; lockedUntil?: Date }> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const rows = await client.$queryRaw<Array<{ lockedUntilEpoch: number | null }>>`
    INSERT INTO "two_factor_rate_limit" ("id", "user_id", "attempts", "locked_until", "updated_at")
    VALUES (${uuid()}, ${userId}::uuid, 1, NULL, clock_timestamp())
    ON CONFLICT ("user_id") DO UPDATE SET
      "attempts" = CASE
        WHEN "two_factor_rate_limit"."locked_until" <= clock_timestamp() THEN 1
        ELSE "two_factor_rate_limit"."attempts" + 1
      END,
      "locked_until" = CASE
        WHEN "two_factor_rate_limit"."locked_until" <= clock_timestamp() THEN NULL
        WHEN "two_factor_rate_limit"."attempts" + 1 >= ${MAX_ATTEMPTS}
          THEN clock_timestamp() + (${LOCKOUT_MINUTES} * interval '1 minute')
        ELSE NULL
      END,
      "updated_at" = clock_timestamp()
    WHERE (
      "two_factor_rate_limit"."locked_until" IS NULL
      AND "two_factor_rate_limit"."attempts" < ${MAX_ATTEMPTS}
    ) OR "two_factor_rate_limit"."locked_until" <= clock_timestamp()
    RETURNING EXTRACT(EPOCH FROM "locked_until")::float8 AS "lockedUntilEpoch"
  `;

  if (rows.length === 1) {
    return { allowed: true, lockedUntil: lockExpiry(rows[0].lockedUntilEpoch) };
  }

  const lock = await client.$queryRaw<Array<{ lockedUntilEpoch: number | null }>>`
    SELECT EXTRACT(EPOCH FROM "locked_until")::float8 AS "lockedUntilEpoch"
    FROM "two_factor_rate_limit"
    WHERE "user_id" = ${userId}::uuid
  `;

  return { allowed: false, lockedUntil: lockExpiry(lock[0]?.lockedUntilEpoch) };
}

export async function resetRateLimit(userId: string): Promise<void> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  await client.twoFactorRateLimit.deleteMany({ where: { userId } });
}
