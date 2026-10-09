import { getBoundedCompareDate, getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { filterParams, withDateRange } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getWebsiteStats } from '@/queries/sql';

function selectTrafficStats(stats: { pageviews: number; visitors: number; visits: number }) {
  return { pageviews: stats.pageviews, visitors: stats.visitors, visits: stats.visits };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = withDateRange({
    ...filterParams,
  });
  const { auth, query, error } = await parseRequest(request, schema, {
    budgetShareQuery: true,
    shareQueryWorkMultiplier: 2,
  });

  if (error) return error();

  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, ['overview', 'compare']))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);
  const data = await getWebsiteStats(websiteId, filters);
  const { startDate, endDate } = await getBoundedCompareDate(
    websiteId,
    filters.compare ?? 'prev',
    filters.startDate,
    filters.endDate,
  );
  const comparison = await getWebsiteStats(websiteId, {
    ...filters,
    startDate,
    endDate,
  });

  return json({ ...selectTrafficStats(data), comparison: selectTrafficStats(comparison) });
}
