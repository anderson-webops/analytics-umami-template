import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, EVENT_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';

export interface GoalParameters {
  startDate: Date;
  endDate: Date;
  type: string;
  value: string;
}

export interface GoalResult {
  num: number;
  total: number;
  numeratorProvenance: 'unverified_pageview' | 'backend_authorized_event';
  denominatorProvenance: 'may_include_unverified_traffic';
}

export async function getGoal(
  ...args: [websiteId: string, params: GoalParameters, filters: QueryFilters]
): Promise<GoalResult> {
  const result = await runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });

  if (!result) {
    return result;
  }

  return {
    ...result,
    numeratorProvenance:
      args[1].type === 'path' ? 'unverified_pageview' : 'backend_authorized_event',
    denominatorProvenance: 'may_include_unverified_traffic',
  };
}

async function relationalQuery(
  websiteId: string,
  parameters: GoalParameters,
  filters: QueryFilters,
) {
  const { startDate, endDate, type, value } = parameters;
  const { rawQuery, parseFilters } = prisma;
  const eventType = type === 'path' ? EVENT_TYPE.pageView : EVENT_TYPE.customEvent;
  const column = type === 'path' ? 'url_path' : 'event_name';
  const claimGuard =
    type === 'path'
      ? ''
      : `and website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}`;

  let operator = '=';
  let paramValue = value;
  if (value.startsWith('*') || value.endsWith('*')) {
    operator = 'like';
    paramValue = value.replace(/^\*|\*$/g, '%');
  }

  const { filterQuery, dateQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    value: paramValue,
    startDate,
    endDate,
    eventType,
  });

  const excludeEventTypeFilterQuery = filterQuery
    .split('\n')
    .filter(filter => !filter.includes('event_type'))
    .join('\n')
    .trim();

  return rawQuery(
    `
    select count(distinct website_event.session_id) as num,
    (
      select count(distinct website_event.session_id)
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId::uuid}}
      and website_event.event_type != ${EVENT_TYPE.performance}
      and (website_event.event_type != ${EVENT_TYPE.customEvent} or website_event.trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
      ${dateQuery}
      ${excludeEventTypeFilterQuery}
    ) as total
    from website_event
    ${cohortQuery}
    ${joinSessionQuery}
    where website_event.website_id = {{websiteId::uuid}}
      and ${column} ${operator} {{value}}
      ${claimGuard}
      ${dateQuery}
      ${filterQuery}
    `,
    queryParams,
  ).then(results => results?.[0]);
}

async function clickhouseQuery(
  websiteId: string,
  parameters: GoalParameters,
  filters: QueryFilters,
) {
  const { startDate, endDate, type, value } = parameters;
  const { rawQuery, parseFilters } = clickhouse;
  const eventType = type === 'path' ? EVENT_TYPE.pageView : EVENT_TYPE.customEvent;
  const column = type === 'path' ? 'url_path' : 'event_name';
  const claimGuard =
    type === 'path' ? '' : `and trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized}`;

  let operator = '=';
  let paramValue = value;
  if (value.startsWith('*') || value.endsWith('*')) {
    operator = 'like';
    paramValue = value.replace(/^\*|\*$/g, '%');
  }

  const { filterQuery, dateQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    value: paramValue,
    startDate,
    endDate,
    eventType,
  });

  const excludeEventTypeFilterQuery = filterQuery
    .split('\n')
    .filter(filter => !filter.includes('event_type'))
    .join('\n')
    .trim();

  return rawQuery(
    `
    select count(distinct session_id) as num,
    (
      select count(distinct session_id)
      from website_event
      ${cohortQuery}
      where website_id = {websiteId:UUID}
        and event_type != ${EVENT_TYPE.performance}
        and (event_type != ${EVENT_TYPE.customEvent} or trust_tier = ${COLLECTION_TRUST_TIER.backendAuthorized})
        ${dateQuery}
        ${excludeEventTypeFilterQuery}
    ) as total
    from website_event
    ${cohortQuery}
    where website_id = {websiteId:UUID}
      and ${column} ${operator} {value:String}
      ${claimGuard}
      ${dateQuery}
      ${filterQuery}
    `,
    queryParams,
  ).then(results => results?.[0]);
}
