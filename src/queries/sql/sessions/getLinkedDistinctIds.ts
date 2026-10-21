import { COLLECTION_TRUST_TIER } from '@/lib/constants';
import prisma from '@/lib/prisma';
import { LINKED_QUERY_TIMEOUT_MS, MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

const FUNCTION_NAME = 'getLinkedDistinctIds';

export async function getLinkedDistinctIds(
  ...args: [websiteId: string, sessionId: string, rowLimit: number]
): Promise<string[]> {
  if (!Number.isSafeInteger(args[2]) || args[2] < 1 || args[2] > MAX_AUTH_SESSION_ROWS + 1) {
    throw new Error('LINKED_SESSION_ROW_LIMIT_INVALID');
  }

  return relationalQuery(...args);
}

async function relationalQuery(
  websiteId: string,
  sessionId: string,
  rowLimit: number,
): Promise<string[]> {
  const { rawQuery } = prisma;

  return rawQuery(
    `
    select distinct_id as "distinctId"
    from session_link
    where website_id = {{websiteId::uuid}}
      and session_id = {{sessionId::uuid}}
      and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
    limit {{rowLimit}}
    `,
    { websiteId, sessionId, rowLimit },
    FUNCTION_NAME,
    LINKED_QUERY_TIMEOUT_MS,
  ).then(result => (result as { distinctId: string }[]).map(({ distinctId }) => distinctId));
}
