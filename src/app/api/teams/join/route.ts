import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, unauthorized } from '@/lib/response';
import { canMutateResource } from '@/permissions/mutation';
import { joinTeamByAccessCode } from '@/queries/prisma';

export async function POST(request: Request) {
  const schema = z.object({
    accessCode: z.string().regex(/^team_[A-Za-z0-9]{16}$/, 'Invalid team access code.'),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  if (!canMutateResource(auth.user)) {
    return unauthorized();
  }

  const { accessCode } = body;

  let user;

  try {
    user = await joinTeamByAccessCode(auth.user.id, accessCode);
  } catch (error: any) {
    switch (error?.message) {
      case 'TEAM_NOT_FOUND':
        return notFound({ message: 'Team not found.', code: 'team-not-found' });
      case 'TEAM_USER_EXISTS':
        return badRequest({ message: 'User is already a team member.' });
      case 'TEAM_USER_NOT_FOUND':
        return badRequest({ message: 'Your account is no longer active.' });
      case 'TEAM_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your team-join permission changed.' });
      default:
        throw error;
    }
  }

  return json(user);
}
