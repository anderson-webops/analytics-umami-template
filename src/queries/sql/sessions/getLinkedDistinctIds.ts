import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import { MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

const FUNCTION_NAME = 'getLinkedDistinctIds';

export async function getLinkedDistinctIds(
  ...args: [websiteId: string, sessionId: string, rowLimit: number]
): Promise<string[]> {
  if (!Number.isSafeInteger(args[2]) || args[2] < 1 || args[2] > MAX_AUTH_SESSION_ROWS + 1) {
    throw new Error('LINKED_SESSION_ROW_LIMIT_INVALID');
  }

  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  sessionId: string,
  rowLimit: number,
): Promise<string[]> {
  const { rawQuery } = prisma;

  return rawQuery(
    `
    select distinct distinct_id as "distinctId"
    from session_link
    where website_id = {{websiteId::uuid}}
      and session_id = {{sessionId::uuid}}
    limit {{rowLimit}}
    `,
    { websiteId, sessionId, rowLimit },
    FUNCTION_NAME,
  ).then(result => (result as { distinctId: string }[]).map(({ distinctId }) => distinctId));
}

async function clickhouseQuery(
  websiteId: string,
  sessionId: string,
  rowLimit: number,
): Promise<string[]> {
  const { rawQuery } = clickhouse;

  return rawQuery(
    `
    select distinct distinct_id as distinctId
    from session_link
    where website_id = {websiteId:UUID}
      and session_id = {sessionId:UUID}
    limit {rowLimit:UInt32}
    `,
    { websiteId, sessionId, rowLimit },
    FUNCTION_NAME,
  ).then(result => (result as { distinctId: string }[]).map(({ distinctId }) => distinctId));
}
