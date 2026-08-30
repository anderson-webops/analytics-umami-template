import { Prisma, type Team } from '@/generated/prisma/client';
import { ROLES, TEAM_ROLE_RANK } from '@/lib/constants';
import { isUuid, uuid } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { sanitizeSortFilters } from '@/lib/sort';
import type { PageResult, QueryFilters } from '@/lib/types';
import { deleteClickhouseCollectionSources } from '@/queries/sql/deleteCollectionSources';
import { runSerializable } from './authorization';
import { lockCollectionSources } from './collection';

import TeamFindManyArgs = Prisma.TeamFindManyArgs;

const TEAM_SORT_FIELDS = ['name', 'createdAt'] as const;

export async function findTeam(criteria: Prisma.TeamFindUniqueArgs): Promise<Team | null> {
  return prisma.client.team.findUnique({
    ...criteria,
    where: {
      ...criteria.where,
      deletedAt: null,
    },
  });
}

export async function getTeam(
  teamId: string,
  options: { includeMembers?: boolean } = {},
): Promise<Team | null> {
  if (!isUuid(teamId)) {
    return null;
  }

  const { includeMembers } = options;

  return findTeam({
    where: {
      id: teamId,
    },
    ...(includeMembers && { include: { members: true } }),
  });
}

export async function getTeams(
  criteria: TeamFindManyArgs,
  filters: QueryFilters,
): Promise<PageResult<Team[]>> {
  const { getSearchParameters } = prisma;
  const sortFilters = sanitizeSortFilters(filters, TEAM_SORT_FIELDS);
  const { search } = sortFilters;

  const where: Prisma.TeamWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [{ name: 'contains' }]),
  };

  return prisma.pagedQuery<TeamFindManyArgs>(
    'team',
    {
      ...criteria,
      where,
    },
    sortFilters,
  );
}

export async function getUserTeams(userId: string, filters: QueryFilters = {}) {
  return getTeams(
    {
      where: {
        deletedAt: null,
        members: {
          some: { userId },
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
              },
            },
          },
        },
        _count: {
          select: {
            websites: {
              where: { deletedAt: null },
            },
            members: {
              where: {
                user: { deletedAt: null },
              },
            },
          },
        },
      },
    },
    filters,
  );
}

export async function getAllUserTeams(userId: string) {
  return prisma.client.team.findMany({
    where: {
      deletedAt: null,
      members: {
        some: { userId },
      },
    },
    select: {
      id: true,
      name: true,
      logoUrl: true,
    },
  });
}

export async function getUserOwnedTeamCount(userId: string) {
  return prisma.client.team.count({
    where: {
      deletedAt: null,
      members: {
        some: { userId, role: ROLES.teamOwner },
      },
    },
  });
}

export async function getTeamOwner(teamId: string) {
  if (!isUuid(teamId)) {
    return null;
  }

  return prisma.client.teamUser.findFirst({
    where: {
      teamId,
      role: ROLES.teamOwner,
      team: { deletedAt: null },
      user: { deletedAt: null },
    },
    select: { userId: true },
  });
}

async function getActiveUserRole(transaction: Prisma.TransactionClient, userId: string) {
  return transaction.user.findFirst({
    where: {
      id: userId,
      deletedAt: null,
    },
    select: {
      role: true,
    },
  });
}

export async function createTeam(
  data: {
    id: string;
    name: string;
    accessCode?: string | null;
    logoUrl?: string | null;
  },
  ownerUserId: string,
  actorUserId: string,
): Promise<Team> {
  return runSerializable(async transaction => {
    const actor = await getActiveUserRole(transaction, actorUserId);
    const owner = await getActiveUserRole(transaction, ownerUserId);

    const actorCanCreate =
      actor?.role === ROLES.admin || (actor?.role === ROLES.user && actorUserId === ownerUserId);

    if (!actorCanCreate) {
      throw new Error('TEAM_ACTOR_NOT_AUTHORIZED');
    }

    if (!owner) {
      throw new Error('TEAM_OWNER_TARGET_NOT_FOUND');
    }

    const team = await transaction.team.create({
      data,
    });

    await transaction.teamUser.create({
      data: {
        id: uuid(),
        teamId: data.id,
        userId: ownerUserId,
        role: ROLES.teamOwner,
      },
    });

    return team;
  });
}

