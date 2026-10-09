import { z } from 'zod';
import { isUuid } from '@/lib/crypto';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { MAX_SHARE_SESSION_ROWS } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { getSessionData } from '@/queries/sql';

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

  const shareRowLimit = auth.shareToken ? MAX_SHARE_SESSION_ROWS + 1 : undefined;
  const data = await getSessionData(websiteId, sessionId, shareRowLimit);

  if (shareRowLimit && data.length >= shareRowLimit) {
    return badRequest({ message: 'Public-share session is too large.' });
  }

  return json(data);
}
