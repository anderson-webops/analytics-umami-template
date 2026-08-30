import { z } from 'zod';
import { BOARD_TYPES, normalizeBoardType } from '@/lib/boards';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, serverError, unauthorized } from '@/lib/response';
import { boardParametersParam } from '@/lib/schema';
import type { BoardParameters } from '@/lib/types';
import {
  canDeleteBoard,
  canUpdateBoard,
  canViewBoard,
  canViewBoardEntities,
  hasValidBoardReports,
} from '@/permissions';
import { deleteBoard, getBoard, updateBoard } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { boardId } = await params;

  if (!(await canViewBoard(auth, boardId))) {
    return unauthorized();
  }

  const board = await getBoard(boardId);

  if (!board) {
    return notFound();
  }

  if (!auth.user) {
    return json({
      id: board.id,
      type: board.type,
      name: board.name,
      description: board.description,
      parameters: board.parameters,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    });
  }

  return json(board);
}

export async function POST(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  const schema = z.object({
    type: z
      .enum([
        BOARD_TYPES.dashboard,
        BOARD_TYPES.mixed,
        BOARD_TYPES.website,
        BOARD_TYPES.pixel,
        BOARD_TYPES.link,
      ])
      .or(z.literal('open'))
      .optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    parameters: boardParametersParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { boardId } = await params;
  const { name, description, parameters } = body;
  const type = normalizeBoardType(body.type);

  if (!(await canUpdateBoard(auth, boardId))) {
    return unauthorized();
  }

  if (type !== undefined || parameters !== undefined) {
    const currentBoard = await getBoard(boardId);

    if (!currentBoard) {
      return unauthorized();
    }

    const nextType = type ?? currentBoard.type;
    const nextParameters = (parameters ?? currentBoard.parameters) as BoardParameters;

    if (!(await canViewBoardEntities(auth, nextType, nextParameters))) {
      return badRequest({ message: 'Board contains inaccessible entities.' });
    }

    if (!(await hasValidBoardReports(nextType, nextParameters))) {
      return badRequest({ message: 'Board contains invalid saved reports.' });
    }
  }

  try {
    const board = await updateBoard(boardId, { type, name, description, parameters }, auth.user.id);

    return Response.json(board);
  } catch (error: any) {
    if (error?.message === 'ENTITY_NOT_FOUND') {
      return notFound({ message: 'Board not found.' });
    }

    if (error?.message === 'ENTITY_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your board-update permission changed.' });
    }

    if (error?.message === 'ENTITY_REFERENCE_NOT_AUTHORIZED') {
      return badRequest({ message: 'Board contains inaccessible entities.' });
    }

    return serverError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ boardId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { boardId } = await params;

  if (!(await canDeleteBoard(auth, boardId))) {
    return unauthorized();
  }

  try {
    await deleteBoard(boardId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_NOT_FOUND':
        return notFound({ message: 'Board not found.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your board-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
