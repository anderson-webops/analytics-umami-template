import { isUuid } from '@/lib/crypto';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  json,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import { reserveShareQueryCost } from '@/lib/share-query-budget';
import { canViewWebsite, canViewWebsiteSection } from '@/permissions';
import { getEventDataById } from '@/queries/sql/events/getEventDataById';

const SHARED_EVENT_DATA_COST = 8;
const MAX_SHARED_EVENT_DATA_ROWS = 500;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; eventId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, eventId } = await params;

  if (!isUuid(websiteId) || !isUuid(eventId)) {
    return badRequest({ message: 'Invalid event identifier.' });
  }

  if (!(await canViewWebsiteSection(auth, websiteId, 'events'))) {
    return unauthorized();
  }

  const isPublicShare =
    !!auth.shareToken && !(auth.user && (await canViewWebsite({ user: auth.user }, websiteId)));

  if (isPublicShare) {
    const shareId =
      auth.shareToken.shareId ??
      auth.shareToken.websiteId ??
      auth.shareToken.boardId ??
      auth.shareToken.pixelId ??
      auth.shareToken.linkId;

    if (!shareId) {
      return unauthorized();
    }

    const limit = await reserveShareQueryCost(shareId, SHARED_EVENT_DATA_COST, request);

    if (limit.unavailable) {
      return serviceUnavailable();
    }

    if (limit.blocked) {
      return tooManyRequests(limit.retryAfter);
    }
  }

  const rowLimit = isPublicShare ? MAX_SHARED_EVENT_DATA_ROWS + 1 : undefined;
  const data = await getEventDataById(websiteId, eventId, rowLimit);

  if (rowLimit && data.length >= rowLimit) {
    return badRequest({ message: 'Public-share event is too large.' });
  }

  return json(data);
}
