import { attributionQuerySchema } from '@/lib/analytics-schema';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import {
  type AttributionParameters,
  getAttribution,
} from '@/queries/sql/attribution/getAttribution';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { websiteId } = await params;
  const { auth, query, error } = await parseRequest(request, attributionQuerySchema, {
    budgetShareQuery: true,
    shareQueryContext: { section: 'attribution', websiteId },
    shareQueryWorkMultiplier: 8,
  });
  if (error) return error();
  if (!(await canViewWebsiteSection(auth, websiteId, 'attribution'))) return unauthorized();
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...query, ...filters } as AttributionParameters;
  return json(await getAttribution(websiteId, parameters, filters));
}
