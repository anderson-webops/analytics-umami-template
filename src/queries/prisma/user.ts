import { Prisma } from '@/generated/prisma/client';
import { ROLES } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { getRandomChars } from '@/lib/generate';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { sanitizeSortFilters } from '@/lib/sort';
import type { QueryFilters, Role } from '@/lib/types';
import { deleteClickhouseCollectionSources } from '@/queries/sql/deleteCollectionSources';
import { runSerializable } from './authorization';
import { lockCollectionSources } from './collection';

import UserFindManyArgs = Prisma.UserFindManyArgs;

const USER_SORT_FIELDS = ['username', 'role', 'createdAt'] as const;

export interface GetUserOptions {
  includePassword?: boolean;
  showDeleted?: boolean;
}

async function findUser(criteria: Prisma.UserFindUniqueArgs, options: GetUserOptions = {}) {
  const { includePassword = false, showDeleted = false } = options;

  return prisma.client.user.findUnique({
    ...criteria,
    where: {
      ...criteria.where,
      ...(showDeleted ? {} : { deletedAt: null }),
    },
    select: {
      id: true,
      username: true,
      password: includePassword,
      role: true,
      createdAt: true,
    },
  });
}

export async function getUser(userId: string, options: GetUserOptions = {}) {
  if (!isUuid(userId)) {
    return null;
  }

  return findUser(
    {
      where: {
        id: userId,
      },
    },
    options,
  );
}

export async function getUserByUsername(username: string, options: GetUserOptions = {}) {
  const { includePassword = false, showDeleted = false } = options;

  return prisma.client.user.findFirst({
    where: {
      username: {
        equals: username.trim(),
        mode: 'insensitive',
      },
      ...(showDeleted ? {} : { deletedAt: null }),
    },
    select: {
      id: true,
      username: true,
      password: includePassword,
      role: true,
      createdAt: true,
    },
  });
}

export async function getUsers(criteria: UserFindManyArgs, filters: QueryFilters = {}) {
  const sortFilters = sanitizeSortFilters(filters, USER_SORT_FIELDS, {
    orderBy: 'createdAt',
    sortDescending: true,
  });
  const { search } = sortFilters;

  const where: Prisma.UserWhereInput = {
    ...criteria.where,
    ...prisma.getSearchParameters(search, [{ username: 'contains' }]),
    deletedAt: null,
  };

  return prisma.pagedQuery(
    'user',
    {
      ...criteria,
      where,
    },
    sortFilters,
  );
}

export async function createUser(
  data: {
    id: string;
    username: string;
    password: string;
    role: Role;
  },
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    const actor = await transaction.user.findFirst({
      where: {
        id: actorUserId,
        role: ROLES.admin,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!actor) {
      throw new Error('ADMIN_AUTHORIZATION_CHANGED');
    }

    return transaction.user.create({
      data,
      select: {
        id: true,
        username: true,
        role: true,
      },
    });
  });
}

