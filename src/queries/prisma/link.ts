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

const LINK_SORT_FIELDS = ['name', 'slug', 'url', 'createdAt'] as const;

export async function findLink(criteria: Prisma.LinkFindUniqueArgs) {
  return prisma.client.link.findUnique(criteria);
}

export async function getLink(linkId: string) {
  if (!isUuid(linkId)) {
    return null;
  }

  return findLink({
    where: {
      id: linkId,
      deletedAt: null,
    },
  });
}

export async function getLinks(criteria: Prisma.LinkFindManyArgs, filters: QueryFilters = {}) {
  const sortFilters = sanitizeSortFilters(filters, LINK_SORT_FIELDS);
  const { search } = sortFilters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where: Prisma.LinkWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [
      { name: 'contains' },
      { url: 'contains' },
      { slug: 'contains' },
    ]),
  };

  return pagedQuery('link', { ...criteria, where }, sortFilters);
}

export async function getUserLinks(userId: string, filters?: QueryFilters) {
  return getLinks(
    {
      where: {
        userId,
        deletedAt: null,
      },
    },
    filters,
  );
}

export async function getTeamLinks(teamId: string, filters?: QueryFilters) {
  return getLinks(
    {
      where: {
        teamId,
        deletedAt: null,
      },
    },
    filters,
  );
}

export async function createLink(
  data: Prisma.LinkUncheckedCreateInput,
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

    return transaction.link.create({ data });
  });
}

export async function updateLink(
  linkId: string,
  data: Prisma.LinkUncheckedUpdateInput,
  actorUserId: string,
) {
  const { link, previousSlug } = await runSerializable(async transaction => {
    await lockCollectionSources(transaction, [linkId]);

    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'link',
      linkId,
      PERMISSIONS.websiteUpdate,
    );

    const previous = await transaction.link.findUnique({
      where: { id: linkId },
      select: { slug: true },
    });
    const link = await transaction.link.update({ where: { id: linkId }, data });

    return {
      link,
      previousSlug: previous?.slug,
    };
  });

  if (redis.enabled) {
    await Promise.all([
      ...(previousSlug ? [redis.client.del(`link:${previousSlug}`)] : []),
      redis.client.del(`link:${link.slug}`),
    ]);
  }

  return link;
}

export async function deleteLink(linkId: string, actorUserId: string) {
  const result = await runSerializable(
    async transaction => {
      await lockCollectionSources(transaction, [linkId]);

      await assertActorCanMutateEntity(
        transaction,
        actorUserId,
        'link',
        linkId,
        PERMISSIONS.websiteDelete,
      );

      await deleteClickhouseCollectionSources([linkId]);

      const link = await transaction.link.findUnique({
        where: { id: linkId },
        select: { slug: true },
      });

      await transaction.revenue.deleteMany({ where: { websiteId: linkId } });
      await transaction.eventData.deleteMany({ where: { websiteId: linkId } });
      await transaction.sessionData.deleteMany({ where: { websiteId: linkId } });
      await transaction.websiteEvent.deleteMany({ where: { websiteId: linkId } });
      await transaction.session.deleteMany({ where: { websiteId: linkId } });
      await transaction.share.deleteMany({
        where: {
          entityId: linkId,
          shareType: ENTITY_TYPE.link,
        },
      });
      await transaction.link.delete({ where: { id: linkId } });

      return { slug: link?.slug };
    },
    {
      timeout: 300_000,
    },
  );

  if (redis.enabled && result.slug) {
    await redis.client.del(`link:${result.slug}`);
  }

  return result;
}
