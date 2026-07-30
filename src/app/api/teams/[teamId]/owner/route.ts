import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { canTransferTeamOwnership } from '@/permissions';
import { transferTeamOwnership } from '@/queries/prisma';

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const schema = z.object({
    userId: z.uuid(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { teamId } = await params;

  if (!(await canTransferTeamOwnership(auth, teamId))) {
    return unauthorized({ message: 'Only the current team owner can transfer ownership.' });
  }

  try {
    const owner = await transferTeamOwnership(teamId, body.userId, auth.user.id);

    return json(owner);
  } catch (error: any) {
    switch (error?.message) {
      case 'TEAM_OWNER_TARGET_NOT_MEMBER':
        return badRequest({ message: 'The new owner must already be a team member.' });
      case 'TEAM_OWNER_UNCHANGED':
        return badRequest({ message: 'That user already owns the team.' });
      case 'TEAM_OWNER_INVARIANT':
        return badRequest({
          message: 'The team owner state is inconsistent and requires administrator repair.',
        });
      case 'TEAM_ACTOR_NOT_AUTHORIZED':
        return unauthorized({
          message:
            'Your ownership or administrator permission changed before this request completed.',
        });
      default:
        throw error;
    }
  }
}
