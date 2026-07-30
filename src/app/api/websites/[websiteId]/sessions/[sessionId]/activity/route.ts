import { z } from 'zod';
import { isUuid } from '@/lib/crypto';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import { getSessionActivity } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId, sessionId } = await params;

  if (!isUuid(websiteId) || !isUuid(sessionId)) {
    return badRequest({ message: 'Invalid session identifier.' });
  }

  if (
    !(await canViewWebsiteSection(auth, websiteId, ['sessions', 'events', 'realtime', 'revenue']))
  ) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  const data = await getSessionActivity(websiteId, sessionId, filters);

  return json(data);
}
