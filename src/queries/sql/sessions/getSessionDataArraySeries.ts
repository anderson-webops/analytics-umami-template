import clickhouse from '@/lib/clickhouse';
import { DATA_TYPE, EVENT_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import {
  getPropertySeriesValueLimit,
  MAX_PROPERTY_SERIES_POINTS,
  PROPERTY_SERIES_QUERY_TIMEOUT_MS,
} from '@/lib/property-series-budget';
import type { EventDataSeriesPoint, PropertyFilter, QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getSessionDataArraySeries';

export async function getSessionDataArraySeries(
  ...args: [
    websiteId: string,
    propertyName: string,
    filters: QueryFilters,
    propertyFilters?: PropertyFilter[],
  ]
): Promise<EventDataSeriesPoint[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  propertyName: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
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
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(
    propertyFilters,
    'session',
    timezone,
  );

  return rawQuery(
    `
    with matched_data as (
      select array_item.value as x, session_data.created_at, session_data.session_id
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      join session_data
        on session_data.session_id = website_event.session_id
          and session_data.website_id = website_event.website_id
      cross join lateral jsonb_array_elements_text(coalesce(session_data.string_value, '[]')::jsonb) as array_item(value)
      where website_event.website_id = {{websiteId::uuid}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type != ${EVENT_TYPE.performance}
        and session_data.created_at between {{startDate}} and {{endDate}}
        and session_data.data_key = {{propertyName}}
        and session_data.data_type = ${DATA_TYPE.array}
        ${filterQuery}
        ${pfSQL}
    ), top_values as (
      select x
      from matched_data
      group by x
      order by count(distinct session_id) desc, x
      limit {{valueLimit}}
    )
    select
      matched_data.x,
      ${getDateSQL('matched_data.created_at', unit, timezone)} as t,
      count(distinct matched_data.session_id) as y
    from matched_data
    join top_values on top_values.x is not distinct from matched_data.x
    group by 1, 2
    order by 2
    `,
    { ...queryParams, propertyName, ...pfParams, valueLimit },
    FUNCTION_NAME,
    PROPERTY_SERIES_QUERY_TIMEOUT_MS,
  );
}

async function clickhouseQuery(
  websiteId: string,
  propertyName: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
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
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(
    propertyFilters,
    'session',
    timezone,
  );

  return rawQuery(
    `
    with matched_data as (
      select arrayJoin(JSONExtract(ifNull(session_data.string_value, '[]'), 'Array(String)')) as x,
        session_data.created_at, session_data.session_id
      from website_event
      ${cohortQuery}
      join session_data final
        on session_data.session_id = website_event.session_id
          and session_data.website_id = {websiteId:UUID}
      where website_event.website_id = {websiteId:UUID}
        and website_event.created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and website_event.event_type != ${EVENT_TYPE.performance}
        and session_data.created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and session_data.data_key = {propertyName:String}
        and session_data.data_type = ${DATA_TYPE.array}
        ${filterQuery}
        ${pfSQL}
    ), top_values as (
      select x
      from matched_data
      group by x
      order by uniq(session_id) desc, x
      limit {valueLimit:UInt32}
    )
    select
      matched_data.x as x,
      ${getDateSQL('matched_data.created_at', unit, timezone)} as t,
      uniq(matched_data.session_id) as y
    from matched_data
    inner join top_values on top_values.x = matched_data.x
    group by x, t
    order by t
    `,
    { ...queryParams, propertyName, ...pfParams, valueLimit },
    FUNCTION_NAME,
    {
      maxExecutionTimeSeconds: PROPERTY_SERIES_QUERY_TIMEOUT_MS / 1000,
      maxResultRows: MAX_PROPERTY_SERIES_POINTS,
    },
  );
}
