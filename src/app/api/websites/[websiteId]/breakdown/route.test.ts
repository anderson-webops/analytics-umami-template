import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getBreakdown } from '@/queries/sql/breakdown/getBreakdown';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql/breakdown/getBreakdown', () => ({ getBreakdown: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const request = new Request(`https://analytics.example/api/websites/${websiteId}/breakdown`);
const context = { params: Promise.resolve({ websiteId }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'viewer' } },
    query: {
      fields: ['path'],
      startAt: Date.UTC(2026, 9, 1),
      endAt: Date.UTC(2026, 9, 2),
    },
  } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getQueryFilters).mockResolvedValue({
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: new Date('2026-10-02T00:00:00.000Z'),
  } as any);
});

test('breakdown rows and header identify unverified pageview counts', async () => {
  const row = { path: '/claimed', views: 4, visitors: 3, visits: 3, bounces: 1, totaltime: 20 };
  vi.mocked(getBreakdown).mockResolvedValue([row]);

  const response = await GET(request, context);

  expect(response.status).toBe(200);
  expect(response.headers.get('X-Metric-Provenance')).toBe('unverified_public_observations');
  expect(await response.json()).toEqual([
    { ...row, metricProvenance: 'unverified_public_observations' },
  ]);
});

test('empty breakdown results still declare provenance', async () => {
  vi.mocked(getBreakdown).mockResolvedValue([]);

  const response = await GET(request, context);

  expect(response.headers.get('X-Metric-Provenance')).toBe('unverified_public_observations');
  expect(await response.json()).toEqual([]);
});

test('breakdown keeps the section permission gate', async () => {
  vi.mocked(canViewWebsiteSection).mockResolvedValue(false);

  const response = await GET(request, context);

  expect(response.status).toBe(401);
  expect(getBreakdown).not.toHaveBeenCalled();
});

test('breakdown still rejects oversized dimension requests', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'viewer' } },
    query: {
      fields: Array.from({ length: 21 }, (_, index) => `field-${index}`),
      startAt: Date.UTC(2026, 9, 1),
      endAt: Date.UTC(2026, 9, 2),
    },
  } as any);

  const response = await GET(request, context);

  expect(response.status).toBe(400);
  expect(getBreakdown).not.toHaveBeenCalled();
});
