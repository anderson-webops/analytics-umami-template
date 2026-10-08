import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { fetchWebsite } from '@/lib/load';
import { reserveShareQueryCost } from '@/lib/share-query-budget';
import {
  canViewLink,
  canViewPixel,
  canViewSharedWebsite,
  canViewWebsiteSection,
} from '@/permissions';
import { canViewBatchWebsites } from '@/permissions/website';
import {
  getActiveVisitors,
  getBreakdown as getCompatBreakdown,
  getFunnel as getCompatFunnel,
  getPageviewStats,
  getRealtimeData,
  getSessionStats,
  getUTM,
  getWebsiteDateRange,
  getWebsiteEvents,
  getWebsiteListCharts,
  getWebsiteSessions,
  getWebsiteStats,
} from '@/queries/sql';
import { getAttribution } from '@/queries/sql/attribution/getAttribution';
import { getBreakdown } from '@/queries/sql/breakdown/getBreakdown';
import { getEventData } from '@/queries/sql/events/getEventData';
import { getFunnel } from '@/queries/sql/funnels/getFunnel';
import { getJourney } from '@/queries/sql/journeys/getJourney';
import { getPerformance } from '@/queries/sql/performance/getPerformance';
import { getPerformanceMetrics } from '@/queries/sql/performance/getPerformanceMetrics';
import { getRevenueChart } from '@/queries/sql/revenue/getRevenueChart';
import { getRevenueMetrics } from '@/queries/sql/revenue/getRevenueMetrics';
import { getRevenueStats } from '@/queries/sql/revenue/getRevenueStats';
import { POST as getAttributionReport } from '../(compat)/compat/api/reports/attribution/route';
import { POST as getBreakdownReport } from '../(compat)/compat/api/reports/breakdown/route';
import { POST as getFunnelReport } from '../(compat)/compat/api/reports/funnel/route';
import { POST as getPerformanceReport } from '../(compat)/compat/api/reports/performance/route';
import { POST as getRevenueReport } from '../(compat)/compat/api/reports/revenue/route';
import { POST as getUtmReport } from '../(compat)/compat/api/reports/utm/route';
import { GET as getLinkChartsRoute } from './links/charts/route';
import { GET as getPixelChartsRoute } from './pixels/charts/route';
import { GET as getRealtimeRoute } from './realtime/[websiteId]/route';
import { GET as getActiveVisitorsRoute } from './websites/[websiteId]/active/route';
import { GET as getAttributionRoute } from './websites/[websiteId]/attribution/route';
import { GET as getBreakdownRoute } from './websites/[websiteId]/breakdown/route';
import { GET as getDateRangeRoute } from './websites/[websiteId]/daterange/route';
import { GET as getEventDataRoute } from './websites/[websiteId]/event-data/route';
import { GET as getEventsRoute } from './websites/[websiteId]/events/route';
import { GET as getFunnelRoute } from './websites/[websiteId]/funnels/stats/route';
import { GET as getJourneyRoute } from './websites/[websiteId]/journeys/route';
import { GET as getPageviewsRoute } from './websites/[websiteId]/pageviews/route';
import { GET as getRevenueStatsRoute } from './websites/[websiteId]/revenue/stats/route';
import { GET as getSessionsRoute } from './websites/[websiteId]/sessions/route';
import { GET as getWebsiteStatsRoute } from './websites/[websiteId]/stats/route';
import { GET as getWebsiteChartsRoute } from './websites/charts/route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn(), fetchWebsite: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewLink: vi.fn(),
  canViewPixel: vi.fn(),
  canViewSharedWebsite: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));
