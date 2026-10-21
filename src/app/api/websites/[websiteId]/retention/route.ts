import { retentionQuerySchema } from '@/lib/analytics-schema';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import { getRetention, type RetentionParameters } from '@/queries/sql/retention/getRetention';

const TRAFFIC_PROVENANCE = 'may_include_unverified_public_observations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, retentionQuerySchema, {
    shareQueryWorkMultiplier: 2,
  });
  if (error) return error();
  const { websiteId } = await params;
  if (!(await canViewWebsiteSection(auth, websiteId, 'retention'))) return unauthorized();
  const filters = await getQueryFilters(query, websiteId);
  const parameters = { ...query, ...filters } as RetentionParameters;
  const rows = await getRetention(websiteId, parameters, filters);
  return json(
    rows.map(row => ({ ...row, trafficProvenance: TRAFFIC_PROVENANCE })),
    { headers: { 'X-Traffic-Provenance': TRAFFIC_PROVENANCE } },
  );
}
