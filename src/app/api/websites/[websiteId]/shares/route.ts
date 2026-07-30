import { z } from 'zod';
import { ENTITY_TYPE } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { getRandomChars } from '@/lib/generate';
import { parseRequest } from '@/lib/request';
import { conflict, json, notFound, unauthorized } from '@/lib/response';
import { filterParams, pagingParams, shareParametersParam } from '@/lib/schema';
import { publicSharesDisabled } from '@/lib/security';
import { canUpdateWebsite, canViewAuthenticatedWebsite } from '@/permissions';
import { createShare, getSharesByEntityId } from '@/queries/prisma';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    ...filterParams,
    ...pagingParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { page, pageSize, search } = query;

  if (!(await canViewAuthenticatedWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const data = await getSharesByEntityId(websiteId, {
    page,
    pageSize,
    search,
  });

  return json(data);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
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

  const { websiteId } = await params;
  const { name, parameters } = body;
  const shareParameters = parameters ?? {};

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const slug = getRandomChars(16);

  let share;

  try {
    share = await createShare(
      {
        id: uuid(),
        entityId: websiteId,
        shareType: ENTITY_TYPE.website,
        name,
        slug,
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
