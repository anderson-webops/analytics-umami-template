import { z } from 'zod';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { pagingParams, sortingParams } from '@/lib/schema';
import { redactWebsiteListShareIds } from '@/permissions';
import { getAllUserWebsitesIncludingTeamAccess, getUserWebsites } from '@/queries/prisma';

export async function GET(request: Request) {
  const schema = z.object({
    ...pagingParams,
    ...sortingParams,
    includeTeams: z.string().optional(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const filters = await getQueryFilters(query);

  if (query.includeTeams) {
    const websites = await getAllUserWebsitesIncludingTeamAccess(auth.user.id, filters);
    return json({
      ...websites,
      data: await redactWebsiteListShareIds(auth, websites.data),
    });
  }

  const websites = await getUserWebsites(auth.user.id, filters);
  return json({
    ...websites,
    data: await redactWebsiteListShareIds(auth, websites.data),
  });
}
