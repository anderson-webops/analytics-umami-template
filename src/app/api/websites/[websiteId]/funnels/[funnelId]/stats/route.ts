import { funnelParametersSchema, savedStatsQuerySchema } from '@/lib/analytics-schema';
import { ENTITY_TYPE } from '@/lib/constants';
import { reserveAdditionalAuthenticatedQueryWork } from '@/lib/query-admission';
import { getQueryFilters, parseRequest } from '@/lib/request';
import {
  badRequest,
  forbidden,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import {
  getAuthenticatedQueryCost,
  getAuthenticatedSavedFunnelQueryCost,
  getFunnelShareWorkMultiplier,
  getShareQueryCost,
  getStepFilterCount,
  reserveShareQueryCost,
} from '@/lib/share-query-budget';
import { canViewReport, canViewWebsiteSection } from '@/permissions';
import { getReport } from '@/queries/prisma';
import { type FunnelParameters, getFunnel } from '@/queries/sql/funnels/getFunnel';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; funnelId: string }> },
) {
  const {
    auth,
    query,
    error,
    admittedMinimumRangeMs = 0,
  } = await parseRequest(request, savedStatsQuerySchema);
  if (error) return error();
  const { websiteId, funnelId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'funnels'))) return unauthorized();
  const report = await getReport(funnelId);
  if (!report || report.websiteId !== websiteId || report.type !== 'funnel') return notFound();
  if (!(await canViewReport(auth, report))) return unauthorized();
  const parsed = funnelParametersSchema.safeParse(report.parameters);
  if (!parsed.success) return badRequest();
  if (auth?.shareToken) {
    const canUseCuratedFilters =
      auth.shareToken.shareType === ENTITY_TYPE.board && auth.shareToken.scopedApiAccess === true;
    if (
      auth.shareToken.parameters?.allowFilter === false &&
      getStepFilterCount(parsed.data.steps) > 0 &&
      !canUseCuratedFilters
    ) {
      return forbidden({
        message: 'Filters are disabled for this public share.',
        code: 'share-filters-disabled',
      });
    }
  }
  const multiplier = getFunnelShareWorkMultiplier(parsed.data.steps, parsed.data.window);
  const shareBase = auth?.shareToken ? getShareQueryCost(query) : null;
  const shareCombined = auth?.shareToken
    ? getShareQueryCost(query, { parameters: { steps: parsed.data.steps } }, multiplier)
    : null;
  const userBase = auth?.user?.id
    ? getAuthenticatedQueryCost(query, undefined, 1, admittedMinimumRangeMs)
    : null;
  const userCombined = auth?.user?.id
    ? getAuthenticatedSavedFunnelQueryCost(
        query,
        parsed.data.steps,
        multiplier,
        admittedMinimumRangeMs,
      )
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
  const parameters = {
    startDate: filters.startDate,
    endDate: filters.endDate,
    window: parsed.data.window,
    steps: parsed.data.steps,
  } as FunnelParameters;
  return json(await getFunnel(websiteId, parameters, filters));
}
