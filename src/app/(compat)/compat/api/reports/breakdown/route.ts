import { getQueryFilters, parseRequest, setWebsiteDate } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { reportResultSchema } from '@/lib/schema';
import { getBreakdownShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { type BreakdownParameters, getBreakdown } from '@/queries/sql';

export async function POST(request: Request) {
  const { auth, body, error } = await parseRequest(request, reportResultSchema, {
    shareQueryWorkMultiplier: (_query, body) => {
      const parameters = (body as { parameters?: { fields?: unknown } } | null)?.parameters;
      return getBreakdownShareWorkMultiplier(parameters?.fields);
    },
  });

  if (error) {
    return error();
  }

  const { websiteId } = body;

  if (!(await canViewWebsiteSection(auth, websiteId, 'breakdown'))) {
    return unauthorized();
  }

  const parameters = await setWebsiteDate(websiteId, body.parameters);
  const filters = await getQueryFilters(body.filters, websiteId);

  const data = await getBreakdown(websiteId, parameters as BreakdownParameters, filters);

  return json(data);
}
