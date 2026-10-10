import { getQueryFilters, parseRequest, setWebsiteDate } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { reportResultSchema } from '@/lib/schema';
import { getJourneyShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { getJourney } from '@/queries/sql';

const journeyReportResultSchema = reportResultSchema.transform(body =>
  body.type === 'journey' && body.parameters.eventType
    ? {
        ...body,
        filters: { ...body.filters, eventType: body.parameters.eventType },
      }
    : body,
);

export async function POST(request: Request) {
  const { auth, body, error } = await parseRequest(request, journeyReportResultSchema, {
    shareQueryWorkMultiplier: (_query, body) => {
      const parameters = (body as { parameters?: { steps?: unknown } } | null)?.parameters;
      return getJourneyShareWorkMultiplier(parameters?.steps);
    },
  });

  if (error) {
    return error();
  }

  const { websiteId, parameters, filters } = body;

  if (!(await canViewWebsiteSection(auth, websiteId, 'journeys'))) {
    return unauthorized();
  }

  const queryFilters = await getQueryFilters(filters, websiteId);
  const boundedParameters = await setWebsiteDate(websiteId, parameters);
  const data = await getJourney(websiteId, boundedParameters, queryFilters);

  return json(data);
}
