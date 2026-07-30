import { Prisma } from '@/generated/prisma/client';
import { ROLES, TEAM_ROLE_RANK } from '@/lib/constants';
import { isUuid, uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { runSerializable } from './authorization';

import TeamUserFindManyArgs = Prisma.TeamUserFindManyArgs;

export async function getTeamUser(teamId: string, userId: string) {
  if (!isUuid(teamId) || !isUuid(userId)) {
    return null;
  }

  return prisma.client.teamUser.findFirst({
    where: {
      teamId,
      userId,
      team: {
        deletedAt: null,
      },
      user: {
        deletedAt: null,
      },
    },
  });
}

export async function getTeamUsers(criteria: TeamUserFindManyArgs, filters?: QueryFilters) {
  const { search } = filters || {};

  const where: Prisma.TeamUserWhereInput = {
    ...criteria.where,
    ...prisma.getSearchParameters(search, [{ user: { username: 'contains' } }]),
  };

  return prisma.pagedQuery(
    'teamUser',
    {
      ...criteria,
      where,
    },
    filters,
  );
}

async function getActorState(
  transaction: Prisma.TransactionClient,
  teamId: string,
  actorUserId: string,
) {
  const actor = await transaction.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, deletedAt: true },
  });

  if (!actor || actor.deletedAt) {
    return null;
  }

  if (actor.role === ROLES.admin) {
    return { isAdmin: true, rank: Number.POSITIVE_INFINITY };
  }

  const membership = await transaction.teamUser.findFirst({
    where: {
      teamId,
      userId: actorUserId,
      team: { deletedAt: null },
      user: { deletedAt: null },
    },
    select: { role: true },
  });

  return membership ? { isAdmin: false, rank: TEAM_ROLE_RANK[membership.role] ?? -1 } : null;
}

export async function addTeamUserByActor(
  teamId: string,
  userId: string,
  role: string,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    const actor = await getActorState(transaction, teamId, actorUserId);
    const team = await transaction.team.findFirst({
      where: { id: teamId, deletedAt: null },
      select: { id: true },
    });
    const targetUser = await transaction.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    const existing = await transaction.teamUser.findFirst({
      where: { teamId, userId },
      select: { id: true },
    });

    if (!team) {
      throw new Error('TEAM_NOT_FOUND');
    }

    if (!targetUser) {
      throw new Error('TEAM_USER_NOT_FOUND');
    }

    if (existing) {
      throw new Error('TEAM_USER_EXISTS');
    }

    const requestedRank = TEAM_ROLE_RANK[role] ?? -1;

    if (
      !actor ||
      (!actor.isAdmin &&
        (actor.rank < TEAM_ROLE_RANK[ROLES.teamManager] || actor.rank <= requestedRank))
    ) {
      throw new Error('TEAM_ACTOR_NOT_AUTHORIZED');
    }

    try {
      return await transaction.teamUser.create({
        data: {
          id: uuid(),
          userId,
          teamId,
          role,
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new Error('TEAM_USER_EXISTS');
      }

      throw error;
    }
  });
}

export async function joinTeamByAccessCode(userId: string, accessCode: string) {
  return runSerializable(async transaction => {
    const team = await transaction.team.findFirst({
      where: { accessCode, deletedAt: null },
      select: { id: true },
    });
    const user = await transaction.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });

    if (!team) {
      throw new Error('TEAM_NOT_FOUND');
    }

    if (!user) {
      throw new Error('TEAM_USER_NOT_FOUND');
    }

    const existing = await transaction.teamUser.findFirst({
      where: { teamId: team.id, userId },
      select: { id: true },
    });

    if (existing) {
      throw new Error('TEAM_USER_EXISTS');
    }

    try {
      return await transaction.teamUser.create({
        data: {
          id: uuid(),
          userId,
          teamId: team.id,
          role: ROLES.teamMember,
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new Error('TEAM_USER_EXISTS');
      }

      throw error;
    }
  });
}

export async function updateTeamUserRoleByActor(
  teamId: string,
  userId: string,
  role: string,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    const actor = await getActorState(transaction, teamId, actorUserId);
    const target = await transaction.teamUser.findFirst({
      where: {
        teamId,
        userId,
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
    });

    if (!target) {
      throw new Error('TEAM_USER_NOT_FOUND');
    }

    if (target.role === ROLES.teamOwner) {
      throw new Error('TEAM_OWNER_REQUIRES_TRANSFER');
    }

    const targetRank = TEAM_ROLE_RANK[target.role] ?? -1;
    const requestedRank = TEAM_ROLE_RANK[role] ?? -1;

    if (
      !actor ||
      (!actor.isAdmin &&
        (actor.rank < TEAM_ROLE_RANK[ROLES.teamManager] ||
          actor.rank <= targetRank ||
          actor.rank <= requestedRank))
    ) {
      throw new Error('TEAM_ACTOR_NOT_AUTHORIZED');
    }

    return transaction.teamUser.update({
      where: { id: target.id },
      data: { role },
    });
  });
}

export async function deleteTeamUserByActor(teamId: string, userId: string, actorUserId: string) {
  return runSerializable(async transaction => {
    const actor = await getActorState(transaction, teamId, actorUserId);
    const target = await transaction.teamUser.findFirst({
      where: {
        teamId,
        userId,
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
    });

    if (!target) {
      throw new Error('TEAM_USER_NOT_FOUND');
    }

    if (target.role === ROLES.teamOwner) {
      throw new Error('TEAM_OWNER_REQUIRES_TRANSFER');
    }

    const targetRank = TEAM_ROLE_RANK[target.role] ?? -1;
    const canRemove =
      actor &&
      (actor.isAdmin ||
        actorUserId === userId ||
        (actor.rank >= TEAM_ROLE_RANK[ROLES.teamManager] && actor.rank > targetRank));

    if (!canRemove) {
      throw new Error('TEAM_ACTOR_NOT_AUTHORIZED');
    }

    return transaction.teamUser.delete({
      where: { id: target.id },
    });
  });
}

export async function transferTeamOwnership(
  teamId: string,
  newOwnerId: string,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    const actor = await getActorState(transaction, teamId, actorUserId);
    const owners = await transaction.teamUser.findMany({
      where: {
        teamId,
        role: ROLES.teamOwner,
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
    });

    if (owners.length !== 1) {
      throw new Error('TEAM_OWNER_INVARIANT');
    }

    const currentOwner = owners[0];

    if (!actor || (!actor.isAdmin && currentOwner.userId !== actorUserId)) {
      throw new Error('TEAM_ACTOR_NOT_AUTHORIZED');
    }

    if (currentOwner.userId === newOwnerId) {
      throw new Error('TEAM_OWNER_UNCHANGED');
    }

    const newOwner = await transaction.teamUser.findFirst({
      where: {
        teamId,
        userId: newOwnerId,
        user: { deletedAt: null },
      },
    });

    if (!newOwner) {
      throw new Error('TEAM_OWNER_TARGET_NOT_MEMBER');
    }

    await transaction.teamUser.update({
      where: {
        id: currentOwner.id,
      },
      data: {
        role: ROLES.teamManager,
      },
    });

    return transaction.teamUser.update({
      where: {
        id: newOwner.id,
      },
      data: {
        role: ROLES.teamOwner,
      },
    });
  });
}
