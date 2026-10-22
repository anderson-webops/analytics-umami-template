import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, secret } from '@/lib/crypto';
import prisma from '@/lib/prisma';

const CODE_COUNT = 8;
const CODE_PATTERN = /^UR-[0-9A-F]{64}$/;

export function getLoginRecoveryKeyFingerprint(): string {
  return createHash('sha256')
    .update('umami-login-recovery:key:v1\0')
    .update(secret())
    .digest('hex');
}

function codeSignature(nonce: string): Buffer {
  return createHmac('sha256', secret())
    .update('umami-login-recovery:proof:v1\0')
    .update(nonce)
    .digest()
    .subarray(0, 16);
}

export function digestLoginRecoveryCode(code: string): string | null {
  const normalized = code.toUpperCase();

  if (!CODE_PATTERN.test(normalized)) {
    return null;
  }

  const nonce = normalized.slice(3, 35);
  const providedSignature = Buffer.from(normalized.slice(35), 'hex');
  if (!timingSafeEqual(providedSignature, codeSignature(nonce))) {
    return null;
  }

  return createHash('sha256').update('umami-login-recovery:v1\0').update(normalized).digest('hex');
}

export function generateLoginRecoveryCodes() {
  return Array.from({ length: CODE_COUNT }, () => {
    const nonce = randomBytes(16).toString('hex').toUpperCase();
    const code = `UR-${nonce}${codeSignature(nonce).toString('hex').toUpperCase()}`;
    const digest = digestLoginRecoveryCode(code);

    if (!digest) {
      throw new Error('Generated invalid recovery code');
    }

    return { code, digest };
  });
}

export interface LoginRecoveryMatch {
  userId: string;
  passwordHash: string;
}

export async function lookupLoginRecoveryCode(
  username: string,
  code: string,
): Promise<LoginRecoveryMatch | null> {
  const digest = digestLoginRecoveryCode(code);

  if (!digest) {
    return null;
  }

  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const rows = await client.$queryRaw<Array<LoginRecoveryMatch & { passwordFingerprint: string }>>`
    SELECT credential."user_id" AS "userId",
           owner."password" AS "passwordHash",
           credential."password_fingerprint" AS "passwordFingerprint"
    FROM "login_recovery_credential" AS credential
    JOIN "user" AS owner ON credential."user_id" = owner."user_id"
    WHERE credential."code_digest" = ${digest}
      AND credential."consumed_at" IS NULL
      AND credential."key_fingerprint" = ${getLoginRecoveryKeyFingerprint()}
      AND owner."deleted_at" IS NULL
      AND lower(owner."username") = ${username.trim().toLowerCase()}
    LIMIT 1
  `;

  const match = rows[0];
  return match && match.passwordFingerprint === hash(match.passwordHash)
    ? { userId: match.userId, passwordHash: match.passwordHash }
    : null;
}

export async function consumeLoginRecoveryCode(
  username: string,
  code: string,
  match: LoginRecoveryMatch,
): Promise<string | null> {
  const digest = digestLoginRecoveryCode(code);

  if (!digest) {
    return null;
  }

  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const rows = await client.$queryRaw<Array<{ userId: string }>>`
    UPDATE "login_recovery_credential" AS credential
    SET "consumed_at" = clock_timestamp()
    FROM "user" AS owner
    WHERE credential."code_digest" = ${digest}
      AND credential."consumed_at" IS NULL
      AND credential."key_fingerprint" = ${getLoginRecoveryKeyFingerprint()}
      AND credential."user_id" = owner."user_id"
      AND owner."user_id" = ${match.userId}::uuid
      AND owner."deleted_at" IS NULL
      AND owner."password" = ${match.passwordHash}
      AND credential."password_fingerprint" = ${hash(match.passwordHash)}
      AND lower(owner."username") = ${username.trim().toLowerCase()}
    RETURNING credential."user_id" AS "userId"
  `;

  return rows[0]?.userId ?? null;
}
