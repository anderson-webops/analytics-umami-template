import clickhouse from '@/lib/clickhouse';
import { PERMISSIONS } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { Auth, QueryFilters } from '@/lib/types';
import {
  assertActorCanMutateEntity,
  assertCurrentActorAuth,
  runSerializable,
} from './authorization';

export interface CreateReplayChunkArgs {
  websiteId: string;
  sessionId: string;
  visitId: string;
  chunkIndex: number;
  events: Uint8Array;
  eventCount: number;
  startedAt: Date;
  endedAt: Date;
}

async function getClickHouseReplayExpiry(websiteId: string, visitId: string) {
  const rows = await clickhouse.rawQuery<
    { chunks: number; legacyChunks: number; expiresAt: string }[]
  >(
    `select count() as chunks,
      countIf(retention_policy = 0) as legacyChunks,
      minIf(ingested_at + INTERVAL 30 DAY, retention_policy = 1) as expiresAt
    from session_replay
    prewhere website_id = {websiteId:UUID}
      and visit_id = {visitId:UUID}
      and (retention_policy = 0 or ingested_at + INTERVAL 30 DAY > now('UTC'))`,
    { websiteId, visitId },
    'getReplayExpiry',
    { maxExecutionTimeSeconds: 3, maxResultRows: 1 },
  );
  const row = rows[0];

  if (!row || !Number.isSafeInteger(Number(row.chunks)) || Number(row.chunks) < 1) {
    return undefined;
  }

  if (!Number.isSafeInteger(Number(row.legacyChunks))) {
    throw new Error('Invalid replay retention metadata.');
  }

  if (Number(row.legacyChunks) > 0) {
    return null;
  }

  const expiresAt = new Date(row.expiresAt);

  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new Error('Invalid replay retention metadata.');
  }

  return expiresAt;
}

export async function getReplayChunks(websiteId: string, visitId: string) {
  return prisma.client.sessionReplay.findMany({
    where: {
      websiteId,
      visitId,
      OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: new Date() } }],
    },
    orderBy: {
      chunkIndex: 'asc',
    },
    select: {
      events: true,
      sessionId: true,
      chunkIndex: true,
      eventCount: true,
      startedAt: true,
      endedAt: true,
    },
  });
}

export async function createReplayChunk({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
  eventCount,
  startedAt,
  endedAt,
}: CreateReplayChunkArgs) {
  return prisma.client.sessionReplay.create({
    data: {
      id: uuid(),
      websiteId,
      sessionId,
      visitId,
      chunkIndex,
      events: new Uint8Array(events) as any,
      eventCount,
      startedAt,
      endedAt,
    },
  });
}

export async function deleteReplaysByWebsite(websiteId: string) {
  return prisma.client.sessionReplay.deleteMany({
    where: { websiteId },
  });
}

export async function getReplaySaved(websiteId: string, visitId: string): Promise<boolean> {
  const record = await prisma.client.sessionReplaySaved.findFirst({
    where: {
      websiteId,
      visitId,
      OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  return record !== null;
}

export async function setReplaySavedByActor(
  websiteId: string,
  visitId: string,
  isSaved: boolean,
  name: string,
  actorUserId: string,
  auth: Auth,
) {
  return runSerializable(async transaction => {
    await assertCurrentActorAuth(transaction, actorUserId, auth);
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      websiteId,
      PERMISSIONS.websiteUpdate,
    );

    if (!isSaved) {
      await transaction.sessionReplaySaved.deleteMany({
        where: { websiteId, visitId },
      });

      return false;
    }

    const retentionExpiresAt = clickhouse.enabled
      ? await getClickHouseReplayExpiry(websiteId, visitId)
      : (
          await transaction.sessionReplay.findFirst({
            where: {
              websiteId,
              visitId,
              OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: new Date() } }],
            },
            select: { retentionExpiresAt: true },
            orderBy: { retentionExpiresAt: { sort: 'asc', nulls: 'first' } },
          })
        )?.retentionExpiresAt;

    if (retentionExpiresAt === undefined) {
      throw new Error('REPLAY_NOT_FOUND');
    }

    await transaction.sessionReplaySaved.upsert({
      where: {
        websiteId_visitId: {
          websiteId,
          visitId,
        },
      },
      create: {
        id: uuid(),
        websiteId,
        visitId,
        name,
        retentionExpiresAt,
      },
      update: {
        name,
        retentionExpiresAt,
      },
    });

    return true;
  });
}

export async function getSavedReplays(websiteId: string, filters: QueryFilters) {
  const { search } = filters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where = {
    websiteId,
    OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: new Date() } }],
    ...getSearchParameters(search, [{ name: 'contains' }]),
  };

  return pagedQuery(
    'sessionReplaySaved',
    {
      where,
      orderBy: { createdAt: 'desc' },
    },
    filters,
  );
}
