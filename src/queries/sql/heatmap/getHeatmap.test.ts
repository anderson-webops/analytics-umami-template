import { beforeEach, expect, test, vi } from 'vitest';
import { getHeatmap } from './getHeatmap';

const {
  state,
  prismaRawQuery,
  clickhouseRawQuery,
  getWebsite,
  prismaParseFilters,
  clickhouseParseFilters,
} = vi.hoisted(() => ({
  state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
  prismaRawQuery: vi.fn(),
  clickhouseRawQuery: vi.fn(),
  getWebsite: vi.fn(),
  prismaParseFilters: vi.fn(),
  clickhouseParseFilters: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  CLICKHOUSE: 'clickhouse',
  PRISMA: 'prisma',
  runQuery: vi.fn((queries: Record<string, () => unknown>) => queries[state.mode]()),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    rawQuery: prismaRawQuery,
    parseFilters: prismaParseFilters,
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    rawQuery: clickhouseRawQuery,
    parseFilters: clickhouseParseFilters,
  },
}));

vi.mock('@/queries/prisma', () => ({ getWebsite }));

beforeEach(() => {
  state.mode = 'prisma';
  prismaRawQuery.mockReset();
  clickhouseRawQuery.mockReset();
  getWebsite.mockReset();
  getWebsite.mockResolvedValue(null);
  prismaParseFilters.mockReset().mockReturnValue({ filterQuery: '', queryParams: {} });
  clickhouseParseFilters.mockReset().mockReturnValue({ filterQuery: '', queryParams: {} });
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s filtered heatmaps exclude legacy unverified custom events but retain pageview context',
  async mode => {
    state.mode = mode;
    const parseFilters = mode === 'prisma' ? prismaParseFilters : clickhouseParseFilters;
    const rawQuery = mode === 'prisma' ? prismaRawQuery : clickhouseRawQuery;
    const eventFilter =
      mode === 'prisma'
        ? 'and website_event.event_name = {{eventName}}'
        : 'and event_name = {eventName:String}';
    parseFilters.mockReturnValue({
      filterQuery: eventFilter,
      queryParams: { eventName: 'purchase' },
    });
    rawQuery.mockResolvedValue([]);

    await getHeatmap('website-1', {
      mode: 'click',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-02T00:00:00Z'),
    });

    const sql = rawQuery.mock.calls[0][0] as string;
    expect(sql).toContain(
      mode === 'prisma'
        ? 'website_event.event_type != 2 or website_event.trust_tier = 1'
        : 'event_type != 2 or trust_tier = 1',
    );
    expect(sql).toContain(eventFilter);
    expect(sql).toContain('event_type != 5');
  },
);

test.each([
  ['prisma', 'click', 'http://127.0.0.1:3001'],
  ['prisma', 'scroll', 'https://tracked.example'],
  ['clickhouse', 'click', 'https://tracked.example'],
  ['clickhouse', 'scroll', 'http://[::1]:3001'],
] as const)(
  '%s %s heatmaps never send a preview URL for %s to analyst browsers',
  async (database, mode, domain) => {
    state.mode = database;
    const rawQuery = database === 'prisma' ? prismaRawQuery : clickhouseRawQuery;
    getWebsite.mockResolvedValue({ domain });
    rawQuery
      .mockResolvedValueOnce([{ urlPath: '/', count: 1, sessions: 1 }])
      .mockResolvedValueOnce([
        {
          depth: 20,
          sessions: 1,
          x: 12,
          y: 24,
          pageX: 12,
          pageY: 24,
          pageW: 1024,
          pageH: 2048,
          viewportW: 1024,
          viewportH: 768,
          count: 1,
        },
      ]);

    const result = await getHeatmap('website-1', {
      mode,
      urlPath: '/',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-02T00:00:00Z'),
    });

    if (mode === 'click') {
      expect(result.points).toHaveLength(1);
    } else {
      expect(result.scroll.buckets).toHaveLength(1);
    }
    expect(result.snapshot).toBeNull();
    expect(getWebsite).not.toHaveBeenCalled();
  },
);

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

test.each([
  [
    'prisma',
    'click',
    'h.retention_expires_at is null or h.retention_expires_at > CURRENT_TIMESTAMP',
  ],
  [
    'prisma',
    'scroll',
    'h.retention_expires_at is null or h.retention_expires_at > CURRENT_TIMESTAMP',
  ],
  ['clickhouse', 'click', "h.retention_policy = 0 or h.ingested_at + INTERVAL 30 DAY > now('UTC')"],
  [
    'clickhouse',
    'scroll',
    "h.retention_policy = 0 or h.ingested_at + INTERVAL 30 DAY > now('UTC')",
  ],
] as const)(
  '%s %s reports hide expired new rows in every query',
  async (database, mode, retentionPredicate) => {
    state.mode = database;
    const rawQuery = database === 'prisma' ? prismaRawQuery : clickhouseRawQuery;
    rawQuery.mockResolvedValue([]);

    await getHeatmap('website-1', {
      mode,
      urlPath: '/',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-02T00:00:00Z'),
    });

    expect(rawQuery).toHaveBeenCalledTimes(2);
    for (const [query] of rawQuery.mock.calls) {
      expect(query).toContain(retentionPredicate);
    }
  },
);
