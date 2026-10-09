import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import type { RevenuParameters } from '@/queries/sql/revenue/getRevenueChart';
import { getRevenueMetrics, type RevenueMetricType } from '@/queries/sql/revenue/getRevenueMetrics';
import { revenueMetricsQuerySchema } from './schema';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, revenueMetricsQuerySchema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsiteSection(auth, websiteId, 'revenue'))) {
    return unauthorized();
  }

  const { type, currency, limit } = query;
  const filters = await getQueryFilters(query, websiteId);

  if (!type) {
    return badRequest();
  }

  const parameters = { ...filters, currency } as RevenuParameters;

  const data = await getRevenueMetrics(websiteId, parameters, filters, type as RevenueMetricType);
  return json(limit ? data.slice(0, limit) : data);
}
