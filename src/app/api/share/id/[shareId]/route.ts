import z from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, conflict, json, notFound, ok, unauthorized } from '@/lib/response';
import { routeSlugParam, shareParametersParam } from '@/lib/schema';
import { publicSharesDisabled } from '@/lib/security';
import { canDeleteShareEntity, canUpdateShareEntity } from '@/permissions';
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

  if (!(await canUpdateShareEntity(auth, share.shareType, share.entityId))) {
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
    slug: routeSlugParam.meta({
      description: 'Current public URL slug; replacement slugs are not accepted.',
    }),
    rotate: z.boolean().optional().meta({
      description: 'Generate a new public URL and share ID, revoking the previous link and tokens.',
    }),
    parameters: shareParametersParam,
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { shareId } = await params;
  const { name, slug, rotate, parameters } = body;
  const share = await getShare(shareId);

  if (!share) {
    return notFound();
  }

  if (!(await canUpdateShareEntity(auth, share.shareType, share.entityId))) {
    return unauthorized();
  }

  if (slug !== share.slug) {
    return badRequest({ message: 'Share URLs cannot be chosen by the caller.' });
  }

  let result;

  try {
    result = await updateShare(
      shareId,
      {
        name,
        slug,
        rotate,
        parameters,
      },
      auth.user.id,
      auth,
    );
  } catch (error: any) {
    if (error?.message === 'SHARE_NOT_FOUND') {
      return notFound();
    }

    if (error?.message === 'SHARE_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your sharing permission changed.' });
    }

    if (error?.message === 'SHARE_SLUG_CHANGED') {
      return conflict({ message: 'The share URL changed. Refresh before editing.' });
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
    await deleteShare(shareId, auth.user.id, auth);
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
