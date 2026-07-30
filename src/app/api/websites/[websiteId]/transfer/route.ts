import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, unauthorized } from '@/lib/response';
import { canTransferWebsiteToTeam, canTransferWebsiteToUser } from '@/permissions';
import { getTeam, getUser, transferWebsiteByActor } from '@/queries/prisma';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z
    .object({
      userId: z.uuid().optional(),
      teamId: z.uuid().optional(),
    })
    .refine(data => Number(!!data.userId) + Number(!!data.teamId) === 1, {
      message: 'Exactly one transfer destination is required.',
    });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { userId, teamId } = body;

  if (userId) {
    if (!(await getUser(userId))) {
      return badRequest({ message: 'The destination user does not exist.' });
    }

    if (!(await canTransferWebsiteToUser(auth, websiteId, userId))) {
      return unauthorized();
    }

    try {
      const website = await transferWebsiteByActor(websiteId, { userId }, auth.user.id);

      return json(website);
    } catch (error: any) {
      switch (error?.message) {
        case 'WEBSITE_NOT_FOUND':
          return notFound({ message: 'Website not found.' });
        case 'WEBSITE_TRANSFER_USER_NOT_FOUND':
          return badRequest({ message: 'The destination user does not exist.' });
        case 'WEBSITE_TRANSFER_NOT_AUTHORIZED':
          return unauthorized({ message: 'Your website-transfer permission changed.' });
        default:
          throw error;
      }
    }
  } else if (teamId) {
    if (!(await getTeam(teamId))) {
      return badRequest({ message: 'The destination team does not exist.' });
    }

    if (!(await canTransferWebsiteToTeam(auth, websiteId, teamId))) {
      return unauthorized();
    }

    try {
      const website = await transferWebsiteByActor(websiteId, { teamId }, auth.user.id);

      return json(website);
    } catch (error: any) {
      switch (error?.message) {
        case 'WEBSITE_NOT_FOUND':
          return notFound({ message: 'Website not found.' });
        case 'WEBSITE_TRANSFER_TEAM_NOT_FOUND':
          return badRequest({ message: 'The destination team does not exist.' });
        case 'WEBSITE_TRANSFER_NOT_AUTHORIZED':
          return unauthorized({ message: 'Your website-transfer permission changed.' });
        default:
          throw error;
      }
    }
  }

  return badRequest();
}
