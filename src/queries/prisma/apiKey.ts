import { API_KEY_PAGE_SIZE, MAX_API_KEYS_PER_USER } from '@/lib/api-key-limits';
import prisma from '@/lib/prisma';
import { consumeOtp } from '@/lib/two-factor/replay-prevention';

export class ApiKeyCodeUsedError extends Error {}
export class ApiKeyLimitReachedError extends Error {}

interface ApiKeyFactorProof {
  id: string;
  secret: string;
  token: string;
}

export async function createApiKey(
  data: {
    id: string;
    userId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
  },
  expectedSessionGeneration: number,
  expectedPasswordHash: string,
  factor: ApiKeyFactorProof | null = null,
) {
  return prisma.transaction(async transaction => {
    const rows = await transaction.$queryRaw<Array<{ sessionGeneration: number }>>`
      SELECT "session_generation" AS "sessionGeneration"
      FROM "user"
      WHERE "user_id" = ${data.userId}::uuid
        AND "deleted_at" IS NULL
        AND "password" = ${expectedPasswordHash}
      FOR UPDATE
    `;

    if (rows[0]?.sessionGeneration !== expectedSessionGeneration) {
      return null;
    }

    const keyCount = await transaction.apiKey.count({ where: { userId: data.userId } });

    if (keyCount >= MAX_API_KEYS_PER_USER) {
      throw new ApiKeyLimitReachedError();
    }

    const currentFactor = await transaction.twoFactorAuth.findUnique({
      where: { userId: data.userId },
      select: { id: true, secret: true, isEnabled: true },
    });

    if (currentFactor?.isEnabled) {
      if (!factor || currentFactor.id !== factor.id || currentFactor.secret !== factor.secret) {
        return null;
      }

      if (!(await consumeOtp(data.userId, factor.token, transaction))) {
        throw new ApiKeyCodeUsedError();
      }

      await transaction.twoFactorRateLimit.deleteMany({ where: { userId: data.userId } });
    } else if (factor) {
      return null;
    }

    return transaction.apiKey.create({
      data,
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        createdAt: true,
        expiresAt: true,
      },
    });
  });
}

export async function getApiKeyByHash(keyHash: string) {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;

  return client.apiKey.findFirst({
    where: { keyHash, expiresAt: { gt: new Date() } },
  });
}

export async function getUserApiKeys(userId: string, cursor?: string) {
  if (cursor) {
    const anchor = await prisma.client.apiKey.findFirst({
      where: { id: cursor, userId },
      select: { id: true },
    });

    if (!anchor) {
      return null;
    }
  }

  return prisma.client.apiKey.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: API_KEY_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export async function deleteApiKey(id: string, userId: string) {
  const { count } = await prisma.client.apiKey.deleteMany({
    where: { id, userId },
  });

  return count;
}

export async function updateApiKeyLastUsed(id: string) {
  return prisma.client.apiKey.update({
    where: { id },
    data: { lastUsedAt: new Date() },
  });
}
