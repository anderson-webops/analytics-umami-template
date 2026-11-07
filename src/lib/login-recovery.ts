import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { hash, secret } from '@/lib/crypto';
import prisma from '@/lib/prisma';

const CODE_COUNT = 8;
const CODE_PATTERN = /^UR-[0-9A-F]{64}$/;
const PREPARATION_TTL_MS = 15 * 60 * 1000;

export function getLoginRecoveryPreparationKeys(userId: string) {
  const ownerId = userId.toLowerCase();
  return {
    pending: `login-recovery:pending:${ownerId}`,
    confirmed: `login-recovery:confirmed:${ownerId}`,
  };
}

export class RecoveryPreparationError extends Error {}

interface RecoveryPreparation {
  version: 1;
  userId: string;
  batchId: string;
  passwordFingerprint: string;
  keyFingerprint: string;
  digests: string[];
  consumedDigests: string[];
  expiresAt: number;
}

function readPreparation(value: string): RecoveryPreparation {
  try {
    const data = JSON.parse(value);
    if (
      data?.version === 1 &&
      typeof data.userId === 'string' &&
      typeof data.batchId === 'string' &&
      typeof data.passwordFingerprint === 'string' &&
      typeof data.keyFingerprint === 'string' &&
      Number.isSafeInteger(data.expiresAt) &&
      Array.isArray(data.digests) &&
      data.digests.length === CODE_COUNT &&
      new Set(data.digests).size === CODE_COUNT &&
      Array.isArray(data.consumedDigests) &&
      data.consumedDigests.length <= CODE_COUNT &&
      new Set(data.consumedDigests).size === data.consumedDigests.length &&
      data.consumedDigests.every((digest: unknown) => data.digests.includes(digest)) &&
      data.digests.every(
        (digest: unknown) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest),
      )
    ) {
      return data;
    }
  } catch {}
  throw new RecoveryPreparationError();
}

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

export class RecoveryTargetNotFoundError extends Error {}

