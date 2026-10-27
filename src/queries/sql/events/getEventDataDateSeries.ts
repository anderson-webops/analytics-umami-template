import clickhouse from '@/lib/clickhouse';
import { DATA_TYPE } from '@/lib/constants';
import {
  DATE_SERIES_MAX_ROWS_TO_READ,
  DATE_SERIES_QUERY_ROW_LIMIT,
  DATE_SERIES_QUERY_TIMEOUT_MS,
  requireCompleteDateSeries,
} from '@/lib/date-series-budget';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { EventDataDateSeriesPoint, EventPropertyFilter, QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getEventDataDateSeries';

export async function getEventDataDateSeries(
  ...args: [
    websiteId: string,
    eventName: string,
    propertyName: string,
    filters: QueryFilters,
    eventFilters?: EventPropertyFilter[],
  ]
): Promise<EventDataDateSeriesPoint[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  eventName: string,
  propertyName: string,
  filters: QueryFilters,
  eventFilters: EventPropertyFilter[] = [],
): Promise<EventDataDateSeriesPoint[]> {
  const { timezone = 'utc' } = filters;
  const { rawQuery, parseFilters, getDateSQL, getPropertyFilterQuery } = prisma;
  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(eventFilters, 'event', timezone);

  const rows = await rawQuery(
    `
    select
      ${getDateSQL('event_data.date_value', 'day', timezone)} as t,
      count(*) as y
    from event_data
    join website_event on website_event.event_id = event_data.website_event_id
      and website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type = 2
      and website_event.event_name = {{eventName}}
    ${cohortQuery}
    ${joinSessionQuery}
    where event_data.website_id = {{websiteId::uuid}}
      and event_data.trust_tier = 1
      and website_event.trust_tier = 1
      and event_data.created_at between {{startDate}} and {{endDate}}
      and event_data.data_key = {{propertyName}}
      and event_data.data_type = ${DATA_TYPE.date}
      ${filterQuery}
      ${pfSQL}
    group by 1
    order by 1
    limit {{rowLimit}}
    `,
    { ...queryParams, eventName, propertyName, ...pfParams, rowLimit: DATE_SERIES_QUERY_ROW_LIMIT },
    FUNCTION_NAME,
    DATE_SERIES_QUERY_TIMEOUT_MS,
  );

  return requireCompleteDateSeries(rows);
}

async function clickhouseQuery(
  websiteId: string,
  eventName: string,
  propertyName: string,
  filters: QueryFilters,
  eventFilters: EventPropertyFilter[] = [],
): Promise<EventDataDateSeriesPoint[]> {
  const { timezone = 'UTC' } = filters;
  const { rawQuery, parseFilters, getDateSQL, getPropertyFilterQuery } = clickhouse;
  const { filterQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(eventFilters, 'event', timezone);

  const rows = await rawQuery<EventDataDateSeriesPoint[]>(
    `
    select
      ${getDateSQL('event_data.date_value', 'day', timezone)} as t,
      count() as y
    from event_data
    left any join (
          select *, 1 as admitted
          from website_event
          where website_id = {websiteId:UUID}
            and created_at between {startDate:DateTime64} and {endDate:DateTime64}
            and event_type = 2
            and trust_tier = 1
            and event_name = {eventName:String}) website_event
    on website_event.event_id = event_data.event_id
      and website_event.session_id = event_data.session_id
        and website_event.website_id = event_data.website_id
        and website_event.event_name = event_data.event_name
        and website_event.url_path = event_data.url_path
    ${cohortQuery}
    where event_data.website_id = {websiteId:UUID}
      and website_event.admitted = 1
      and event_data.trust_tier = 1
      and event_data.created_at between {startDate:DateTime64} and {endDate:DateTime64}
      and event_data.event_name = {eventName:String}
      and event_data.data_key = {propertyName:String}
      and event_data.data_type = ${DATA_TYPE.date}
    ${filterQuery}
    ${pfSQL}
    group by t
    order by t
    limit {rowLimit:UInt32}
    `,
    { ...queryParams, eventName, propertyName, ...pfParams, rowLimit: DATE_SERIES_QUERY_ROW_LIMIT },
    FUNCTION_NAME,
    {
      maxExecutionTimeSeconds: DATE_SERIES_QUERY_TIMEOUT_MS / 1000,
      maxResultRows: DATE_SERIES_QUERY_ROW_LIMIT,
      maxRowsToRead: DATE_SERIES_MAX_ROWS_TO_READ,
      maxRowsToGroupBy: DATE_SERIES_QUERY_ROW_LIMIT,
      maxThreads: 2,
    },
  );

  return requireCompleteDateSeries(rows);
}
