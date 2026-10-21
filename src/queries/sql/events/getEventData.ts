import clickhouse from '@/lib/clickhouse';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getEventData';
const MAX_EVENT_DATA_PAGE_ROWS = 10_000;

export class EventDataPageTooBroadError extends Error {
  constructor() {
    super('Narrow the page size or filters to view event properties.');
  }
}

export async function getEventData(...args: [websiteId: string, filters: QueryFilters]) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, filters: QueryFilters) {
  const { rawQuery, parseFilters } = prisma;
  const { page = 1, pageSize } = filters;
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const offset = +size * (+page - 1);

  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  // Selects distinct event IDs matching all filters — reused for count and paged data
  const eventQuery = `
    select website_event.event_id
    from website_event
    join event_data on event_data.website_event_id = website_event.event_id
      and event_data.website_id = {{websiteId::uuid}}
      and event_data.trust_tier = 1
      and event_data.created_at between {{startDate}} and {{endDate}}
    ${cohortQuery}
    ${joinSessionQuery}
    where website_event.website_id = {{websiteId::uuid}}
      and website_event.trust_tier = 1
      and website_event.created_at between {{startDate}} and {{endDate}}
      ${filterQuery}
    group by website_event.event_id
  `;

  const count = await rawQuery(`select count(*) as num from (${eventQuery}) t`, queryParams).then(
    (res: any) => res[0].num,
  );

  const data = await rawQuery(
    `
    with paged_events as (
      ${eventQuery}
      order by max(website_event.created_at) desc
      limit ${size} offset ${offset}
    )
    select
      event_data.website_id as "websiteId",
      website_event.session_id as "sessionId",
      event_data.website_event_id as "eventId",
      website_event.event_name as "eventName",
      website_event.url_path as "urlPath",
      event_data.data_key as "dataKey",
      event_data.string_value as "stringValue",
      event_data.number_value as "numberValue",
      event_data.date_value as "dateValue",
      event_data.data_type as "dataType",
      event_data.created_at as "createdAt"
    from event_data
    join website_event on website_event.event_id = event_data.website_event_id
      and website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
    join paged_events on paged_events.event_id = event_data.website_event_id
    where event_data.website_id = {{websiteId::uuid}}
      and event_data.trust_tier = 1
      and website_event.trust_tier = 1
      and event_data.created_at between {{startDate}} and {{endDate}}
    order by event_data.created_at desc
    limit ${MAX_EVENT_DATA_PAGE_ROWS + 1}
    `,
    queryParams,
    FUNCTION_NAME,
  );

  if (data.length > MAX_EVENT_DATA_PAGE_ROWS) {
    throw new EventDataPageTooBroadError();
  }

  return { data, count, page: +page, pageSize: size };
}

async function clickhouseQuery(websiteId: string, filters: QueryFilters) {
  const { rawQuery, parseFilters } = clickhouse;
  const { page = 1, pageSize } = filters;
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const offset = +size * (+page - 1);

  const { filterQuery, cohortQuery, queryParams } = parseFilters(
    { ...filters, websiteId },
    {
      columns: {
        path: 'website_event.url_path',
        entry: 'website_event.url_path',
        exit: 'website_event.url_path',
        event: 'website_event.event_name',
      },
    },
  );

  const eventQuery = `
    select event_data.website_id, event_data.session_id,
      event_data.event_id, event_data.event_name, event_data.url_path
    from event_data
    left any join (
      select *, 1 as admitted
      from website_event
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = 2
        and trust_tier = 1
    ) website_event
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
      ${filterQuery}
    group by event_data.website_id, event_data.session_id,
      event_data.event_id, event_data.event_name, event_data.url_path
  `;

  const count = await rawQuery(`select count(*) as num from (${eventQuery}) t`, queryParams).then(
    (res: any) => res[0].num,
  );

  const data = await rawQuery<Record<string, unknown>[]>(
    `
    with paged_events as (
      ${eventQuery}
      order by max(event_data.created_at) desc, event_data.website_id,
        event_data.session_id, event_data.event_id, event_data.event_name, event_data.url_path
      limit ${size} offset ${offset}
    )
    select
      event_data.website_id as websiteId,
      event_data.session_id as sessionId,
      event_data.event_id as eventId,
      website_event.event_name as eventName,
      event_data.url_path as urlPath,
      data_key as dataKey,
      string_value as stringValue,
      number_value as numberValue,
      date_value as dateValue,
      data_type as dataType,
      event_data.created_at as createdAt
    from event_data
    left any join (
      select *, 1 as admitted
      from website_event
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = 2
        and trust_tier = 1
    ) website_event
    on website_event.event_id = event_data.event_id
      and website_event.session_id = event_data.session_id
      and website_event.website_id = event_data.website_id
      and website_event.event_name = event_data.event_name
      and website_event.url_path = event_data.url_path
    inner join paged_events on paged_events.event_id = event_data.event_id
      and paged_events.website_id = event_data.website_id
      and paged_events.session_id = event_data.session_id
      and paged_events.event_name = event_data.event_name
      and paged_events.url_path = event_data.url_path
    where event_data.website_id = {websiteId:UUID}
      and website_event.admitted = 1
      and event_data.trust_tier = 1
      and event_data.created_at between {startDate:DateTime64} and {endDate:DateTime64}
    order by event_data.created_at desc
    limit ${MAX_EVENT_DATA_PAGE_ROWS + 1}
    `,
    queryParams,
    FUNCTION_NAME,
  );

  if (data.length > MAX_EVENT_DATA_PAGE_ROWS) {
    throw new EventDataPageTooBroadError();
  }

  return { data, count, page: +page, pageSize: size };
}
