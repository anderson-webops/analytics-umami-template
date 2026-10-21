import { COLLECTION_TRUST_TIER } from '@/lib/constants';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import prisma from '@/lib/prisma';
import { LINKED_QUERY_TIMEOUT_MS, MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

export interface VerifiedIdentityLink {
  sessionId: string;
  distinctId: string;
}

export async function getVerifiedIdentityLinks(
  websiteId: string,
  sessionIds: string[],
): Promise<VerifiedIdentityLink[]> {
  if (sessionIds.length === 0) {
    return [];
  }

  if (sessionIds.length > MAX_AUTH_SESSION_ROWS) {
    throw new IdentitySearchTooBroadError();
  }

  const rows = await prisma.rawQuery(
    `select session_id as "sessionId", distinct_id as "distinctId"
     from session_link
     where website_id = {{websiteId::uuid}}
       and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
       and session_id = any({{sessionIds}}::uuid[])
       and distinct_id != ''
     limit {{rowLimit}}`,
    { websiteId, sessionIds, rowLimit: MAX_AUTH_SESSION_ROWS + 1 },
    'getVerifiedIdentityLinks',
    LINKED_QUERY_TIMEOUT_MS,
  );

  if (rows.length > MAX_AUTH_SESSION_ROWS) {
    throw new IdentitySearchTooBroadError();
  }

  return rows as VerifiedIdentityLink[];
}