export async function updateUser(
  userId: string,
  data: Prisma.UserUpdateInput,
  actorUserId: string,
) {
  const nextRole = typeof data.role === 'string' ? data.role : null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.transaction(
        async transaction => {
          const actor = await transaction.user.findFirst({
            where: {
              id: actorUserId,
              role: ROLES.admin,
              deletedAt: null,
            },
            select: { id: true },
          });

          if (!actor) {
            throw new Error('ADMIN_AUTHORIZATION_CHANGED');
          }

          const current = await transaction.user.findUnique({
            where: { id: userId },
            select: { role: true, deletedAt: true },
          });

          if (!current || current.deletedAt) {
            throw new Error('USER_NOT_FOUND');
          }

          if (nextRole && nextRole !== ROLES.admin && current.role === ROLES.admin) {
            const activeAdminCount = await transaction.user.count({
              where: {
                role: ROLES.admin,
                deletedAt: null,
              },
            });

            if (activeAdminCount <= 1) {
              throw new Error('LAST_ACTIVE_ADMIN');
            }
          }

          return transaction.user.update({
            where: {
              id: userId,
            },
            data,
            select: {
              id: true,
              username: true,
              role: true,
              createdAt: true,
            },
          });
        },
        {
          isolationLevel: 'Serializable',
        },
      );
    } catch (error: any) {
      if (
        ['ADMIN_AUTHORIZATION_CHANGED', 'LAST_ACTIVE_ADMIN', 'USER_NOT_FOUND'].includes(
          error?.message,
        )
      ) {
        throw error;
      }

      if (error?.code !== 'P2034' || attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error('USER_UPDATE_RETRY_EXHAUSTED');
}

export async function replacePasswordIfCurrent(
  userId: string,
  expectedPassword: string,
  nextPassword: string,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.transaction(
        async transaction => {
          const updated = await transaction.user.updateMany({
            where: {
              id: userId,
              password: expectedPassword,
              deletedAt: null,
            },
            data: {
              password: nextPassword,
            },
          });

          if (updated.count !== 1) {
            throw new Error('USER_CREDENTIALS_CHANGED');
          }

          return transaction.user.findUnique({
            where: {
              id: userId,
            },
            select: {
              id: true,
              username: true,
              role: true,
              createdAt: true,
            },
          });
        },
        {
          isolationLevel: 'Serializable',
        },
      );
    } catch (error: any) {
      if (error?.message === 'USER_CREDENTIALS_CHANGED') {
        throw error;
      }

      if (error?.code !== 'P2034' || attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error('USER_CREDENTIAL_UPDATE_RETRY_EXHAUSTED');
}

export function isLastActiveAdminError(error: unknown): boolean {
  return error instanceof Error && error.message === 'LAST_ACTIVE_ADMIN';
}

export function isUserDeletionBlockedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'USER_OWNS_RESOURCES';
}

export async function deleteUser(userId: string, actorUserId: string) {
  const cloudMode = isEnvEnabled('CLOUD_MODE');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await prisma.transaction(
        async transaction => {
          const actor = await transaction.user.findFirst({
            where: {
              id: actorUserId,
              role: ROLES.admin,
              deletedAt: null,
            },
            select: { id: true },
          });

          if (!actor) {
            throw new Error('ADMIN_AUTHORIZATION_CHANGED');
          }

          if (actorUserId === userId) {
            throw new Error('ADMIN_CANNOT_DELETE_SELF');
          }

          const current = await transaction.user.findUnique({
            where: { id: userId },
            select: { role: true, deletedAt: true },
          });

          if (!current || current.deletedAt) {
            throw new Error('USER_NOT_FOUND');
          }

          if (current.role === ROLES.admin) {
            const activeAdminCount = await transaction.user.count({
              where: {
                role: ROLES.admin,
                deletedAt: null,
              },
            });

            if (activeAdminCount <= 1) {
              throw new Error('LAST_ACTIVE_ADMIN');
            }
          }

          const ownedTeams = await transaction.team.count({
            where: {
              deletedAt: null,
              members: {
                some: {
                  userId,
                  role: ROLES.teamOwner,
                },
              },
            },
          });
          const activeWebsites = await transaction.website.count({
            where: { userId, deletedAt: null },
          });
          const activeLinks = await transaction.link.count({
            where: { userId, deletedAt: null },
          });
          const activePixels = await transaction.pixel.count({
            where: { userId, deletedAt: null },
          });
          const activeBoards = await transaction.board.count({
            where: { userId },
          });

          if (ownedTeams + activeWebsites + activeLinks + activePixels + activeBoards > 0) {
            throw new Error('USER_OWNS_RESOURCES');
          }

          const websites = await transaction.website.findMany({
            where: { userId },
            select: { id: true },
          });
          const links = await transaction.link.findMany({
            where: { userId },
            select: { id: true, slug: true, deletedAt: true },
          });
          const pixels = await transaction.pixel.findMany({
            where: { userId },
            select: { id: true, slug: true, deletedAt: true },
          });
          const boards = await transaction.board.findMany({
            where: { userId },
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
            where: {
              OR: [{ websiteId: { in: websiteIds } }, { userId }],
            },
          });
          await transaction.segment.deleteMany({
            where: { websiteId: { in: websiteIds } },
          });
          await transaction.share.deleteMany({
            where: { entityId: { in: entityIds } },
          });

          if (cloudMode) {
            await transaction.link.updateMany({
              data: { deletedAt: new Date() },
              where: { userId, deletedAt: null },
            });
            await transaction.pixel.updateMany({
              data: { deletedAt: new Date() },
              where: { userId, deletedAt: null },
            });
            await transaction.website.updateMany({
              data: { deletedAt: new Date() },
              where: { userId, deletedAt: null },
            });
          } else {
            await transaction.link.deleteMany({ where: { userId } });
            await transaction.pixel.deleteMany({ where: { userId } });
            await transaction.website.deleteMany({ where: { userId } });
          }

          await transaction.board.deleteMany({ where: { userId } });
          await transaction.teamUser.deleteMany({ where: { userId } });
          await transaction.website.updateMany({
            where: {
              createdBy: userId,
              id: { notIn: websiteIds },
            },
            data: {
              createdBy: null,
            },
          });

          const user = cloudMode
            ? await transaction.user.update({
                data: {
                  username: getRandomChars(32),
                  deletedAt: new Date(),
                },
                where: {
                  id: userId,
                },
              })
            : await transaction.user.delete({
                where: {
                  id: userId,
                },
              });

          return { user, websiteIds, links, pixels };
        },
        {
          isolationLevel: 'Serializable',
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
        ]);
      }

      return result.user;
    } catch (error: any) {
      if (
        [
          'ADMIN_AUTHORIZATION_CHANGED',
          'ADMIN_CANNOT_DELETE_SELF',
          'LAST_ACTIVE_ADMIN',
          'USER_NOT_FOUND',
          'USER_OWNS_RESOURCES',
        ].includes(error?.message)
      ) {
        throw error;
      }

      if (error?.code !== 'P2034' || attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error('USER_DELETE_RETRY_EXHAUSTED');
}
