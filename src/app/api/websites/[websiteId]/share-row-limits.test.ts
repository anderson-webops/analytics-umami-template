import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getRevenueMetrics } from '@/queries/sql/revenue/getRevenueMetrics';
import { getUTM } from '@/queries/sql/utm/getUTM';
import { GET as getRevenueMetricsRoute } from './revenue/metrics/route';
import { GET as getUtmMetricsRoute } from './utm/metrics/route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql/revenue/getRevenueMetrics', () => ({ getRevenueMetrics: vi.fn() }));
vi.mock('@/queries/sql/utm/getUTM', () => ({ getUTM: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const context = { params: Promise.resolve({ websiteId }) };
const filters = { startDate: new Date(0), endDate: new Date(1000) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getQueryFilters).mockResolvedValue(filters as never);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
});

test('shared revenue metrics return only the ten displayed rows', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { shareToken: { boardId: 'board-1' } },
    query: { type: 'referrer', currency: 'USD', limit: 10 },
  });
  vi.mocked(getRevenueMetrics).mockResolvedValue(
    Array.from({ length: 25 }, (_, index) => ({ name: `referrer-${index}`, value: index })),
  );

  const response = await getRevenueMetricsRoute(
    new Request(`http://localhost/api/websites/${websiteId}/revenue/metrics`),
    context,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toHaveLength(10);
  const schema = vi.mocked(parseRequest).mock.calls[0][1];
  expect(
    schema.safeParse({ startAt: '0', endAt: '1', type: 'referrer', currency: 'USD', limit: '11' })
      .success,
  ).toBe(false);
});

test('shared UTM metrics return only the configured board rows', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { shareToken: { boardId: 'board-1' } },
    query: { type: 'utm_source', limit: 10 },
  });
  vi.mocked(getUTM).mockResolvedValue(
    Array.from({ length: 50 }, (_, index) => ({ utm: `source-${index}`, views: index })),
  );

  const response = await getUtmMetricsRoute(
    new Request(`http://localhost/api/websites/${websiteId}/utm/metrics`),
    context,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toHaveLength(10);
  const schema = vi.mocked(parseRequest).mock.calls[0][1];
  expect(
    schema.safeParse({ startAt: '0', endAt: '1', type: 'utm_source', limit: '21' }).success,
  ).toBe(false);
});