vi.mock('@/permissions/website', () => ({ canViewBatchWebsites: vi.fn() }));
vi.mock('@/queries/sql', () => ({
  getActiveVisitors: vi.fn(),
  getBreakdown: vi.fn(),
  getFunnel: vi.fn(),
  getPageviewStats: vi.fn(),
  getRealtimeData: vi.fn(),
  getSessionStats: vi.fn(),
  getUTM: vi.fn(),
  getWebsiteEvents: vi.fn(),
  getWebsiteDateRange: vi.fn(),
  getWebsiteListCharts: vi.fn(),
  getWebsiteSessions: vi.fn(),
  getWebsiteStats: vi.fn(),
}));
vi.mock('@/queries/sql/attribution/getAttribution', () => ({ getAttribution: vi.fn() }));
vi.mock('@/queries/sql/breakdown/getBreakdown', () => ({ getBreakdown: vi.fn() }));
vi.mock('@/queries/sql/events/getEventData', () => ({ getEventData: vi.fn() }));
vi.mock('@/queries/sql/funnels/getFunnel', () => ({ getFunnel: vi.fn() }));
vi.mock('@/queries/sql/journeys/getJourney', () => ({ getJourney: vi.fn() }));
vi.mock('@/queries/sql/performance/getPerformance', () => ({ getPerformance: vi.fn() }));
vi.mock('@/queries/sql/performance/getPerformanceMetrics', () => ({
  getPerformanceMetrics: vi.fn(),
}));
vi.mock('@/queries/sql/revenue/getRevenueChart', () => ({ getRevenueChart: vi.fn() }));
vi.mock('@/queries/sql/revenue/getRevenueMetrics', () => ({ getRevenueMetrics: vi.fn() }));
vi.mock('@/queries/sql/revenue/getRevenueStats', () => ({ getRevenueStats: vi.fn() }));

const checkAuthMock = vi.mocked(checkAuth);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const canViewLinkMock = vi.mocked(canViewLink);
const canViewPixelMock = vi.mocked(canViewPixel);
const canViewSharedWebsiteMock = vi.mocked(canViewSharedWebsite);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const canViewBatchWebsitesMock = vi.mocked(canViewBatchWebsites);
const getActiveVisitorsMock = vi.mocked(getActiveVisitors);
const getCompatBreakdownMock = vi.mocked(getCompatBreakdown);
const getCompatFunnelMock = vi.mocked(getCompatFunnel);
const getPageviewStatsMock = vi.mocked(getPageviewStats);
const getRealtimeDataMock = vi.mocked(getRealtimeData);
const getSessionStatsMock = vi.mocked(getSessionStats);
const getAttributionMock = vi.mocked(getAttribution);
const getBreakdownMock = vi.mocked(getBreakdown);
const getEventDataMock = vi.mocked(getEventData);
const getFunnelMock = vi.mocked(getFunnel);
const getJourneyMock = vi.mocked(getJourney);
const getPerformanceMock = vi.mocked(getPerformance);
const getPerformanceMetricsMock = vi.mocked(getPerformanceMetrics);
const getRevenueChartMock = vi.mocked(getRevenueChart);
const getRevenueMetricsMock = vi.mocked(getRevenueMetrics);
const getRevenueStatsMock = vi.mocked(getRevenueStats);
const getUtmMock = vi.mocked(getUTM);
const getWebsiteDateRangeMock = vi.mocked(getWebsiteDateRange);
const getWebsiteListChartsMock = vi.mocked(getWebsiteListCharts);
const getWebsiteStatsMock = vi.mocked(getWebsiteStats);
const getWebsiteEventsMock = vi.mocked(getWebsiteEvents);
const getWebsiteSessionsMock = vi.mocked(getWebsiteSessions);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const pathParams = { params: Promise.resolve({ websiteId: WEBSITE_ID }) };

