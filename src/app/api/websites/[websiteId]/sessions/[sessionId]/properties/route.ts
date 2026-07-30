import { isUuid } from '@/lib/crypto';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { canViewWebsiteSection } from '@/permissions';
import { getSessionData } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, sessionId } = await params;

  if (!isUuid(websiteId) || !isUuid(sessionId)) {
    return badRequest({ message: 'Invalid session identifier.' });
  }

  if (
    !(await canViewWebsiteSection(auth, websiteId, ['sessions', 'events', 'realtime', 'revenue']))
  ) {
    return unauthorized();
  }

  const data = await getSessionData(websiteId, sessionId);

  return json(data);
}
