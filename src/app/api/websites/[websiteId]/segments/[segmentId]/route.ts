import { parseRequest } from '@/lib/request';
import { json, notFound, ok, unauthorized } from '@/lib/response';
import { savedSegmentSchema } from '@/lib/schema';
import { canDeleteWebsite, canUpdateWebsite, canViewSharedWebsiteFilters } from '@/permissions';
import { deleteSegment, getWebsiteSegment, updateSegment } from '@/queries/prisma';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; segmentId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, segmentId } = await params;

  if (!(await canViewSharedWebsiteFilters(auth, websiteId))) {
    return unauthorized();
  }

  const segment = await getWebsiteSegment(websiteId, segmentId);

  if (!segment) {
    return notFound();
  }

  return json(segment);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; segmentId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, savedSegmentSchema);

  if (error) {
    return error();
  }

  const { websiteId, segmentId } = await params;
  const { type, name, parameters } = body;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const segment = await getWebsiteSegment(websiteId, segmentId);

  if (!segment) {
    return notFound();
  }

  let result;

  try {
    result = await updateSegment(
      websiteId,
      segmentId,
      {
        type,
        name,
        parameters,
      } as any,
      auth.user.id,
    );
  } catch (error: any) {
    switch (error?.message) {
      case 'SEGMENT_NOT_FOUND':
        return notFound();
      case 'ENTITY_NOT_FOUND':
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your segment-update permission changed.' });
      default:
        throw error;
    }
  }

  return json(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; segmentId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, segmentId } = await params;

  if (!(await canDeleteWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const segment = await getWebsiteSegment(websiteId, segmentId);

  if (!segment) {
    return notFound();
  }

  try {
    await deleteSegment(websiteId, segmentId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'SEGMENT_NOT_FOUND':
        return notFound();
      case 'ENTITY_NOT_FOUND':
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your segment-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
