import { Prisma } from '@/generated/prisma/client';
import { ROLES } from '@/lib/constants';
import { hash, isUuid } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { getRandomChars } from '@/lib/generate';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { hasCurrentSessionGeneration } from '@/lib/session-generation';
import { sanitizeSortFilters } from '@/lib/sort';
import { getTwoFactorRequirement } from '@/lib/two-factor/requirement';
import type { Auth, QueryFilters, Role } from '@/lib/types';
import { deleteClickhouseCollectionSources } from '@/queries/sql/deleteCollectionSources';
import {
  assertActorIsAdministrator,
  assertCurrentActorAuth,
  runCredentialRevocationMutation,
  runSerializedUserMutation,
} from './authorization';
import { lockCollectionSources } from './collection';
import { recordDeletedWebsiteCollectionGenerations } from './collection-generation';

import UserFindManyArgs = Prisma.UserFindManyArgs;

const USER_SORT_FIELDS = ['username', 'role', 'createdAt'] as const;

async function requireCurrentAdministrator(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
) {
  try {
    await assertActorIsAdministrator(transaction, actorUserId);
  } catch (error) {
    if (error instanceof Error && error.message === 'ENTITY_ADMIN_REQUIRED') {
      throw new Error('ADMIN_AUTHORIZATION_CHANGED');
    }

    throw error;
  }
}

export interface GetUserOptions {
  includePassword?: boolean;
  includeSessionGeneration?: boolean;
  showDeleted?: boolean;
}

