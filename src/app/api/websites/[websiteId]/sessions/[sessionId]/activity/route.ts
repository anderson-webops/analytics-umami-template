import { endOfMonth, startOfMonth } from 'date-fns';
import { z } from 'zod';
import { isClickHouseReadLimitError } from '@/lib/clickhouse';
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
  getAuthenticatedQueryCost,
  getShareQueryCost,
  LINKED_IDENTITY_LOOKUP_COST,
  MAX_AUTH_SESSION_ROWS,
  MAX_SHARE_SESSION_ROWS,
  reserveAuthenticatedQueryCost,
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

  const reserveActivityWork = async (cost: number) => {
    let limit;

    if (auth.shareToken) {
      const shareId =
        auth.shareToken.shareId ??
        auth.shareToken.websiteId ??
        auth.shareToken.boardId ??
        auth.shareToken.pixelId ??
        auth.shareToken.linkId;

      if (!shareId) {
        return unauthorized();
      }

      limit = await reserveShareQueryCost(shareId, cost, 0);
    } else {
      if (!auth.user?.id) {
        return unauthorized();
      }

      limit = await reserveAuthenticatedQueryCost(auth.user.id, cost, 0);
    }

    if (limit.unavailable) {
      return serviceUnavailable();
    }

    if (limit.blocked) {
      return tooManyRequests(limit.retryAfter);
    }

    return null;
  };

  const tooLarge = () =>
    badRequest({
      message: auth.shareToken ? 'Public-share session is too large.' : 'Session is too large.',
    });

  const identityLookupLimit = await reserveActivityWork(LINKED_IDENTITY_LOOKUP_COST);

  if (identityLookupLimit) {
    return identityLookupLimit;
  }

  let sessionIds = [sessionId];
  let startAt = query.startAt;
  let endAt = query.endAt;
  let linkedDistinctIds: string[];

  try {
    linkedDistinctIds = await getLinkedDistinctIds(websiteId, sessionId, 2);
  } catch (error) {
    if (isClickHouseReadLimitError(error)) {
      return tooLarge();
    }
    throw error;
  }
  const distinctIds = linkedDistinctIds.length
    ? linkedDistinctIds
    : session.distinctId
      ? [session.distinctId]
      : [];

  if (query.distinctId && (distinctIds.length !== 1 || distinctIds[0] !== query.distinctId)) {
    return badRequest({ message: 'Distinct identifier does not match session.' });
  }

  if (distinctIds.length === 1) {
    const rowLimit = auth.shareToken ? MAX_SHARE_SESSION_ROWS : MAX_AUTH_SESSION_ROWS;
    const discoveryLimit = await reserveActivityWork(Math.ceil(rowLimit / DEFAULT_PAGE_SIZE) + 1);

    if (discoveryLimit) {
      return discoveryLimit;
    }

    let links: Awaited<ReturnType<typeof getLinkedSessionIds>>;

    try {
      links = await getLinkedSessionIds(websiteId, distinctIds[0], rowLimit + 1);
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

    if (linkedDistinctIds.length === 0 && links.length >= rowLimit) {
      links = [];
    } else if (links.length > rowLimit) {
      return tooLarge();
    }

    const linkedIds = links.map(link => link.sessionId);
    const linkedDates = links
      .map(link => +new Date(link.createdAt))
      .filter(timestamp => !Number.isNaN(timestamp));

    sessionIds = Array.from(new Set([sessionId, ...linkedIds]));

    if (sessionIds.length > rowLimit) {
      return tooLarge();
    }

    if (sessionIds.length > 1 && linkedDates.length) {
      startAt = Math.min(startAt, +startOfMonth(new Date(Math.min(...linkedDates))));
      endAt = Math.max(endAt, +endOfMonth(new Date(Math.max(...linkedDates))));
    }
  }

  const getCost = auth.shareToken ? getShareQueryCost : getAuthenticatedQueryCost;
  const requestedCost = getCost(query);
  const actualCost = getCost({ ...query, startAt, endAt });

  if (!requestedCost || !actualCost) {
    return badRequest({
      message: auth.shareToken
        ? 'The public-share query is too complex.'
        : 'The analytics query is too complex.',
    });
  }

  const additionalCost =
    actualCost.charge -
    requestedCost.charge +
    (auth.shareToken
      ? Math.ceil((sessionIds.length - 1) / DEFAULT_PAGE_SIZE)
      : sessionIds.length - 1);

  if (additionalCost > 0) {
    const expandedLimit = await reserveActivityWork(additionalCost);

    if (expandedLimit) {
      return expandedLimit;
    }
  }

  const filters = await getQueryFilters({ ...query, startAt, endAt }, websiteId);

  const data = (await getSessionActivity(websiteId, sessionIds, filters)) as SessionActivity[];

  return json(data);
}
