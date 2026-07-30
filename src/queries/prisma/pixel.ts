import type { Prisma } from '@/generated/prisma/client';
import { ENTITY_TYPE, PERMISSIONS } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { sanitizeSortFilters } from '@/lib/sort';
import type { QueryFilters } from '@/lib/types';
import { deleteClickhouseCollectionSources } from '@/queries/sql/deleteCollectionSources';
import {
  assertActorCanCreateOwnedEntity,
  assertActorCanMutateEntity,
  assertActorIsAdministrator,
  assertEntityIdAvailable,
  runSerializable,
} from './authorization';
import { lockCollectionSources } from './collection';

const PIXEL_SORT_FIELDS = ['name', 'slug', 'createdAt'] as const;

export async function findPixel(criteria: Prisma.PixelFindUniqueArgs) {
  return prisma.client.pixel.findUnique(criteria);
}

export async function getPixel(pixelId: string) {
  if (!isUuid(pixelId)) {
    return null;
  }

  return findPixel({
    where: {
      id: pixelId,
      deletedAt: null,
    },
  });
}

export async function getPixels(criteria: Prisma.PixelFindManyArgs, filters: QueryFilters = {}) {
  const sortFilters = sanitizeSortFilters(filters, PIXEL_SORT_FIELDS);
  const { search } = sortFilters;

  const where: Prisma.PixelWhereInput = {
    ...criteria.where,
    ...prisma.getSearchParameters(search, [{ name: 'contains' }, { slug: 'contains' }]),
  };

  return prisma.pagedQuery('pixel', { ...criteria, where }, sortFilters);
}

export async function getUserPixels(userId: string, filters?: QueryFilters) {
  return getPixels(
    {
      where: {
        userId,
        deletedAt: null,
      },
    },
    filters,
  );
}

export async function getTeamPixels(teamId: string, filters?: QueryFilters) {
  return getPixels(
    {
      where: {
        teamId,
        deletedAt: null,
      },
    },
    filters,
  );
}

export async function createPixel(
  data: Prisma.PixelUncheckedCreateInput,
  actorUserId: string,
  options: { customEntityId?: boolean } = {},
) {
  return runSerializable(async transaction => {
    if (options.customEntityId) {
      await assertActorIsAdministrator(transaction, actorUserId);
    }

    if (data.teamId) {
      await assertActorCanCreateOwnedEntity(transaction, actorUserId, {
        teamId: data.teamId,
      });
    } else if (data.userId) {
      await assertActorCanCreateOwnedEntity(transaction, actorUserId, {
        userId: data.userId,
      });
    } else {
      throw new Error('ENTITY_OWNER_NOT_FOUND');
    }

    await assertEntityIdAvailable(transaction, data.id);

    return transaction.pixel.create({ data });
  });
}

export async function updatePixel(
  pixelId: string,
  data: Prisma.PixelUncheckedUpdateInput,
  actorUserId: string,
) {
  const { pixel, previousSlug } = await runSerializable(async transaction => {
    await lockCollectionSources(transaction, [pixelId]);

    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'pixel',
      pixelId,
      PERMISSIONS.websiteUpdate,
    );

    const previous = await transaction.pixel.findUnique({
      where: { id: pixelId },
      select: { slug: true },
    });
    const pixel = await transaction.pixel.update({ where: { id: pixelId }, data });

    return {
      pixel,
      previousSlug: previous?.slug,
    };
  });

  if (redis.enabled) {
    await Promise.all([
      ...(previousSlug ? [redis.client.del(`pixel:${previousSlug}`)] : []),
      redis.client.del(`pixel:${pixel.slug}`),
    ]);
  }

  return pixel;
}

export async function deletePixel(pixelId: string, actorUserId: string) {
  const result = await runSerializable(
    async transaction => {
      await lockCollectionSources(transaction, [pixelId]);

      await assertActorCanMutateEntity(
        transaction,
        actorUserId,
        'pixel',
        pixelId,
        PERMISSIONS.websiteDelete,
      );

      await deleteClickhouseCollectionSources([pixelId]);

      const pixel = await transaction.pixel.findUnique({
        where: { id: pixelId },
        select: { slug: true },
      });

      await transaction.revenue.deleteMany({ where: { websiteId: pixelId } });
      await transaction.eventData.deleteMany({ where: { websiteId: pixelId } });
      await transaction.sessionData.deleteMany({ where: { websiteId: pixelId } });
      await transaction.websiteEvent.deleteMany({ where: { websiteId: pixelId } });
      await transaction.session.deleteMany({ where: { websiteId: pixelId } });
      await transaction.share.deleteMany({
        where: {
          entityId: pixelId,
          shareType: ENTITY_TYPE.pixel,
        },
      });
      await transaction.pixel.delete({ where: { id: pixelId } });

      return { slug: pixel?.slug };
    },
    {
      timeout: 300_000,
    },
  );

  if (redis.enabled && result.slug) {
    await redis.client.del(`pixel:${result.slug}`);
  }

  return result;
}
