import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';

const FUNCTION_NAME = 'getLinkedSessionIds';

export async function getLinkedSessionIds(
  ...args: [websiteId: string, distinctId: string, rowLimit?: number]
): Promise<{ sessionId: string; createdAt: string }[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, distinctId: string, rowLimit?: number) {
  const { rawQuery } = prisma;

  return rawQuery(
    `
    select
      session_id as "sessionId",
      min(created_at) as "createdAt"
    from session_link
    where website_id = {{websiteId::uuid}}
      and distinct_id = {{distinctId}}
    group by session_id
    ${rowLimit === undefined ? '' : 'limit {{rowLimit}}'}
    `,
    { websiteId, distinctId, rowLimit },
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(websiteId: string, distinctId: string, rowLimit?: number) {
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
    ${rowLimit === undefined ? '' : 'limit {rowLimit:UInt32}'}
    `,
    { websiteId, distinctId, rowLimit },
    FUNCTION_NAME,
  );
}
