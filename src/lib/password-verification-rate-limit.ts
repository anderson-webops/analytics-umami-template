import { hash } from '@/lib/crypto';
import prisma from '@/lib/prisma';

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;
const WINDOW_SECONDS = WINDOW_MINUTES * 60;

interface PasswordVerificationAttempt {
  allowed: boolean;
  retryAfter: number;
}

export async function reservePasswordVerificationAttempt(
  userId: string,
): Promise<PasswordVerificationAttempt> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const key = `password-verification:${hash(userId).slice(0, 32)}`;
  const rows = await client.$queryRaw<Array<{ retryAfter: number }>>`
    INSERT INTO "app_setting" ("key", "value")
    VALUES (
      ${key},
      jsonb_build_object(
        'attempts', 1,
        'expiresAt', clock_timestamp() + (${WINDOW_MINUTES} * interval '1 minute')
      )::text
    )
    ON CONFLICT ("key") DO UPDATE SET
      "value" = CASE
        WHEN ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz <= clock_timestamp()
          THEN jsonb_build_object(
            'attempts', 1,
            'expiresAt', clock_timestamp() + (${WINDOW_MINUTES} * interval '1 minute')
          )::text
        ELSE jsonb_build_object(
          'attempts', ("app_setting"."value"::jsonb->>'attempts')::integer + 1,
          'expiresAt', "app_setting"."value"::jsonb->>'expiresAt'
        )::text
      END
    WHERE ("app_setting"."value"::jsonb->>'attempts')::integer BETWEEN 1 AND ${MAX_ATTEMPTS}
      AND ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz IS NOT NULL
      AND (
        ("app_setting"."value"::jsonb->>'expiresAt')::timestamptz <= clock_timestamp()
        OR ("app_setting"."value"::jsonb->>'attempts')::integer < ${MAX_ATTEMPTS}
      )
    RETURNING 0::integer AS "retryAfter"
  `;

  if (rows.length === 1) {
    return { allowed: true, retryAfter: 0 };
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
    allowed: false,
    retryAfter: Math.min(WINDOW_SECONDS, Math.max(1, lock[0]?.retryAfter ?? WINDOW_SECONDS)),
  };
}
