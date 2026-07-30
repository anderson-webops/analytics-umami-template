import { z } from 'zod';
import { ENTITY_TYPE } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { getRandomChars } from '@/lib/generate';
import { parseRequest } from '@/lib/request';
import { conflict, json, notFound, unauthorized } from '@/lib/response';
import { filterParams, pagingParams, shareParametersParam } from '@/lib/schema';
import { publicSharesDisabled } from '@/lib/security';
import { canUpdateBoard, canViewBoard } from '@/permissions';
import { createShare, getSharesByEntityId } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  const schema = z.object({
    ...filterParams,
    ...pagingParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { boardId } = await params;
  const { page, pageSize, search } = query;

  if (!(await canViewBoard(auth, boardId))) {
    return unauthorized();
  }

  const data = await getSharesByEntityId(boardId, {
    page,
    pageSize,
    search,
  });

  return json(data);
}

export async function POST(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  if (publicSharesDisabled()) {
    return notFound();
  }

  const schema = z.object({
    name: z.string().trim().min(1).max(200),
    parameters: shareParametersParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { boardId } = await params;
  const { name, parameters } = body;
  const shareParameters = parameters ?? {};

  if (!(await canUpdateBoard(auth, boardId))) {
    return unauthorized();
  }

  let share;

  try {
    share = await createShare(
      {
        id: uuid(),
        entityId: boardId,
        shareType: ENTITY_TYPE.board,
        name,
        slug: getRandomChars(16),
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
