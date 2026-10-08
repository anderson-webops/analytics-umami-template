import { getQueryFilters, parseRequest, setWebsiteDate } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { reportResultSchema } from '@/lib/schema';
import { getFunnelShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { type FunnelParameters, getFunnel } from '@/queries/sql';

export async function POST(request: Request) {
  const { auth, body, error } = await parseRequest(request, reportResultSchema, {
    shareQueryWorkMultiplier: (_query, body) => {
      const parameters = (body as { parameters?: { steps?: unknown; window?: unknown } } | null)
        ?.parameters;
      return getFunnelShareWorkMultiplier(parameters?.steps, parameters?.window);
    },
  });

  if (error) {
    return error();
  }

  const { websiteId } = body;

  if (!(await canViewWebsiteSection(auth, websiteId, 'funnels'))) {
    return unauthorized();
  }

  const parameters = await setWebsiteDate(websiteId, body.parameters);
  const filters = await getQueryFilters(body.filters, websiteId);

  const data = await getFunnel(websiteId, parameters as FunnelParameters, filters);

  return json(data);
}
