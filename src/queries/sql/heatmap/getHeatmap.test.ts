import { beforeEach, expect, test, vi } from 'vitest';
import { getHeatmap } from './getHeatmap';

const { state, prismaRawQuery, clickhouseRawQuery, getWebsite } = vi.hoisted(() => ({
  state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
  prismaRawQuery: vi.fn(),
  clickhouseRawQuery: vi.fn(),
  getWebsite: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  CLICKHOUSE: 'clickhouse',
  PRISMA: 'prisma',
  runQuery: vi.fn((queries: Record<string, () => unknown>) => queries[state.mode]()),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    rawQuery: prismaRawQuery,
    parseFilters: vi.fn(() => ({ filterQuery: '', queryParams: {} })),
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    rawQuery: clickhouseRawQuery,
    parseFilters: vi.fn(() => ({ filterQuery: '', queryParams: {} })),
  },
}));

vi.mock('@/queries/prisma', () => ({ getWebsite }));

beforeEach(() => {
  state.mode = 'prisma';
  prismaRawQuery.mockReset();
  clickhouseRawQuery.mockReset();
  getWebsite.mockReset();
  getWebsite.mockResolvedValue(null);
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s scroll queries aggregate by bounded screen width and preserve visit counts',
  async mode => {
    state.mode = mode;
    const rawQuery = mode === 'prisma' ? prismaRawQuery : clickhouseRawQuery;
    rawQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { depth: 20, sessions: 3, pageW: 1024, pageH: 3000, viewportW: 1024, viewportH: 768 },
      { depth: 30, sessions: 2, pageW: 1440, pageH: 4000, viewportW: 1440, viewportH: 900 },
    ]);

    const result = await getHeatmap('website-1', {
      mode: 'scroll',
      urlPath: '/',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-02T00:00:00Z'),
    });

    expect(rawQuery).toHaveBeenCalledTimes(2);
    const query = rawQuery.mock.calls[1][0] as string;
    expect(query).toMatch(/group by depth, width_bucket/i);
    expect(query).not.toMatch(/group by depth, page_w, page_h, viewport_w, viewport_h/i);
    expect(query).toContain('when viewport_w <= 347 then 320');
    expect(query).toContain('when viewport_w <= 1680 then 1440');
    expect(query).toContain('else 1920');
    expect(query).toContain('least(100, greatest(0,');
    expect(result.scroll.totalSessions).toBe(5);
    expect(result.scroll.buckets).toHaveLength(2);
    expect(result.scroll.viewportW).toBe(1024);
  },
);
