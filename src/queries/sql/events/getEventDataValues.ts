import clickhouse from '@/lib/clickhouse';
import { DATA_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { boundedClickhouseDiscovery, boundedPostgresDiscovery } from './discoveryBudget';

const FUNCTION_NAME = 'getEventDataValues';

interface WebsiteEventData {
  value: string;
  total: number;
}

export async function getEventDataValues(
  ...args: [
    websiteId: string,
    eventName: string | undefined,
    filters: QueryFilters & { propertyName?: string; dataType?: number },
  ]
): Promise<WebsiteEventData[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  eventName: string | undefined,
  filters: QueryFilters & { propertyName?: string; dataType?: number },
) {
  const { parseFilters, getDateSQL } = prisma;
  const { dataType } = filters;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });
  const eventNameFilter = eventName ? 'and website_event.event_name = {{eventName}}' : '';

  if (dataType === DATA_TYPE.array) {
    return boundedPostgresDiscovery<WebsiteEventData>(
      `
      select array_item.value
      from event_data
      join website_event on website_event.event_id = event_data.website_event_id
        and website_event.website_id = {{websiteId::uuid}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type = 2
        ${eventNameFilter}
      cross join lateral jsonb_array_elements_text(coalesce(event_data.string_value, '[]')::jsonb) as array_item(value)
      ${cohortQuery}
      ${joinSessionQuery}
      where event_data.website_id = {{websiteId::uuid}}
        and event_data.trust_tier = 1
        and website_event.trust_tier = 1
        and event_data.created_at between {{startDate}} and {{endDate}}
        and event_data.data_key = {{propertyName}}
        and event_data.data_type = ${DATA_TYPE.array}
      ${filterQuery}
      `,
      `select value, count(*) as "total" from admitted group by value order by 2 desc`,
      'result."total" desc',
      { ...queryParams, eventName },
      FUNCTION_NAME,
      100,
    );
  }

  return boundedPostgresDiscovery<WebsiteEventData>(
    `
    select case
        when data_type = 2 then replace(string_value, '.0000', '')
        when data_type = 4 then ${getDateSQL('date_value', 'hour')}
        else string_value
      end as value
    from event_data
    join website_event on website_event.event_id = event_data.website_event_id
      and website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type = 2
      ${eventNameFilter}
    ${cohortQuery}
    ${joinSessionQuery}
    where event_data.website_id = {{websiteId::uuid}}
      and event_data.trust_tier = 1
      and website_event.trust_tier = 1
      and event_data.created_at between {{startDate}} and {{endDate}}
      and event_data.data_key = {{propertyName}}
      ${dataType ? `and event_data.data_type = ${dataType}` : ''}
    ${filterQuery}
    `,
    `select value, count(*) as "total" from admitted group by value order by 2 desc`,
    'result."total" desc',
    { ...queryParams, eventName },
    FUNCTION_NAME,
    100,
  );
}

async function clickhouseQuery(
  websiteId: string,
  eventName: string | undefined,
  filters: QueryFilters & { propertyName?: string; dataType?: number },
): Promise<{ value: string; total: number }[]> {
  const { parseFilters } = clickhouse;
  const { dataType } = filters;
  const { filterQuery, cohortQuery, queryParams } = parseFilters({ ...filters, websiteId });
  const eventNameFilter = eventName ? 'and event_name = {eventName:String}' : '';
  const eventDataNameFilter = eventName ? 'and event_data.event_name = {eventName:String}' : '';

  if (dataType === DATA_TYPE.array) {
    return boundedClickhouseDiscovery<WebsiteEventData>(
      `
      select
        arrayJoin(JSONExtract(ifNull(event_data.string_value, '[]'), 'Array(String)')) as "value",
        count(*) as "total"
      from event_data
      left any join (
            select *, 1 as admitted
            from website_event
            where website_id = {websiteId:UUID}
              and created_at between {startDate:DateTime64} and {endDate:DateTime64}
              and event_type = 2
              and trust_tier = 1
              ${eventNameFilter}) website_event
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
        ${eventDataNameFilter}
        and event_data.data_key = {propertyName:String}
        and event_data.data_type = ${DATA_TYPE.array}
      ${filterQuery}
      group by value
      order by 2 desc
      limit 100
      `,
      { ...queryParams, eventName },
      FUNCTION_NAME,
    );
  }

  return boundedClickhouseDiscovery<WebsiteEventData>(
    `
    select
      multiIf(data_type = 2, replaceAll(string_value, '.0000', ''),
              data_type = 4, toString(date_trunc('hour', date_value)),
              string_value) as "value",
      count(*) as "total"
    from event_data
    left any join (
          select *, 1 as admitted
          from website_event
          where website_id = {websiteId:UUID}
            and created_at between {startDate:DateTime64} and {endDate:DateTime64}
            and event_type = 2
            and trust_tier = 1
            ${eventNameFilter}) website_event
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
      ${eventDataNameFilter}
      and event_data.data_key = {propertyName:String}
      ${dataType ? `and event_data.data_type = ${dataType}` : ''}
    ${filterQuery}
    group by value
    order by 2 desc
    limit 100
    `,
    { ...queryParams, eventName },
    FUNCTION_NAME,
  );
}
