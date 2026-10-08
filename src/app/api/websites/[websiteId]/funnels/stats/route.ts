import { funnelQuerySchema } from '@/lib/analytics-schema';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { getFunnelShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';

import { type FunnelParameters, getFunnel } from '@/queries/sql/funnels/getFunnel';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, funnelQuerySchema, {
    shareQueryWorkMultiplier: query => getFunnelShareWorkMultiplier(query.steps, query.window),
  });
  if (error) return error();
  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'funnels'))) return unauthorized();
  const filters = await getQueryFilters(query, websiteId);
  const parameters = {
    startDate: filters.startDate,
    endDate: filters.endDate,
    window: query.window,
    steps: query.steps,
  } as FunnelParameters;
  return json(await getFunnel(websiteId, parameters, filters));
}
