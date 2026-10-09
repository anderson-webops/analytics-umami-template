import clickhouse from '@/lib/clickhouse';
import { DATA_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import {
  getPropertySeriesValueLimit,
  MAX_PROPERTY_SERIES_POINTS,
  PROPERTY_SERIES_QUERY_TIMEOUT_MS,
} from '@/lib/property-series-budget';
import type { EventDataSeriesPoint, EventPropertyFilter, QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getEventDataPropertySeries';

export async function getEventDataPropertySeries(
  ...args: [
    websiteId: string,
    eventName: string,
    propertyName: string,
    filters: QueryFilters,
    eventFilters?: EventPropertyFilter[],
  ]
): Promise<EventDataSeriesPoint[]> {
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
): Promise<EventDataSeriesPoint[]> {
  const valueLimit = getPropertySeriesValueLimit(filters);

  if (!valueLimit) {
    throw new Error('The requested property series exceeds the allowed size.');
  }

  const { timezone = 'utc', unit = 'day' } = filters;
  const { rawQuery, getDateSQL, parseFilters, getPropertyFilterQuery } = prisma;
  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(eventFilters, 'event', timezone);

  return rawQuery(
    `
    with matched_data as (
      select event_data.string_value as x, event_data.created_at
      from event_data
      join website_event on website_event.event_id = event_data.website_event_id
        and website_event.website_id = {{websiteId::uuid}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type = 2
        and website_event.event_name = {{eventName}}
      ${cohortQuery}
      ${joinSessionQuery}
      where event_data.website_id = {{websiteId::uuid}}
        and event_data.created_at between {{startDate}} and {{endDate}}
        and event_data.data_key = {{propertyName}}
        and event_data.data_type in (${DATA_TYPE.string}, ${DATA_TYPE.boolean})
        ${filterQuery}
        ${pfSQL}
    ), top_values as (
      select x
      from matched_data
      group by x
      order by count(*) desc, x
      limit {{valueLimit}}
    )
    select
      matched_data.x,
      ${getDateSQL('matched_data.created_at', unit, timezone)} t,
      count(*) y
    from matched_data
    join top_values on top_values.x is not distinct from matched_data.x
    group by 1, 2
    order by 2
    `,
    { ...queryParams, eventName, propertyName, ...pfParams, valueLimit },
    FUNCTION_NAME,
    PROPERTY_SERIES_QUERY_TIMEOUT_MS,
  );
}

async function clickhouseQuery(
  websiteId: string,
  eventName: string,
  propertyName: string,
  filters: QueryFilters,
  eventFilters: EventPropertyFilter[] = [],
): Promise<EventDataSeriesPoint[]> {
  const valueLimit = getPropertySeriesValueLimit(filters);

  if (!valueLimit) {
    throw new Error('The requested property series exceeds the allowed size.');
  }

  const { timezone = 'UTC', unit = 'day' } = filters;
  const { rawQuery, getDateSQL, parseFilters, getPropertyFilterQuery } = clickhouse;
  const { filterQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(eventFilters, 'event', timezone);

  return rawQuery(
    `
    with matched_data as (
      select event_data.string_value as x,
        tuple(isNull(event_data.string_value), ifNull(event_data.string_value, '')) as x_key,
        event_data.created_at
      from event_data
      any left join (
            select *
            from website_event
            where website_id = {websiteId:UUID}
              and created_at between {startDate:DateTime64} and {endDate:DateTime64}
              and event_type = 2
              and event_name = {eventName:String}) website_event
      on website_event.event_id = event_data.event_id
        and website_event.session_id = event_data.session_id
        and website_event.website_id = event_data.website_id
      ${cohortQuery}
      where event_data.website_id = {websiteId:UUID}
        and event_data.created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_data.event_name = {eventName:String}
        and event_data.data_key = {propertyName:String}
        and event_data.data_type in (${DATA_TYPE.string}, ${DATA_TYPE.boolean})
        and (isNull(event_data.string_value) or lengthUTF8(event_data.string_value) <= 500)
        ${filterQuery}
        ${pfSQL}
    ), top_values as (
      select x_key
      from matched_data
      group by x_key
      order by count() desc, x_key
      limit {valueLimit:UInt32}
    )
    select
      matched_data.x as x,
      ${getDateSQL('matched_data.created_at', unit, timezone)} as t,
      count() as y
    from matched_data
    inner join top_values on top_values.x_key = matched_data.x_key
    group by x, t
    order by t
    `,
    { ...queryParams, eventName, propertyName, ...pfParams, valueLimit },
    FUNCTION_NAME,
    {
      maxExecutionTimeSeconds: PROPERTY_SERIES_QUERY_TIMEOUT_MS / 1000,
      maxResultRows: MAX_PROPERTY_SERIES_POINTS,
    },
  );
}
