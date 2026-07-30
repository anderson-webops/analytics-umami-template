import type { Prisma } from '@/generated/prisma/client';
import { getBoardEntityIds } from '@/lib/boards';
import { ENTITY_TYPE, PERMISSIONS } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { BoardParameters, QueryFilters } from '@/lib/types';
import {
  assertActorCanAccessEntities,
  assertActorCanMutateEntity,
  type OwnedEntityType,
  runSerializable,
} from './authorization';

export async function findShare(criteria: Prisma.ShareFindUniqueArgs) {
  return prisma.client.share.findUnique(criteria);
}

export async function getShare(shareId: string) {
  if (!isUuid(shareId)) {
    return null;
  }

  return findShare({
    where: {
      id: shareId,
    },
  });
}

export async function getShareByCode(slug: string) {
  return findShare({
    where: {
      slug,
    },
  });
}

export async function getShareByEntityId(entityId: string) {
  if (!isUuid(entityId)) {
    return null;
  }

  return prisma.client.share.findFirst({
    where: {
      entityId,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

export async function getSharesByEntityId(entityId: string, filters?: QueryFilters) {
  if (!isUuid(entityId)) {
    return {
      data: [],
      count: 0,
      page: 1,
      pageSize: 0,
    };
  }

  return prisma.pagedQuery(
    'share',
    {
      where: {
        entityId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    },
    filters,
  );
}

function getShareEntityType(shareType: number): OwnedEntityType | null {
  if (shareType === ENTITY_TYPE.website) return 'website';
  if (shareType === ENTITY_TYPE.link) return 'link';
  if (shareType === ENTITY_TYPE.pixel) return 'pixel';
  if (shareType === ENTITY_TYPE.board) return 'board';

  return null;
}

async function assertActorCanManageShareEntity(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  shareType: number,
  entityId: string,
  permission: typeof PERMISSIONS.websiteUpdate | typeof PERMISSIONS.websiteDelete,
) {
  const entityType = getShareEntityType(shareType);

  if (!entityType) {
    throw new Error('SHARE_ENTITY_NOT_FOUND');
  }

  await assertActorCanMutateEntity(transaction, actorUserId, entityType, entityId, permission);

  if (entityType === 'board' && permission === PERMISSIONS.websiteUpdate) {
    const board = await transaction.board.findUnique({
      where: { id: entityId },
      select: {
        type: true,
        parameters: true,
      },
    });

    if (!board) {
      throw new Error('SHARE_ENTITY_NOT_FOUND');
    }

    const { websiteIds, linkIds, pixelIds } = getBoardEntityIds({
      type: board.type,
      parameters: board.parameters as BoardParameters,
    });

    await assertActorCanAccessEntities(
      transaction,
      actorUserId,
      [
        ...websiteIds.map(entityId => ({ entityType: 'website' as const, entityId })),
        ...linkIds.map(entityId => ({ entityType: 'link' as const, entityId })),
        ...pixelIds.map(entityId => ({ entityType: 'pixel' as const, entityId })),
      ],
      PERMISSIONS.websiteUpdate,
    );
  }
}

export async function createShare(
  data: Prisma.ShareCreateInput | Prisma.ShareUncheckedCreateInput,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    const shareType = Number(data.shareType);
    const entityId = String(data.entityId);

    try {
      await assertActorCanManageShareEntity(
        transaction,
        actorUserId,
        shareType,
        entityId,
        PERMISSIONS.websiteUpdate,
      );
    } catch (error: any) {
      if (
        [
          'ENTITY_NOT_FOUND',
          'ENTITY_ACTOR_NOT_AUTHORIZED',
          'ENTITY_REFERENCE_NOT_AUTHORIZED',
        ].includes(error?.message)
      ) {
        throw new Error('SHARE_ACTOR_NOT_AUTHORIZED');
      }

      throw error;
    }

    return transaction.share.create({
      data,
    });
  });
}

export async function updateShare(
  shareId: string,
  data: Prisma.ShareUpdateInput | Prisma.ShareUncheckedUpdateInput,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    const share = await transaction.share.findUnique({
      where: { id: shareId },
      select: {
        entityId: true,
        shareType: true,
      },
    });

    if (!share) {
      throw new Error('SHARE_NOT_FOUND');
    }

    try {
      await assertActorCanManageShareEntity(
        transaction,
        actorUserId,
        share.shareType,
        share.entityId,
        PERMISSIONS.websiteUpdate,
      );
    } catch (error: any) {
      if (
        [
          'ENTITY_NOT_FOUND',
          'ENTITY_ACTOR_NOT_AUTHORIZED',
          'ENTITY_REFERENCE_NOT_AUTHORIZED',
        ].includes(error?.message)
      ) {
        throw new Error('SHARE_ACTOR_NOT_AUTHORIZED');
      }

      throw error;
    }

    return transaction.share.update({
      where: {
        id: shareId,
      },
      data,
    });
  });
}

export async function deleteShare(shareId: string, actorUserId: string) {
  return runSerializable(async transaction => {
    const share = await transaction.share.findUnique({
      where: { id: shareId },
      select: {
        entityId: true,
        shareType: true,
      },
    });

    if (!share) {
      throw new Error('SHARE_NOT_FOUND');
    }

    try {
      await assertActorCanManageShareEntity(
        transaction,
        actorUserId,
        share.shareType,
        share.entityId,
        PERMISSIONS.websiteDelete,
      );
    } catch (error: any) {
      if (['ENTITY_NOT_FOUND', 'ENTITY_ACTOR_NOT_AUTHORIZED'].includes(error?.message)) {
        throw new Error('SHARE_ACTOR_NOT_AUTHORIZED');
      }

      throw error;
    }

    return transaction.share.delete({ where: { id: shareId } });
  });
}

export async function deleteSharesByEntityId(entityId: string) {
  return prisma.client.share.deleteMany({
    where: {
      entityId,
    },
  });
}
