import { getQueryFilters, parseRequest, setWebsiteDate } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { reportResultSchema } from '@/lib/schema';
import { getGoalShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { type GoalParameters, getGoal } from '@/queries/sql/goals/getGoal';

export async function POST(request: Request) {
  const { auth, body, error } = await parseRequest(request, reportResultSchema, {
    shareQueryWorkMultiplier: (_query, body) =>
      getGoalShareWorkMultiplier(
        (body as { parameters?: { value?: unknown } } | null)?.parameters?.value,
      ),
  });

  if (error) {
    return error();
  }

  const { websiteId } = body;

  if (!(await canViewWebsiteSection(auth, websiteId, 'goals'))) {
    return unauthorized();
  }

  const parameters = await setWebsiteDate(websiteId, body.parameters);
  const filters = await getQueryFilters(body.filters, websiteId);

  const data = await getGoal(websiteId, parameters as GoalParameters, filters);

  return json(data);
}
