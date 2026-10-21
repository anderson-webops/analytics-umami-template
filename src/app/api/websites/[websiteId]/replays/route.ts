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
import { canViewAuthenticatedWebsite } from '@/permissions';
import { getSessionReplays } from '@/queries/sql';

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

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewAuthenticatedWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  let data: Awaited<ReturnType<typeof getSessionReplays>>;

  try {
    data = await getSessionReplays(websiteId, filters);
  } catch (error) {
    if (error instanceof IdentitySearchTooBroadError) {
      return badRequest({ message: 'Identity search is too broad.' });
    }
    throw error;
  }

  return json(data);
}
