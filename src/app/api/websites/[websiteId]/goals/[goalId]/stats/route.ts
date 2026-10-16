import { goalParametersSchema, savedStatsQuerySchema } from '@/lib/analytics-schema';
import { reserveAdditionalAuthenticatedQueryWork } from '@/lib/query-admission';
import { getQueryFilters, parseRequest } from '@/lib/request';
import {
  badRequest,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import {
  getAuthenticatedQueryCost,
  getGoalShareWorkMultiplier,
  getShareQueryCost,
  reserveShareQueryCost,
} from '@/lib/share-query-budget';
import { canViewReport, canViewWebsiteSection } from '@/permissions';
import { getReport } from '@/queries/prisma';
import { type GoalParameters, getGoal } from '@/queries/sql/goals/getGoal';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; goalId: string }> },
) {
  const {
    auth,
    query,
    error,
    admittedMinimumRangeMs = 0,
  } = await parseRequest(request, savedStatsQuerySchema);
  if (error) return error();
  const { websiteId, goalId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'goals'))) return unauthorized();
  const report = await getReport(goalId);
  if (!report || report.websiteId !== websiteId || report.type !== 'goal') return notFound();
  if (!(await canViewReport(auth, report))) return unauthorized();
  const parsed = goalParametersSchema.safeParse(report.parameters);
  if (!parsed.success) return badRequest();
  const multiplier = getGoalShareWorkMultiplier(parsed.data.value);
  const shareBase = auth?.shareToken ? getShareQueryCost(query) : null;
  const shareCombined = auth?.shareToken ? getShareQueryCost(query, undefined, multiplier) : null;
  const userBase = auth?.user?.id
    ? getAuthenticatedQueryCost(query, undefined, 1, admittedMinimumRangeMs)
    : null;
  const userCombined = auth?.user?.id
    ? getAuthenticatedQueryCost(query, undefined, multiplier, admittedMinimumRangeMs)
    : null;
  if (
    (auth?.shareToken && (!shareBase || !shareCombined)) ||
    (auth?.user && (!userBase || !userCombined))
  ) {
    return badRequest({
      message: auth?.shareToken
        ? 'The public-share query is too complex.'
        : 'The analytics query is too complex.',
    });
  }
  if (shareBase && shareCombined && shareCombined.charge > shareBase.charge) {
    const shareId = auth.shareToken.shareId ?? auth.shareToken.websiteId;
    if (!shareId) return unauthorized();
    const limit = await reserveShareQueryCost(
      shareId,
      shareCombined.charge - shareBase.charge,
      request,
      0,
    );
    if (limit.unavailable) return serviceUnavailable();
    if (limit.blocked) return tooManyRequests(limit.retryAfter);
  }
  if (userBase && userCombined && userCombined.charge > userBase.charge) {
    const limit = await reserveAdditionalAuthenticatedQueryWork(
      auth.user.id,
      websiteId,
      userCombined.charge - userBase.charge,
    );
    if (limit) return limit;
  }
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...parsed.data, ...filters } as GoalParameters;
  return json(await getGoal(websiteId, parameters, filters));
}
