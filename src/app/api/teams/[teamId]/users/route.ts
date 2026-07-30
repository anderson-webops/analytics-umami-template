import { z } from 'zod';
import { TEAM_ROLE_RANK } from '@/lib/constants';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { pagingParams, searchParams, teamRoleParam } from '@/lib/schema';
import { canUpdateTeam, canViewTeam } from '@/permissions';
import { addTeamUserByActor, getTeamUser, getTeamUsers, getUser } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const schema = z.object({
    ...pagingParams,
    ...searchParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { teamId } = await params;

  if (!(await canViewTeam(auth, teamId))) {
    return unauthorized({ message: 'You must be a member of this team.' });
  }

  const filters = await getQueryFilters(query);

  const users = await getTeamUsers(
    {
      where: {
        teamId,
        user: {
          deletedAt: null,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    },
    filters,
  );

  return json(users);
}

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const schema = z.object({
    userId: z.uuid(),
    role: teamRoleParam,
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { teamId } = await params;

  if (!(await canUpdateTeam(auth, teamId))) {
    return unauthorized({ message: 'You must be the owner/manager of this team.' });
  }

  const { userId, role } = body;

  const targetUser = await getUser(userId);

  if (!targetUser) {
    return badRequest({ message: 'User does not exist.' });
  }

  const teamUser = await getTeamUser(teamId, userId);

  if (teamUser) {
    return badRequest({ message: 'User is already a member of the Team.' });
  }

  if (!auth.user.isAdmin) {
    const actorTeamUser = await getTeamUser(teamId, auth.user.id);
    const actorRank = TEAM_ROLE_RANK[actorTeamUser?.role] ?? -1;
    const requestedRank = TEAM_ROLE_RANK[role] ?? -1;

    if (actorRank <= requestedRank) {
      return unauthorized({ message: 'You cannot assign a role at or above your own role.' });
    }
  }

  let users;

  try {
    users = await addTeamUserByActor(teamId, userId, role, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'TEAM_NOT_FOUND':
        return badRequest({ message: 'Team does not exist.' });
      case 'TEAM_USER_NOT_FOUND':
        return badRequest({ message: 'User does not exist.' });
      case 'TEAM_USER_EXISTS':
        return badRequest({ message: 'User is already a member of the team.' });
      case 'TEAM_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your team-management permission changed.' });
      default:
        throw error;
    }
  }

  return json(users);
}
