import { beforeEach, expect, test, vi } from 'vitest';
import { getBoundedCompareDate, getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getPageviewStats, getSessionStats } from '@/queries/sql';
import { GET } from './route';

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
  getQueryFilters: vi.fn(),
  getBoundedCompareDate: vi.fn(),
}));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql', () => ({ getPageviewStats: vi.fn(), getSessionStats: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'viewer' } },
    query: {},
  } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getQueryFilters).mockResolvedValue({
    startDate: new Date('2026-10-01T00:00:00Z'),
    endDate: new Date('2026-10-02T00:00:00Z'),
    compare: undefined,
  } as any);
  vi.mocked(getBoundedCompareDate).mockResolvedValue({
    compare: 'prev',
    startDate: new Date('2026-09-30T00:00:00Z'),
    endDate: new Date('2026-10-01T00:00:00Z'),
  });
  vi.mocked(getPageviewStats).mockResolvedValue([{ x: '2026-10-01', y: 4 }]);
  vi.mocked(getSessionStats).mockResolvedValue([{ x: '2026-10-01', y: 3 }]);
});

test.each([false, true])(
  'pageview time series labels public provenance with compare=%s',
  async compare => {
    if (compare) {
      vi.mocked(getQueryFilters).mockResolvedValueOnce({
        startDate: new Date('2026-10-01T00:00:00Z'),
        endDate: new Date('2026-10-02T00:00:00Z'),
        compare: 'prev',
      } as any);
    }

    const response = await GET(
      new Request(`https://analytics.example/api/websites/${websiteId}/pageviews`),
      { params: Promise.resolve({ websiteId }) },
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.trafficProvenance).toBe('unverified_public_observations');
    expect(result.pageviews).toEqual([{ x: '2026-10-01', y: 4 }]);
    expect(result.sessions).toEqual([{ x: '2026-10-01', y: 3 }]);
    expect(Boolean(result.compare)).toBe(compare);
  },
);
