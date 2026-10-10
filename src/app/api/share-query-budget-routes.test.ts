import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import { GET as getLinkCharts } from './links/charts/route';
import { GET as getPixelCharts } from './pixels/charts/route';
import { GET as getActiveVisitors } from './websites/[websiteId]/active/route';
import { GET as getDateRange } from './websites/[websiteId]/daterange/route';
import { GET as getWebsiteCharts } from './websites/charts/route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewWebsiteSection: vi.fn(),
  canViewSharedWebsite: vi.fn(),
  canViewLink: vi.fn(),
  canViewPixel: vi.fn(),
}));
vi.mock('@/permissions/website', () => ({ canViewBatchWebsites: vi.fn() }));
vi.mock('@/queries/sql', () => ({
  getActiveVisitors: vi.fn(),
  getWebsiteDateRange: vi.fn(),
  getWebsiteListCharts: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const pathParams = { params: Promise.resolve({ websiteId: WEBSITE_ID }) };

beforeEach(() => {
  parseRequestMock.mockReset();
  parseRequestMock.mockResolvedValue({
    error: () => new Response(null, { status: 429 }),
  });
});

test.each([
  {
    name: 'active visitors',
    route: getActiveVisitors,
    path: `/api/websites/${WEBSITE_ID}/active`,
    context: pathParams,
  },
  {
    name: 'website date range',
    route: getDateRange,
    path: `/api/websites/${WEBSITE_ID}/daterange`,
    context: pathParams,
  },
  {
    name: 'website charts',
    route: getWebsiteCharts,
    path: `/api/websites/charts?ids=${WEBSITE_ID}`,
    context: undefined,
  },
  {
    name: 'link charts',
    route: getLinkCharts,
    path: `/api/links/charts?ids=${WEBSITE_ID}`,
    context: undefined,
  },
  {
    name: 'pixel charts',
    route: getPixelCharts,
    path: `/api/pixels/charts?ids=${WEBSITE_ID}`,
    context: undefined,
  },
])(
  'reserves a share-query budget before $name analytics',
  async ({ route, path, context, name }) => {
    const request = new Request(`https://analytics.example${path}`);
    const response = await route(request, context as never);

    expect(response.status).toBe(429);
    expect(parseRequestMock).toHaveBeenCalledOnce();
    expect(parseRequestMock.mock.calls[0][0]).toBe(request);
    expect(parseRequestMock.mock.calls[0][2]).toEqual(
      name === 'website charts'
        ? { budgetShareQuery: true, shareQueryWorkMultiplier: expect.any(Function) }
        : { budgetShareQuery: true },
    );
    const schema = parseRequestMock.mock.calls[0][1];
    expect(schema).toBeDefined();
    if (name === 'active visitors' || name === 'website date range') {
      expect(schema.safeParse({ startAt: '2', endAt: '1' }).data).toEqual({});
    }
  },
);
