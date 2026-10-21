import clickhouse from '@/lib/clickhouse';
import {
  COLLECTION_TRUST_TIER,
  EVENT_TYPE,
  FILTER_COLUMNS,
  SESSION_COLUMNS,
} from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { getVerifiedIdentityLinks } from './getVerifiedIdentityLinks';
import { queryVerifiedIdentityEvents } from './queryVerifiedIdentityEvents';

const FUNCTION_NAME = 'getSessionExpandedMetrics';

export interface SessionExpandedMetricsParameters {
  type: string;
  limit?: number | string;
  offset?: number | string;
}

export interface SessionExpandedMetricsData {
  name: string;
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}

export async function getSessionExpandedMetrics(
  ...args: [websiteId: string, parameters: SessionExpandedMetricsParameters, filters: QueryFilters]
): Promise<SessionExpandedMetricsData[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  parameters: SessionExpandedMetricsParameters,
  filters: QueryFilters,
): Promise<SessionExpandedMetricsData[]> {
  const { type, limit = 500, offset = 0 } = parameters;
  let column = FILTER_COLUMNS[type] || type;
  const verifiedIdentity = type === 'distinctId';
  if (verifiedIdentity) {
    column = 'verified_link.distinct_id';
  }
  const { parseFilters, rawQuery, getTimestampDiffSQL } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, excludeBounceQuery, queryParams } =
    parseFilters(
      {
        ...filters,
        websiteId,
      },
      {
        joinSession: SESSION_COLUMNS.includes(type),
      },
    );
  const needsBounceEvents = filters.excludeBounce !== true;
  const includeCountry = column === 'city' || column === 'region';

  if (type === 'language') {
    column = `lower(left(${type}, 2))`;
  }
  const verifiedIdentityJoin = verifiedIdentity
    ? `join session_link verified_link
        on verified_link.website_id = website_event.website_id
        and verified_link.session_id = website_event.session_id
        and verified_link.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}`
    : '';
  const bounceQuery = needsBounceEvents
    ? `sum(case when t.c = 1 and coalesce(e.has_custom_event, 0) = 0 then 1 else 0 end) as "bounces",`
    : '0 as "bounces",';
  const visitEventsJoin = needsBounceEvents
    ? `left join (
      select session_id, visit_id, 1 as "has_custom_event"
      from website_event
      where website_id = {{websiteId::uuid}}
        and created_at between {{startDate}} and {{endDate}}
        and event_type = ${EVENT_TYPE.customEvent}
        and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
      group by 1, 2
    ) as e
      on e.session_id = t.session_id
      and e.visit_id = t.visit_id`
    : '';

  return rawQuery(
    `
    select
      name,
      ${includeCountry ? 'country,' : ''}
      sum(t.c) as "pageviews",
      count(distinct t.session_id) as "visitors",
      count(distinct t.visit_id) as "visits",
      ${bounceQuery}
      sum(${getTimestampDiffSQL('t.min_time', 't.max_time')}) as "totaltime"
    from (
      select
        ${column} as "name",
        ${includeCountry ? 'country,' : ''}
        website_event.session_id,
        website_event.visit_id,
        count(*) as "c",
        min(website_event.created_at) as "min_time",
        max(website_event.created_at) as "max_time"
      from website_event
      ${cohortQuery}
      ${excludeBounceQuery}
      ${joinSessionQuery}
      ${verifiedIdentityJoin}
      where website_event.website_id = {{websiteId::uuid}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type NOT IN (2, 5)
        ${filterQuery}
      group by name, website_event.session_id, website_event.visit_id
      ${includeCountry ? ', country' : ''}
    ) as t
    ${visitEventsJoin}
    where name != ''
    group by name 
    ${includeCountry ? ', country' : ''}
    order by visitors desc, visits desc
    limit ${limit}
    offset ${offset}
    `,
    { ...queryParams, ...parameters },
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(
  websiteId: string,
  parameters: SessionExpandedMetricsParameters,
  filters: QueryFilters,
): Promise<SessionExpandedMetricsData[]> {
  const { type, limit = 500, offset = 0 } = parameters;
  let column = FILTER_COLUMNS[type] || type;
  const { parseFilters, rawQuery } = clickhouse;
  const { filterQuery, cohortQuery, excludeBounceQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });
  const needsBounceEvents = filters.excludeBounce !== true;
  const includeCountry = column === 'city' || column === 'region';

  if (type === 'distinctId') {
    const visits = await queryVerifiedIdentityEvents<{
      sessionId: string;
      visitId: string;
      count: number;
      totalTime: number;
    }>(
      `select website_event.session_id as sessionId,
         website_event.visit_id as visitId,
         count() as count,
         dateDiff('second', min(website_event.created_at), max(website_event.created_at)) as totalTime
       from website_event
       ${cohortQuery}
       ${excludeBounceQuery}
       where website_event.website_id = {websiteId:UUID}
         and website_event.created_at between {startDate:DateTime64} and {endDate:DateTime64}
         and website_event.event_type NOT IN (2, 5)
         ${filterQuery}
       group by website_event.session_id, website_event.visit_id
       limit {rowLimit:UInt32}`,
      queryParams,
      FUNCTION_NAME,
    );
    const links = await getVerifiedIdentityLinks(websiteId, [
      ...new Set(visits.map(({ sessionId }) => sessionId)),
    ]);
    if (links.length === 0) {
      return [];
    }

    const labelsBySession = new Map<string, string[]>();

    for (const { sessionId, distinctId } of links) {
      const labels = labelsBySession.get(sessionId) ?? [];
      labels.push(distinctId);
      labelsBySession.set(sessionId, labels);
    }

    const customEventVisits =
      needsBounceEvents && visits.length > 0
        ? await queryVerifiedIdentityEvents<{ sessionId: string; visitId: string }>(
            `select session_id as sessionId, visit_id as visitId
           from website_event
           where website_id = {websiteId:UUID}
             and created_at between {startDate:DateTime64} and {endDate:DateTime64}
             and event_type = ${EVENT_TYPE.customEvent}
             and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
             and has({sessionIds:Array(UUID)}, session_id)
             and has({visitIds:Array(UUID)}, visit_id)
           group by session_id, visit_id
           limit {rowLimit:UInt32}`,
            {
              websiteId,
              startDate: filters.startDate,
              endDate: filters.endDate,
              sessionIds: [...labelsBySession.keys()],
              visitIds: visits.map(({ visitId }) => visitId),
            },
            FUNCTION_NAME,
          )
        : [];
    const customEventKeys = new Set(
      customEventVisits.map(({ sessionId, visitId }) => `${sessionId}:${visitId}`),
    );
    const totals = new Map<
      string,
      {
        pageviews: number;
        visitors: Set<string>;
        visits: Set<string>;
        bounces: number;
        totaltime: number;
      }
    >();

    for (const visit of visits) {
      for (const name of labelsBySession.get(visit.sessionId) ?? []) {
        const total = totals.get(name) ?? {
          pageviews: 0,
          visitors: new Set<string>(),
          visits: new Set<string>(),
          bounces: 0,
          totaltime: 0,
        };
        total.pageviews += Number(visit.count);
        total.visitors.add(visit.sessionId);
        total.visits.add(visit.visitId);
        total.bounces +=
          needsBounceEvents &&
          Number(visit.count) === 1 &&
          !customEventKeys.has(`${visit.sessionId}:${visit.visitId}`)
            ? 1
            : 0;
        total.totaltime += Number(visit.totalTime);
        totals.set(name, total);
      }
    }

    return [...totals]
      .map(([name, total]) => ({
        name,
        pageviews: total.pageviews,
        visitors: total.visitors.size,
        visits: total.visits.size,
        bounces: total.bounces,
        totaltime: total.totaltime,
      }))
      .sort(
        (left, right) =>
          right.visitors - left.visitors ||
          right.visits - left.visits ||
          left.name.localeCompare(right.name),
      )
      .slice(Number(offset), Number(offset) + Number(limit));
  }

  if (type === 'language') {
    column = `lower(left(${type}, 2))`;
  }
  const bounceQuery = needsBounceEvents
    ? `sumIf(1, t.c = 1 and ifNull(e.has_custom_event, 0) = 0) as "bounces",`
    : '0 as "bounces",';
  const visitEventsJoin = needsBounceEvents
    ? `left join (
      select session_id, visit_id, toUInt8(1) as has_custom_event
      from website_event
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = ${EVENT_TYPE.customEvent}
        and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
      group by session_id, visit_id
    ) as e using (session_id, visit_id)`
    : '';

  return rawQuery(
    `
    select
      name,
      ${includeCountry ? 'country,' : ''}
      sum(t.c) as "pageviews",
      uniq(t.session_id) as "visitors",
      uniq(t.visit_id) as "visits",
      ${bounceQuery}
      sum(max_time-min_time) as "totaltime"
    from (
      select
        ${column} name,
        ${includeCountry ? 'country,' : ''}
        session_id,
        visit_id,
        count(*) c,
        min(created_at) min_time,
        max(created_at) max_time
      from website_event
      ${cohortQuery}
      ${excludeBounceQuery}
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type NOT IN (2, 5)
        and name != ''
        ${filterQuery}
      group by name, session_id, visit_id
      ${includeCountry ? ', country' : ''}
    ) as t
    ${visitEventsJoin}
    group by name
    ${includeCountry ? ', country' : ''}
    order by visitors desc, visits desc
    limit ${limit}
    offset ${offset}
    `,
    { ...queryParams, ...parameters },
    FUNCTION_NAME,
  );
}
