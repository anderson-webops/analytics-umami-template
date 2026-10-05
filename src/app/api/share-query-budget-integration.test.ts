import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { reserveShareQueryCost } from '@/lib/share-query-budget';
import {
  canViewLink,
  canViewPixel,
  canViewSharedWebsite,
  canViewWebsiteSection,
} from '@/permissions';
import { canViewBatchWebsites } from '@/permissions/website';
import { getActiveVisitors, getWebsiteDateRange, getWebsiteListCharts } from '@/queries/sql';
import { GET as getLinkChartsRoute } from './links/charts/route';
import { GET as getPixelChartsRoute } from './pixels/charts/route';
import { GET as getActiveVisitorsRoute } from './websites/[websiteId]/active/route';
import { GET as getDateRangeRoute } from './websites/[websiteId]/daterange/route';
import { GET as getWebsiteChartsRoute } from './websites/charts/route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
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
}));

const checkAuthMock = vi.mocked(checkAuth);
const canViewLinkMock = vi.mocked(canViewLink);
const canViewPixelMock = vi.mocked(canViewPixel);
const canViewSharedWebsiteMock = vi.mocked(canViewSharedWebsite);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const canViewBatchWebsitesMock = vi.mocked(canViewBatchWebsites);
const getActiveVisitorsMock = vi.mocked(getActiveVisitors);
const getWebsiteDateRangeMock = vi.mocked(getWebsiteDateRange);
const getWebsiteListChartsMock = vi.mocked(getWebsiteListCharts);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const pathParams = { params: Promise.resolve({ websiteId: WEBSITE_ID }) };

beforeEach(() => {
  checkAuthMock.mockReset();
  canViewLinkMock.mockReset();
  canViewPixelMock.mockReset();
  canViewSharedWebsiteMock.mockReset();
  canViewWebsiteSectionMock.mockReset();
  canViewBatchWebsitesMock.mockReset();
  getActiveVisitorsMock.mockReset();
  getWebsiteDateRangeMock.mockReset();
  getWebsiteListChartsMock.mockReset();
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
