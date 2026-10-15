import { z } from 'zod';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getSessionDataValues } from '@/queries/sql';
import { DiscoveryRangeTooBroadError } from '@/queries/sql/events/discoveryError';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    propertyName: z.string().optional(),
    dataType: z.coerce.number().int().optional(),
    ...filterParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsiteSection(auth, websiteId, 'sessions'))) {
    return unauthorized();
  }

  const { propertyName, dataType } = query;
  const filters = await getQueryFilters(query, websiteId);

  try {
    const data = await getSessionDataValues(websiteId, {
      ...filters,
      propertyName,
      dataType,
    });

    return json(data);
  } catch (caught) {
    if (caught instanceof DiscoveryRangeTooBroadError) {
      return badRequest({ message: caught.message });
    }

    throw caught;
  }
}
