import { z } from 'zod';
import { isClickHouseReadLimitError } from '@/lib/clickhouse';
import { isUuid } from '@/lib/crypto';
import { isSessionDeletionAvailable } from '@/lib/db';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, unauthorized } from '@/lib/response';
import { MAX_AUTH_SESSION_ROWS, MAX_SHARE_SESSION_ROWS } from '@/lib/share-query-budget';
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

  const canDelete = isSessionDeletionAvailable() && (await canDeleteWebsite(auth, websiteId));

  const data = await getWebsiteSession(websiteId, sessionId);

  if (!data) {
    return notFound();
  }

  let sessionIds = [sessionId];
  const rowLimit = auth.shareToken ? MAX_SHARE_SESSION_ROWS : MAX_AUTH_SESSION_ROWS;
  const queryLimit = rowLimit + 1;
  const tooLarge = () =>
    badRequest({
      message: auth.shareToken ? 'Public-share session is too large.' : 'Session is too large.',
    });
  let linkedDistinctIds: string[];

  try {
    linkedDistinctIds = await getLinkedDistinctIds(websiteId, sessionId, queryLimit);
  } catch (error) {
    if (isClickHouseReadLimitError(error)) {
      return tooLarge();
    }
    throw error;
  }

  if (linkedDistinctIds.length >= queryLimit) {
    return tooLarge();
  }

  const distinctIds = linkedDistinctIds;
  const distinctId = distinctIds.length === 1 ? distinctIds[0] : undefined;

  // A collided legacy session cannot be safely attributed to one identity.
  data.distinctId = distinctId;

  if (distinctId) {
    let links: Awaited<ReturnType<typeof getLinkedSessionIds>>;

    try {
      links = await getLinkedSessionIds(websiteId, distinctId, queryLimit);
    } catch (error) {
      if (isClickHouseReadLimitError(error)) {
        if (linkedDistinctIds.length) {
          return tooLarge();
        }
        links = [];
      } else {
        throw error;
      }
    }

    if (links.length >= queryLimit) {
      return tooLarge();
    }

    const linkedIds = links.map(link => link.sessionId);

    sessionIds = Array.from(new Set([sessionId, ...linkedIds]));
  }

  const stitchedSessionCount = sessionIds.length;

  if (stitchedSessionCount > rowLimit) {
    return tooLarge();
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

  if (!isSessionDeletionAvailable()) {
    return badRequest({ message: 'Session deletion requires reviewed storage history.' });
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
    deletedSession = await deleteSession(websiteId, sessionId, auth.user.id, auth);
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
