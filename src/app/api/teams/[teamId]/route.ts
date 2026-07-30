import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, notFound, ok, unauthorized } from '@/lib/response';
import { canDeleteTeam, canUpdateTeam, canViewTeam } from '@/permissions';
import { deleteTeam, getTeam, updateTeam } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { teamId } = await params;

  if (!(await canViewTeam(auth, teamId))) {
    return unauthorized();
  }

  const team = await getTeam(teamId, { includeMembers: true });

  if (!team) {
    return notFound({ message: 'Team not found.' });
  }

  return json(team);
}

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const schema = z.object({
    name: z.string().trim().min(1).max(50).optional(),
    accessCode: z
      .string()
      .regex(/^team_[A-Za-z0-9]{16}$/, 'Invalid team access code.')
      .optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { teamId } = await params;

  if (!(await canUpdateTeam(auth, teamId))) {
    return unauthorized({ message: 'You must be the owner/manager of this team.' });
  }

  let team;

  try {
    team = await updateTeam(teamId, body, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'TEAM_NOT_FOUND':
        return notFound({ message: 'Team not found.' });
      case 'TEAM_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your team-management permission changed.' });
      default:
        throw error;
    }
  }

  return json(team);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { teamId } = await params;

  if (!(await canDeleteTeam(auth, teamId))) {
    return unauthorized({ message: 'You must be the owner/manager of this team.' });
  }

  try {
    await deleteTeam(teamId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'TEAM_NOT_FOUND':
        return notFound({ message: 'Team not found.' });
      case 'TEAM_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your team-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
