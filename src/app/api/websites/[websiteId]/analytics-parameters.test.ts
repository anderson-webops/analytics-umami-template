import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewReport, canViewWebsiteSection } from '@/permissions';
import { getReport } from '@/queries/prisma';
import { getFunnel } from '@/queries/sql/funnels/getFunnel';
import { getPerformanceChart } from '@/queries/sql/performance/getPerformanceChart';
import { getPerformanceMetrics } from '@/queries/sql/performance/getPerformanceMetrics';
import { GET as getSavedFunnelStats } from './funnels/[funnelId]/stats/route';
import { GET as getFunnelStats } from './funnels/stats/route';
import { GET as getPerformanceChartRoute } from './performance/chart/route';
import { GET as getPerformanceMetricsRoute } from './performance/metrics/route';

vi.mock('@/lib/request', () => ({
  getQueryFilters: vi.fn(),
  parseRequest: vi.fn(),
}));
vi.mock('@/permissions', () => ({
  canViewReport: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({ getReport: vi.fn() }));
vi.mock('@/queries/sql/funnels/getFunnel', () => ({ getFunnel: vi.fn() }));
vi.mock('@/queries/sql/performance/getPerformanceChart', () => ({ getPerformanceChart: vi.fn() }));
vi.mock('@/queries/sql/performance/getPerformanceMetrics', () => ({
  getPerformanceMetrics: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getQueryFiltersMock = vi.mocked(getQueryFilters);
const getReportMock = vi.mocked(getReport);
const getFunnelMock = vi.mocked(getFunnel);
const getPerformanceChartMock = vi.mocked(getPerformanceChart);
const getPerformanceMetricsMock = vi.mocked(getPerformanceMetrics);

const startDate = new Date('2026-09-01T00:00:00.000Z');
const endDate = new Date('2026-09-02T00:00:00.000Z');
const poisonedFilters = {
  startDate,
  endDate,
  unit: 'day',
  timezone: 'UTC',
  country: 'eq.US',
  metric: 'lcp) FROM users --',
  window: '0); DROP TABLE users; --',
};
const websiteParams = { params: Promise.resolve({ websiteId: 'website-1' }) };

beforeEach(() => {
  parseRequestMock.mockReset();
  getQueryFiltersMock.mockReset();
  getReportMock.mockReset();
  getFunnelMock.mockReset();
  getPerformanceChartMock.mockReset();
  getPerformanceMetricsMock.mockReset();
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(canViewReport).mockResolvedValue(true);
  getQueryFiltersMock.mockResolvedValue(poisonedFilters as any);
  getFunnelMock.mockResolvedValue([]);
  getPerformanceChartMock.mockResolvedValue({ chart: [] });
  getPerformanceMetricsMock.mockResolvedValue([]);
});

test.each([
  ['chart', getPerformanceChartRoute, getPerformanceChartMock],
  ['metrics', getPerformanceMetricsRoute, getPerformanceMetricsMock],
] as const)(
  'keeps validated performance metric for %s despite untrusted filters',
  async (_, route, query) => {
    parseRequestMock.mockResolvedValue({
      auth: {},
      query: { metric: 'inp', type: 'path', startAt: 1788220800000, endAt: 1788307200000 },
    } as any);

    const response = await route(new Request('https://example.test'), websiteParams);

    expect(response.status).toBe(200);
    expect(query.mock.calls[0][1]).toMatchObject({ metric: 'inp', startDate, endDate });
    expect(query.mock.calls[0][2]).toMatchObject({ country: 'eq.US' });
  },
);

test('keeps validated funnel window despite untrusted filters', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: {
      window: 30,
      steps: [
        { type: 'path', value: '/' },
        { type: 'event', value: 'signup' },
      ],
      startAt: 1788220800000,
      endAt: 1788307200000,
    },
  } as any);

  const response = await getFunnelStats(new Request('https://example.test'), websiteParams);

  expect(response.status).toBe(200);
  expect(getFunnelMock.mock.calls[0][1]).toMatchObject({ window: 30, startDate, endDate });
  expect(getFunnelMock.mock.calls[0][2]).toMatchObject({ country: 'eq.US' });
});

test('keeps validated saved-funnel window despite untrusted filters', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: { startAt: 1788220800000, endAt: 1788307200000 },
  } as any);
  getReportMock.mockResolvedValue({
    websiteId: 'website-1',
    type: 'funnel',
    parameters: {
      window: 30,
      steps: [
        { type: 'path', value: '/' },
        { type: 'event', value: 'signup' },
      ],
    },
  } as any);

  const response = await getSavedFunnelStats(new Request('https://example.test'), {
    params: Promise.resolve({ websiteId: 'website-1', funnelId: 'funnel-1' }),
  });

  expect(response.status).toBe(200);
  expect(getFunnelMock.mock.calls[0][1]).toMatchObject({ window: 30, startDate, endDate });
  expect(getFunnelMock.mock.calls[0][2]).toMatchObject({ country: 'eq.US' });
});
