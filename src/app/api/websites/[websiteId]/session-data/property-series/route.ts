import { z } from 'zod';
import { parsePropertyFilters } from '@/lib/params';
import { getPropertySeriesValueLimit } from '@/lib/property-series-budget';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams, timezoneParam, unitParam } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getSessionDataPropertySeries } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    propertyName: z.string(),
    timezone: timezoneParam.optional(),
    unit: unitParam.optional(),
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

  const { propertyName, ...rest } = query;
  const filters = await getQueryFilters(rest, websiteId);

  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    return json([]);
  }

  if (!getPropertySeriesValueLimit(filters)) {
    return badRequest({ message: 'The requested property series exceeds the allowed size.' });
  }

  const propertyFilters = parsePropertyFilters(query);
  const data = await getSessionDataPropertySeries(
    websiteId,
    propertyName,
    filters,
    propertyFilters,
  );

  return json(data);
}
