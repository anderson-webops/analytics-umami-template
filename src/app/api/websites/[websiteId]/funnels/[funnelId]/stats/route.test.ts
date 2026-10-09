import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { reserveShareQueryCost } from '@/lib/share-query-budget';
import { canViewReport, canViewWebsiteSection } from '@/permissions';
import { getReport } from '@/queries/prisma';
import { getFunnel } from '@/queries/sql/funnels/getFunnel';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewReport: vi.fn(), canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/prisma', () => ({ getReport: vi.fn() }));
vi.mock('@/queries/sql/funnels/getFunnel', () => ({ getFunnel: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const startAt = Date.UTC(2025, 0, 1);
const endAt = Date.UTC(2025, 0, 31);

function report(propertyCount: number) {
  return {
    websiteId,
    type: 'funnel',
    parameters: {
      window: 60,
      steps: [
        {
          type: 'event',
          value: 'signup',
          filters: Array.from({ length: propertyCount }, () => ({
            property: 'plan',
            operator: 'eq',
            value: 'pro',
          })),
        },
        { type: 'event', value: 'purchase' },
      ],
    },
  };
}

beforeEach(() => {
  vi.mocked(getQueryFilters).mockReset();
  vi.mocked(parseRequest).mockReset();
  vi.mocked(canViewReport).mockReset();
  vi.mocked(canViewWebsiteSection).mockReset();
  vi.mocked(getReport).mockReset();
  vi.mocked(getFunnel).mockReset();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { shareToken: { shareId: 'saved-funnel-test', websiteId } },
    query: { startAt, endAt },
  } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(canViewReport).mockResolvedValue(true);
  vi.mocked(getQueryFilters).mockResolvedValue({
    startDate: new Date(startAt),
    endDate: new Date(endAt),
  } as any);
  vi.mocked(getFunnel).mockResolvedValue({ data: [] } as any);
});

test('rejects a share-accessible saved funnel with excessive stored property filters', async () => {
  vi.mocked(getReport).mockResolvedValue(report(17) as any);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/funnels/report/stats'),
    { params: Promise.resolve({ websiteId, funnelId: 'report' }) },
  );

  expect(response.status).toBe(400);
  expect(getFunnel).not.toHaveBeenCalled();
});

test('preserves ordinary saved funnel analytics for a public share', async () => {
  vi.mocked(getReport).mockResolvedValue(report(2) as any);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/funnels/report/stats'),
    { params: Promise.resolve({ websiteId, funnelId: 'report' }) },
  );

  expect(response.status).toBe(200);
  expect(getFunnel).toHaveBeenCalledTimes(1);
});

test('reserves saved funnel join work before executing analytics', async () => {
  const shareId = `saved-funnel-work-${crypto.randomUUID()}`;
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { shareToken: { shareId, websiteId } },
    query: { startAt, endAt, window: 10080 },
  } as any);
  const savedReport = report(0);
  savedReport.parameters.window = 10080;
  vi.mocked(getReport).mockResolvedValue(savedReport as any);
  expect((await reserveShareQueryCost(shareId, 600)).blocked).toBe(false);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/funnels/report/stats'),
    { params: Promise.resolve({ websiteId, funnelId: 'report' }) },
  );

  expect(response.status).toBe(429);
  expect(getFunnel).not.toHaveBeenCalled();
});

test('rejects a filtered saved funnel when the public share disables filters', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {
      shareToken: {
        shareId: 'saved-funnel-test',
        websiteId,
        parameters: { allowFilter: false },
      },
    },
    query: { startAt, endAt },
  } as any);
  vi.mocked(getReport).mockResolvedValue(report(2) as any);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/funnels/report/stats'),
    { params: Promise.resolve({ websiteId, funnelId: 'report' }) },
  );

  expect(response.status).toBe(403);
  expect(getFunnel).not.toHaveBeenCalled();
});

test('allows a scoped board share to use its curated saved funnel filters', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {
      shareToken: {
        shareId: 'saved-funnel-board-share',
        boardId: 'board-1',
        websiteIds: [websiteId],
        shareType: ENTITY_TYPE.board,
        scopedApiAccess: true,
        parameters: { allowFilter: false },
      },
    },
    query: { startAt, endAt },
  } as any);
  vi.mocked(getReport).mockResolvedValue(report(2) as any);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/funnels/report/stats'),
    { params: Promise.resolve({ websiteId, funnelId: 'report' }) },
  );

  expect(response.status).toBe(200);
  expect(getFunnel).toHaveBeenCalledTimes(1);
});

test('rejects curated filters without a scoped board API grant', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {
      shareToken: {
        shareId: 'saved-funnel-board-share',
        boardId: 'board-1',
        websiteIds: [websiteId],
        shareType: ENTITY_TYPE.board,
        parameters: { allowFilter: false },
      },
    },
    query: { startAt, endAt },
  } as any);
  vi.mocked(getReport).mockResolvedValue(report(2) as any);

  const response = await GET(
    new Request('https://analytics.example/api/websites/site/funnels/report/stats'),
    { params: Promise.resolve({ websiteId, funnelId: 'report' }) },
  );

  expect(response.status).toBe(403);
  expect(getFunnel).not.toHaveBeenCalled();
});
