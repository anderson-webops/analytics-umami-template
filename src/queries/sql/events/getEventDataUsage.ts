import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, notImplemented, PRISMA, runQuery } from '@/lib/db';
import type { QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getEventDataUsage';

export function getEventDataUsage(...args: [websiteIds: string[], filters: QueryFilters]) {
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
  const { startDate, endDate } = filters;

  return rawQuery(
    `
    select
      event_data.website_id as websiteId,
      count(*) as count
    from event_data
    left any join (
      select website_id, session_id, event_id, event_name, url_path, 1 as admitted
      from website_event
      where website_id in {websiteIds:Array(UUID)}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = 2
        and trust_tier = 1) website_event
    on website_event.event_id = event_data.event_id
      and website_event.session_id = event_data.session_id
      and website_event.website_id = event_data.website_id
      and website_event.event_name = event_data.event_name
      and website_event.url_path = event_data.url_path
    where event_data.created_at between {startDate:DateTime64} and {endDate:DateTime64}
      and event_data.website_id in {websiteIds:Array(UUID)}
      and event_data.trust_tier = 1
      and website_event.admitted = 1
    group by event_data.website_id
    `,
    {
      websiteIds,
      startDate,
      endDate,
    },
    FUNCTION_NAME,
  );
}
