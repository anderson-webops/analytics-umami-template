import { z } from 'zod';
import { isUuid } from '@/lib/crypto';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, unauthorized } from '@/lib/response';
import { canUpdateWebsite, canViewAuthenticatedWebsite } from '@/permissions';
import { getReplaySaved, setReplaySavedByActor } from '@/queries/prisma/sessionReplay';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; replayId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, replayId } = await params;

  if (!isUuid(websiteId) || !isUuid(replayId)) {
    return badRequest({ message: 'Invalid replay identifier.' });
  }

  if (!(await canViewAuthenticatedWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const isSaved = await getReplaySaved(websiteId, replayId);

  return json({ isSaved });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; replayId: string }> },
) {
  const schema = z.object({
    isSaved: z.boolean(),
    name: z.string().max(100).optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId, replayId } = await params;

  if (!isUuid(websiteId) || !isUuid(replayId)) {
    return badRequest({ message: 'Invalid replay identifier.' });
  }

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  try {
    await setReplaySavedByActor(websiteId, replayId, body.isSaved, body.name ?? '', auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'REPLAY_NOT_FOUND':
      case 'ENTITY_NOT_FOUND':
        return notFound({ message: 'Replay or website not found.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your replay-management permission changed.' });
      default:
        throw error;
    }
  }

  return json({ ok: true });
}
