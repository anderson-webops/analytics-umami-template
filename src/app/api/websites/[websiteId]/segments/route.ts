import { z } from 'zod';
import { uuid } from '@/lib/crypto';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { savedSegmentSchema, searchParams, segmentTypeParam } from '@/lib/schema';
import { canUpdateWebsite, canViewSharedWebsiteFilters } from '@/permissions';
import { createSegment, getWebsiteSegments } from '@/queries/prisma';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    type: segmentTypeParam,
    ...searchParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { type } = query;

  if (websiteId && !(await canViewSharedWebsiteFilters(auth, websiteId))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query);

  const segments = await getWebsiteSegments(websiteId, type, filters);

  return json(segments);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, savedSegmentSchema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { type, name, parameters } = body;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  let result;

  try {
    result = await createSegment(
      {
        id: uuid(),
        websiteId,
        type,
        name,
        parameters,
      } as any,
      auth.user.id,
    );
  } catch (error: any) {
    if (['ENTITY_NOT_FOUND', 'ENTITY_ACTOR_NOT_AUTHORIZED'].includes(error?.message)) {
      return unauthorized({ message: 'Your segment-creation permission changed.' });
    }

    throw error;
  }

  return json(result);
}
