import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getSessionDataArraySeries, getSessionDataPropertySeries } from '@/queries/sql';
import { getEventDataArraySeries } from '@/queries/sql/events/getEventDataArraySeries';
import { getEventDataPropertySeries } from '@/queries/sql/events/getEventDataPropertySeries';
import { GET as eventArray } from './[websiteId]/event-data-pivot/array-series/route';
import { GET as eventProperty } from './[websiteId]/event-data-pivot/property-series/route';
import { GET as sessionArray } from './[websiteId]/session-data/array-series/route';
import { GET as sessionProperty } from './[websiteId]/session-data/property-series/route';

vi.mock('@/lib/request', () => ({
  getQueryFilters: vi.fn(),
  parseRequest: vi.fn(),
}));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql/events/getEventDataArraySeries', () => ({
  getEventDataArraySeries: vi.fn(),
}));
vi.mock('@/queries/sql/events/getEventDataPropertySeries', () => ({
  getEventDataPropertySeries: vi.fn(),
}));
vi.mock('@/queries/sql', () => ({
  getSessionDataArraySeries: vi.fn(),
  getSessionDataPropertySeries: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getQueryFiltersMock = vi.mocked(getQueryFilters);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const queries = [
  vi.mocked(getEventDataArraySeries),
  vi.mocked(getEventDataPropertySeries),
  vi.mocked(getSessionDataArraySeries),
  vi.mocked(getSessionDataPropertySeries),
];
const routes = [eventArray, eventProperty, sessionArray, sessionProperty];
const params = Promise.resolve({ websiteId: 'website-1' });

beforeEach(() => {
  vi.resetAllMocks();
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2, eventName: 'signup', propertyName: 'plan' },
    error: undefined,
  } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getQueryFiltersMock.mockResolvedValue({
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: new Date('2026-09-03T00:00:00Z'),
    unit: 'day',
  });
  for (const query of queries) {
    query.mockResolvedValue([]);
  }
});

async function callRoute(
  route: (
    request: Request,
    context: { params: Promise<{ websiteId: string }> },
  ) => Promise<Response>,
) {
  return route(new Request('http://localhost/api/websites/website-1/property-series'), { params });
}

test('all four routes reject an oversized value-by-bucket request before SQL', async () => {
  getQueryFiltersMock.mockResolvedValue({
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: new Date('2026-10-01T00:00:00Z'),
    unit: 'minute',
  });

  for (const route of routes) {
    expect((await callRoute(route)).status).toBe(400);
  }
  for (const query of queries) {
    expect(query).not.toHaveBeenCalled();
  }
});

test('all four routes preserve ordinary bounded charts', async () => {
  for (const route of routes) {
    expect((await callRoute(route)).status).toBe(200);
  }
  for (const query of queries) {
    expect(query).toHaveBeenCalledOnce();
  }
});

test('authorization is still required before budget validation', async () => {
  canViewWebsiteSectionMock.mockResolvedValue(false);

  for (const route of routes) {
    expect((await callRoute(route)).status).toBe(401);
  }
  expect(getQueryFiltersMock).not.toHaveBeenCalled();
});

test('retention-adjusted empty date ranges return no data', async () => {
  getQueryFiltersMock.mockResolvedValue({
    startDate: new Date('2026-09-03T00:00:00Z'),
    endDate: new Date('2026-09-01T00:00:00Z'),
    unit: 'day',
  });

  for (const route of routes) {
    const response = await callRoute(route);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  }
  for (const query of queries) {
    expect(query).not.toHaveBeenCalled();
  }
});
