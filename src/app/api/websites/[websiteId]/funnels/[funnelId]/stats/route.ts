import { funnelParametersSchema, savedStatsQuerySchema } from '@/lib/analytics-schema';
import { ENTITY_TYPE } from '@/lib/constants';
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
  const { auth, query, error } = await parseRequest(request, savedStatsQuerySchema);
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

    const base = getShareQueryCost(query);
    const combined = getShareQueryCost(
      query,
      { parameters: { steps: parsed.data.steps } },
      getFunnelShareWorkMultiplier(parsed.data.steps, parsed.data.window),
    );
    if (!base || !combined) {
      return badRequest({ message: 'The public-share query is too complex.' });
    }

    const shareId = auth.shareToken.shareId ?? auth.shareToken.websiteId;
    if (!shareId) return unauthorized();
    const extraCharge = combined.charge - base.charge;
    if (extraCharge > 0) {
      const limit = await reserveShareQueryCost(shareId, extraCharge);
      if (limit.unavailable) return serviceUnavailable();
      if (limit.blocked) return tooManyRequests(limit.retryAfter);
    }
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
