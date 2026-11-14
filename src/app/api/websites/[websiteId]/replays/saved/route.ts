import { z } from 'zod';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { pagingParams, searchParams } from '@/lib/schema';
import { getPagedShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewAuthenticatedWebsite } from '@/permissions';
import { getSavedReplays } from '@/queries/prisma/sessionReplay';
import { getReplayDistinctIds } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    ...pagingParams,
    ...searchParams,
  });

  const { auth, query, error } = await parseRequest(request, schema, {
    budgetShareQuery: true,
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

  let data: Awaited<ReturnType<typeof getSavedReplays>>;
  let distinctIds: Record<string, string[]>;
  try {
    data = await getSavedReplays(websiteId, query);
    distinctIds = await getReplayDistinctIds(
      websiteId,
      data.data.map(({ visitId }) => visitId),
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
      data: data.data.map(row => ({ ...row, distinctIds: distinctIds[row.visitId] ?? [] })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
