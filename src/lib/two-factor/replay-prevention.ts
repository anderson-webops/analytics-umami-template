import type { Prisma } from '@/generated/prisma/client';
import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';

type TxClient = Prisma.TransactionClient;

/**
 * Atomically records a one-time password for 90 seconds.
 *
 * The conditional conflict update lets an expired value be reused while ensuring
 * that concurrent requests cannot both consume the same active TOTP.
 */
export async function consumeOtp(userId: string, otp: string, tx?: TxClient): Promise<boolean> {
  const client = tx ?? prisma.client;
  const expiresAt = new Date(Date.now() + 90 * 1000);
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "two_factor_otp_used" ("id", "user_id", "otp", "expires_at")
    VALUES (${uuid()}, ${userId}::uuid, ${otp}, ${expiresAt})
    ON CONFLICT ("user_id", "otp")
    DO UPDATE SET "expires_at" = EXCLUDED."expires_at"
    WHERE "two_factor_otp_used"."expires_at" <= CURRENT_TIMESTAMP
    RETURNING "id"
  `;

  return rows.length === 1;
}
