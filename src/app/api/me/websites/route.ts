import { z } from 'zod';
import { redactWebsiteShareId } from '@/lib/api-key';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { pagingParams, sortingParams } from '@/lib/schema';
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
      data: websites.data.map(website => redactWebsiteShareId(website, auth.authType, true)),
    });
  }

  const websites = await getUserWebsites(auth.user.id, filters);
  return json({
    ...websites,
    data: websites.data.map(website => redactWebsiteShareId(website, auth.authType, true)),
  });
}
