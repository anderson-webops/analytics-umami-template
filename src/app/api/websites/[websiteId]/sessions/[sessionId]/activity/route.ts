import { endOfMonth, startOfMonth } from 'date-fns';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, FIELD_LENGTH } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import { getQueryFilters, parseRequest } from '@/lib/request';
import {
  badRequest,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import {
  getShareQueryCost,
  MAX_SHARE_SESSION_ROWS,
  reserveShareQueryCost,
} from '@/lib/share-query-budget';
import type { SessionActivity } from '@/lib/types';
import { canViewWebsiteSection } from '@/permissions';
import {
  getLinkedDistinctIds,
  getLinkedSessionIds,
  getSessionActivity,
  getWebsiteSession,
} from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    distinctId: z.string().max(FIELD_LENGTH.distinctId).optional(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

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

  const session = await getWebsiteSession(websiteId, sessionId);

  if (!session) {
    return notFound();
  }

  let sessionIds = [sessionId];
  let startAt = query.startAt;
  let endAt = query.endAt;
  const linkedDistinctIds = await getLinkedDistinctIds(websiteId, sessionId, 2);
  const distinctIds = linkedDistinctIds.length
    ? linkedDistinctIds
    : session.distinctId
      ? [session.distinctId]
      : [];

  if (query.distinctId && (distinctIds.length !== 1 || distinctIds[0] !== query.distinctId)) {
    return badRequest({ message: 'Distinct identifier does not match session.' });
  }

  if (distinctIds.length === 1) {
    const shareRowLimit = auth.shareToken ? MAX_SHARE_SESSION_ROWS + 1 : undefined;
    const links = shareRowLimit
      ? await getLinkedSessionIds(websiteId, distinctIds[0], shareRowLimit)
      : await getLinkedSessionIds(websiteId, distinctIds[0]);

    if (shareRowLimit && links.length >= shareRowLimit) {
      return badRequest({ message: 'Public-share session is too large.' });
    }

    const linkedIds = links.map(link => link.sessionId);
    const linkedDates = links
      .map(link => +new Date(link.createdAt))
      .filter(timestamp => !Number.isNaN(timestamp));

    sessionIds = Array.from(new Set([sessionId, ...linkedIds]));

    if (shareRowLimit && sessionIds.length > MAX_SHARE_SESSION_ROWS) {
      return badRequest({ message: 'Public-share session is too large.' });
    }

    if (sessionIds.length > 1 && linkedDates.length) {
      startAt = Math.min(startAt, +startOfMonth(new Date(Math.min(...linkedDates))));
      endAt = Math.max(endAt, +endOfMonth(new Date(Math.max(...linkedDates))));
    }
  }

  if (auth.shareToken) {
    const requestedCost = getShareQueryCost(query);
    const actualCost = getShareQueryCost({ ...query, startAt, endAt });

    if (!requestedCost || !actualCost) {
      return badRequest({ message: 'The public-share query is too complex.' });
    }

    const additionalCost =
      actualCost.charge -
      requestedCost.charge +
      Math.ceil((sessionIds.length - 1) / DEFAULT_PAGE_SIZE);

    if (additionalCost > 0) {
      const shareId =
        auth.shareToken.shareId ??
        auth.shareToken.websiteId ??
        auth.shareToken.boardId ??
        auth.shareToken.pixelId ??
        auth.shareToken.linkId;

      if (!shareId) {
        return unauthorized();
      }

      const limit = await reserveShareQueryCost(shareId, additionalCost);

      if (limit.unavailable) {
        return serviceUnavailable();
      }

      if (limit.blocked) {
        return tooManyRequests(limit.retryAfter);
      }
    }
  }

  const filters = await getQueryFilters({ ...query, startAt, endAt }, websiteId);

  const data = (await getSessionActivity(websiteId, sessionIds, filters)) as SessionActivity[];

  return json(data);
}
