import { errorAccess, withErrorQuery } from '@/lib/errors/access';
import { errorQuerySchema, errorUpdateSchema } from '@/lib/errors/schema';
import { json, notFound, serverError, unauthorized } from '@/lib/response';
import { canUpdateWebsite } from '@/permissions';
import { updateErrorIssue } from '@/queries/prisma/error';
import { getErrorStats } from '@/queries/sql/errors/query';

type Context = { params: Promise<{ websiteId: string; issueId: string }> };
export async function GET(request: Request, context: Context) {
  const access = await errorAccess(request, await context.params, errorQuerySchema);
  if (access.response) return access.response;
  return withErrorQuery(async () =>
    json({
      ...access.issue,
      ...(await getErrorStats(access.scope, access.query, access.issue.id)),
      canUpdate: !!(await canUpdateWebsite(access.auth, access.website.id)),
    }),
  );
}
export async function PATCH(request: Request, context: Context) {
  const access = await errorAccess(request, await context.params, errorUpdateSchema, true);
  if (access.response) return access.response;
  try {
    await updateErrorIssue(access.website.id, access.issue.id, access.body.status, access.auth);
    return json({ ok: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : undefined;
    if (message === 'ENTITY_NOT_FOUND' || message === 'ERROR_ISSUE_NOT_FOUND') return notFound();
    if (message === 'ENTITY_ACTOR_NOT_AUTHORIZED')
      return unauthorized({ message: 'Your website-update permission changed.' });
    return serverError(cause);
  }
}
