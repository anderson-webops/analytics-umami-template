import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import {
  filterParams,
  pagingParams,
  replayParams,
  searchParams,
  withDateRange,
} from '@/lib/schema';
import { getPagedShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewAuthenticatedWebsite } from '@/permissions';
import { getReplayDistinctIds, getSessionReplays } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = withDateRange({
    ...filterParams,
    ...replayParams,
    ...pagingParams,
    ...searchParams,
  });

  const { auth, query, error } = await parseRequest(request, schema, {
    shareQueryWorkMultiplier: query => {
      const work = getPagedShareWorkMultiplier(query.page, query.pageSize);
      return work === null ? null : work * 2;
    },
  });

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewAuthenticatedWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  let data: Awaited<ReturnType<typeof getSessionReplays>>;
  let distinctIds: Record<string, string[]>;

  try {
    data = await getSessionReplays(websiteId, filters);
    distinctIds = await getReplayDistinctIds(
      websiteId,
      data.data.map(({ id }) => id),
      filters,
    );
  } catch (error) {
    if (error instanceof IdentitySearchTooBroadError) {
      return badRequest({ message: 'Identity search is too broad.' });
    }
    throw error;
  }

  return json(
    {
      ...data,
      data: data.data.map(row => ({ ...row, distinctIds: distinctIds[row.id] ?? [] })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
