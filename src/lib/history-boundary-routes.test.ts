import { beforeEach, expect, test, vi } from 'vitest';
import {
  getBoundedCompareDate,
  getQueryFilters,
  parseRequest,
  setWebsiteDate,
} from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getJourney, getWebsiteStats } from '@/queries/sql';
import { POST as postCompatibilityJourney } from '../app/(compat)/compat/api/reports/journey/route';
import { GET as getWebsiteStatsRoute } from '../app/api/websites/[websiteId]/stats/route';

vi.mock('@/lib/request', () => ({
  getBoundedCompareDate: vi.fn(),
  getQueryFilters: vi.fn(),
  parseRequest: vi.fn(),
  setWebsiteDate: vi.fn(),
}));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql', () => ({ getJourney: vi.fn(), getWebsiteStats: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const startDate = new Date('2026-09-02T00:00:00.000Z');
const endDate = new Date('2026-09-03T00:00:00.000Z');
const cutoff = new Date('2026-09-01T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getQueryFilters).mockResolvedValue({ startDate, endDate } as any);
  vi.mocked(getBoundedCompareDate).mockResolvedValue({
    compare: 'prev',
    startDate: cutoff,
    endDate: startDate,
  });
});

test('website stats use the bounded comparison period', async () => {
  vi.mocked(parseRequest).mockResolvedValue({ auth: {}, query: {} } as any);
  vi.mocked(getWebsiteStats).mockResolvedValue({ pageviews: 0, visitors: 0, visits: 0 } as any);

  const response = await getWebsiteStatsRoute(
    new Request(`https://analytics.example/api/websites/${websiteId}/stats`),
    { params: Promise.resolve({ websiteId }) },
  );

  expect(response.status).toBe(200);
  expect(getBoundedCompareDate).toHaveBeenCalledWith(websiteId, 'prev', startDate, endDate);
  expect(getWebsiteStats).toHaveBeenNthCalledWith(2, websiteId, {
    startDate: cutoff,
    endDate: startDate,
  });
});

test('compatibility journey applies the website history limit to its parameters', async () => {
  const parameters = { startDate, endDate, steps: 3 };
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {},
    body: { websiteId, parameters, filters: {} },
  } as any);
  vi.mocked(setWebsiteDate).mockResolvedValue({ ...parameters, startDate: cutoff });
  vi.mocked(getJourney).mockResolvedValue([]);

  const response = await postCompatibilityJourney(
    new Request('https://analytics.example/compat/api/reports/journey', { method: 'POST' }),
  );

  expect(response.status).toBe(200);
  expect(setWebsiteDate).toHaveBeenCalledWith(websiteId, parameters);
  expect(getJourney).toHaveBeenCalledWith(
    websiteId,
    { ...parameters, startDate: cutoff },
    { startDate, endDate },
  );
});
