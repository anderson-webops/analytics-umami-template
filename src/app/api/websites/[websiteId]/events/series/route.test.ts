import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getEventSeriesLimit, getEventStats, isEventSeriesWithinBudget } from '@/queries/sql';
import { GET } from './route';

vi.mock('@/lib/request', () => ({
  getQueryFilters: vi.fn(),
  parseRequest: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canViewWebsiteSection: vi.fn(),
}));

vi.mock('@/queries/sql', () => ({
  getEventSeriesLimit: vi.fn(),
  getEventStats: vi.fn(),
  isEventSeriesWithinBudget: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getQueryFiltersMock = vi.mocked(getQueryFilters);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const getEventSeriesLimitMock = vi.mocked(getEventSeriesLimit);
const getEventStatsMock = vi.mocked(getEventStats);
const isEventSeriesWithinBudgetMock = vi.mocked(isEventSeriesWithinBudget);
const params = Promise.resolve({ websiteId: 'website-1' });

beforeEach(() => {
  vi.resetAllMocks();
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2, timezone: 'UTC' },
    error: undefined,
  } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getEventSeriesLimitMock.mockReturnValue(50);
  isEventSeriesWithinBudgetMock.mockReturnValue(true);
  getEventStatsMock.mockResolvedValue([]);
});

async function requestSeries() {
  return GET(new Request('http://localhost/api/websites/website-1/events/series'), { params });
}

test('returns an empty series when retention leaves no matching date range', async () => {
  getQueryFiltersMock.mockResolvedValue({
    startDate: new Date('2026-09-02T00:00:00Z'),
    endDate: new Date('2026-09-01T00:00:00Z'),
    unit: 'day',
  });

  const response = await requestSeries();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
  expect(isEventSeriesWithinBudgetMock).not.toHaveBeenCalled();
  expect(getEventStatsMock).not.toHaveBeenCalled();
});

test('rejects an oversized chart before querying the database', async () => {
  const filters = {
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: new Date('2026-09-30T00:00:00Z'),
    unit: 'hour',
  };
  getQueryFiltersMock.mockResolvedValue(filters);
  isEventSeriesWithinBudgetMock.mockReturnValue(false);

  const response = await requestSeries();

  expect(response.status).toBe(400);
  expect(getEventStatsMock).not.toHaveBeenCalled();
});

test('passes the bounded default to the query for an ordinary chart', async () => {
  const filters = {
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: new Date('2026-09-02T00:00:00Z'),
    unit: 'day',
  };
  getQueryFiltersMock.mockResolvedValue(filters);

  const response = await requestSeries();

  expect(response.status).toBe(200);
  expect(getEventStatsMock).toHaveBeenCalledWith('website-1', { limit: 50 }, filters);
});
