import clickhouse from '@/lib/clickhouse';
import {
  COLLECTION_TRUST_TIER,
  EVENT_COLUMNS,
  FILTER_COLUMNS,
  SESSION_COLUMNS,
} from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { getVerifiedIdentityLinks } from './getVerifiedIdentityLinks';
import { queryVerifiedIdentityEvents } from './queryVerifiedIdentityEvents';

const FUNCTION_NAME = 'getSessionMetrics';

export interface SessionMetricsParameters {
  type: string;
  limit?: number | string;
  offset?: number | string;
}

export async function getSessionMetrics(
  ...args: [websiteId: string, parameters: SessionMetricsParameters, filters: QueryFilters]
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  parameters: SessionMetricsParameters,
  filters: QueryFilters,
) {
  const { type, limit = 500, offset = 0 } = parameters;
  let column = FILTER_COLUMNS[type] || type;
  const verifiedIdentity = type === 'distinctId';
  if (verifiedIdentity) {
    column = 'verified_link.distinct_id';
  }
  const { parseFilters, rawQuery } = prisma;
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

  return rawQuery(
    `
    select 
      ${column} x,
      count(distinct website_event.session_id) y
      ${includeCountry ? ', country' : ''}
    from website_event
    ${cohortQuery}
    ${excludeBounceQuery}
    ${joinSessionQuery}
    ${verifiedIdentityJoin}
    where website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type NOT IN (2, 5)
      and ${column} != ''
    ${filterQuery}
    group by 1
    ${includeCountry ? ', 3' : ''}
    order by 2 desc
    limit ${limit}
    offset ${offset}
    `,
    { ...queryParams, ...parameters },
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(
  websiteId: string,
  parameters: SessionMetricsParameters,
  filters: QueryFilters,
): Promise<{ x: string; y: number }[]> {
  const { type, limit = 500, offset = 0 } = parameters;
  let column = FILTER_COLUMNS[type] || type;
  const { parseFilters, rawQuery } = clickhouse;
  const { filterQuery, cohortQuery, excludeBounceQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });
  const includeCountry = column === 'city' || column === 'region';

  if (type === 'distinctId') {
    const sessions = await queryVerifiedIdentityEvents<{ sessionId: string }>(
      `select website_event.session_id as sessionId
       from website_event
       ${cohortQuery}
       ${excludeBounceQuery}
       where website_event.website_id = {websiteId:UUID}
         and website_event.created_at between {startDate:DateTime64} and {endDate:DateTime64}
         and website_event.event_type NOT IN (2, 5)
         ${filterQuery}
       group by website_event.session_id
       limit {rowLimit:UInt32}`,
      queryParams,
      FUNCTION_NAME,
    );
    const links = await getVerifiedIdentityLinks(
      websiteId,
      sessions.map(({ sessionId }) => sessionId),
    );
    const counts = new Map<string, Set<string>>();

    for (const { sessionId, distinctId } of links) {
      if (!counts.has(distinctId)) {
        counts.set(distinctId, new Set());
      }
      counts.get(distinctId)?.add(sessionId);
    }

    return [...counts]
      .map(([x, sessionIds]) => ({ x, y: sessionIds.size }))
      .sort((left, right) => right.y - left.y || left.x.localeCompare(right.x))
      .slice(Number(offset), Number(offset) + Number(limit));
  }

  if (type === 'language') {
    column = `lower(left(${type}, 2))`;
  }

  let sql = '';

  if (EVENT_COLUMNS.some(item => Object.keys(filters).includes(item))) {
    sql = `
    select
      ${column} x,
      count(distinct session_id) y
      ${includeCountry ? ', country' : ''}
    from website_event
    ${cohortQuery}
    ${excludeBounceQuery}
    where website_id = {websiteId:UUID}
      and created_at between {startDate:DateTime64} and {endDate:DateTime64}
      and event_type NOT IN (2, 5)
      and ${column} != ''
      ${filterQuery}
    group by x
    ${includeCountry ? ', country' : ''}
    order by y desc
    limit ${limit}
    offset ${offset}
    `;
  } else {
    sql = `
    select
      ${column} x,
      uniq(session_id) y
      ${includeCountry ? ', country' : ''}
    from website_event_stats_hourly as website_event
    ${cohortQuery}
    ${excludeBounceQuery}
    where website_id = {websiteId:UUID}
      and created_at between {startDate:DateTime64} and {endDate:DateTime64}
      and event_type NOT IN (2, 5)
      and ${column} != ''
      ${filterQuery}
    group by x 
    ${includeCountry ? ', country' : ''}
    order by y desc
    limit ${limit}
    offset ${offset}
    `;
  }

  return rawQuery(sql, { ...queryParams, ...parameters }, FUNCTION_NAME);
}
