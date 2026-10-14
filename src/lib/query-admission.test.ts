import { beforeEach, expect, test, vi } from 'vitest';
import { getWebsite } from '@/queries/prisma';
import { completeTestResponses } from '@/test/setup';
import {
  getTenantQueryIdentity,
  reserveAdditionalAuthenticatedQueryWork,
  reserveAuthorizedBatchTenantWork,
} from './query-admission';
import { reserveAuthenticatedQueryLease } from './query-concurrency';
import { reserveAuthenticatedQueryCost, reserveTenantQueryCost } from './share-query-budget';

vi.mock('@/queries/prisma', () => ({ getWebsite: vi.fn() }));

const getWebsiteMock = vi.mocked(getWebsite);

beforeEach(() => {
  getWebsiteMock.mockReset();
});

test('charges separate websites of one team to the same cumulative tenant budget', async () => {
  const teamId = crypto.randomUUID();
  const firstWebsiteId = crypto.randomUUID();
  const secondWebsiteId = crypto.randomUUID();
  getWebsiteMock.mockImplementation(
    async websiteId => ({ id: websiteId, teamId, userId: null }) as any,
  );

  expect(await getTenantQueryIdentity(firstWebsiteId)).toBe(`team:${teamId}`);
  expect(
    await reserveAdditionalAuthenticatedQueryWork(crypto.randomUUID(), firstWebsiteId, 20_000),
  ).toBeNull();
  expect(
    await reserveAdditionalAuthenticatedQueryWork(crypto.randomUUID(), secondWebsiteId, 20_000),
  ).toBeNull();
  const denied = await reserveAdditionalAuthenticatedQueryWork(
    crypto.randomUUID(),
    secondWebsiteId,
    1,
  );

  expect(denied?.status).toBe(429);
  await completeTestResponses();
});

test('denies unknown or unowned websites before consuming a viewer budget', async () => {
  const userId = crypto.randomUUID();
  getWebsiteMock.mockResolvedValue(null);

  const denied = await reserveAdditionalAuthenticatedQueryWork(userId, crypto.randomUUID(), 10);

  expect(denied?.status).toBe(503);
  expect((await reserveAuthenticatedQueryCost(userId, 20_000, 0)).blocked).toBe(false);
});

test('enforces one team concurrency cap across multiple websites', async () => {
  const teamId = crypto.randomUUID();
  getWebsiteMock.mockImplementation(
    async websiteId => ({ id: websiteId, teamId, userId: null }) as any,
  );
  const occupiers = await Promise.all(
    Array.from({ length: 4 }, () =>
      reserveAuthenticatedQueryLease(crypto.randomUUID(), `team:${teamId}`, 9_600),
    ),
  );

  expect(occupiers.every(lease => !lease.blocked)).toBe(true);
  const denied = await reserveAdditionalAuthenticatedQueryWork(
    crypto.randomUUID(),
    crypto.randomUUID(),
    1,
  );
  expect(denied?.status).toBe(429);

  for (const lease of occupiers) {
    if ('release' in lease) await lease.release();
  }
});

test('does not charge any team when a later team denies a batch', async () => {
  const firstWebsiteId = crypto.randomUUID();
  const secondWebsiteId = crypto.randomUUID();
  const firstTeamId = crypto.randomUUID();
  const secondTeamId = crypto.randomUUID();
  getWebsiteMock.mockImplementation(
    async websiteId =>
      ({
        id: websiteId,
        teamId: websiteId === firstWebsiteId ? firstTeamId : secondTeamId,
        userId: null,
      }) as any,
  );
  expect((await reserveTenantQueryCost(`team:${secondTeamId}`, 40_000, 0)).blocked).toBe(false);

  const denied = await reserveAuthorizedBatchTenantWork([firstWebsiteId, secondWebsiteId], 10);

  expect(denied?.status).toBe(429);
  expect((await reserveTenantQueryCost(`team:${firstTeamId}`, 40_000, 0)).blocked).toBe(false);
});
