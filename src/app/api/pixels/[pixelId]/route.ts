import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, serverError, unauthorized } from '@/lib/response';
import { routeSlugParam } from '@/lib/schema';
import { canDeletePixel, canUpdatePixel, canViewPixel } from '@/permissions';
import { deletePixel, getPixel, updatePixel } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ pixelId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { pixelId } = await params;

  if (!(await canViewPixel(auth, pixelId))) {
    return unauthorized();
  }

  const pixel = await getPixel(pixelId);

  if (!pixel) {
    return notFound();
  }

  if (!auth.user) {
    return json({
      id: pixel.id,
      name: pixel.name,
      slug: pixel.slug,
      createdAt: pixel.createdAt,
      updatedAt: pixel.updatedAt,
    });
  }

  return json(pixel);
}

export async function POST(request: Request, { params }: { params: Promise<{ pixelId: string }> }) {
  const schema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    slug: routeSlugParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { pixelId } = await params;
  const { name, slug } = body;

  if (!(await canUpdatePixel(auth, pixelId))) {
    return unauthorized();
  }

  try {
    const pixel = await updatePixel(pixelId, { name, slug }, auth.user.id);

    return Response.json(pixel);
  } catch (e: any) {
    if (e.message === 'ENTITY_NOT_FOUND') {
      return notFound({ message: 'Pixel not found.' });
    }

    if (e.message === 'ENTITY_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your pixel-update permission changed.' });
    }

    if (e?.code === 'P2002') {
      return badRequest({ message: 'That slug is already taken.' });
    }

    return serverError(e);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ pixelId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { pixelId } = await params;

  if (!(await canDeletePixel(auth, pixelId))) {
    return unauthorized();
  }

  try {
    await deletePixel(pixelId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_NOT_FOUND':
        return notFound({ message: 'Pixel not found.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your pixel-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
