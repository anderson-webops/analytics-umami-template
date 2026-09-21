import { parseRequest } from '@/lib/request';
import { json, notFound, ok, unauthorized } from '@/lib/response';
import { annotationSchema } from '@/lib/schema';
import { canUpdateWebsite, canViewSharedWebsiteFilters } from '@/permissions';
import { deleteAnnotation, getWebsiteAnnotation, updateAnnotation } from '@/queries/prisma';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; annotationId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, annotationId } = await params;

  if (!(await canViewSharedWebsiteFilters(auth, websiteId))) {
    return unauthorized();
  }

  const annotation = await getWebsiteAnnotation(websiteId, annotationId);

  if (!annotation) {
    return notFound();
  }

  return json(annotation);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; annotationId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, annotationSchema);

  if (error) {
    return error();
  }

  const { websiteId, annotationId } = await params;
  const { date, allDay, note } = body;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const annotation = await getWebsiteAnnotation(websiteId, annotationId);

  if (!annotation) {
    return notFound();
  }

  let result;

  try {
    result = await updateAnnotation(websiteId, annotationId, { date, allDay, note }, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ANNOTATION_NOT_FOUND':
        return notFound();
      case 'ENTITY_NOT_FOUND':
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your annotation-update permission changed.' });
      default:
        throw error;
    }
  }

  return json(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; annotationId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, annotationId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const annotation = await getWebsiteAnnotation(websiteId, annotationId);

  if (!annotation) {
    return notFound();
  }

  try {
    await deleteAnnotation(websiteId, annotationId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ANNOTATION_NOT_FOUND':
        return notFound();
      case 'ENTITY_NOT_FOUND':
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your annotation-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
