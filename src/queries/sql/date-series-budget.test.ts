import { afterEach, describe, expect, test, vi } from 'vitest';

const filters = {
  startDate: new Date('2026-09-01T00:00:00Z'),
  endDate: new Date('2026-09-03T00:00:00Z'),
  unit: 'day',
};

type Backend = 'prisma' | 'clickhouse';
type Source = 'event' | 'session';

async function loadQuery(backend: Backend, source: Source, rows: unknown[]) {
  vi.resetModules();

  const rawQuery = vi.fn().mockResolvedValue(rows);
  const client = {
    rawQuery,
    parseFilters: vi.fn().mockReturnValue({
      filterQuery: '',
      cohortQuery: '',
      joinSessionQuery: '',
      queryParams: { websiteId: 'website-1' },
    }),
    getPropertyFilterQuery: vi.fn().mockReturnValue({ sql: '', params: {} }),
    getDateSQL: vi.fn().mockReturnValue('date_bucket'),
  };

  vi.doMock('@/lib/db', () => ({
    CLICKHOUSE: 'clickhouse',
    PRISMA: 'prisma',
    runQuery: (queries: Record<Backend, () => Promise<unknown>>) => queries[backend](),
  }));
  vi.doMock('@/lib/prisma', () => ({ default: client }));
  vi.doMock('@/lib/clickhouse', () => ({ default: client }));

  if (source === 'event') {
    const { getEventDataDateSeries } = await import('./events/getEventDataDateSeries');
    return {
      run: () => getEventDataDateSeries('website-1', 'signup', 'meeting-date', filters, []),
      rawQuery,
      getDateSQL: client.getDateSQL,
    };
  }

  const { getSessionDataDateSeries } = await import('./sessions/getSessionDataDateSeries');
  return {
    run: () => getSessionDataDateSeries('website-1', 'meeting-date', filters, []),
    rawQuery,
    getDateSQL: client.getDateSQL,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe.each(['prisma', 'clickhouse'] as const)('%s date-series budget', backend => {
  test.each(['event', 'session'] as const)(
    '%s preserves complete small results and rejects an overflow row',
    async source => {
      const result = [{ t: '2026-09-01T00:00:00Z', y: 2 }];
      const ordinary = await loadQuery(backend, source, result);

      await expect(ordinary.run()).resolves.toEqual(result);

      const [sql, params, , limits] = ordinary.rawQuery.mock.calls[0];
      expect(ordinary.getDateSQL).toHaveBeenCalledWith(
        source === 'event' ? 'event_data.date_value' : 'session_data.date_value',
        'day',
        backend === 'prisma' ? 'utc' : 'UTC',
      );
      expect(sql).toContain('group by');
      expect(sql).toContain(
        backend === 'prisma' ? 'limit {{rowLimit}}' : 'limit {rowLimit:UInt32}',
      );
      expect(params).toMatchObject({ rowLimit: 10_001, propertyName: 'meeting-date' });
      expect(limits).toEqual(
        backend === 'prisma'
          ? 10_000
          : {
              maxExecutionTimeSeconds: 10,
              maxResultRows: 10_001,
              maxRowsToRead: 262_144,
              maxRowsToGroupBy: 10_001,
              maxThreads: 2,
            },
      );

      const maximum = await loadQuery(
        backend,
        source,
        Array.from({ length: 10_000 }, () => result[0]),
      );
      await expect(maximum.run()).resolves.toHaveLength(10_000);

      const overflow = await loadQuery(
        backend,
        source,
        Array.from({ length: 10_001 }, () => result[0]),
      );
      await expect(overflow.run()).rejects.toThrow('date series exceeds the allowed size');
    },
  );
});

describe.each(['event', 'session'] as const)('%s date-series route', source => {
  test('returns a bounded client error only for date-series overflow', async () => {
    vi.resetModules();

    const { DateSeriesLimitError } = await import('@/lib/date-series-budget');
    const query = vi.fn().mockRejectedValue(new DateSeriesLimitError());
    const canView = vi.fn().mockResolvedValue(true);
    vi.doMock('@/lib/request', () => ({
      parseRequest: vi.fn().mockResolvedValue({
        auth: { userId: 'user-1' },
        query: { startAt: 1, endAt: 2, eventName: 'signup', propertyName: 'meeting-date' },
      }),
      getQueryFilters: vi.fn().mockResolvedValue(filters),
    }));
    vi.doMock('@/lib/params', () => ({
      parseEventPropertyFilters: vi.fn().mockReturnValue([]),
      parsePropertyFilters: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('@/permissions', () => ({
      canViewWebsiteSection: canView,
    }));
    vi.doMock('@/queries/sql/events/getEventDataDateSeries', () => ({
      getEventDataDateSeries: query,
    }));
    vi.doMock('@/queries/sql', () => ({ getSessionDataDateSeries: query }));

    const route =
      source === 'event'
        ? await import('@/app/api/websites/[websiteId]/event-data-pivot/date-series/route')
        : await import('@/app/api/websites/[websiteId]/session-data/date-series/route');
    const request = new Request('https://analytics.example.test/api/date-series');
    const context = { params: Promise.resolve({ websiteId: 'website-1' }) };
    const response = await route.GET(request, context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'bad-request',
        message: 'The requested date series exceeds the allowed size.',
      },
    });
    expect(query).toHaveBeenCalledOnce();

    const failure = new Error('synthetic dependency failure');
    query.mockRejectedValueOnce(failure);
    await expect(route.GET(request, context)).rejects.toBe(failure);

    query.mockResolvedValueOnce([]);
    const empty = await route.GET(request, context);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    canView.mockResolvedValueOnce(false);
    query.mockClear();
    expect((await route.GET(request, context)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});
