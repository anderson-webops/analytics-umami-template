import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, DATA_TYPE, EVENT_TYPE } from '@/lib/constants';
import {
  DATE_SERIES_MAX_ROWS_TO_READ,
  DATE_SERIES_QUERY_ROW_LIMIT,
  DATE_SERIES_QUERY_TIMEOUT_MS,
  requireCompleteDateSeries,
} from '@/lib/date-series-budget';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { EventDataDateSeriesPoint, PropertyFilter, QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getSessionDataDateSeries';

export async function getSessionDataDateSeries(
  ...args: [
    websiteId: string,
    propertyName: string,
    filters: QueryFilters,
    propertyFilters?: PropertyFilter[],
  ]
): Promise<EventDataDateSeriesPoint[]> {
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
): Promise<EventDataDateSeriesPoint[]> {
  const { timezone = 'utc' } = filters;
  const { rawQuery, parseFilters, getDateSQL, getPropertyFilterQuery } = prisma;
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

  const rows = await rawQuery(
    `
    select
      ${getDateSQL('session_data.date_value', 'day', timezone)} as t,
      count(distinct session_data.session_id) as y
    from website_event
    ${cohortQuery}
    ${joinSessionQuery}
    join session_data
      on session_data.session_id = website_event.session_id
        and session_data.website_id = website_event.website_id
    where website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type != ${EVENT_TYPE.performance}
      and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
      and session_data.data_key = {{propertyName}}
      and session_data.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
      and session_data.data_type = ${DATA_TYPE.date}
      ${filterQuery}
      ${pfSQL}
    group by 1
    order by 1
    limit {{rowLimit}}
    `,
    { ...queryParams, propertyName, ...pfParams, rowLimit: DATE_SERIES_QUERY_ROW_LIMIT },
    FUNCTION_NAME,
    DATE_SERIES_QUERY_TIMEOUT_MS,
  );

  return requireCompleteDateSeries(rows);
}

async function clickhouseQuery(
  websiteId: string,
  propertyName: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
): Promise<EventDataDateSeriesPoint[]> {
  const { timezone = 'UTC' } = filters;
  const { rawQuery, parseFilters, getDateSQL, getPropertyFilterQuery } = clickhouse;
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

  const rows = await rawQuery<EventDataDateSeriesPoint[]>(
    `
    select
      ${getDateSQL('session_data.date_value', 'day', timezone)} as t,
      uniq(session_data.session_id) as y
    from website_event
    ${cohortQuery}
    join session_data final
      on session_data.session_id = website_event.session_id
        and session_data.website_id = {websiteId:UUID}
    where website_event.website_id = {websiteId:UUID}
      and website_event.created_at between {startDate:DateTime64} and {endDate:DateTime64}
      and website_event.event_type != ${EVENT_TYPE.performance}
      and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
      and session_data.data_key = {propertyName:String}
      and session_data.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
      and session_data.data_type = ${DATA_TYPE.date}
    ${filterQuery}
    ${pfSQL}
    group by t
    order by t
    limit {rowLimit:UInt32}
    `,
    { ...queryParams, propertyName, ...pfParams, rowLimit: DATE_SERIES_QUERY_ROW_LIMIT },
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