async function findUser(criteria: Prisma.UserFindUniqueArgs, options: GetUserOptions = {}) {
  const {
    includePassword = false,
    includeSessionGeneration = false,
    showDeleted = false,
  } = options;
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;

  return client.user.findUnique({
    ...criteria,
    where: {
      ...criteria.where,
      ...(showDeleted ? {} : { deletedAt: null }),
    },
    select: {
      id: true,
      username: true,
      password: includePassword,
      sessionGeneration: includeSessionGeneration,
      role: true,
      createdAt: true,
      twoFactorRequired: true,
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
  return findUser({ where: { username: username.trim().toLowerCase() } }, options);
}

export async function revokeStatelessSessions(userId: string, sessionGeneration: number) {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;

  await client.user.updateMany({
    where: { id: userId, deletedAt: null, sessionGeneration },
    data: { sessionGeneration: { increment: 1 } },
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
  session: {
    sessionGeneration: number;
    passwordFingerprint: string;
    mfaId?: string;
    authKey?: string;
  },
) {
  return runSerializedUserMutation(async transaction => {
    await requireCurrentAdministrator(transaction, actorUserId);

    if (
      !session ||
      !Number.isSafeInteger(session.sessionGeneration) ||
      session.sessionGeneration < 0 ||
      typeof session.passwordFingerprint !== 'string'
    ) {
      throw new Error('ADMIN_AUTHORIZATION_CHANGED');
    }

    const actor = await transaction.user.findUnique({
      where: { id: actorUserId },
      select: { password: true, sessionGeneration: true },
    });
    const enforceLocalMfa = !isEnvEnabled('CLOUD_MODE');
    const factor = enforceLocalMfa
      ? await transaction.twoFactorAuth.findUnique({
          where: { userId: actorUserId },
          select: { id: true, isEnabled: true },
        })
      : null;
    const currentMfaId = factor?.isEnabled ? factor.id : undefined;
    const enrollmentRequired =
      enforceLocalMfa &&
      !currentMfaId &&
      (await getTwoFactorRequirement(actorUserId, transaction)).reason !== null;
    const redisSession =
      redis.enabled && session.authKey ? await redis.client.get(session.authKey) : null;

    if (
      !actor ||
      actor.sessionGeneration !== session.sessionGeneration ||
      hash(actor.password) !== session.passwordFingerprint ||
      (enforceLocalMfa && (currentMfaId !== session.mfaId || enrollmentRequired)) ||
      (redis.enabled &&
        session.authKey &&
        (redisSession?.userId !== actorUserId ||
          redisSession.role !== ROLES.admin ||
          redisSession.pwd !== session.passwordFingerprint ||
          !hasCurrentSessionGeneration(redisSession.sessionGeneration, session.sessionGeneration) ||
          (enforceLocalMfa &&
            currentMfaId &&
            (redisSession.mfa !== true || redisSession.mfaId !== currentMfaId))))
    ) {
      throw new Error('ADMIN_AUTHORIZATION_CHANGED');
    }

    const existingUser = await transaction.user.findUnique({
      where: { username: data.username },
      select: { id: true },
    });

    if (existingUser) {
      throw new Error('USER_ALREADY_EXISTS');
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
  auth: Auth,
) {
  const nextRole =
    typeof data.role === 'string'
      ? data.role
      : data.role && typeof data.role === 'object' && 'set' in data.role
        ? data.role.set
        : null;
  const changingPassword = data.password !== undefined;
  const runMutation = changingPassword
    ? runCredentialRevocationMutation
    : runSerializedUserMutation;

  return runMutation(async transaction => {
    await assertCurrentActorAuth(transaction, actorUserId, auth, 'ADMIN_AUTHORIZATION_CHANGED');
    await requireCurrentAdministrator(transaction, actorUserId);

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

    const changingRole = nextRole !== null && nextRole !== current.role;
    const updated = await transaction.user.update({
      where: {
        id: userId,
      },
      data: {
        ...data,
        ...(changingPassword || changingRole ? { sessionGeneration: { increment: 1 } } : {}),
      },
      select: {
        id: true,
        username: true,
        role: true,
        createdAt: true,
      },
    });

    if (changingPassword || changingRole) {
      await transaction.apiKey.deleteMany({ where: { userId } });
    }

    return updated;
  });
}

async function writePasswordIfCurrent(
  userId: string,
  expectedPassword: string,
  nextPassword: string,
  expectedSessionGeneration: number,
  rotateCredentials: boolean,
) {
  const runMutation = rotateCredentials
    ? runCredentialRevocationMutation
    : runSerializedUserMutation;

  return runMutation(async transaction => {
    const updated = await transaction.$queryRaw<Array<{ sessionGeneration: number }>>`
      UPDATE "user"
      SET "password" = ${nextPassword},
          "session_generation" = "session_generation" + ${rotateCredentials ? 1 : 0},
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "user_id" = ${userId}::uuid
        AND "password" = ${expectedPassword}
        AND "deleted_at" IS NULL
        AND "session_generation" = ${expectedSessionGeneration}
      RETURNING "session_generation" AS "sessionGeneration"
    `;

    if (
      updated.length !== 1 ||
      updated[0].sessionGeneration !== expectedSessionGeneration + (rotateCredentials ? 1 : 0)
    ) {
      throw new Error('USER_CREDENTIALS_CHANGED');
    }

    if (rotateCredentials) {
      await transaction.apiKey.deleteMany({ where: { userId } });
    } else {
      await transaction.loginRecoveryCredential.updateMany({
        where: { userId, passwordFingerprint: hash(expectedPassword), consumedAt: null },
        data: { passwordFingerprint: hash(nextPassword) },
      });
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
        sessionGeneration: true,
      },
    });
  });
}

export function replacePasswordIfCurrent(
  userId: string,
  expectedPassword: string,
  nextPassword: string,
  expectedSessionGeneration: number,
) {
  return writePasswordIfCurrent(
    userId,
    expectedPassword,
    nextPassword,
    expectedSessionGeneration,
    true,
  );
}

export function rehashPasswordIfCurrent(
  userId: string,
  expectedPassword: string,
  nextPassword: string,
  expectedSessionGeneration: number,
) {
  return writePasswordIfCurrent(
    userId,
    expectedPassword,
    nextPassword,
    expectedSessionGeneration,
    false,
  );
}

export function isLastActiveAdminError(error: unknown): boolean {
  return error instanceof Error && error.message === 'LAST_ACTIVE_ADMIN';
}

export function isUserDeletionBlockedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'USER_OWNS_RESOURCES';
}

export async function deleteUser(userId: string, actorUserId: string, auth: Auth) {
  const cloudMode = isEnvEnabled('CLOUD_MODE');

  const result = await runSerializedUserMutation(
    async transaction => {
      await assertCurrentActorAuth(transaction, actorUserId, auth, 'ADMIN_AUTHORIZATION_CHANGED');
      await requireCurrentAdministrator(transaction, actorUserId);

      if (actorUserId === userId) {
        throw new Error('ADMIN_CANNOT_DELETE_SELF');
      }

      await transaction.$queryRaw`
        SELECT user_id FROM "user" WHERE user_id = ${userId}::uuid FOR UPDATE
      `;
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
      await transaction.attestedRevenueMovement.deleteMany({
        where: { websiteId: { in: websiteIds } },
      });
      await transaction.eventData.deleteMany({
        where: { websiteId: { in: sourceIds } },
      });
      await transaction.sessionData.deleteMany({
        where: { websiteId: { in: sourceIds } },
      });
      await transaction.sessionLink.deleteMany({
        where: { websiteId: { in: websiteIds } },
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
        const deletedWebsites = await transaction.website.findMany({
          where: { id: { in: websiteIds }, userId },
          select: { id: true, collectionGeneration: true },
        });
        await recordDeletedWebsiteCollectionGenerations(transaction, deletedWebsites);
        await transaction.website.deleteMany({ where: { id: { in: websiteIds }, userId } });
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
}
