import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, EVENT_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { PropertyFilter, PropertyMetric, QueryFilters } from '@/lib/types';
import { boundedClickhouseDiscovery, boundedPostgresDiscovery } from '../events/discoveryBudget';

const FUNCTION_NAME = 'getSessionDataProperties';

export async function getSessionDataProperties(
  ...args: [
    websiteId: string,
    filters: QueryFilters,
    propertyFilters?: PropertyFilter[],
    propertyName?: string,
  ]
): Promise<PropertyMetric[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
  propertyName?: string,
) {
  const { timezone = 'utc' } = filters;
  const { parseFilters, getPropertyFilterQuery } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(
    propertyFilters,
    'session',
    timezone,
  );
  const selectedPropertyFilter = propertyName
    ? `and exists (
        select 1 from session_data selected_property
        where selected_property.session_id = website_event.session_id
          and selected_property.website_id = website_event.website_id
          and selected_property.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
          and selected_property.data_key = {{propertyName}}
      )`
    : '';

  return boundedPostgresDiscovery<PropertyMetric>(
    `
    select website_event.session_id, session_data.data_key, session_data.data_type
    from website_event
    ${cohortQuery}
    ${joinSessionQuery}
    join session_data on session_data.session_id = website_event.session_id
      and session_data.website_id = website_event.website_id
    where website_event.website_id = {{websiteId::uuid}}
      and session_data.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type != ${EVENT_TYPE.performance}
      and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
      ${filterQuery}
      ${pfSQL}
      ${selectedPropertyFilter}
    `,
    `
    select data_key as "propertyName", data_type as "dataType",
      count(distinct session_id) as "total"
    from admitted
    group by 1, 2
    order by 3 desc, 1 asc
    `,
    'result."total" desc, result."propertyName" asc',
    { ...queryParams, websiteId, propertyName, ...pfParams },
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(
  websiteId: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
  propertyName?: string,
): Promise<{ propertyName: string; dataType: number; total: number }[]> {
  const { timezone = 'UTC' } = filters;
  const { parseFilters, getPropertyFilterQuery } = clickhouse;
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

  return boundedClickhouseDiscovery<PropertyMetric>(
    `
    with filtered_sessions as (
      select distinct website_event.session_id, website_event.website_id
      from website_event
      ${cohortQuery}
      where website_event.website_id = {websiteId:UUID}
        and website_event.created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and website_event.event_type != ${EVENT_TYPE.performance}
        and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
      ${filterQuery}
      ${pfSQL}
    ),
    selected_property_sessions as (
      select distinct session_data.session_id, session_data.website_id
      from session_data final
      join filtered_sessions
        on filtered_sessions.session_id = session_data.session_id
        and filtered_sessions.website_id = session_data.website_id
      where session_data.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
      ${propertyName ? 'and session_data.data_key = {propertyName:String}' : ''}
    )
    select
      data_key as propertyName,
      data_type as dataType,
      count(distinct session_data.session_id) as total
    from selected_property_sessions
    join session_data final
      on session_data.session_id = selected_property_sessions.session_id
        and session_data.website_id = selected_property_sessions.website_id
    where session_data.website_id = {websiteId:UUID}
      and session_data.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
      and session_data.data_key != ''
    group by 1, 2
    order by 3 desc, 1 asc
    limit 500
    `,
    { ...queryParams, websiteId, propertyName, ...pfParams },
    FUNCTION_NAME,
  );
}
