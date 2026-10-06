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
  getWebsiteDateRange,
  getWebsiteListCharts,
  getWebsiteStats,
} from '@/queries/sql';
import { GET as getLinkChartsRoute } from './links/charts/route';
import { GET as getPixelChartsRoute } from './pixels/charts/route';
import { GET as getActiveVisitorsRoute } from './websites/[websiteId]/active/route';
import { GET as getDateRangeRoute } from './websites/[websiteId]/daterange/route';
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
  getWebsiteDateRange: vi.fn(),
  getWebsiteListCharts: vi.fn(),
  getWebsiteStats: vi.fn(),
}));

const checkAuthMock = vi.mocked(checkAuth);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const canViewLinkMock = vi.mocked(canViewLink);
const canViewPixelMock = vi.mocked(canViewPixel);
const canViewSharedWebsiteMock = vi.mocked(canViewSharedWebsite);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const canViewBatchWebsitesMock = vi.mocked(canViewBatchWebsites);
const getActiveVisitorsMock = vi.mocked(getActiveVisitors);
const getWebsiteDateRangeMock = vi.mocked(getWebsiteDateRange);
const getWebsiteListChartsMock = vi.mocked(getWebsiteListCharts);
const getWebsiteStatsMock = vi.mocked(getWebsiteStats);
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
  getWebsiteDateRangeMock.mockReset();
  getWebsiteListChartsMock.mockReset();
  getWebsiteStatsMock.mockReset();
  fetchWebsiteMock.mockResolvedValue({ id: WEBSITE_ID } as any);
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