export async function updateTeam(
  teamId: string,
  data: Prisma.TeamUpdateInput,
  actorUserId: string,
): Promise<Team> {
  return runSerializable(async transaction => {
    const actor = await getActiveUserRole(transaction, actorUserId);
    const team = await transaction.team.findFirst({
      where: {
        id: teamId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });
    const membership = await transaction.teamUser.findFirst({
      where: {
        teamId,
        userId: actorUserId,
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
      select: {
        role: true,
      },
    });

    if (!team) {
      throw new Error('TEAM_NOT_FOUND');
    }

    const canUpdate =
      actor?.role === ROLES.admin ||
      (actor && (TEAM_ROLE_RANK[membership?.role] ?? -1) >= TEAM_ROLE_RANK[ROLES.teamManager]);

    if (!canUpdate) {
      throw new Error('TEAM_ACTOR_NOT_AUTHORIZED');
    }

    return transaction.team.update({
      where: {
        id: teamId,
      },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });
  });
}

export async function deleteTeam(teamId: string, actorUserId: string) {
  const cloudMode = isEnvEnabled('CLOUD_MODE');

  const result = await runSerializable(
    async transaction => {
      const actor = await getActiveUserRole(transaction, actorUserId);
      const team = await transaction.team.findFirst({
        where: {
          id: teamId,
          deletedAt: null,
        },
        select: {
          id: true,
        },
      });
      const membership = await transaction.teamUser.findFirst({
        where: {
          teamId,
          userId: actorUserId,
          team: { deletedAt: null },
          user: { deletedAt: null },
        },
        select: {
          role: true,
        },
      });

      if (!team) {
        throw new Error('TEAM_NOT_FOUND');
      }

      if (actor?.role !== ROLES.admin && membership?.role !== ROLES.teamOwner) {
        throw new Error('TEAM_ACTOR_NOT_AUTHORIZED');
      }

      const websites = await transaction.website.findMany({
        where: { teamId },
        select: { id: true },
      });
      const links = await transaction.link.findMany({
        where: { teamId },
        select: { id: true, slug: true, deletedAt: true },
      });
      const pixels = await transaction.pixel.findMany({
        where: { teamId },
        select: { id: true, slug: true, deletedAt: true },
      });
      const boards = await transaction.board.findMany({
        where: { teamId },
        select: { id: true },
      });
      const websiteIds = websites.map(website => website.id);
      const sourceIds = [
        ...websiteIds,
        ...links.map(link => link.id),
        ...pixels.map(pixel => pixel.id),
      ];
      const entityIds = [...sourceIds, ...boards.map(board => board.id)];

      await lockCollectionSources(transaction, sourceIds);
      await deleteClickhouseCollectionSources(sourceIds);

      await transaction.sessionReplaySaved.deleteMany({
        where: { websiteId: { in: websiteIds } },
      });
      await transaction.sessionReplay.deleteMany({
        where: { websiteId: { in: websiteIds } },
      });
      await transaction.heatmapEvent.deleteMany({
        where: { websiteId: { in: websiteIds } },
      });
      await transaction.revenue.deleteMany({
        where: { websiteId: { in: sourceIds } },
      });
      await transaction.eventData.deleteMany({
        where: { websiteId: { in: sourceIds } },
      });
      await transaction.sessionData.deleteMany({
        where: { websiteId: { in: sourceIds } },
      });
      await transaction.websiteEvent.deleteMany({
        where: { websiteId: { in: sourceIds } },
      });
      await transaction.session.deleteMany({
        where: { websiteId: { in: sourceIds } },
      });
      await transaction.report.deleteMany({
        where: { websiteId: { in: websiteIds } },
      });
      await transaction.segment.deleteMany({
        where: { websiteId: { in: websiteIds } },
      });
      await transaction.share.deleteMany({
        where: { entityId: { in: entityIds } },
      });

      if (cloudMode) {
        const deletedAt = new Date();

        await transaction.link.updateMany({
          data: { deletedAt },
          where: { teamId, deletedAt: null },
        });
        await transaction.pixel.updateMany({
          data: { deletedAt },
          where: { teamId, deletedAt: null },
        });
        await transaction.website.updateMany({
          data: { deletedAt },
          where: { teamId, deletedAt: null },
        });
        await transaction.board.deleteMany({ where: { teamId } });
        await transaction.teamUser.deleteMany({ where: { teamId } });
        await transaction.team.updateMany({
          data: { deletedAt },
          where: { id: teamId, deletedAt: null },
        });
      } else {
        await transaction.link.deleteMany({ where: { teamId } });
        await transaction.pixel.deleteMany({ where: { teamId } });
        await transaction.board.deleteMany({ where: { teamId } });
        await transaction.website.deleteMany({ where: { teamId } });
        await transaction.teamUser.deleteMany({ where: { teamId } });
        await transaction.team.deleteMany({ where: { id: teamId } });
      }

      return { websiteIds, links, pixels };
    },
    {
      timeout: 300_000,
    },
  );

  if (redis.enabled) {
    await Promise.all([
      ...result.websiteIds.map(id => redis.client.del(`website:${id}`)),
      ...result.links
        .filter(link => !link.deletedAt)
        .map(link => redis.client.del(`link:${link.slug}`)),
      ...result.pixels
        .filter(pixel => !pixel.deletedAt)
        .map(pixel => redis.client.del(`pixel:${pixel.slug}`)),
      redis.client.del(`team:${teamId}`),
    ]);
  }

  return result;
}
