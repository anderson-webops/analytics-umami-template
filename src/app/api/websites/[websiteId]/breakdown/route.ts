import { breakdownQuerySchema } from '@/lib/analytics-schema';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { getBreakdownShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { type BreakdownParameters, getBreakdown } from '@/queries/sql/breakdown/getBreakdown';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, breakdownQuerySchema, {
    shareQueryWorkMultiplier: query => getBreakdownShareWorkMultiplier(query.fields),
  });
  if (error) return error();
  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'breakdown'))) return unauthorized();
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...query, ...filters } as BreakdownParameters;
  return json(await getBreakdown(websiteId, parameters, filters));
}
