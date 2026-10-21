import { COLLECTION_TRUST_TIER } from '@/lib/constants';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import prisma from '@/lib/prisma';
import { LINKED_QUERY_TIMEOUT_MS, MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

export { IdentitySearchTooBroadError } from '@/lib/identity-search-error';

const SEARCH_ROW_LIMIT = MAX_AUTH_SESSION_ROWS + 1;

export async function getVerifiedIdentitySearchSessions(
  websiteId: string,
  search: string,
  sessionId?: string,
): Promise<string[]> {
  const rows = await prisma.rawQuery(
    `select distinct session_id as "sessionId"
     from session_link
     where website_id = {{websiteId::uuid}}
       and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
       and distinct_id ilike {{search}}
       ${sessionId ? 'and session_id = {{sessionId::uuid}}' : ''}
     limit {{rowLimit}}`,
    { websiteId, search: `%${search}%`, sessionId, rowLimit: SEARCH_ROW_LIMIT },
    'getVerifiedIdentitySearchSessions',
    LINKED_QUERY_TIMEOUT_MS,
  );

  if (rows.length >= SEARCH_ROW_LIMIT) {
    throw new IdentitySearchTooBroadError();
  }

  return (rows as { sessionId: string }[]).map(({ sessionId }) => sessionId);
}
