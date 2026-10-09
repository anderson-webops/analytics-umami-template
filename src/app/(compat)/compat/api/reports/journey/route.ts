import { getQueryFilters, parseRequest, setWebsiteDate } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { reportResultSchema } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getJourney } from '@/queries/sql';

export async function POST(request: Request) {
  const { auth, body, error } = await parseRequest(request, reportResultSchema);

  if (error) {
    return error();
  }

  const { websiteId, parameters, filters } = body;
  const { eventType } = parameters;

  if (!(await canViewWebsiteSection(auth, websiteId, 'journeys'))) {
    return unauthorized();
  }

  if (eventType) {
    filters.eventType = eventType;
  }

  const queryFilters = await getQueryFilters(filters, websiteId);
  const boundedParameters = await setWebsiteDate(websiteId, parameters);
  const data = await getJourney(websiteId, boundedParameters, queryFilters);

  return json(data);
}
