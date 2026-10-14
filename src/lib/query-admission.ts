import { reserveAuthenticatedQueryLease } from '@/lib/query-concurrency';
import { releaseAfterResponse } from '@/lib/request-lifecycle';
import { badRequest, serviceUnavailable, tooManyRequests } from '@/lib/response';
import {
  reserveAuthenticatedQueryCost,
  reserveTenantQueryCost,
  reserveTenantQueryCosts,
} from '@/lib/share-query-budget';
import { getLink, getPixel, getWebsite } from '@/queries/prisma';

type AnalyticsEntity = 'website' | 'link' | 'pixel';

export async function getTenantQueryIdentity(
  entityId: string,
  entityType: AnalyticsEntity = 'website',
): Promise<string | null> {
  const entity =
    entityType === 'link'
      ? await getLink(entityId)
      : entityType === 'pixel'
        ? await getPixel(entityId)
        : await getWebsite(entityId);

  if (!entity) return null;
  if (entity.teamId) return `team:${entity.teamId}`;
  if (entity.userId) return `user:${entity.userId}`;
  return null;
}

export async function reserveAdditionalAuthenticatedQueryWork(
  userId: string,
  websiteId: string,
  cost: number,
): Promise<Response | null> {
  if (cost <= 0) return null;

  let tenantId: string | null;

  try {
    tenantId = await getTenantQueryIdentity(websiteId);
  } catch {
    return serviceUnavailable();
  }

  if (!tenantId) return serviceUnavailable();

  const userLimit = await reserveAuthenticatedQueryCost(userId, cost, 0);
  if (userLimit.unavailable) return serviceUnavailable();
  if (userLimit.blocked) return tooManyRequests(userLimit.retryAfter);

  const lease = await reserveAuthenticatedQueryLease(userId, tenantId, cost);
  if (!('release' in lease)) {
    return lease.unavailable ? serviceUnavailable() : tooManyRequests(lease.retryAfter);
  }

  let releaseScheduled = false;

  try {
    const tenantLimit = await reserveTenantQueryCost(tenantId, cost, 0);
    if (tenantLimit.unavailable) return serviceUnavailable();
    if (tenantLimit.blocked) return tooManyRequests(tenantLimit.retryAfter);

    releaseAfterResponse(lease.release);
    releaseScheduled = true;
    return null;
  } catch {
    return serviceUnavailable();
  } finally {
    if (!releaseScheduled) await lease.release();
  }
}

export async function reserveAuthorizedBatchTenantWork(
  entityIds: string[],
  costPerEntity: number,
  entityType: AnalyticsEntity = 'website',
): Promise<Response | null> {
  if (!Number.isSafeInteger(costPerEntity) || costPerEntity < 1) return badRequest();
  if (!entityIds.length) return null;

  const tenantCosts = new Map<string, number>();

  try {
    for (const entityId of entityIds) {
      const tenantId = await getTenantQueryIdentity(entityId, entityType);
      if (!tenantId) return serviceUnavailable();
      tenantCosts.set(tenantId, (tenantCosts.get(tenantId) ?? 0) + costPerEntity);
    }
  } catch {
    return serviceUnavailable();
  }

  const releases: (() => Promise<void>)[] = [];
  let releaseScheduled = false;

  try {
    for (const [tenantId, cost] of tenantCosts) {
      const lease = await reserveAuthenticatedQueryLease(`batch:${tenantId}`, tenantId, cost);
      if (!('release' in lease)) {
        return lease.unavailable ? serviceUnavailable() : tooManyRequests(lease.retryAfter);
      }
      releases.push(lease.release);
    }

    const tenantLimit = await reserveTenantQueryCosts(tenantCosts);
    if (tenantLimit.unavailable) return serviceUnavailable();
    if (tenantLimit.blocked) return tooManyRequests(tenantLimit.retryAfter);

    releaseAfterResponse(async () => {
      await Promise.all(releases.map(release => release()));
    });
    releaseScheduled = true;
    return null;
  } catch {
    return serviceUnavailable();
  } finally {
    if (!releaseScheduled) await Promise.all(releases.map(release => release()));
  }
}
