import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, serverError, unauthorized } from '@/lib/response';
import { httpUrlParam, routeSlugParam } from '@/lib/schema';
import { canDeleteLink, canUpdateLink, canViewLink } from '@/permissions';
import { deleteLink, getLink, updateLink } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { linkId } = await params;

  if (!(await canViewLink(auth, linkId))) {
    return unauthorized();
  }

  const link = await getLink(linkId);

  if (!link) {
    return notFound();
  }

  if (!auth.user) {
    return json({
      id: link.id,
      name: link.name,
      url: link.url,
      slug: link.slug,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    });
  }

  return json(link);
}

export async function POST(request: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const schema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    url: httpUrlParam.optional(),
    slug: routeSlugParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { linkId } = await params;
  const { name, url, slug } = body;

  if (!(await canUpdateLink(auth, linkId))) {
    return unauthorized();
  }

  try {
    const result = await updateLink(linkId, { name, url, slug }, auth.user.id);

    return Response.json(result);
  } catch (e: any) {
    if (e.message === 'ENTITY_NOT_FOUND') {
      return notFound({ message: 'Link not found.' });
    }

    if (e.message === 'ENTITY_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your link-update permission changed.' });
    }

    if (e?.code === 'P2002') {
      return badRequest({ message: 'That slug is already taken.' });
    }

    return serverError(e);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { linkId } = await params;

  if (!(await canDeleteLink(auth, linkId))) {
    return unauthorized();
  }

  try {
    await deleteLink(linkId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_NOT_FOUND':
        return notFound({ message: 'Link not found.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your link-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