beforeEach(() => {
  checkAuthMock.mockReset();
  fetchWebsiteMock.mockReset();
  canViewLinkMock.mockReset();
  canViewPixelMock.mockReset();
  canViewSharedWebsiteMock.mockReset();
  canViewWebsiteSectionMock.mockReset();
  canViewBatchWebsitesMock.mockReset();
  getActiveVisitorsMock.mockReset();
  getCompatBreakdownMock.mockReset();
  getCompatFunnelMock.mockReset();
  getPageviewStatsMock.mockReset();
  getRealtimeDataMock.mockReset();
  getSessionStatsMock.mockReset();
  getAttributionMock.mockReset();
  getBreakdownMock.mockReset();
  getEventDataMock.mockReset();
  getFunnelMock.mockReset();
  getJourneyMock.mockReset();
  getPerformanceMock.mockReset();
  getPerformanceMetricsMock.mockReset();
  getRevenueChartMock.mockReset();
  getRevenueMetricsMock.mockReset();
  getRevenueStatsMock.mockReset();
  getUtmMock.mockReset();
  getWebsiteDateRangeMock.mockReset();
  getWebsiteListChartsMock.mockReset();
  getWebsiteStatsMock.mockReset();
  getWebsiteEventsMock.mockReset();
  getWebsiteSessionsMock.mockReset();
  fetchWebsiteMock.mockResolvedValue({ id: WEBSITE_ID } as any);
  getAttributionMock.mockResolvedValue({} as any);
  getBreakdownMock.mockResolvedValue([] as any);
  getFunnelMock.mockResolvedValue([] as any);
  getCompatBreakdownMock.mockResolvedValue([] as any);
  getCompatFunnelMock.mockResolvedValue([] as any);
  getPageviewStatsMock.mockResolvedValue({} as any);
  getRealtimeDataMock.mockResolvedValue({} as any);
  getSessionStatsMock.mockResolvedValue({} as any);
  getEventDataMock.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 20 } as any);
  getJourneyMock.mockResolvedValue([] as any);
  getWebsiteEventsMock.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 20 } as any);
  getWebsiteSessionsMock.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 20 } as any);
  getPerformanceMock.mockResolvedValue({ chart: [], summary: {} } as any);
  getPerformanceMetricsMock.mockResolvedValue([] as any);
  getRevenueChartMock.mockResolvedValue({ chart: [] } as any);
  getRevenueMetricsMock.mockResolvedValue([] as any);
  getRevenueStatsMock.mockResolvedValue({} as any);
  getUtmMock.mockResolvedValue([] as any);
});

test('public stats shares reserve both maximum-range scans before concurrent execution', async () => {
  const shareId = `stats-budget-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId, websiteId: WEBSITE_ID, parameters: { overview: true, compare: true } },
  } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getWebsiteStatsMock.mockResolvedValue({ pageviews: 0 } as any);
  const startAt = Date.UTC(2006, 0, 1);
  const endAt = Date.UTC(2025, 11, 31);
  const request = () =>
    getWebsiteStatsRoute(
      new Request(
        `https://analytics.example/api/websites/${WEBSITE_ID}/stats?startAt=${startAt}&endAt=${endAt}`,
      ),
      pathParams,
    );

  const responses = await Promise.all([request(), request()]);

  expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
  expect(responses.find(response => response.status === 429)?.headers.get('Retry-After')).toBe(
    '60',
  );
  expect(getWebsiteStatsMock).toHaveBeenCalledTimes(2);
});

test('ordinary signed-in stats requests remain unaffected by share budgeting', async () => {
  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getWebsiteStatsMock.mockResolvedValue({ pageviews: 0 } as any);
  const request = () =>
    getWebsiteStatsRoute(
      new Request(
        `https://analytics.example/api/websites/${WEBSITE_ID}/stats?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 11, 31)}`,
      ),
      pathParams,
    );

  expect((await Promise.all([request(), request()])).map(response => response.status)).toEqual([
    200, 200,
  ]);
  expect(getWebsiteStatsMock).toHaveBeenCalledTimes(4);
});

