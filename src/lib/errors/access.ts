import { z } from 'zod';
import { ErrorQueryLimitError } from '@/lib/errors/query-limits';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { badRequest, notFound, unauthorized } from '@/lib/response';
import { getPagedShareWorkMultiplier } from '@/lib/share-query-budget';
import { canUpdateWebsite, canViewAuthenticatedWebsite } from '@/permissions';

export async function errorAccess(
  request: Request,
  params: Record<string, string>,
  schema?: z.ZodType,
  write = false,
) {
  if (Object.values(params).some(value => !z.uuid().safeParse(value).success)) {
    return { response: badRequest() };
  }
  const parsed = await parseRequest(request, schema ?? z.object({}).strict(), {
    budgetShareQuery: true,
    authenticatedQueryFanout: 5,
    shareQueryWorkMultiplier: query => {
      const paged = getPagedShareWorkMultiplier(query.page, query.pageSize);
      return paged === null ? null : paged * 5;
    },
  });
  if (parsed.error) return { response: parsed.error() };
  if (!parsed.auth?.user?.id || parsed.auth.shareToken) return { response: unauthorized() };
  const allowed = write
    ? await canUpdateWebsite(parsed.auth, params.websiteId)
    : await canViewAuthenticatedWebsite(parsed.auth, params.websiteId);
  if (!allowed) return { response: unauthorized() };
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const website = await client.website.findUnique({ where: { id: params.websiteId } });
  if (!website || website.deletedAt) return { response: notFound() };
  const issue = params.issueId
    ? await client.errorIssue.findFirst({
        where: { id: params.issueId, websiteId: params.websiteId },
      })
    : null;
  if (params.issueId && !issue) return { response: notFound() };
  return {
    ...parsed,
    website,
    issue,
    scope: { websiteId: website.id, resetAt: website.resetAt },
  };
}

export async function withErrorQuery(operation: () => Promise<Response>) {
  let response: Response;
  try {
    response = await operation();
  } catch (cause) {
    if (!(cause instanceof ErrorQueryLimitError)) throw cause;
    response = badRequest({ code: 'error-filter-too-broad', message: cause.message });
  }
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
