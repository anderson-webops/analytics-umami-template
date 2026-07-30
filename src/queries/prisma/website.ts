import type { Prisma, Website } from '@/generated/prisma/client';
import { ENTITY_TYPE, PERMISSIONS, ROLES, TEAM_ROLE_RANK } from '@/lib/constants';
import { isUuid, uuid } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import prisma from '@/lib/prisma';
import { getRecorderConfig, getRecorderEnabled } from '@/lib/recorder';
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

const WEBSITE_SORT_FIELDS = ['name', 'domain', 'createdAt'] as const;

export async function findWebsite(criteria: Prisma.WebsiteFindUniqueArgs) {
  return prisma.client.website.findUnique(criteria);
}

export async function getWebsite(websiteId: string) {
  if (!isUuid(websiteId)) {
    return null;
  }

  const website = await findWebsite({
    where: {
      id: websiteId,
      deletedAt: null,
    },
  });

  if (!website) {
    return null;
  }

  return attachShareIdToWebsite(website);
}

export async function getWebsites(criteria: Prisma.WebsiteFindManyArgs, filters: QueryFilters) {
  const sortFilters = sanitizeSortFilters(filters, WEBSITE_SORT_FIELDS);
  const { search } = sortFilters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where: Prisma.WebsiteWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [
      {
        name: 'contains',
      },
      { domain: 'contains' },
    ]),
    deletedAt: null,
  };

  const websites = await pagedQuery('website', { ...criteria, where }, sortFilters);

  return attachShareIdToWebsites(websites);
}

export async function getAllUserWebsitesIncludingTeamAccess(
  userId: string,
  filters?: QueryFilters,
) {
  return getWebsites(
    {
      where: {
        OR: [
          { userId },
          {
            team: {
              deletedAt: null,
              members: {
                some: {
                  role: { in: [ROLES.teamOwner, ROLES.teamManager] },
                  userId,
                },
              },
            },
          },
        ],
      },
    },
    sanitizeSortFilters(filters, WEBSITE_SORT_FIELDS, { orderBy: 'name' }),
  );
}

export async function getUserWebsites(userId: string, filters?: QueryFilters) {
  return getWebsites(
    {
      where: {
        userId,
      },
      include: {
        user: {
          select: {
            username: true,
            id: true,
          },
        },
      },
    },
    sanitizeSortFilters(filters, WEBSITE_SORT_FIELDS, { orderBy: 'name' }),
  );
}