test('website list charts do not expose overview data through an events-only share', async () => {
  const shareId = `restricted-charts-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    shareToken: {
      shareId,
      websiteId: WEBSITE_ID,
      parameters: { events: true, overview: false, compare: false },
    },
  } as any);
  canViewBatchWebsitesMock.mockImplementation(async auth => (auth.shareToken ? [WEBSITE_ID] : []));
  getWebsiteListChartsMock.mockImplementation(async ids =>
    ids.length ? { [WEBSITE_ID]: { values: [1], total: 1 } } : {},
  );

  const response = await getWebsiteChartsRoute(
    new Request(`https://analytics.example/api/websites/charts?ids=${WEBSITE_ID}`),
  );

  expect(response.status).toBe(200);
  expect(canViewBatchWebsitesMock.mock.calls[0][0].shareToken).toBeUndefined();
  await expect(response.json()).resolves.toEqual({ data: {} });
  expect(getWebsiteListChartsMock).toHaveBeenCalledWith([], expect.any(Object));
});

test.each([
  {
    name: 'active visitors with ignored URL dates',
    path: `/api/websites/${WEBSITE_ID}/active?startAt=2&endAt=1`,
    run: (request: Request) => getActiveVisitorsRoute(request, pathParams),
  },
  {
    name: 'website date range',
    path: `/api/websites/${WEBSITE_ID}/daterange`,
    run: (request: Request) => getDateRangeRoute(request, pathParams),
  },
  {
    name: 'default-range website charts',
    path: `/api/websites/charts?ids=${WEBSITE_ID}`,
    run: getWebsiteChartsRoute,
  },
  {
    name: 'default-range link charts',
    path: `/api/links/charts?ids=${WEBSITE_ID}`,
    run: getLinkChartsRoute,
  },
  {
    name: 'default-range pixel charts',
    path: `/api/pixels/charts?ids=${WEBSITE_ID}`,
    run: getPixelChartsRoute,
  },
])('$name rejects an exhausted public share before querying analytics', async ({ path, run }) => {
  const shareId = `aggregate-budget-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  expect((await reserveShareQueryCost(shareId, 600)).blocked).toBe(false);

  const response = await run(new Request(`https://analytics.example${path}`));

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(canViewLinkMock).not.toHaveBeenCalled();
  expect(canViewPixelMock).not.toHaveBeenCalled();
  expect(canViewSharedWebsiteMock).not.toHaveBeenCalled();
  expect(canViewWebsiteSectionMock).not.toHaveBeenCalled();
  expect(canViewBatchWebsitesMock).not.toHaveBeenCalled();
  expect(getActiveVisitorsMock).not.toHaveBeenCalled();
  expect(getWebsiteDateRangeMock).not.toHaveBeenCalled();
  expect(getWebsiteListChartsMock).not.toHaveBeenCalled();
});

test('a public share within budget retains access to authorized analytics', async () => {
  const shareId = `allowed-budget-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getActiveVisitorsMock.mockResolvedValue({ visitors: 2 });

  const response = await getActiveVisitorsRoute(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/active`),
    pathParams,
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ visitors: 2 });
  expect(getActiveVisitorsMock).toHaveBeenCalledOnce();
});

test('ordinary users retain active-visitor access and denied users remain denied', async () => {
  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  canViewWebsiteSectionMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  getActiveVisitorsMock.mockResolvedValue({ visitors: 2 });
  const request = () => new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/active`);

  const allowed = await getActiveVisitorsRoute(request(), pathParams);
  const denied = await getActiveVisitorsRoute(request(), pathParams);

  expect(allowed.status).toBe(200);
  await expect(allowed.json()).resolves.toEqual({ visitors: 2 });
  expect(denied.status).toBe(401);
  expect(getActiveVisitorsMock).toHaveBeenCalledOnce();
});

test.each([
  { name: 'link', run: getLinkChartsRoute, permission: canViewLinkMock },
  { name: 'pixel', run: getPixelChartsRoute, permission: canViewPixelMock },
])(
  '$name list charts do not expose overview data through an events-only share',
  async ({ run, permission }) => {
    const shareId = `restricted-charts-${crypto.randomUUID()}`;
    checkAuthMock.mockResolvedValue({
      shareToken: {
        shareId,
        websiteId: WEBSITE_ID,
        parameters: { events: true, overview: false, compare: false },
      },
    } as any);
    permission.mockImplementation(async auth => !!auth.shareToken);
    getWebsiteListChartsMock.mockImplementation(async ids =>
      ids.length ? { [WEBSITE_ID]: { values: [1], total: 1 } } : {},
    );

    const response = await run(
      new Request(`https://analytics.example/api/${name}s/charts?ids=${WEBSITE_ID}`),
    );

    expect(response.status).toBe(200);
    expect(permission.mock.calls[0][0].shareToken).toBeUndefined();
    await expect(response.json()).resolves.toEqual({ data: {} });
    expect(getWebsiteListChartsMock).toHaveBeenCalledWith([], expect.any(Object));
  },
);

