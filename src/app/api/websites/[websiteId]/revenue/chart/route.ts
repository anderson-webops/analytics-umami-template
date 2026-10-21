import { z } from 'zod';
import { REVENUE_PROVENANCE, REVENUE_RESPONSE_HEADERS } from '@/lib/constants';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { filterParams, withDateRange } from '@/lib/schema';
import { canViewWebsiteSection } from '@/permissions';
import { getRevenueChart, type RevenuParameters } from '@/queries/sql/revenue/getRevenueChart';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = withDateRange({
    currency: z.string(),
    ...filterParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsiteSection(auth, websiteId, 'revenue'))) {
    return unauthorized();
  }

  const { currency } = query;
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...filters, currency } as RevenuParameters;

  return json(
    {
      ...(await getRevenueChart(websiteId, parameters, filters)),
      revenueProvenance: REVENUE_PROVENANCE,
    },
    { headers: REVENUE_RESPONSE_HEADERS },
  );
}
