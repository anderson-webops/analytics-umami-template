import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, EVENT_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { PageResult, QueryFilters, SessionReplaySummary } from '@/lib/types';
import { getVerifiedIdentitySearchSessions } from '../sessions/getVerifiedIdentitySearchSessions';

const FUNCTION_NAME = 'getSessionReplays';

export function getSessionReplays(
  ...args: [websiteId: string, filters: QueryFilters, sessionId?: string]
): Promise<PageResult<SessionReplaySummary[]>> {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, filters: QueryFilters, sessionId?: string) {
  const { pagedRawQuery, parseFilters } = prisma;
  const { search, minDuration } = filters;
  const minDurationMs = minDuration && minDuration > 0 ? minDuration * 1000 : undefined;
  const { filterQuery, cohortQuery, queryParams, joinSessionQuery } = parseFilters({
    ...filters,
    websiteId,
    search: search ? `%${search}%` : undefined,
  });

  const joinQuery =
    filterQuery || cohortQuery
      ? `join (select distinct website_event.website_id, website_event.session_id, website_event.visit_id
               from website_event
               ${joinSessionQuery}
               ${cohortQuery}
               where website_event.website_id = {{websiteId::uuid}}
                  and website_event.created_at between {{startDate}} and {{endDate}}
                  and website_event.event_type != ${EVENT_TYPE.performance}
                  and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
                  ${filterQuery}) website_event
        on website_event.website_id = sr.website_id
          and website_event.session_id = sr.session_id
          and website_event.visit_id = sr.visit_id`
      : '';

  const sessionFilter = sessionId ? 'and sr.session_id = {{sessionId::uuid}}' : '';

  const searchQuery = search
    ? `and (exists (
             select 1 from session_link verified_link
             where verified_link.website_id = sr.website_id
               and verified_link.session_id = sr.session_id
               and verified_link.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}
               and verified_link.distinct_id ilike {{search}})
           or session.city ilike {{search}}
           or session.browser ilike {{search}}
           or session.os ilike {{search}}
           or session.device ilike {{search}})`
    : '';

  const havingQuery = minDurationMs
    ? `having sum(extract(epoch from sr.ended_at - sr.started_at) * 1000) >= {{minDurationMs}}`
    : '';

  return pagedRawQuery(
    `
    select
      sr.visit_id as "id",
      sr.session_id as "sessionId",
      sr.website_id as "websiteId",
      session.browser,
      session.os,
      session.device,
      session.country,
      session.city,
      sum(sr.event_count) as "eventCount",
      count(sr.replay_id) as "chunkCount",
      min(sr.started_at) as "startedAt",
      max(sr.ended_at) as "endedAt",
      sum(extract(epoch from sr.ended_at - sr.started_at) * 1000)::bigint as "duration",
      max(sr.created_at) as "createdAt"
    from session_replay sr
    join session on session.session_id = sr.session_id
      and session.website_id = sr.website_id
    ${joinQuery}
    where sr.website_id = {{websiteId::uuid}}
      and sr.created_at between {{startDate}} and {{endDate}}
      and (sr.retention_expires_at is null or sr.retention_expires_at > CURRENT_TIMESTAMP)
    ${sessionFilter}
    ${searchQuery}
    group by sr.visit_id,
      sr.session_id,
      sr.website_id,
      session.browser,
      session.os,
      session.device,
      session.country,
      session.city
    ${havingQuery}
    order by max(sr.created_at) desc
    `,
    { ...queryParams, sessionId, minDurationMs },
    filters,
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(websiteId: string, filters: QueryFilters, sessionId?: string) {
  const { pagedRawQuery, parseFilters } = clickhouse;
  const { search, minDuration } = filters;
  const verifiedSessionIds = search
    ? await getVerifiedIdentitySearchSessions(websiteId, search, sessionId)
    : [];
  const minDurationMs = minDuration && minDuration > 0 ? minDuration * 1000 : undefined;
  const { queryParams, cohortQuery, filterQuery } = parseFilters({
    ...filters,
    websiteId,
  });

  const sessionFilter = sessionId ? 'and session_replay.session_id = {sessionId:UUID}' : '';

  const searchQuery = search
    ? `and (has({verifiedSessionIds:Array(UUID)}, website_event.session_id)
           or (positionCaseInsensitive(city, {search:String}) > 0)
           or (positionCaseInsensitive(browser, {search:String}) > 0)
           or (positionCaseInsensitive(os, {search:String}) > 0)
           or (positionCaseInsensitive(device, {search:String}) > 0))`
    : '';

  const havingQuery = minDurationMs
    ? `having toInt64(sum(toUnixTimestamp64Milli(session_replay.ended_at) - toUnixTimestamp64Milli(session_replay.started_at))) >= {minDurationMs:Int64}`
    : '';

  return pagedRawQuery(
    `
    select
      session_replay.visit_id as id,
      session_replay.session_id as sessionId,
      session_replay.website_id as websiteId,
      website_event.browser,
      website_event.os,
      website_event.device,
      website_event.country,
      website_event.city,
      sum(session_replay.event_count) as eventCount,
      count(session_replay.replay_id) as chunkCount,
      min(session_replay.started_at) as startedAt,
      max(session_replay.ended_at) as endedAt,
      toInt64(sum(toUnixTimestamp64Milli(session_replay.ended_at) - toUnixTimestamp64Milli(session_replay.started_at))) as duration,
      max(session_replay.created_at) as createdAt
    from session_replay
    join (
      select distinct website_id, session_id, visit_id, browser, os, device, country, city
      from website_event
      ${cohortQuery}
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type != ${EVENT_TYPE.performance}
        and (event_type != ${EVENT_TYPE.customEvent} or trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
        ${filterQuery}
        ${searchQuery}
    ) website_event
    on website_event.session_id = session_replay.session_id
      and website_event.website_id = session_replay.website_id
      and website_event.visit_id = session_replay.visit_id
    where session_replay.website_id = {websiteId:UUID}
        and session_replay.created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and (session_replay.retention_policy = 0 or session_replay.ingested_at + INTERVAL 30 DAY > now('UTC'))
    ${sessionFilter}
    group by session_replay.visit_id, session_replay.session_id, session_replay.website_id, website_event.browser, website_event.os, website_event.device, website_event.country, website_event.city
    ${havingQuery}
    order by max(created_at) desc
    `,
    { ...queryParams, sessionId, minDurationMs, verifiedSessionIds },
    filters,
    FUNCTION_NAME,
  );
}