const reportStartDate = '2025-01-29T12:00:00.000Z';
const reportEndDate = '2025-03-01T12:00:00.000Z';

test.each([
  { name: 'events', run: getEventsRoute, query: getWebsiteEventsMock },
  { name: 'sessions', run: getSessionsRoute, query: getWebsiteSessionsMock },
  { name: 'event-data', run: getEventDataRoute, query: getEventDataMock },
])('$name share prices count and paged rows before database access', async route => {
  const shareId = `paged-work-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  expect((await reserveShareQueryCost(shareId, 597)).blocked).toBe(false);
  const request = (page: number, pageSize: number) =>
    route.run(
      new Request(
        `https://analytics.example/api/websites/${WEBSITE_ID}/${route.name}?startAt=1&endAt=2&page=${page}&pageSize=${pageSize}`,
      ),
      pathParams,
    );

  expect((await request(3, 20)).status).toBe(429);
  expect((await request(10_000, 500)).status).toBe(400);
  expect(route.query).not.toHaveBeenCalled();

  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  expect((await request(3, 20)).status).toBe(200);
  expect(route.query).toHaveBeenCalledOnce();
});

test('journey shares price step depth before database access', async () => {
  const shareId = `journey-work-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  expect((await reserveShareQueryCost(shareId, 587)).blocked).toBe(false);
  const request = () =>
    getJourneyRoute(
      new Request(
        `https://analytics.example/api/websites/${WEBSITE_ID}/journeys?startAt=1&endAt=2&steps=7`,
      ),
      pathParams,
    );

  expect((await request()).status).toBe(429);
  expect(getJourneyMock).not.toHaveBeenCalled();

  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  expect((await request()).status).toBe(200);
  expect(getJourneyMock).toHaveBeenCalledOnce();
});

