import { z } from 'zod';
import { isUuid } from '@/lib/crypto';
import { isRelationalOnly } from '@/lib/db';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, unauthorized } from '@/lib/response';
import { MAX_SHARE_SESSION_ROWS } from '@/lib/share-query-budget';
import { canDeleteWebsite, canViewWebsiteSection } from '@/permissions';
import { deleteSession } from '@/queries/prisma';
import { getLinkedDistinctIds, getLinkedSessionIds, getWebsiteSession } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const { auth, error } = await parseRequest(request, z.object({}), {
    budgetShareQuery: true,
    shareQueryWorkMultiplier: 8,
  });

  if (error) {
    return error();
  }

  const { websiteId, sessionId } = await params;

  if (!isUuid(websiteId) || !isUuid(sessionId)) {
    return badRequest({ message: 'Invalid session identifier.' });
  }

  if (!(await canViewWebsiteSection(auth, websiteId, 'sessions'))) {
    return unauthorized();
  }

  const canDelete = isRelationalOnly() && (await canDeleteWebsite(auth, websiteId));

  const data = await getWebsiteSession(websiteId, sessionId);

  if (!data) {
    return notFound();
  }

  let sessionIds = [sessionId];
  const shareRowLimit = auth.shareToken ? MAX_SHARE_SESSION_ROWS + 1 : undefined;
  const linkedDistinctIds = await getLinkedDistinctIds(websiteId, sessionId, shareRowLimit);

  if (shareRowLimit && linkedDistinctIds.length >= shareRowLimit) {
    return badRequest({ message: 'Public-share session is too large.' });
  }

  const distinctIds = linkedDistinctIds.length
    ? linkedDistinctIds
    : data.distinctId
      ? [data.distinctId]
      : [];
  const distinctId = distinctIds.length === 1 ? distinctIds[0] : undefined;

  // A collided legacy session cannot be safely attributed to one identity.
  data.distinctId = distinctId;

  if (distinctId) {
    const links = await getLinkedSessionIds(websiteId, distinctId, shareRowLimit);

    if (shareRowLimit && links.length >= shareRowLimit) {
      return badRequest({ message: 'Public-share session is too large.' });
    }

    const linkedIds = links.map(link => link.sessionId);

    sessionIds = Array.from(new Set([sessionId, ...linkedIds]));
  }

  const stitchedSessionCount = sessionIds.length;

  if (shareRowLimit && stitchedSessionCount > MAX_SHARE_SESSION_ROWS) {
    return badRequest({ message: 'Public-share session is too large.' });
  }

  return json({
    ...data,
    canDelete,
    distinctIds,
    stitchedSessionCount,
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!isRelationalOnly()) {
    return badRequest({ message: 'Session deletion is only available with relational storage.' });
  }

  const { websiteId, sessionId } = await params;

  if (!isUuid(websiteId) || !isUuid(sessionId)) {
    return badRequest({ message: 'Invalid session identifier.' });
  }

  if (!(await canDeleteWebsite(auth, websiteId))) {
    return unauthorized();
  }

  let deletedSession;

  try {
    deletedSession = await deleteSession(websiteId, sessionId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_NOT_FOUND':
        return notFound({ message: 'Website not found.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your website-delete permission changed.' });
      default:
        throw error;
    }
  }

  if (!deletedSession) {
    return notFound();
  }

  return ok();
}