export async function prepareLoginRecoveryCodes(
  transaction: Prisma.TransactionClient,
  userIdInput: string,
  credentials: ReturnType<typeof generateLoginRecoveryCodes>,
) {
  const userId = userIdInput.toLowerCase();
  const target = await transaction.user.findUnique({
    where: { id: userId, deletedAt: null },
    select: { password: true },
  });
  if (!target) throw new RecoveryTargetNotFoundError();

  const preparation: RecoveryPreparation = {
    version: 1,
    userId,
    batchId: randomUUID(),
    passwordFingerprint: hash(target.password),
    keyFingerprint: getLoginRecoveryKeyFingerprint(),
    digests: credentials.map(({ digest }) => digest),
    consumedDigests: [],
    expiresAt: Date.now() + PREPARATION_TTL_MS,
  };
  readPreparation(JSON.stringify(preparation));
  const key = getLoginRecoveryPreparationKeys(userId).pending;
  const value = JSON.stringify(preparation);
  await transaction.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

async function persistLoginRecoveryConfirmation(
  transaction: Prisma.TransactionClient,
  userId: string,
  confirmation: {
    batchId: string;
    passwordFingerprint: string;
    keyFingerprint: string;
    proofDigest: string;
  },
) {
  const key = getLoginRecoveryPreparationKeys(userId).confirmed;
  const value = JSON.stringify({
    version: 1,
    userId,
    ...confirmation,
    confirmedAt: new Date().toISOString(),
  });
  await transaction.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function confirmPreparedLoginRecoveryCodes(
  transaction: Prisma.TransactionClient,
  userIdInput: string,
  code: string,
  options: { requirePending?: boolean } = {},
) {
  const userId = userIdInput.toLowerCase();
  const digest = digestLoginRecoveryCode(code);
  if (!digest) throw new RecoveryPreparationError();

  const target = await transaction.user.findUnique({
    where: { id: userId, deletedAt: null },
    select: { password: true },
  });
  if (!target) throw new RecoveryTargetNotFoundError();
  const passwordFingerprint = hash(target.password);
  const keyFingerprint = getLoginRecoveryKeyFingerprint();
  const keys = getLoginRecoveryPreparationKeys(userId);
  const pendingRows = await transaction.$queryRaw<Array<{ value: string }>>`
    SELECT "value" FROM "app_setting" WHERE "key" = ${keys.pending} FOR UPDATE
  `;
  const pending = pendingRows[0];
  if (!pending) {
    if (options.requirePending) throw new RecoveryPreparationError();
    const confirmed = await transaction.appSetting.findUnique({ where: { key: keys.confirmed } });
    const active = await transaction.$queryRaw<Array<{ codeDigest: string }>>`
      SELECT "code_digest" AS "codeDigest" FROM "login_recovery_credential"
      WHERE "user_id" = ${userId}::uuid
        AND "password_fingerprint" = ${passwordFingerprint}
        AND "key_fingerprint" = ${keyFingerprint}
        AND "consumed_at" IS NULL
      ORDER BY "code_digest"
      FOR UPDATE
    `;
    let receipt;
    try {
      receipt = JSON.parse(confirmed?.value ?? 'null');
    } catch {}
    if (
      receipt?.version === 1 &&
      receipt.userId === userId &&
      receipt.passwordFingerprint === passwordFingerprint &&
      receipt.keyFingerprint === keyFingerprint &&
      receipt.proofDigest === digest &&
      active.length > 0
    ) {
      return;
    }
    if (confirmed || active.length < 2 || !active.some(row => row.codeDigest === digest)) {
      throw new RecoveryPreparationError();
    }
    const consumed = await transaction.loginRecoveryCredential.updateMany({
      where: {
        userId,
        codeDigest: digest,
        passwordFingerprint,
        keyFingerprint,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new RecoveryPreparationError();
    await persistLoginRecoveryConfirmation(transaction, userId, {
      batchId: randomUUID(),
      passwordFingerprint,
      keyFingerprint,
      proofDigest: digest,
    });
    return;
  }

  const preparation = readPreparation(pending.value);
  if (
    preparation.userId !== userId ||
    preparation.passwordFingerprint !== passwordFingerprint ||
    preparation.keyFingerprint !== keyFingerprint ||
    preparation.expiresAt <= Date.now() ||
    !preparation.digests.includes(digest) ||
    preparation.consumedDigests.includes(digest)
  ) {
    throw new RecoveryPreparationError();
  }

  const remaining = preparation.digests.filter(
    value => value !== digest && !preparation.consumedDigests.includes(value),
  );
  if (remaining.length === 0) throw new RecoveryPreparationError();
  await persistLoginRecoveryCodes(
    transaction,
    userId,
    remaining.map(value => ({ digest: value })),
  );
  await persistLoginRecoveryConfirmation(transaction, userId, {
    batchId: preparation.batchId,
    passwordFingerprint,
    keyFingerprint,
    proofDigest: digest,
  });
}

export async function rebindLoginRecoveryPreparation(
  transaction: Prisma.TransactionClient,
  userId: string,
  expectedPassword: string,
  nextPassword: string,
) {
  const keys = getLoginRecoveryPreparationKeys(userId);
  await transaction.$executeRaw`
    UPDATE "app_setting"
    SET "value" = jsonb_set("value"::jsonb, '{passwordFingerprint}',
      to_jsonb(${hash(nextPassword)}::text))::text
    WHERE "key" IN (${keys.pending}, ${keys.confirmed})
      AND "value"::jsonb->>'passwordFingerprint' = ${hash(expectedPassword)}
  `;
}

export async function persistLoginRecoveryCodes(
  transaction: Prisma.TransactionClient,
  userIdInput: string,
  credentials: ReadonlyArray<{ digest: string }>,
) {
  const userId = userIdInput.toLowerCase();
  const target = await transaction.user.findUnique({
    where: { id: userId, deletedAt: null },
    select: { password: true },
  });
  if (!target) {
    throw new RecoveryTargetNotFoundError();
  }

  const keys = getLoginRecoveryPreparationKeys(userId);
  await transaction.appSetting.deleteMany({
    where: { key: { in: [keys.pending, keys.confirmed] } },
  });
  await transaction.loginRecoveryCredential.deleteMany({ where: { userId } });
  await transaction.loginRecoveryCredential.createMany({
    data: credentials.map(({ digest }) => ({
      userId,
      codeDigest: digest,
      passwordFingerprint: hash(target.password),
      keyFingerprint: getLoginRecoveryKeyFingerprint(),
    })),
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
    UNION ALL
    SELECT owner."user_id" AS "userId",
           owner."password" AS "passwordHash",
           pending."value"::jsonb->>'passwordFingerprint' AS "passwordFingerprint"
    FROM "user" AS owner
    JOIN "app_setting" AS pending
      ON pending."key" = 'login-recovery:pending:' || owner."user_id"::text
    WHERE owner."deleted_at" IS NULL
      AND lower(owner."username") = ${username.trim().toLowerCase()}
      AND pending."value"::jsonb->>'userId' = owner."user_id"::text
      AND pending."value"::jsonb->>'keyFingerprint' = ${getLoginRecoveryKeyFingerprint()}
      AND (pending."value"::jsonb->>'expiresAt')::numeric > EXTRACT(EPOCH FROM clock_timestamp()) * 1000
      AND (pending."value"::jsonb->'digests') @> jsonb_build_array(${digest}::text)
      AND NOT (pending."value"::jsonb->'consumedDigests') @> jsonb_build_array(${digest}::text)
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
    WITH active AS (
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
    ), pending AS (
      UPDATE "app_setting" AS preparation
      SET "value" = jsonb_set(preparation."value"::jsonb, '{consumedDigests}',
        (preparation."value"::jsonb->'consumedDigests') || jsonb_build_array(${digest}::text))::text
      FROM "user" AS owner
      WHERE preparation."key" = ${getLoginRecoveryPreparationKeys(match.userId).pending}
        AND owner."user_id" = ${match.userId}::uuid
        AND owner."deleted_at" IS NULL
        AND lower(owner."username") = ${username.trim().toLowerCase()}
        AND owner."password" = ${match.passwordHash}
        AND preparation."value"::jsonb->>'userId' = owner."user_id"::text
        AND preparation."value"::jsonb->>'passwordFingerprint' = ${hash(match.passwordHash)}
        AND preparation."value"::jsonb->>'keyFingerprint' = ${getLoginRecoveryKeyFingerprint()}
        AND (preparation."value"::jsonb->>'expiresAt')::numeric > EXTRACT(EPOCH FROM clock_timestamp()) * 1000
        AND (preparation."value"::jsonb->'digests') @> jsonb_build_array(${digest}::text)
        AND NOT (preparation."value"::jsonb->'consumedDigests') @> jsonb_build_array(${digest}::text)
        AND NOT EXISTS (SELECT 1 FROM active)
      RETURNING owner."user_id" AS "userId"
    )
    SELECT "userId" FROM active UNION ALL SELECT "userId" FROM pending
  `;

  return rows[0]?.userId ?? null;
}