test.each([
  {
    name: 'two-scan pageviews',
    charge: 2,
    query: getPageviewStatsMock,
    run: () =>
      getPageviewsRoute(
        new Request(
          `https://analytics.example/api/websites/${WEBSITE_ID}/pageviews?startAt=1&endAt=2`,
        ),
        pathParams,
      ),
  },
  {
    name: 'four-scan comparison pageviews',
    charge: 6,
    query: getPageviewStatsMock,
    run: () =>
      getPageviewsRoute(
        new Request(
          `https://analytics.example/api/websites/${WEBSITE_ID}/pageviews?startAt=1&endAt=2&compare=yoy`,
        ),
        pathParams,
      ),
  },
  {
    name: 'multi-dimension breakdown',
    charge: 40,
    query: getBreakdownMock,
    run: () =>
      getBreakdownRoute(
        new Request(
          `https://analytics.example/api/websites/${WEBSITE_ID}/breakdown?startAt=1&endAt=2&fields=${encodeURIComponent(JSON.stringify(Array.from({ length: 20 }, () => 'path')))}`,
        ),
        pathParams,
      ),
  },
  {
    name: 'multi-step funnel',
    charge: 16,
    query: getFunnelMock,
    run: () =>
      getFunnelRoute(
        new Request(
          `https://analytics.example/api/websites/${WEBSITE_ID}/funnels/stats?startAt=1&endAt=2&window=10080&steps=${encodeURIComponent(
            JSON.stringify([
              { type: 'path', value: '/start' },
              { type: 'event', value: 'done' },
            ]),
          )}`,
        ),
        pathParams,
      ),
  },
])('$name charges public-share work before querying', async ({ charge, query, run }) => {
  const shareId = `report-work-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  expect((await reserveShareQueryCost(shareId, 601 - charge)).blocked).toBe(false);

  const rejected = await run();

  expect(rejected.status).toBe(429);
  expect(query).not.toHaveBeenCalled();

  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  expect((await run()).status).toBe(200);
  expect(query).toHaveBeenCalled();
});

test('realtime shares reserve all three analytics scans before querying', async () => {
  const shareId = `realtime-work-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  expect((await reserveShareQueryCost(shareId, 598)).blocked).toBe(false);
  const request = () =>
    getRealtimeRoute(
      new Request(`https://analytics.example/api/realtime/${WEBSITE_ID}`),
      pathParams,
    );

  expect((await request()).status).toBe(429);
  expect(getRealtimeDataMock).not.toHaveBeenCalled();

  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  expect((await request()).status).toBe(200);
  expect(getRealtimeDataMock).toHaveBeenCalledOnce();
});

test.each([
  {
    name: 'funnel',
    charge: 16,
    query: getCompatFunnelMock,
    parameters: {
      window: 10080,
      steps: [
        { type: 'path', value: '/start' },
        { type: 'event', value: 'done' },
      ],
    },
    run: getFunnelReport,
  },
  {
    name: 'breakdown',
    charge: 40,
    query: getCompatBreakdownMock,
    parameters: { fields: Array.from({ length: 20 }, () => 'path') },
    run: getBreakdownReport,
  },
])('compatibility $name charges public-share work before querying', async report => {
  const shareId = `compat-work-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  expect((await reserveShareQueryCost(shareId, 601 - report.charge)).blocked).toBe(false);
  const request = () =>
    new Request(`https://analytics.example/compat/api/reports/${report.name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        websiteId: WEBSITE_ID,
        type: report.name,
        filters: {},
        parameters: {
          startDate: '2025-01-01T00:00:00.000Z',
          endDate: '2025-01-02T00:00:00.000Z',
          ...report.parameters,
        },
      }),
    });

  const rejected = await report.run(request());

  expect(rejected.status).toBe(429);
  expect(report.query).not.toHaveBeenCalled();

  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  expect((await report.run(request())).status).toBe(200);
  expect(report.query).toHaveBeenCalled();
});

function analyticsCalls() {
  return [
    getAttributionMock,
    getPerformanceMock,
    getPerformanceMetricsMock,
    getRevenueChartMock,
    getRevenueMetricsMock,
    getRevenueStatsMock,
    getUtmMock,
  ].reduce((count, query) => count + query.mock.calls.length, 0);
}

const compatibilityReports = [
  {
    name: 'performance',
    multiplier: 6,
    dispatchedCalls: 5,
    parameters: {},
    run: getPerformanceReport,
  },
  {
    name: 'revenue',
    multiplier: 8,
    dispatchedCalls: 7,
    parameters: { currency: 'USD', compare: 'yoy' },
    run: getRevenueReport,
  },
  {
    name: 'utm',
    multiplier: 5,
    dispatchedCalls: 5,
    parameters: {},
    run: getUtmReport,
  },
  {
    name: 'attribution',
    multiplier: 8,
    dispatchedCalls: 1,
    parameters: { model: 'first-click', type: 'path', step: '/checkout' },
    run: getAttributionReport,
  },
] as const;

