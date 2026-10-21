import { subMinutes } from 'date-fns';
import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, EVENT_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { ActiveVisitors } from '@/lib/types';

const FUNCTION_NAME = 'getActiveVisitors';
type ActiveVisitorCount = Pick<ActiveVisitors, 'visitors'>;

export async function getActiveVisitors(
  ...args: [websiteId: string]
): Promise<ActiveVisitors | null> {
  const result: ActiveVisitorCount | null = await runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });

  return result
    ? {
        visitors: result.visitors,
        trafficProvenance: 'may_include_unverified_public_observations',
      }
    : null;
}

async function relationalQuery(websiteId: string) {
  const { rawQuery } = prisma;
  const startDate = subMinutes(new Date(), 5);

  const result = await rawQuery(
    `
    select count(distinct session_id) as "visitors"
    from website_event
    where website_id = {{websiteId::uuid}}
    and created_at >= {{startDate}}
    and event_type != ${EVENT_TYPE.performance}
    and (event_type != ${EVENT_TYPE.customEvent} or trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
    and coalesce(is_bot, false) = false
    `,
    { websiteId, startDate },
    FUNCTION_NAME,
  );

  return result?.[0] ?? null;
}

async function clickhouseQuery(websiteId: string): Promise<ActiveVisitorCount | null> {
  const { rawQuery } = clickhouse;
  const startDate = subMinutes(new Date(), 5);

  const result = await rawQuery(
    `
    select
      count(distinct session_id) as "visitors"
    from website_event
    where website_id = {websiteId:UUID}
      and created_at >= {startDate:DateTime64}
      and event_type != ${EVENT_TYPE.performance}
      and (event_type != ${EVENT_TYPE.customEvent} or trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
      and is_bot = 0
    `,
    { websiteId, startDate },
    FUNCTION_NAME,
  );

  return result[0] ?? null;
}
