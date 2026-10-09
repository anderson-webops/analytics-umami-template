import prisma from '@/lib/prisma';

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

    return transaction.apiKey.create({
      data,
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        createdAt: true,
      },
    });
  });
}

export async function getApiKeyByHash(keyHash: string) {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;

  return client.apiKey.findUnique({
    where: { keyHash },
  });
}

export async function getUserApiKeys(userId: string) {
  return prisma.client.apiKey.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
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