function compatibilityRequest(
  report: (typeof compatibilityReports)[number],
  dates = { startDate: reportStartDate, endDate: reportEndDate },
) {
  return new Request(`https://analytics.example/compat/api/reports/${report.name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      websiteId: WEBSITE_ID,
      type: report.name,
      filters: {},
      parameters: {
        ...dates,
        ...report.parameters,
      },
    }),
  });
}

test.each(compatibilityReports)(
  '$name share reserves its full query fan-out before dispatch',
  async report => {
    const shareId = `compat-budget-${crypto.randomUUID()}`;
    checkAuthMock.mockResolvedValue({
      shareToken: { shareId, websiteId: WEBSITE_ID, parameters: { allowFilter: true } },
    } as any);
    canViewWebsiteSectionMock.mockResolvedValue(true);
    expect((await reserveShareQueryCost(shareId, 600 - report.multiplier)).blocked).toBe(false);

    const responses = await Promise.all([
      report.run(compatibilityRequest(report)),
      report.run(compatibilityRequest(report)),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
    expect(analyticsCalls()).toBe(report.dispatchedCalls);
  },
);

test('ordinary authenticated report requests retain access without a share budget', async () => {
  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  const report = compatibilityReports[0];

  const responses = await Promise.all([
    report.run(compatibilityRequest(report)),
    report.run(compatibilityRequest(report)),
  ]);

  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(analyticsCalls()).toBe(10);
});

test('denied report sections do not dispatch analytics', async () => {
  const shareId = `denied-report-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId, websiteId: WEBSITE_ID },
  } as any);
  canViewWebsiteSectionMock.mockImplementation(
    async (_auth, _websiteId, section) => section !== 'revenue',
  );
  getWebsiteStatsMock.mockResolvedValue({ pageviews: 0 } as any);
  expect((await reserveShareQueryCost(shareId, 598)).blocked).toBe(false);

  expect((await getRevenueReport(compatibilityRequest(compatibilityReports[1]))).status).toBe(401);
  expect(analyticsCalls()).toBe(0);
  const stats = await getWebsiteStatsRoute(
    new Request(
      `https://analytics.example/api/websites/${WEBSITE_ID}/stats?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 31)}`,
    ),
    pathParams,
  );
  expect(stats.status).toBe(200);
  expect(getWebsiteStatsMock).toHaveBeenCalledTimes(2);
});

test('historical attribution shares reject work above the complete window allowance', async () => {
  const shareId = `historical-attribution-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  const report = compatibilityReports[3];
  const dates = {
    startDate: '2006-01-01T12:00:00.000Z',
    endDate: '2025-12-31T12:00:00.000Z',
  };

  const responses = await Promise.all([
    report.run(compatibilityRequest(report, dates)),
    report.run(compatibilityRequest(report, dates)),
  ]);

  expect(responses.map(response => response.status)).toEqual([400, 400]);
  expect(getAttributionMock).not.toHaveBeenCalled();
});

test.each([
  {
    name: 'attribution',
    multiplier: 8,
    dispatchedCalls: 1,
    run: getAttributionRoute,
    extra: '&model=first-click&type=path&step=%2Fcheckout',
  },
  {
    name: 'revenue/stats',
    multiplier: 3,
    dispatchedCalls: 2,
    run: getRevenueStatsRoute,
    extra: '&currency=USD&compare=yoy',
  },
])('$name GET share reserves every query before dispatch', async route => {
  const shareId = `get-budget-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(true);
  expect((await reserveShareQueryCost(shareId, 600 - route.multiplier)).blocked).toBe(false);
  const url = `https://analytics.example/api/websites/${WEBSITE_ID}/${route.name}?startAt=${new Date(reportStartDate).getTime()}&endAt=${new Date(reportEndDate).getTime()}${route.extra}`;

  const responses = await Promise.all([
    route.run(new Request(url), pathParams),
    route.run(new Request(url), pathParams),
  ]);

  expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
  expect(analyticsCalls()).toBe(route.dispatchedCalls);
});
