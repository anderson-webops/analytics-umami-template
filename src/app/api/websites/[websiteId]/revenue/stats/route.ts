import { z } from 'zod';
import { getBoundedCompareDate, getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { filterParams, withDateRange } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import type { RevenuParameters } from '@/queries/sql/revenue/getRevenueChart';
import { getRevenueStats } from '@/queries/sql/revenue/getRevenueStats';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { websiteId } = await params;
  const schema = withDateRange({
    currency: z.string(),
    ...filterParams,
  });

  const { auth, query, error } = await parseRequest(request, schema, {
    budgetShareQuery: true,
    shareQueryContext: { section: 'revenue', websiteId },
    shareQueryWorkMultiplier: 3,
  });

  if (error) {
    return error();
  }

  if (!(await canViewWebsiteSection(auth, websiteId, 'revenue'))) {
    return unauthorized();
  }

  const { currency } = query;
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...filters, currency } as RevenuParameters;
  const { compare = 'prev' } = parameters;
  const { startDate, endDate } = await getBoundedCompareDate(
    websiteId,
    compare,
    parameters.startDate,
    parameters.endDate,
  );
  const comparisonParameters = { ...parameters, startDate, endDate };

  const [stats, comparison] = await Promise.all([
    getRevenueStats(websiteId, parameters, filters),
    getRevenueStats(websiteId, comparisonParameters, filters),
  ]);

  return json({ ...stats, comparison });
}
