import { z } from 'zod';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams, queryLimitParam, timezoneParam, unitParam } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getEventSeriesLimit, getEventStats, isEventSeriesWithinBudget } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    unit: unitParam.optional(),
    timezone: timezoneParam,
    limit: queryLimitParam.optional(),
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

  const { limit } = query;
  const filters = await getQueryFilters(query, websiteId);
  const eventSeriesLimit = getEventSeriesLimit(limit);

  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    return json([]);
  }

  if (!isEventSeriesWithinBudget(eventSeriesLimit, filters)) {
    return badRequest({ message: 'The requested event series exceeds the allowed size.' });
  }

  const data = await getEventStats(websiteId, { limit: eventSeriesLimit }, filters);

  return json(data);
}
