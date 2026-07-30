import type { Prisma } from '@/generated/prisma/client';
import { PERMISSIONS } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { assertActorCanMutateEntity, runSerializable } from './authorization';

async function findSegment(criteria: Prisma.SegmentFindUniqueArgs) {
  return prisma.client.segment.findUnique(criteria);
}

export async function getSegment(segmentId: string) {
  if (!isUuid(segmentId)) {
    return null;
  }

  return findSegment({
    where: {
      id: segmentId,
    },
  });
}

export async function getSegments(criteria: Prisma.SegmentFindManyArgs, filters: QueryFilters) {
  const { search } = filters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where: Prisma.SegmentWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [
      {
        name: 'contains',
      },
    ]),
  };

  return pagedQuery('segment', { ...criteria, where }, filters);
}

export async function getWebsiteSegment(websiteId: string, segmentId: string) {
  if (!isUuid(websiteId) || !isUuid(segmentId)) {
    return null;
  }

  return prisma.client.segment.findFirst({
    where: { id: segmentId, websiteId },
  });
}

export async function getWebsiteSegments(websiteId: string, type: string, filters?: QueryFilters) {
  return getSegments(
    {
      where: {
        websiteId,
        type,
      },
    },
    filters,
  );
}

export async function createSegment(data: Prisma.SegmentUncheckedCreateInput, actorUserId: string) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      data.websiteId,
      PERMISSIONS.websiteUpdate,
    );

    return transaction.segment.create({ data });
  });
}

export async function updateSegment(
  websiteId: string,
  segmentId: string,
  data: Prisma.SegmentUpdateInput,
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

    const segment = await transaction.segment.findFirst({
      where: {
        id: segmentId,
        websiteId,
      },
      select: {
        id: true,
      },
    });

    if (!segment) {
      throw new Error('SEGMENT_NOT_FOUND');
    }

    return transaction.segment.update({ where: { id: segmentId }, data });
  });
}

export async function deleteSegment(websiteId: string, segmentId: string, actorUserId: string) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      websiteId,
      PERMISSIONS.websiteDelete,
    );

    const segment = await transaction.segment.findFirst({
      where: {
        id: segmentId,
        websiteId,
      },
      select: {
        id: true,
      },
    });

    if (!segment) {
      throw new Error('SEGMENT_NOT_FOUND');
    }

    return transaction.segment.delete({ where: { id: segmentId } });
  });
}
