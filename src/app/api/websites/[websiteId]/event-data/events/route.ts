import { z } from 'zod';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { DiscoveryRangeTooBroadError } from '@/queries/sql/events/discoveryError';
import { getEventDataEvents } from '@/queries/sql/events/getEventDataEvents';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    event: z.string().optional(),
    ...filterParams,
  });
  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsiteSection(auth, websiteId, 'events'))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  try {
    return json(await getEventDataEvents(websiteId, { ...filters }));
  } catch (caught) {
    if (caught instanceof DiscoveryRangeTooBroadError) {
      return badRequest({ message: caught.message });
    }

    throw caught;
  }
}
