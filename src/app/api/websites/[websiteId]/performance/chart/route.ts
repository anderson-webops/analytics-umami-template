import { performanceChartQuerySchema } from '@/lib/analytics-schema';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import type { PerformanceParameters } from '@/queries/sql/performance/getPerformance';
import { getPerformanceChart } from '@/queries/sql/performance/getPerformanceChart';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, performanceChartQuerySchema);
  if (error) return error();
  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'performance'))) return unauthorized();
  const filters = await getQueryFilters(query, websiteId);
  const parameters = {
    startDate: filters.startDate,
    endDate: filters.endDate,
    unit: filters.unit,
    timezone: filters.timezone,
    metric: query.metric,
  } as PerformanceParameters;
  return json(await getPerformanceChart(websiteId, parameters, filters));
}
