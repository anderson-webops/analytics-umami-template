import { z } from 'zod';
import { parseEventPropertyFilters } from '@/lib/params';
import { getPropertySeriesValueLimit } from '@/lib/property-series-budget';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams, timezoneParam, unitParam } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getEventDataArraySeries } from '@/queries/sql/events/getEventDataArraySeries';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    eventName: z.string(),
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

  if (!(await canViewWebsiteSection(auth, websiteId, 'events'))) {
    return unauthorized();
  }

  const { eventName, propertyName, ...rest } = query;
  const filters = await getQueryFilters(rest, websiteId);

  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    return json([]);
  }

  if (!getPropertySeriesValueLimit(filters)) {
    return badRequest({ message: 'The requested property series exceeds the allowed size.' });
  }

  const eventFilters = parseEventPropertyFilters(query);
  const data = await getEventDataArraySeries(
    websiteId,
    eventName,
    propertyName,
    filters,
    eventFilters,
  );

  return json(data);
}
