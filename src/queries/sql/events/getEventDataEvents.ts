import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { boundedClickhouseDiscovery, boundedPostgresDiscovery } from './discoveryBudget';

const FUNCTION_NAME = 'getEventDataEvents';

export interface WebsiteEventData {
  eventName?: string;
  propertyName: string;
  dataType: number;
  propertyValue?: string;
  total: number;
}

export async function getEventDataEvents(
  ...args: [websiteId: string, filters: QueryFilters]
): Promise<WebsiteEventData[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, filters: QueryFilters) {
  const { parseFilters } = prisma;
  const { event } = filters;
  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  if (event) {
    return boundedPostgresDiscovery<WebsiteEventData>(
      `
      select website_event.event_name, event_data.data_key,
        event_data.data_type, event_data.string_value
      from event_data
      inner join website_event
        on website_event.event_id = event_data.website_event_id
      ${cohortQuery}
      ${joinSessionQuery}
      where event_data.website_id = {{websiteId::uuid}}
        and event_data.created_at between {{startDate}} and {{endDate}}
      ${filterQuery}
      `,
      `
      select event_name as "eventName", data_key as "propertyName",
        data_type as "dataType", string_value as "propertyValue", count(*) as "total"
      from admitted
      group by event_name, data_key, data_type, string_value
      order by 1 asc, 2 asc, 3 asc, 5 desc
      `,
      'result."eventName" asc, result."propertyName" asc, result."dataType" asc, result."total" desc',
      queryParams,
      FUNCTION_NAME,
    );
  }

  return boundedPostgresDiscovery<WebsiteEventData>(
    `
    select website_event.event_name, event_data.data_key, event_data.data_type
    from event_data
    inner join website_event
      on website_event.event_id = event_data.website_event_id
    ${cohortQuery}
    ${joinSessionQuery}
    where event_data.website_id = {{websiteId::uuid}}
      and event_data.created_at between {{startDate}} and {{endDate}}
    ${filterQuery}
    `,
    `
    select event_name as "eventName", data_key as "propertyName",
      data_type as "dataType", count(*) as "total"
    from admitted
    group by event_name, data_key, data_type
    order by 1 asc, 2 asc
    `,
    'result."eventName" asc, result."propertyName" asc, result."dataType" asc',
    queryParams,
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(
  websiteId: string,
  filters: QueryFilters,
): Promise<WebsiteEventData[]> {
  const { parseFilters } = clickhouse;
  const { event } = filters;
  const { filterQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  if (event) {
    return boundedClickhouseDiscovery<WebsiteEventData>(
      `
      select
        event_data.event_name as eventName,
        event_data.data_key as propertyName,
        event_data.data_type as dataType,
        event_data.string_value as propertyValue,
        count(*) as total
      from event_data
      any left join (
            select *
            from website_event
            where website_id = {websiteId:UUID}
              and created_at between {startDate:DateTime64} and {endDate:DateTime64}
              and event_type = 2) website_event
      on website_event.event_id = event_data.event_id
        and website_event.session_id = event_data.session_id
        and website_event.website_id = event_data.website_id
      ${cohortQuery}
      where event_data.website_id = {websiteId:UUID}
        and event_data.created_at between {startDate:DateTime64} and {endDate:DateTime64}
      ${filterQuery}
      group by
        event_data.data_key,
        event_data.data_type,
        event_data.string_value,
        event_data.event_name
      order by 1 asc, 2 asc, 3 asc, 5 desc
      limit 500
      `,
      queryParams,
      FUNCTION_NAME,
    );
  }

  return boundedClickhouseDiscovery<WebsiteEventData>(
    `
    select
      event_data.event_name as eventName,
      event_data.data_key as propertyName,
      event_data.data_type as dataType,
      count(*) as total
    from event_data
    any left join (
          select *
          from website_event
          where website_id = {websiteId:UUID}
            and created_at between {startDate:DateTime64} and {endDate:DateTime64}
            and event_type = 2) website_event
    on website_event.event_id = event_data.event_id
      and website_event.session_id = event_data.session_id
      and website_event.website_id = event_data.website_id
    ${cohortQuery}
    where event_data.website_id = {websiteId:UUID}
      and event_data.created_at between {startDate:DateTime64} and {endDate:DateTime64}
    ${filterQuery}
    group by event_data.data_key, event_data.data_type, event_data.event_name
    order by 1 asc, 2 asc
    limit 500
    `,
    queryParams,
    FUNCTION_NAME,
  );
}
