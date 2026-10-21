import { journeyQuerySchema } from '@/lib/analytics-schema';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { getJourneyShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { getJourney, type JourneyParameters } from '@/queries/sql/journeys/getJourney';

const TRAFFIC_PROVENANCE = 'may_include_unverified_public_observations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, journeyQuerySchema, {
    shareQueryWorkMultiplier: query => getJourneyShareWorkMultiplier(query.steps),
  });
  if (error) return error();
  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'journeys'))) return unauthorized();
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...query, ...filters } as JourneyParameters;
  const rows = await getJourney(websiteId, parameters, filters);
  return json(
    rows.map(row => ({ ...row, trafficProvenance: TRAFFIC_PROVENANCE })),
    { headers: { 'X-Traffic-Provenance': TRAFFIC_PROVENANCE } },
  );
}
