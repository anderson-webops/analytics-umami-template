import { isUuid } from '@/lib/crypto';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import prisma from '@/lib/prisma';
import { LINKED_QUERY_TIMEOUT_MS, MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';
import type { QueryFilters } from '@/lib/types';
import { getWebsite } from '@/queries/prisma/website';
import { getVerifiedIdentityLinks } from '../sessions/getVerifiedIdentityLinks';
import { queryVerifiedIdentityEvents } from '../sessions/queryVerifiedIdentityEvents';

const FUNCTION_NAME = 'getReplayDistinctIds';

interface ReplaySession {
  visitId: string;
  sessionId: string;
}

export async function getReplayDistinctIds(
  websiteId: string,
  visitIds: string[],
  filters: Pick<QueryFilters, 'startDate' | 'endDate'> = {},
): Promise<Record<string, string[]>> {
  if (!visitIds.length) return {};
  if (visitIds.length > MAX_AUTH_SESSION_ROWS) throw new IdentitySearchTooBroadError();
  if (!isUuid(websiteId) || visitIds.some(visitId => !isUuid(visitId))) {
    throw new Error('INVALID_REPLAY_IDENTIFIER');
  }

  const selectedVisits = [...new Set(visitIds)];
  const result = Object.fromEntries(selectedVisits.map(visitId => [visitId, [] as string[]]));
  const website = await getWebsite(websiteId);
  if (!website) return result;

  const startDate = Math.max(
    filters.startDate == null ? 0 : +filters.startDate,
    website.resetAt == null ? 0 : +new Date(website.resetAt),
  );
  const endDate = filters.endDate ?? new Date();
  if (!Number.isFinite(startDate) || !Number.isFinite(+endDate)) {
    throw new Error('INVALID_REPLAY_DATE_RANGE');
  }
  if (startDate > +endDate) return result;

  const parameters = {
    websiteId,
    visitIds: selectedVisits,
    startDate: new Date(startDate),
    endDate,
    rowLimit: MAX_AUTH_SESSION_ROWS + 1,
  };
  const rows: ReplaySession[] = await runQuery({
    [PRISMA]: () =>
      prisma.rawQuery(
        `select distinct visit_id as "visitId", session_id as "sessionId"
       from session_replay
       where website_id = {{websiteId::uuid}}
         and visit_id = any({{visitIds}}::uuid[])
         and created_at between {{startDate}} and {{endDate}}
         and (retention_expires_at is null or retention_expires_at > CURRENT_TIMESTAMP)
       limit {{rowLimit}}`,
        parameters,
        FUNCTION_NAME,
        LINKED_QUERY_TIMEOUT_MS,
      ),
    [CLICKHOUSE]: () =>
      queryVerifiedIdentityEvents<ReplaySession>(
        `select distinct visit_id as visitId, session_id as sessionId
       from session_replay
       where website_id = {websiteId:UUID}
         and visit_id in {visitIds:Array(UUID)}
         and created_at between {startDate:DateTime64} and {endDate:DateTime64}
         and (retention_policy = 0 or ingested_at + INTERVAL 30 DAY > now('UTC'))
       limit {rowLimit:UInt32}`,
        parameters,
        FUNCTION_NAME,
      ),
  });

  if (rows.length > MAX_AUTH_SESSION_ROWS) throw new IdentitySearchTooBroadError();
  const links = await getVerifiedIdentityLinks(websiteId, [
    ...new Set(rows.map(row => row.sessionId)),
  ]);
  const identities = new Map<string, Set<string>>();
  for (const { sessionId, distinctId } of links) {
    if (!identities.has(sessionId)) identities.set(sessionId, new Set());
    identities.get(sessionId).add(distinctId);
  }

  const byVisit = new Map<string, Set<string>>();
  for (const { visitId, sessionId } of rows) {
    if (!Object.hasOwn(result, visitId)) continue;
    if (!byVisit.has(visitId)) byVisit.set(visitId, new Set());
    for (const distinctId of identities.get(sessionId) ?? []) {
      byVisit.get(visitId).add(distinctId);
    }
  }
  for (const [visitId, distinctIds] of byVisit) result[visitId] = [...distinctIds].sort();
  return result;
}
