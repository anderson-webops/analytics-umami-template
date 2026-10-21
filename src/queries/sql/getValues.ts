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
import { getVerifiedIdentityLinks } from './sessions/getVerifiedIdentityLinks';
import { queryVerifiedIdentityEvents } from './sessions/queryVerifiedIdentityEvents';

const SESSION_DB_COLUMNS = new Set(
  SESSION_COLUMNS.map(col => FILTER_COLUMNS[col as keyof typeof FILTER_COLUMNS]).filter(Boolean),
);

const FUNCTION_NAME = 'getValues';

export async function getValues(
  ...args: [websiteId: string, column: string, filters: QueryFilters]
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, column: string, filters: QueryFilters) {
  const { rawQuery, getSearchSQL } = prisma;
  const params = {};
  const { startDate, endDate, search, trafficType = 'human' } = filters;
  const sessionColumns = new Set([
    'browser',
    'os',
    'device',
    'screen',
    'language',
    'country',
    'region',
    'city',
    'distinct_id',
  ]);
  const qualifiedColumn =
    column === 'distinct_id'
      ? 'verified_link.distinct_id'
      : sessionColumns.has(column)
        ? `session.${column}`
        : `website_event.${column}`;

  let searchQuery = '';
  let excludeDomain = '';
  let trafficQuery = '';

  if (column === 'referrer_domain') {
    excludeDomain = `and website_event.referrer_domain != regexp_replace(website_event.hostname, '^www.', '')
      and website_event.referrer_domain != ''`;
  }

  if (trafficType === 'bot') {
    trafficQuery = 'and coalesce(website_event.is_bot, false) = true';
  } else if (trafficType !== 'all') {
    trafficQuery = 'and coalesce(website_event.is_bot, false) = false';
  }

  if (search) {
    if (decodeURIComponent(search).includes(',')) {
      searchQuery = `AND (${decodeURIComponent(search)
        .split(',')
        .slice(0, 5)
        .map((value: string, index: number) => {
          const key = `search${index}`;

          params[key] = value;

          return getSearchSQL(qualifiedColumn, key).replace('and ', '');
        })
        .join(' OR ')})`;
    } else {
      searchQuery = getSearchSQL(qualifiedColumn);
    }
  }

  if (column === 'distinct_id') {
    return rawQuery(
      `
      select verified_link.distinct_id as "value", count(*) as "count"
      from session_link verified_link
      join session on session.website_id = verified_link.website_id
        and session.session_id = verified_link.session_id
      where verified_link.website_id = {{websiteId::uuid}}
        and verified_link.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
        and session.created_at between {{startDate}} and {{endDate}}
        ${searchQuery}
      group by 1
      order by 2 desc
      limit 10
      `,
      { websiteId, startDate, endDate, search: `%${search}%`, ...params },
      FUNCTION_NAME,
    );
  }

  if (SESSION_DB_COLUMNS.has(column)) {
    return rawQuery(
      `
      select ${column} as "value", count(*) as "count"
      from session
      where website_id = {{websiteId::uuid}}
        and created_at between {{startDate}} and {{endDate}}
        ${searchQuery}
      group by 1
      order by 2 desc
      limit 10
      `,
      { websiteId, startDate, endDate, search: `%${search}%`, ...params },
      FUNCTION_NAME,
    );
  }

  const sourceTrustQuery =
    column === 'event_name'
      ? `and website_event.event_type = ${EVENT_TYPE.customEvent} and website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}`
      : `and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})`;

  return rawQuery(
    `
    select ${qualifiedColumn} as "value", count(*) as "count"
    from website_event
    where website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      ${sourceTrustQuery}
      ${searchQuery}
      ${trafficQuery}
      ${excludeDomain}
    group by 1
    order by 2 desc
    limit 10
    `,
    { websiteId, startDate, endDate, search: `%${search}%`, ...params },
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(websiteId: string, column: string, filters: QueryFilters) {
  const { rawQuery, getSearchSQL } = clickhouse;
  const params = {};
  const { startDate, endDate, search, trafficType = 'human' } = filters;

  let searchQuery = '';
  let excludeDomain = '';
  let trafficQuery = '';

  if (column === 'referrer_domain') {
    excludeDomain = `and referrer_domain != hostname and referrer_domain != ''`;
  }

  if (trafficType === 'bot') {
    trafficQuery = 'and is_bot = 1';
  } else if (trafficType !== 'all') {
    trafficQuery = 'and is_bot = 0';
  }

  if (column === 'distinct_id') {
    const sessions = await queryVerifiedIdentityEvents<{ sessionId: string; count: number }>(
      `select session_id as sessionId, count() as count
         from website_event
         where website_id = {websiteId:UUID}
           and created_at between {startDate:DateTime64} and {endDate:DateTime64}
           ${trafficQuery}
         group by session_id
         limit {rowLimit:UInt32}`,
      { websiteId, startDate, endDate },
      FUNCTION_NAME,
    );

    const links = await getVerifiedIdentityLinks(
      websiteId,
      sessions.map(({ sessionId }) => sessionId),
    );
    const countsBySession = new Map(sessions.map(({ sessionId, count }) => [sessionId, count]));
    const countsByIdentity = new Map<string, number>();
    const searchTerms = search
      ? decodeURIComponent(search)
          .split(',')
          .slice(0, 5)
          .map(term => term.toLowerCase())
      : [];

    for (const { sessionId, distinctId } of links) {
      if (
        searchTerms.length > 0 &&
        !searchTerms.some(term => distinctId.toLowerCase().includes(term))
      ) {
        continue;
      }

      countsByIdentity.set(
        distinctId,
        (countsByIdentity.get(distinctId) ?? 0) + (countsBySession.get(sessionId) ?? 0),
      );
    }

    return [...countsByIdentity]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, 10);
  }

  if (search) {
    if (decodeURIComponent(search).includes(',')) {
      searchQuery = `AND (${decodeURIComponent(search)
        .split(',')
        .slice(0, 5)
        .map((value: string, index: number) => {
          const key = `search${index}`;

          params[key] = value;

          return getSearchSQL(column, key).replace('and ', '');
        })
        .join(' OR ')})`;
    } else {
      searchQuery = getSearchSQL(column);
    }
  }

  const sourceTrustQuery =
    column === 'event_name'
      ? `and event_type = ${EVENT_TYPE.customEvent} and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}`
      : `and (event_type != ${EVENT_TYPE.customEvent} or trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})`;

  return rawQuery(
    `
    select ${column} as "value", count(*) as "count"
    from website_event
    where website_id = {websiteId:UUID}
      and created_at between {startDate:DateTime64} and {endDate:DateTime64}
      ${sourceTrustQuery}
      ${searchQuery}
      ${trafficQuery}
      ${excludeDomain}
    group by 1
    order by 2 desc
    limit 10
    `,
    {
      websiteId,
      startDate,
      endDate,
      search,
      ...params,
    },
    FUNCTION_NAME,
  );
}
