import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, notImplemented, PRISMA, runQuery } from '@/lib/db';
import type { QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getEventUsage';

export function getEventUsage(...args: [websiteIds: string[], filters: QueryFilters]) {
  return runQuery({
    [PRISMA]: notImplemented,
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

function clickhouseQuery(
  websiteIds: string[],
  filters: QueryFilters,
): Promise<{ websiteId: string; count: number }[]> {
  const { rawQuery } = clickhouse;
  const { startDate, endDate, trafficType = 'human' } = filters;
  const trafficQuery =
    trafficType === 'all' ? '' : trafficType === 'bot' ? 'and is_bot = 1' : 'and is_bot = 0';

  return rawQuery(
    `
    select 
      website_id as websiteId,
      count(*) as count
    from website_event 
    where website_id in {websiteIds:Array(UUID)}
      and created_at between {startDate:DateTime64} and {endDate:DateTime64}
      ${trafficQuery}
    group by website_id
    `,
    {
      websiteIds,
      startDate,
      endDate,
    },
    FUNCTION_NAME,
  );
}
