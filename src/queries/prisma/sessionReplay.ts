import { PERMISSIONS } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { assertActorCanMutateEntity, runSerializable } from './authorization';

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

export async function getReplayChunks(websiteId: string, visitId: string) {
  return prisma.client.sessionReplay.findMany({
    where: {
      websiteId,
      visitId,
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
  const record = await prisma.client.sessionReplaySaved.findUnique({
    where: { websiteId_visitId: { websiteId, visitId } },
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
) {
  return runSerializable(async transaction => {
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

    const replayExists = await transaction.sessionReplay.findFirst({
      where: {
        websiteId,
        visitId,
      },
      select: {
        id: true,
      },
    });

    if (!replayExists) {
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
      },
      update: {
        name,
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
