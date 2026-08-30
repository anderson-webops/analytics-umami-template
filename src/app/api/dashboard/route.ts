import { z } from 'zod';
import { BOARD_TYPES } from '@/lib/boards';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { boardParametersParam } from '@/lib/schema';
import type { BoardParameters } from '@/lib/types';
import { canViewBoardEntities, hasValidBoardReports } from '@/permissions';
import { createBoard, getBoard, updateBoard } from '@/queries/prisma';

export async function GET(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const board = await getBoard(auth.user.id);

  if (board && board.userId !== auth.user.id) {
    return unauthorized();
  }

  return json(board);
}

export async function POST(request: Request) {
  const schema = z.object({
    name: z.string().trim().max(100).optional(),
    description: z.string().max(500).optional(),
    parameters: boardParametersParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const userId = auth.user.id;
  const existing = await getBoard(userId);

  if (existing && existing.userId !== userId) {
    return unauthorized();
  }

  if (
    body.parameters &&
    !(await canViewBoardEntities(auth, BOARD_TYPES.dashboard, body.parameters as BoardParameters))
  ) {
    return badRequest({ message: 'Dashboard contains inaccessible entities.' });
  }

  const data = {
    name: body.name,
    description: body.description,
    parameters: body.parameters ?? {},
  };

  if (!(await hasValidBoardReports(existing?.type ?? 'dashboard', data.parameters))) {
    return badRequest({ message: 'Board contains invalid saved reports.' });
  }

  try {
    if (existing) {
      const result = await updateBoard(userId, data, userId);

      return json(result);
    }

    const result = await createBoard(
      {
        id: userId,
        type: BOARD_TYPES.dashboard,
        userId,
        ...data,
      },
      userId,
      { isPersonalDashboard: true },
    );

    return json(result);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your dashboard permission changed.' });
      case 'ENTITY_REFERENCE_NOT_AUTHORIZED':
        return badRequest({ message: 'Dashboard contains inaccessible entities.' });
      case 'ENTITY_ID_CONFLICT':
        return badRequest({ message: 'Your dashboard identifier conflicts with another entity.' });
      default:
        throw error;
    }
  }
}
