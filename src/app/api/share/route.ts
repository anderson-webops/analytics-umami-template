import z from 'zod';
import { ENTITY_TYPE } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { getRandomChars } from '@/lib/generate';
import { parseRequest } from '@/lib/request';
import { conflict, json, notFound, unauthorized } from '@/lib/response';
import { entityTypeParam, routeSlugParam, shareParametersParam } from '@/lib/schema';
import { publicSharesDisabled } from '@/lib/security';
import {
  canShareBoardEntities,
  canUpdateBoard,
  canUpdateLink,
  canUpdatePixel,
  canUpdateWebsite,
} from '@/permissions';
import { createShare, getBoard, getLink, getPixel, getWebsite } from '@/queries/prisma';

export async function POST(request: Request) {
  if (publicSharesDisabled()) {
    return notFound();
  }

  const schema = z.object({
    entityId: z.uuid(),
    shareType: entityTypeParam,
    name: z.string().trim().min(1).max(200),
    slug: routeSlugParam.optional(),
    parameters: shareParametersParam,
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { entityId, shareType, name, slug, parameters } = body;
  const shareParameters = parameters ?? {};

  if (shareType === ENTITY_TYPE.board) {
    const board = await getBoard(entityId);

    if (
      !board ||
      !(await canUpdateBoard(auth, entityId)) ||
      !(await canShareBoardEntities(auth, board.type, board.parameters as any))
    ) {
      return unauthorized({ message: 'Board contains entities you are not allowed to share.' });
    }
  } else if (
    shareType === ENTITY_TYPE.website &&
    (!(await getWebsite(entityId)) || !(await canUpdateWebsite(auth, entityId)))
  ) {
    return unauthorized();
  } else if (
    shareType === ENTITY_TYPE.link &&
    (!(await getLink(entityId)) || !(await canUpdateLink(auth, entityId)))
  ) {
    return unauthorized();
  } else if (
    shareType === ENTITY_TYPE.pixel &&
    (!(await getPixel(entityId)) || !(await canUpdatePixel(auth, entityId)))
  ) {
    return unauthorized();
  }

  let share;

  try {
    share = await createShare(
      {
        id: uuid(),
        entityId,
        shareType,
        name,
        slug: slug || getRandomChars(16),
        parameters: shareParameters,
      },
      auth.user.id,
    );
  } catch (error: any) {
    if (error?.message === 'SHARE_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your sharing permission changed.' });
    }

    if (error?.code === 'P2002') {
      return conflict({ message: 'That share slug is already in use.' });
    }

    throw error;
  }

  return json(share);
}
