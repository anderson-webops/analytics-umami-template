import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';

export type CollectionSourceType = 'website' | 'link' | 'pixel';

async function acquireCollectionLock(
  transaction: Prisma.TransactionClient,
  sourceId: string,
  mode: 'shared' | 'exclusive',
) {
  if (mode === 'shared') {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${sourceId}))::text`;
  } else {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))::text`;
  }
}

export async function lockCollectionSources(
  transaction: Prisma.TransactionClient,
  sourceIds: string[],
) {
  const uniqueIds = [...new Set(sourceIds)].sort();

  for (const sourceId of uniqueIds) {
    await acquireCollectionLock(transaction, sourceId, 'exclusive');
  }
}

async function sourceIsActive(
  transaction: Prisma.TransactionClient,
  sourceType: CollectionSourceType,
  sourceId: string,
) {
  switch (sourceType) {
    case 'website':
      return transaction.website.findFirst({
        where: { id: sourceId, deletedAt: null },
        select: { id: true },
      });
    case 'link':
      return transaction.link.findFirst({
        where: { id: sourceId, deletedAt: null },
        select: { id: true },
      });
    case 'pixel':
      return transaction.pixel.findFirst({
        where: { id: sourceId, deletedAt: null },
        select: { id: true },
      });
  }
}

export async function withActiveCollectionSource<T>(
  sourceType: CollectionSourceType,
  sourceId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.transaction(
    async transaction => {
      await acquireCollectionLock(transaction, sourceId, 'shared');

      if (!(await sourceIsActive(transaction, sourceType, sourceId))) {
        throw new Error('COLLECTION_SOURCE_NOT_FOUND');
      }

      return operation(transaction);
    },
    {
      timeout: 30_000,
    },
  );
}
