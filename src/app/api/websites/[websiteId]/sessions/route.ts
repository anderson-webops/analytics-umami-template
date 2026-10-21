import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams, pagingParams, searchParams, withDateRange } from '@/lib/schema';
import { getPagedShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { getWebsiteSessions } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = withDateRange({
    ...filterParams,
    ...pagingParams,
    ...searchParams,
  });

  const { auth, query, error } = await parseRequest(request, schema, {
    shareQueryWorkMultiplier: query => getPagedShareWorkMultiplier(query.page, query.pageSize),
    capShareCount: true,
  });

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsiteSection(auth, websiteId, 'sessions'))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  let data: Awaited<ReturnType<typeof getWebsiteSessions>>;

  try {
    data = await getWebsiteSessions(websiteId, filters);
  } catch (error) {
    if (error instanceof IdentitySearchTooBroadError) {
      return badRequest({ message: 'Identity search is too broad.' });
    }
    throw error;
  }

  return json(data);
}