export async function getTeamWebsites(teamId: string, filters?: QueryFilters) {
  return getWebsites(
    {
      where: {
        teamId,
      },
      include: {
        createUser: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    },
    filters,
  );
}

export async function createWebsite(
  data: Prisma.WebsiteUncheckedCreateInput,
  actorUserId: string,
  options: {
    initialShare?: {
      slug: string;
      name: string;
      parameters: Prisma.InputJsonValue;
    };
    activeOwnerWebsiteLimit?: number;
    customEntityId?: boolean;
  } = {},
) {
  const { initialShare, activeOwnerWebsiteLimit, customEntityId = false } = options;

  return runSerializable(async transaction => {
    if (
      activeOwnerWebsiteLimit !== undefined &&
      (!Number.isInteger(activeOwnerWebsiteLimit) || activeOwnerWebsiteLimit < 1)
    ) {
      throw new Error('WEBSITE_LIMIT_CONFIGURATION_INVALID');
    }

    if (customEntityId) {
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

    if (activeOwnerWebsiteLimit !== undefined) {
      const activeWebsiteCount = await transaction.website.count({
        where: {
          ...(data.teamId ? { teamId: data.teamId } : { userId: data.userId }),
          deletedAt: null,
        },
      });

      if (activeWebsiteCount >= activeOwnerWebsiteLimit) {
        throw new Error('WEBSITE_LIMIT_REACHED');
      }
    }

    await assertEntityIdAvailable(transaction, data.id);

    const website = await transaction.website.create({
      data,
    });
    const share = initialShare
      ? await transaction.share.create({
          data: {
            id: uuid(),
            entityId: website.id,
            shareType: ENTITY_TYPE.website,
            ...initialShare,
          },
        })
      : null;

    return { website, share };
  });
}

export async function updateWebsite(
  websiteId: string,
  data: Prisma.WebsiteUncheckedUpdateInput,
  actorUserId: string,
  options: {
    shareSlug?: string | null;
    replayConfig?: unknown;
  } = {},
) {
  const { shareSlug, replayConfig } = options;
  const result = await runSerializable(async transaction => {
    await lockCollectionSources(transaction, [websiteId]);

    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      websiteId,
      PERMISSIONS.websiteUpdate,
    );

    let recorderUpdate: Prisma.WebsiteUncheckedUpdateInput = {};

    if (replayConfig !== undefined) {
      const currentWebsite = await transaction.website.findUnique({
        where: { id: websiteId },
        select: { replayConfig: true },
      });
      const nextReplayConfig = getRecorderConfig(
        replayConfig === null
          ? {}
          : {
              ...getRecorderConfig(currentWebsite?.replayConfig),
              ...(replayConfig as Record<string, unknown>),
            },
      );

      recorderUpdate = {
        replayConfig: nextReplayConfig as Prisma.InputJsonObject,
        recorderEnabled: getRecorderEnabled(nextReplayConfig),
      };
    }

    const website = await transaction.website.update({
      where: {
        id: websiteId,
      },
      data: {
        ...data,
        ...recorderUpdate,
      },
    });
    let share;

    if (shareSlug === null) {
      await transaction.share.deleteMany({
        where: {
          entityId: websiteId,
          shareType: ENTITY_TYPE.website,
        },
      });
      share = null;
    } else if (typeof shareSlug === 'string') {
      share = await transaction.share.create({
        data: {
          id: uuid(),
          entityId: websiteId,
          shareType: ENTITY_TYPE.website,
          name: website.name,
          slug: shareSlug,
          parameters: { overview: true, events: true },
        },
      });
    } else {
      share = await transaction.share.findFirst({
        where: {
          entityId: websiteId,
          shareType: ENTITY_TYPE.website,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    }

    return { website, share };
  });

  if (redis.enabled) {
    await redis.client.del(`website:${websiteId}`);
  }

  return result;
}

export async function transferWebsiteByActor(
  websiteId: string,
  destination: { userId: string } | { teamId: string },
  actorUserId: string,
) {
  const website = await runSerializable(async transaction => {
    await lockCollectionSources(transaction, [websiteId]);

    const actor = await transaction.user.findFirst({
      where: {
        id: actorUserId,
        deletedAt: null,
      },
      select: {
        role: true,
      },
    });
    const currentWebsite = await transaction.website.findFirst({
      where: {
        id: websiteId,
        deletedAt: null,
      },
      select: {
        id: true,
        userId: true,
        teamId: true,
      },
    });

    if (!currentWebsite) {
      throw new Error('WEBSITE_NOT_FOUND');
    }

    if (!actor) {
      throw new Error('WEBSITE_TRANSFER_NOT_AUTHORIZED');
    }

    const isAdmin = actor.role === ROLES.admin;

    if ('userId' in destination) {
      const destinationUser = await transaction.user.findFirst({
        where: {
          id: destination.userId,
          deletedAt: null,
        },
        select: {
          id: true,
        },
      });

      if (!destinationUser) {
        throw new Error('WEBSITE_TRANSFER_USER_NOT_FOUND');
      }

      if (!isAdmin) {
        const membership = currentWebsite.teamId
          ? await transaction.teamUser.findFirst({
              where: {
                teamId: currentWebsite.teamId,
                userId: actorUserId,
                team: { deletedAt: null },
                user: { deletedAt: null },
              },
              select: {
                role: true,
              },
            })
          : null;

        if (destination.userId !== actorUserId || membership?.role !== ROLES.teamOwner) {
          throw new Error('WEBSITE_TRANSFER_NOT_AUTHORIZED');
        }
      }

      return transaction.website.update({
        where: {
          id: websiteId,
        },
        data: {
          userId: destination.userId,
          teamId: null,
        },
      });
    }

    const destinationTeam = await transaction.team.findFirst({
      where: {
        id: destination.teamId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });
    const destinationMembership = await transaction.teamUser.findFirst({
      where: {
        teamId: destination.teamId,
        userId: actorUserId,
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
      select: {
        role: true,
      },
    });

    if (!destinationTeam) {
      throw new Error('WEBSITE_TRANSFER_TEAM_NOT_FOUND');
    }

    if (
      !isAdmin &&
      (currentWebsite.userId !== actorUserId ||
        (TEAM_ROLE_RANK[destinationMembership?.role] ?? -1) < TEAM_ROLE_RANK[ROLES.teamManager])
    ) {
      throw new Error('WEBSITE_TRANSFER_NOT_AUTHORIZED');
    }

    return transaction.website.update({
      where: {
        id: websiteId,
      },
      data: {
        userId: null,
        teamId: destination.teamId,
      },
    });
  });

  if (redis.enabled) {
    await redis.client.del(`website:${websiteId}`);
  }

  return website;
}

export async function resetWebsite(websiteId: string, actorUserId: string) {
  return runSerializable(
    async tx => {
      await lockCollectionSources(tx, [websiteId]);

      await assertActorCanMutateEntity(
        tx,
        actorUserId,
        'website',
        websiteId,
        PERMISSIONS.websiteUpdate,
      );

      await deleteClickhouseCollectionSources([websiteId]);

      await tx.sessionReplaySaved.deleteMany({
        where: { websiteId },
      });

      await tx.sessionReplay.deleteMany({
        where: { websiteId },
      });

      await tx.heatmapEvent.deleteMany({
        where: { websiteId },
      });

      await tx.revenue.deleteMany({
        where: { websiteId },
      });

      await tx.eventData.deleteMany({
        where: { websiteId },
      });

      await tx.sessionData.deleteMany({
        where: { websiteId },
      });

      await tx.websiteEvent.deleteMany({
        where: { websiteId },
      });

      await tx.session.deleteMany({
        where: { websiteId },
      });

      const website = await tx.website.update({
        where: { id: websiteId },
        data: {
          resetAt: new Date(),
        },
      });

      return website;
    },
    {
      timeout: 300_000,
    },
  ).then(async data => {
    if (redis.enabled) {
      await redis.client.del(`website:${websiteId}`);
    }

    return data;
  });
}

export async function deleteWebsite(websiteId: string, actorUserId: string) {
  const cloudMode = isEnvEnabled('CLOUD_MODE');

  return runSerializable(
    async tx => {
      await lockCollectionSources(tx, [websiteId]);

      await assertActorCanMutateEntity(
        tx,
        actorUserId,
        'website',
        websiteId,
        PERMISSIONS.websiteDelete,
      );

      await deleteClickhouseCollectionSources([websiteId]);

      await tx.sessionReplaySaved.deleteMany({
        where: { websiteId },
      });

      await tx.sessionReplay.deleteMany({
        where: { websiteId },
      });

      await tx.heatmapEvent.deleteMany({
        where: { websiteId },
      });

      await tx.revenue.deleteMany({
        where: { websiteId },
      });

      await tx.eventData.deleteMany({
        where: { websiteId },
      });

      await tx.sessionData.deleteMany({
        where: { websiteId },
      });

      await tx.websiteEvent.deleteMany({
        where: { websiteId },
      });

      await tx.session.deleteMany({
        where: { websiteId },
      });

      await tx.report.deleteMany({
        where: { websiteId },
      });

      await tx.segment.deleteMany({
        where: { websiteId },
      });

      await tx.share.deleteMany({
        where: {
          entityId: websiteId,
          shareType: ENTITY_TYPE.website,
        },
      });

      const website = cloudMode
        ? await tx.website.update({
            data: {
              deletedAt: new Date(),
            },
            where: { id: websiteId },
          })
        : await tx.website.delete({
            where: { id: websiteId },
          });

      return website;
    },
    {
      timeout: 300_000,
    },
  ).then(async data => {
    if (redis.enabled) {
      await redis.client.del(`website:${websiteId}`);
    }

    return data;
  });
}

export async function getWebsiteCount(userId: string) {
  return prisma.client.website.count({
    where: {
      userId,
      deletedAt: null,
    },
  });
}

export async function getTeamWebsiteCount(teamId: string) {
  return prisma.client.website.count({
    where: {
      teamId,
      deletedAt: null,
    },
  });
}

export async function attachShareIdToWebsite(website: Website) {
  const share = await prisma.client.share.findFirst({
    where: {
      entityId: website.id,
      shareType: ENTITY_TYPE.website,
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      slug: true,
    },
  });

  return {
    ...website,
    shareId: share?.slug ?? null,
  };
}

export async function attachShareIdToWebsites(websites: {
  data: any;
  count: any;
  page: number;
  pageSize: number;
  orderBy: string;
  search: string;
}) {
  const websiteIds = websites.data.map(website => website.id);

  if (websiteIds.length === 0) {
    return {
      ...websites,
      data: websites.data.map(website => ({ ...website, shareId: null })),
    };
  }

  const shares = await prisma.client.share.findMany({
    where: {
      entityId: { in: websiteIds },
      shareType: ENTITY_TYPE.website,
    },
    distinct: ['entityId'],
    orderBy: {
      createdAt: 'desc',
    },
  });

  const shareByWebsiteId = new Map(shares.map(share => [share.entityId, share.slug]));

  return {
    ...websites,
    data: websites.data.map(website => ({
      ...website,
      shareId: shareByWebsiteId.get(website.id) ?? null,
    })),
  };
}
