import type { EventData } from '@/generated/prisma/client';
import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';

const FUNCTION_NAME = 'getEventDataById';

export async function getEventDataById(
  ...args: [websiteId: string, eventId: string, rowLimit?: number]
): Promise<EventData[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, eventId: string, rowLimit?: number) {
  const { rawQuery } = prisma;

  return rawQuery(
    `
    select event_data.website_id as "websiteId",
       event_data.website_event_id as "eventId",
       website_event.event_name as "eventName",
       event_data.data_key as "dataKey",
       event_data.string_value as "stringValue",
       event_data.number_value as "numberValue",
       event_data.date_value as "dateValue",
       event_data.data_type as "dataType",
       case when event_data.trust_tier = 1 and website_event.trust_tier = 1 then 1 else 0 end as "trustTier",
       event_data.created_at as "createdAt"
    from event_data
    join website_event on website_event.event_id = event_data.website_event_id
      and website_event.website_id = {{websiteId::uuid}}
    where event_data.website_id = {{websiteId::uuid}}
      and event_data.website_event_id = {{eventId::uuid}}
    ${rowLimit === undefined ? '' : 'limit {{rowLimit}}'}
    `,
    { websiteId, eventId, rowLimit },
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(
  websiteId: string,
  eventId: string,
  rowLimit?: number,
): Promise<EventData[]> {
  const { rawQuery } = clickhouse;

  return rawQuery(
    `
      select event_data.website_id as websiteId,
        event_data.event_id as eventId,
        website_event.event_name as eventName,
        event_data.data_key as dataKey,
        event_data.string_value as stringValue,
        event_data.number_value as numberValue,
        event_data.date_value as dateValue,
        event_data.data_type as dataType,
        if(event_data.trust_tier = 1 and website_event.trust_tier = 1
          and event_data.event_name = website_event.event_name
          and event_data.url_path = website_event.url_path, 1, 0) as trustTier,
        event_data.created_at as createdAt
      from event_data
      inner join website_event on website_event.event_id = event_data.event_id
        and website_event.website_id = event_data.website_id
        and website_event.session_id = event_data.session_id
      where event_data.website_id = {websiteId:UUID}
        and event_data.event_id = {eventId:UUID}
      ${rowLimit === undefined ? '' : 'limit {rowLimit:UInt32}'}
    `,
    { websiteId, eventId, rowLimit },
    FUNCTION_NAME,
  );
}
