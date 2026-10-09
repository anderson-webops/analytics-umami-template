import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import { getConservativeSeriesBucketCount } from '@/lib/series-budget';
import type { QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getEventStats';
const DEFAULT_EVENT_SERIES_LIMIT = 50;
const MAX_EVENT_SERIES_LIMIT = 500;
const MAX_EVENT_SERIES_GROUPS = 50_000;
const EVENT_SERIES_QUERY_TIMEOUT_MS = 10_000;

export interface EventStatsParameters {
  limit?: number | string;
}

export function getEventSeriesLimit(limit?: number | string): number {
  const value = limit === undefined ? DEFAULT_EVENT_SERIES_LIMIT : Number(limit);

  if (!Number.isInteger(value) || value < 1 || value > MAX_EVENT_SERIES_LIMIT) {
    throw new Error('Invalid event series limit.');
  }

  return value;
}

export function isEventSeriesWithinBudget(limit: number, filters: QueryFilters): boolean {
  const buckets = getConservativeSeriesBucketCount(filters);

  return (
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_EVENT_SERIES_LIMIT &&
    buckets > 0 &&
    limit * buckets <= MAX_EVENT_SERIES_GROUPS
  );
}

interface WebsiteEventMetric {
  x: string;
  t: string;
  y: number;
}

export async function getEventStats(
  ...args: [websiteId: string, parameters: EventStatsParameters, filters: QueryFilters]
): Promise<WebsiteEventMetric[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  parameters: EventStatsParameters,
  filters: QueryFilters,
) {
  const limit = getEventSeriesLimit(parameters.limit);
  const { timezone = 'utc', unit = 'day' } = filters;
  const { rawQuery, getDateSQL, parseFilters } = prisma;
  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  return rawQuery(
    `
    with matched_events as (
      select website_event.event_name, website_event.created_at
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId::uuid}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type = 2
        ${filterQuery}
    ), top_names as (
      select event_name
      from matched_events
      group by event_name
      order by count(*) desc, event_name
      limit {{limit}}
    )
    select
      matched_events.event_name x,
      ${getDateSQL('matched_events.created_at', unit, timezone)} t,
      count(*) y
    from matched_events
    join top_names on top_names.event_name = matched_events.event_name
    group by 1, 2
    order by 2
    `,
    { ...queryParams, limit },
    FUNCTION_NAME,
    EVENT_SERIES_QUERY_TIMEOUT_MS,
  );
}

async function clickhouseQuery(
  websiteId: string,
  parameters: EventStatsParameters,
  filters: QueryFilters,
): Promise<{ x: string; t: string; y: number }[]> {
  const limit = getEventSeriesLimit(parameters.limit);
  const { timezone = 'UTC', unit = 'day' } = filters;
  const { rawQuery, getDateSQL, parseFilters } = clickhouse;
  const { filterQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  let sql = '';

  if (filterQuery || cohortQuery) {
    sql = `
    select
      event_name x,
      ${getDateSQL('created_at', unit, timezone)} t,
      count(*) y
    from website_event
    ${cohortQuery}
    where website_id = {websiteId:UUID}
      and created_at between {startDate:DateTime64} and {endDate:DateTime64}
      and event_type = 2
      ${filterQuery}
      and event_name in (
        select event_name
        from website_event
        ${cohortQuery}
        where website_id = {websiteId:UUID}
          and created_at between {startDate:DateTime64} and {endDate:DateTime64}
          and event_type = 2
          ${filterQuery}
        group by event_name
        order by count(*) desc, event_name
        limit {limit:UInt32}
      )
    group by x, t
    order by t
    `;
  } else {
    sql = `
    select
      event_name x,
      ${getDateSQL('created_at', unit, timezone)} t,
      count(*) y
    from (
      select arrayJoin(event_name) as event_name,
        created_at
      from website_event_stats_hourly website_event
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = 2
    ) as g
    where g.event_name in (
      select arrayJoin(event_name) as ranked_name
      from website_event_stats_hourly
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = 2
      group by ranked_name
      order by count(*) desc, ranked_name
      limit {limit:UInt32}
    )
    group by x, t
    order by t
    `;
  }

  return rawQuery(sql, { ...queryParams, limit }, FUNCTION_NAME, {
    maxExecutionTimeSeconds: EVENT_SERIES_QUERY_TIMEOUT_MS / 1000,
    maxResultRows: MAX_EVENT_SERIES_GROUPS,
  });
}
