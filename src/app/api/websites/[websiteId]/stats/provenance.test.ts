import { beforeEach, expect, test, vi } from 'vitest';
import { getBoundedCompareDate, getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getWebsiteStats } from '@/queries/sql';
import { GET as getStats } from './route';
import { GET as getTrafficStats } from './traffic/route';

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
  getQueryFilters: vi.fn(),
  getBoundedCompareDate: vi.fn(),
}));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql', () => ({ getWebsiteStats: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const currentStats = {
  pageviews: 11,
  unverifiedViews: 11,
  visitors: 5,
  visits: 6,
  bounces: 2,
  totaltime: 30,
};
const comparisonStats = {
  pageviews: 9,
  unverifiedViews: 9,
  visitors: 4,
  visits: 5,
  bounces: 1,
  totaltime: 25,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'viewer' } },
    query: {},
  } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getQueryFilters).mockResolvedValue({
    startDate: new Date('2026-10-01T00:00:00Z'),
    endDate: new Date('2026-10-02T00:00:00Z'),
  } as any);
  vi.mocked(getBoundedCompareDate).mockResolvedValue({
    compare: 'prev',
    startDate: new Date('2026-09-30T00:00:00Z'),
    endDate: new Date('2026-10-01T00:00:00Z'),
  });
  vi.mocked(getWebsiteStats)
    .mockResolvedValueOnce(currentStats)
    .mockResolvedValueOnce(comparisonStats);
});

test.each([
  ['/stats', getStats],
  ['/stats/traffic', getTrafficStats],
] as const)('%s separates public observations from total views', async (path, handler) => {
  const response = await handler(
    new Request(`https://analytics.example/api/websites/${websiteId}${path}`),
    { params: Promise.resolve({ websiteId }) },
  );
  const result = await response.json();

  expect(response.status).toBe(200);
  expect(result).toMatchObject({
    pageviews: 11,
    unverifiedViews: 11,
    comparison: { pageviews: 9, unverifiedViews: 9 },
  });
  expect(getWebsiteStats).toHaveBeenCalledTimes(2);
});
