import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { reserveAuthenticatedQueryCost } from '@/lib/share-query-budget';
import { canViewReport, canViewWebsiteSection } from '@/permissions';
import { getReport, getWebsite } from '@/queries/prisma';
import { getGoal } from '@/queries/sql/goals/getGoal';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewReport: vi.fn(), canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/prisma', () => ({ getReport: vi.fn(), getWebsite: vi.fn() }));
vi.mock('@/queries/sql/goals/getGoal', () => ({ getGoal: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const startAt = Date.UTC(2025, 0, 1);
const endAt = Date.UTC(2025, 0, 31);

beforeEach(() => {
  vi.mocked(parseRequest).mockReset();
  vi.mocked(getQueryFilters).mockReset();
  vi.mocked(canViewWebsiteSection).mockReset();
  vi.mocked(canViewReport).mockReset();
  vi.mocked(getReport).mockReset();
  vi.mocked(getWebsite).mockResolvedValue({ id: websiteId, userId: websiteId } as any);
  vi.mocked(getGoal).mockReset();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: `saved-goal-user-${crypto.randomUUID()}` } },
    query: { startAt, endAt },
  } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(canViewReport).mockResolvedValue(true);
  vi.mocked(getReport).mockResolvedValue({
    websiteId,
    type: 'goal',
    parameters: { type: 'path', value: '*/checkout' },
  } as any);
  vi.mocked(getQueryFilters).mockResolvedValue({
    startDate: new Date(startAt),
    endDate: new Date(endAt),
  } as any);
  vi.mocked(getGoal).mockResolvedValue({ num: 1, total: 1 } as any);
});

test('reserves stored goal work for authenticated viewers before executing analytics', async () => {
  const userId = `saved-goal-user-${crypto.randomUUID()}`;
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: userId } },
    query: { startAt, endAt },
  } as any);
  expect((await reserveAuthenticatedQueryCost(userId, 20_000, 0)).blocked).toBe(false);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/goals/report/stats'),
    { params: Promise.resolve({ websiteId, goalId: 'report' }) },
  );

  expect(response.status).toBe(429);
  expect(getGoal).not.toHaveBeenCalled();
});

test('preserves ordinary saved goal analytics for authenticated viewers', async () => {
  vi.mocked(getGoal).mockResolvedValue({
    num: 1,
    total: 2,
    numeratorProvenance: 'unverified_pageview',
    denominatorProvenance: 'may_include_unverified_traffic',
  });
  const response = await GET(
    new Request('https://analytics.example/api/websites/site/goals/report/stats'),
    { params: Promise.resolve({ websiteId, goalId: 'report' }) },
  );

  expect(response.status).toBe(200);
  expect(getGoal).toHaveBeenCalledTimes(1);
  expect(await response.json()).toEqual({
    num: 1,
    total: 2,
    numeratorProvenance: 'unverified_pageview',
    denominatorProvenance: 'may_include_unverified_traffic',
  });
});

test('preserves ordinary saved goal analytics for public shares', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { shareToken: { shareId: `saved-goal-share-${crypto.randomUUID()}`, websiteId } },
    query: { startAt, endAt },
  } as any);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/goals/report/stats'),
    { params: Promise.resolve({ websiteId, goalId: 'report' }) },
  );

  expect(response.status).toBe(200);
  expect(getGoal).toHaveBeenCalledTimes(1);
});

test('charges the user for saved goal work even with a share credential', async () => {
  const userId = `mixed-goal-user-${crypto.randomUUID()}`;
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: userId }, shareToken: { shareId: crypto.randomUUID(), websiteId } },
    query: { startAt, endAt },
  } as any);
  expect((await reserveAuthenticatedQueryCost(userId, 20_000, 0)).blocked).toBe(false);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/goals/report/stats'),
    { params: Promise.resolve({ websiteId, goalId: 'report' }) },
  );

  expect(response.status).toBe(429);
  expect(getGoal).not.toHaveBeenCalled();
});
