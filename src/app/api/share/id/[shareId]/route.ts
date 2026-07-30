import z from 'zod';
import { parseRequest } from '@/lib/request';
import { conflict, json, notFound, ok, unauthorized } from '@/lib/response';
import { routeSlugParam, shareParametersParam } from '@/lib/schema';
import { publicSharesDisabled } from '@/lib/security';
import { canDeleteShareEntity, canUpdateShareEntity, canViewShareEntity } from '@/permissions';
import { deleteShare, getShare, updateShare } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { shareId } = await params;
  const share = await getShare(shareId);

  if (!share) {
    return notFound();
  }

  if (!(await canViewShareEntity(auth, share.shareType, share.entityId))) {
    return unauthorized();
  }

  return json(share);
}

export async function POST(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  if (publicSharesDisabled()) {
    return notFound();
  }

  const schema = z.object({
    name: z.string().trim().min(1).max(200),
    slug: routeSlugParam,
    parameters: shareParametersParam,
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { shareId } = await params;
  const { name, slug, parameters } = body;
  const share = await getShare(shareId);

  if (!share) {
    return notFound();
  }

  if (!(await canUpdateShareEntity(auth, share.shareType, share.entityId))) {
    return unauthorized();
  }

  let result;

  try {
    result = await updateShare(
      shareId,
      {
        name,
        slug,
        parameters,
      } as any,
      auth.user.id,
    );
  } catch (error: any) {
    if (error?.message === 'SHARE_NOT_FOUND') {
      return notFound();
    }

    if (error?.message === 'SHARE_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your sharing permission changed.' });
    }

    if (error?.code === 'P2002') {
      return conflict({ message: 'That share slug is already in use.' });
    }

    throw error;
  }

  return json(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ shareId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { shareId } = await params;
  const share = await getShare(shareId);

  if (!share) {
    return notFound();
  }

  if (!(await canDeleteShareEntity(auth, share.shareType, share.entityId))) {
    return unauthorized();
  }

  try {
    await deleteShare(shareId, auth.user.id);
  } catch (error: any) {
    if (error?.message === 'SHARE_NOT_FOUND') {
      return notFound();
    }

    if (error?.message === 'SHARE_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your share-deletion permission changed.' });
    }

    throw error;
  }

  return ok();
}
