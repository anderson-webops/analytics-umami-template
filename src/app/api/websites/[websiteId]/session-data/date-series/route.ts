import { z } from 'zod';
import { DateSeriesLimitError } from '@/lib/date-series-budget';
import { parsePropertyFilters } from '@/lib/params';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams, timezoneParam } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getSessionDataDateSeries } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    propertyName: z.string(),
    timezone: timezoneParam.optional(),
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
  const propertyFilters = parsePropertyFilters(query);
  try {
    return json(await getSessionDataDateSeries(websiteId, propertyName, filters, propertyFilters));
  } catch (error) {
    if (error instanceof DateSeriesLimitError) {
      return badRequest({ message: error.message });
    }

    throw error;
  }
}
