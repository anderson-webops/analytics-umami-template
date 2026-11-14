import clickhouse from '@/lib/clickhouse';
import { EVENT_TYPE } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type { RevenuParameters } from './getRevenueChart';
import { isImportedRevenue } from './importedRevenue';

export interface RevenueStatsResult {
  sum: number;
  count: number;
  average: number;
  unique_count: number;
  arpu: null;
}

export async function getRevenueStats(
  ...args: [websiteId: string, parameters: RevenuParameters, filters: QueryFilters]
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  parameters: RevenuParameters,
  filters: QueryFilters,
): Promise<RevenueStatsResult> {
  const { startDate, endDate, currency } = parameters;
  const { rawQuery, parseFilters } = prisma;
  const { queryParams, filterQuery, cohortQuery, joinSessionQuery, dateQuery } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
    currency,
  });

  const total = await rawQuery(
    `
    with
      filtered_sessions as (
        select distinct website_event.website_id, website_event.session_id
        from website_event
        ${cohortQuery}
        ${joinSessionQuery}
        where website_event.website_id = {{websiteId::uuid}}
          and website_event.event_type != ${EVENT_TYPE.performance}
        ${dateQuery}
        ${filterQuery}
      ),
      filtered_revenue as (
        select revenue.website_id, revenue.session_id, revenue.event_id, revenue.revenue
        from revenue
        join filtered_sessions
          on filtered_sessions.website_id = revenue.website_id
         and filtered_sessions.session_id = revenue.session_id
        where revenue.website_id = {{websiteId::uuid}}
          and revenue.created_at between {{startDate}} and {{endDate}}
          and upper(revenue.currency) = {{currency}}
      )
    select
      sum(filtered_revenue.revenue) as sum,
      count(distinct case when filtered_revenue.revenue > 0 then filtered_revenue.event_id end) as count,
      count(distinct filtered_revenue.session_id) as unique_count
    from filtered_revenue
    `,
    queryParams,
  ).then(result => result?.[0]);

  total.average = total.count > 0 ? Number(total.sum) / Number(total.count) : 0;
  total.arpu = null;

  return total;
}

async function clickhouseQuery(
  websiteId: string,
  parameters: RevenuParameters,
  filters: QueryFilters,
): Promise<RevenueStatsResult> {
  const { startDate, endDate, currency } = parameters;
  const { rawQuery, parseFilters } = clickhouse;
  const { filterQuery, cohortQuery, dateQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
    currency,
  });

  const total = await rawQuery<{
    sum: number;
    count: number;
    unique_count: number;
  }>(
    `
    with
      filtered_sessions as (
        select
          session_id,
          countIf(not ${isImportedRevenue('event_name')}) as tracked_events
        from website_event
        ${cohortQuery}
        where website_id = {websiteId:UUID}
          and event_type != ${EVENT_TYPE.performance}
        ${dateQuery}
        ${filterQuery}
        group by session_id
      ),
      filtered_revenue as (
        select event_id, session_id, revenue
        from website_revenue
        where website_id = {websiteId:UUID}
          and created_at between {startDate:DateTime64} and {endDate:DateTime64}
          and upper(currency) = {currency:String}
          and (${isImportedRevenue('event_name')}
            or session_id in (select session_id from filtered_sessions))
      )
    select
      sum(filtered_revenue.revenue) as sum,
      uniqExactIf(filtered_revenue.event_id, filtered_revenue.revenue > 0) as count,
      uniqExact(filtered_revenue.session_id) as unique_count
    from filtered_revenue
    `,
    queryParams,
  ).then(result => result?.[0]);

  total.average = total.count > 0 ? total.sum / total.count : 0;
  total.arpu = null;

  return total;
}
