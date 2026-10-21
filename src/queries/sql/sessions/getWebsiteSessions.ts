import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, EVENT_TYPE, FILTER_COLUMNS } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { PageResult, QueryFilters, WebsiteSession } from '@/lib/types';
import { getVerifiedIdentitySearchSessions } from './getVerifiedIdentitySearchSessions';

const FUNCTION_NAME = 'getWebsiteSessions';
const QUALIFIED_FILTER_COLUMNS = Object.fromEntries(
  Object.entries(FILTER_COLUMNS).map(([key, value]) => [key, `website_event.${value}`]),
);

export async function getWebsiteSessions(
  ...args: [websiteId: string, filters: QueryFilters]
): Promise<PageResult<WebsiteSession[]>> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, filters: QueryFilters) {
  const { pagedRawQuery, parseFilters } = prisma;
  const { search } = filters;
  const { filterQuery, dateQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    search: search ? `%${search}%` : undefined,
  });

  const searchQuery = search
    ? `and (exists (
             select 1 from session_link verified_link
             where verified_link.website_id = website_event.website_id
               and verified_link.session_id = website_event.session_id
               and verified_link.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
               and verified_link.distinct_id ilike {{search}})
           or city ilike {{search}}
           or browser ilike {{search}}
           or os ilike {{search}}
           or device ilike {{search}}
           or session.bot_name ilike {{search}}
           or session.bot_category ilike {{search}})`
    : '';

  return pagedRawQuery(
    `
    select
      session.session_id as "id",
      session.website_id as "websiteId",
      website_event.hostname,
      session.browser,
      session.os,
      session.device,
      session.screen,
      session.language,
      session.country,
      session.region,
      session.city,
      session.is_bot as "isBot",
      session.bot_name as "botName",
      session.bot_category as "botCategory",
      min(website_event.created_at) as "firstAt",
      max(website_event.created_at) as "lastAt",
      count(distinct website_event.visit_id) as "visits",
      sum(case when website_event.event_type = ${EVENT_TYPE.pageView} then 1 else 0 end) as "views",
      sum(case when website_event.event_type = ${EVENT_TYPE.customEvent} then 1 else 0 end) as "events",
      max(website_event.created_at) as "createdAt"
    from website_event 
    ${cohortQuery}
    join session on session.session_id = website_event.session_id
      and session.website_id = website_event.website_id
    where website_event.website_id = {{websiteId::uuid}}
      and website_event.event_type != ${EVENT_TYPE.performance}
      and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
    ${dateQuery}
    ${filterQuery}
    ${searchQuery}
    group by session.session_id, 
      session.website_id, 
      website_event.hostname, 
      session.browser, 
      session.os, 
      session.device, 
      session.screen, 
      session.language, 
      session.country, 
      session.region, 
      session.city,
      session.is_bot,
      session.bot_name,
      session.bot_category
    `,
    queryParams,
    filters,
    FUNCTION_NAME,
    'max(website_event.created_at) desc, session.session_id',
  );
}

async function clickhouseQuery(websiteId: string, filters: QueryFilters) {
  const { pagedRawQuery, parseFilters, getDateStringSQL } = clickhouse;
  const { search } = filters;
  const verifiedSessionIds = search
    ? await getVerifiedIdentitySearchSessions(websiteId, search)
    : [];
  const { filterQuery, dateQuery, cohortQuery, queryParams } = parseFilters(
    {
      ...filters,
      websiteId,
    },
    {
      columns: QUALIFIED_FILTER_COLUMNS,
    },
  );

  const searchQuery = search
    ? `and (has({verifiedSessionIds:Array(UUID)}, website_event.session_id)
           or (positionCaseInsensitive(website_event.city, {search:String}) > 0)
           or (positionCaseInsensitive(website_event.browser, {search:String}) > 0)
           or (positionCaseInsensitive(website_event.os, {search:String}) > 0)
           or (positionCaseInsensitive(website_event.device, {search:String}) > 0)
           or (positionCaseInsensitive(website_event.bot_name, {search:String}) > 0)
           or (positionCaseInsensitive(website_event.bot_category, {search:String}) > 0))`
    : '';
  const normalizedFilterQuery = filterQuery.replace(
    /referrer_domain != hostname/g,
    'website_event.referrer_domain != website_event.hostname',
  );

  const sql = `
    select
      session_id as id,
      any(website_id) as websiteId,
      argMax(hostname, created_at) as hostname,
      argMax(browser, created_at) as browser,
      argMax(os, created_at) as os,
      argMax(device, created_at) as device,
      argMax(screen, created_at) as screen,
      argMax(language, created_at) as language,
      argMax(country, created_at) as country,
      argMax(region, created_at) as region,
      argMax(city, created_at) as city,
      argMax(is_bot, created_at) as isBot,
      argMax(bot_name, created_at) as botName,
      argMax(bot_category, created_at) as botCategory,
      ${getDateStringSQL('min(created_at)')} as firstAt,
      ${getDateStringSQL('max(created_at)')} as lastAt,
      uniq(visit_id) as visits,
      sumIf(1, event_type = ${EVENT_TYPE.pageView}) as views,
      sumIf(1, event_type = ${EVENT_TYPE.customEvent}) as events,
      max(created_at) as createdAt
    from website_event
    ${cohortQuery}
    where website_id = {websiteId:UUID}
      and event_type != ${EVENT_TYPE.performance}
      and (event_type != ${EVENT_TYPE.customEvent} or trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
    ${dateQuery}
    ${normalizedFilterQuery}
    ${searchQuery}
    group by session_id
    order by lastAt desc, id
    `;

  return pagedRawQuery(sql, { ...queryParams, verifiedSessionIds }, filters, FUNCTION_NAME);
}
