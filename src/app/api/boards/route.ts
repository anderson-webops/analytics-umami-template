import { z } from 'zod';
import { BOARD_TYPES, normalizeBoardType } from '@/lib/boards';
import { uuid } from '@/lib/crypto';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, conflict, json, unauthorized } from '@/lib/response';
import { boardParametersParam, pagingParams, searchParams, sortingParams } from '@/lib/schema';
import type { BoardParameters } from '@/lib/types';
import { canCreateTeamWebsite, canCreateWebsite, canViewBoardEntities } from '@/permissions';
import { createBoard, getUserBoards } from '@/queries/prisma';

export async function GET(request: Request) {
  const schema = z.object({
    ...pagingParams,
    ...searchParams,
    ...sortingParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const filters = await getQueryFilters(query);

  const boards = await getUserBoards(auth.user.id, filters);

  return json(boards);
}

export async function POST(request: Request) {
  const schema = z.object({
    type: z
      .enum([BOARD_TYPES.mixed, BOARD_TYPES.website, BOARD_TYPES.pixel, BOARD_TYPES.link])
      .or(z.literal('open')),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).optional(),
    teamId: z.uuid().nullable().optional(),
    parameters: boardParametersParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { teamId } = body;

  if ((teamId && !(await canCreateTeamWebsite(auth, teamId))) || !(await canCreateWebsite(auth))) {
    return unauthorized();
  }

  if (!(await canViewBoardEntities(auth, body.type, body.parameters as BoardParameters))) {
    return badRequest({ message: 'Board contains inaccessible entities.' });
  }

  const data = {
    ...body,
    type: normalizeBoardType(body.type),
    id: uuid(),
    parameters: body.parameters ?? {},
    userId: !teamId ? auth.user.id : undefined,
  };

  let result;

  try {
    result = await createBoard(data, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_ID_CONFLICT':
        return conflict({ message: 'That entity ID is already in use.' });
      case 'ENTITY_OWNER_NOT_FOUND':
        return unauthorized({ message: 'The selected owner is no longer available.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your board-creation permission changed.' });
      case 'ENTITY_REFERENCE_NOT_AUTHORIZED':
        return badRequest({ message: 'Board contains inaccessible entities.' });
      default:
        throw error;
    }
  }

  return json(result);
}
