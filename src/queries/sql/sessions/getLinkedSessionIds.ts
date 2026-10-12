import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import {
  LINKED_QUERY_TIMEOUT_MS,
  MAX_AUTH_SESSION_ROWS,
  MAX_LINK_READ_ROWS,
} from '@/lib/share-query-budget';

const FUNCTION_NAME = 'getLinkedSessionIds';

export async function getLinkedSessionIds(
  ...args: [websiteId: string, distinctId: string, rowLimit: number]
): Promise<{ sessionId: string; createdAt: string }[]> {
  if (!Number.isSafeInteger(args[2]) || args[2] < 1 || args[2] > MAX_AUTH_SESSION_ROWS + 1) {
    throw new Error('LINKED_SESSION_ROW_LIMIT_INVALID');
  }

  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, distinctId: string, rowLimit: number) {
  const { rawQuery } = prisma;

  return rawQuery(
    `
    select
      session_id as "sessionId",
      created_at as "createdAt"
    from session_link
    where website_id = {{websiteId::uuid}}
      and distinct_id = {{distinctId}}
    order by session_id
    limit {{rowLimit}}
    `,
    { websiteId, distinctId, rowLimit },
    FUNCTION_NAME,
    LINKED_QUERY_TIMEOUT_MS,
  );
}

async function clickhouseQuery(websiteId: string, distinctId: string, rowLimit: number) {
  const { rawQuery } = clickhouse;

  return rawQuery(
    `
    select
      session_id as sessionId,
      min(created_at) as createdAt
    from session_link
    where website_id = {websiteId:UUID}
      and distinct_id = {distinctId:String}
    group by session_id
    limit {rowLimit:UInt32}
    `,
    { websiteId, distinctId, rowLimit },
    FUNCTION_NAME,
    {
      maxExecutionTimeSeconds: LINKED_QUERY_TIMEOUT_MS / 1000,
      maxResultRows: rowLimit,
      maxRowsToRead: MAX_LINK_READ_ROWS,
    },
  );
}
