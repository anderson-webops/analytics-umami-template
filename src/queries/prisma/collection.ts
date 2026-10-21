import { createHash } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import {
  type CollectionAdmissionClass,
  getCollectionCost,
  reserveCollectionBudget,
} from '@/lib/collection-budget';
import { getCollectionClientKeys } from '@/lib/collection-client-key';
import {
  type BackendCollectionRequest,
  CollectionRequestReplayError,
  matchesCollectionOwner,
} from '@/lib/collection-proof';
import { reserveCollectionSourceLimit } from '@/lib/collection-rate-limit';
import prisma from '@/lib/prisma';

export type CollectionSourceType = 'website' | 'link' | 'pixel';

export type ReservedCollectionSource = {
  sourceType: CollectionSourceType;
  sourceId: string;
  accountType: 'user' | 'team';
  accountId: string;
  collectionGeneration: number | null;
};

export async function reserveBackendCollectionRequest(
  transaction: Prisma.TransactionClient,
  websiteId: string,
  { requestId }: BackendCollectionRequest,
) {
  const requestKey = `nonce:${createHash('sha256')
    .update(`backend-collection-v1\0${websiteId}\0${requestId}`)
    .digest('hex')
    .slice(0, 58)}`;
  const rows = await transaction.$queryRaw<Array<{ requests: bigint }>>`
    INSERT INTO collection_ingest_budget
      (subject_type, subject_key, scope, window_start, bytes, rows, requests, expires_at)
    VALUES
      ('source', ${requestKey}, 'day', to_timestamp(0), 0, 0, 1,
       transaction_timestamp() + interval '15 minutes')
    ON CONFLICT (subject_type, subject_key, scope, window_start) DO NOTHING
    RETURNING requests
  `;

  if (rows.length !== 1) {
    throw new CollectionRequestReplayError();
  }

  await transaction.$executeRaw`
    DELETE FROM collection_ingest_budget
    WHERE ctid IN (
      SELECT ctid
      FROM collection_ingest_budget
      WHERE expires_at < transaction_timestamp()
      ORDER BY expires_at
      LIMIT 64
    )
  `;
}

async function acquireCollectionLock(
  transaction: Prisma.TransactionClient,
  sourceId: string,
  mode: 'shared' | 'exclusive',
) {
  const normalizedSourceId = sourceId.toLowerCase();

  if (mode === 'shared') {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${normalizedSourceId}))::text`;
  } else {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${normalizedSourceId}))::text`;
  }
}

export async function lockCollectionSources(
  transaction: Prisma.TransactionClient,
  sourceIds: string[],
) {
  const uniqueIds = [...new Set(sourceIds.map(sourceId => sourceId.toLowerCase()))].sort();

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
        select: { id: true, userId: true, teamId: true, collectionGeneration: true },
      });
    case 'link':
      return transaction.link.findFirst({
        where: { id: sourceId, deletedAt: null },
        select: { id: true, userId: true, teamId: true },
      });
    case 'pixel':
      return transaction.pixel.findFirst({
        where: { id: sourceId, deletedAt: null },
        select: { id: true, userId: true, teamId: true },
      });
  }
}

function getSourceGeneration(source: NonNullable<Awaited<ReturnType<typeof sourceIsActive>>>) {
  return 'collectionGeneration' in source && typeof source.collectionGeneration === 'number'
    ? source.collectionGeneration
    : null;
}

export async function reserveActiveCollectionBudget(
  sourceType: CollectionSourceType,
  sourceId: string,
  body: {
    type: 'event' | 'identify' | 'performance';
    payload: { data?: Record<string, unknown>; id?: string };
  },
  clientIp: string,
  admissionClass: CollectionAdmissionClass = 'anonymous',
  backendRequest?: BackendCollectionRequest,
  deferBackendRequestReservation = false,
) {
  if (admissionClass === 'backend' && (sourceType !== 'website' || !backendRequest)) {
    throw new Error('Backend collection requires a website source.');
  }

  const cost = getCollectionCost(body);

  return prisma.transaction(
    async transaction => {
      await acquireCollectionLock(transaction, sourceId, 'shared');
      const source = await sourceIsActive(transaction, sourceType, sourceId);

      if (!source) {
        throw new Error('COLLECTION_SOURCE_NOT_FOUND');
      }

      if (backendRequest) {
        const generation = 'collectionGeneration' in source ? source.collectionGeneration : null;

        if (
          typeof generation !== 'number' ||
          !matchesCollectionOwner(backendRequest, {
            userId: source.userId,
            teamId: source.teamId,
            collectionGeneration: generation,
          })
        ) {
          throw new Error('COLLECTION_KEY_OWNER_CHANGED');
        }
      }

      if (backendRequest && !deferBackendRequestReservation) {
        if (admissionClass !== 'backend') {
          throw new Error('Backend request proof requires backend admission.');
        }

        await reserveBackendCollectionRequest(transaction, sourceId, backendRequest);
      }

      const accountType = source.teamId ? 'team' : 'user';
      const accountId = source.teamId || source.userId;

      if (!accountId) {
        throw new Error('COLLECTION_SOURCE_OWNER_MISSING');
      }

      await reserveCollectionBudget(
        transaction,
        {
          sourceType,
          sourceId,
          accountType,
          accountId,
          ...getCollectionClientKeys(
            sourceType,
            sourceId,
            accountType,
            accountId,
            clientIp,
            admissionClass,
          ),
        },
        cost,
        admissionClass,
      );
      await reserveCollectionSourceLimit(transaction, sourceId, admissionClass);
      return {
        sourceType,
        sourceId: sourceId.toLowerCase(),
        accountType,
        accountId,
        collectionGeneration: getSourceGeneration(source),
      } satisfies ReservedCollectionSource;
    },
    { timeout: 30_000 },
  );
}

export async function withActiveCollectionSource<T>(
  sourceType: CollectionSourceType,
  sourceId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  backendRequest?: BackendCollectionRequest,
  reservedSource?: ReservedCollectionSource,
) {
  return prisma.transaction(
    async transaction => {
      await acquireCollectionLock(transaction, sourceId, 'shared');

      const source = await sourceIsActive(transaction, sourceType, sourceId);

      if (!source) {
        throw new Error('COLLECTION_SOURCE_NOT_FOUND');
      }

      if (
        reservedSource &&
        (reservedSource.sourceType !== sourceType ||
          reservedSource.sourceId !== sourceId.toLowerCase() ||
          reservedSource.accountType !== (source.teamId ? 'team' : 'user') ||
          reservedSource.accountId !== (source.teamId || source.userId) ||
          reservedSource.collectionGeneration !== getSourceGeneration(source))
      ) {
        throw new Error('COLLECTION_SOURCE_CHANGED');
      }

      if (backendRequest) {
        const generation = 'collectionGeneration' in source ? source.collectionGeneration : null;

        if (
          typeof generation !== 'number' ||
          !matchesCollectionOwner(backendRequest, {
            userId: source.userId,
            teamId: source.teamId,
            collectionGeneration: generation,
          })
        ) {
          throw new Error('COLLECTION_KEY_OWNER_CHANGED');
        }
      }

      return operation(transaction);
    },
    {
      timeout: 30_000,
    },
  );
}
