import { afterEach, describe, expect, test, vi } from 'vitest';

const filters = {
  startDate: new Date('2026-09-01T00:00:00Z'),
  endDate: new Date('2026-09-03T00:00:00Z'),
  unit: 'day',
};

type Backend = 'prisma' | 'clickhouse';
type Source = 'event' | 'session';
type Series = 'property' | 'array';

async function loadSeries(backend: Backend, source: Source, series: Series) {
  vi.resetModules();

  const rawQuery = vi.fn().mockResolvedValue([]);
  const parseFilters = vi.fn().mockReturnValue({
    filterQuery: 'and website_event.is_bot = {{isBot}}',
    cohortQuery: 'join cohort on cohort.session_id = website_event.session_id',
    joinSessionQuery: 'join session on session.session_id = website_event.session_id',
    queryParams: { websiteId: 'website-1', isBot: false },
  });
  const getPropertyFilterQuery = vi.fn().mockReturnValue({
    sql: 'and website_event.event_name = {{pf_value}}',
    params: { pf_value: 'signup' },
  });
  const client = {
    rawQuery,
    parseFilters,
    getPropertyFilterQuery,
    getDateSQL: (field: string) => `bucket(${field})`,
  };

  vi.doMock('@/lib/db', () => ({
    CLICKHOUSE: 'clickhouse',
    PRISMA: 'prisma',
    runQuery: (queries: Record<Backend, () => unknown>) => queries[backend](),
  }));
  vi.doMock('@/lib/prisma', () => ({ default: client }));
  vi.doMock('@/lib/clickhouse', () => ({ default: client }));

  let query: (...args: any[]) => Promise<unknown>;

  if (source === 'event' && series === 'property') {
    query = (await import('./events/getEventDataPropertySeries')).getEventDataPropertySeries;
  } else if (source === 'event') {
    query = (await import('./events/getEventDataArraySeries')).getEventDataArraySeries;
  } else if (series === 'property') {
    query = (await import('./sessions/getSessionDataPropertySeries')).getSessionDataPropertySeries;
  } else {
    query = (await import('./sessions/getSessionDataArraySeries')).getSessionDataArraySeries;
  }

  return { query, rawQuery };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe.each(['prisma', 'clickhouse'] as const)('%s property series', backend => {
  test.each([
    ['event', 'property'],
    ['event', 'array'],
    ['session', 'property'],
    ['session', 'array'],
  ] as const)('%s %s ranks filtered values before time grouping', async (source, series) => {
    const { query, rawQuery } = await loadSeries(backend, source, series);
    const args =
      source === 'event'
        ? ['website-1', 'signup', 'plan', filters, []]
        : ['website-1', 'plan', filters, []];

    await query(...args);

    const [sql, params, , limits] = rawQuery.mock.calls[0];
    expect(sql).toContain('with matched_data as (');
    expect(sql).toContain('top_values as (');
    expect(sql.indexOf('and website_event.is_bot')).toBeLessThan(sql.indexOf('top_values as ('));
    expect(sql.indexOf('and website_event.event_name = {{pf_value}}')).toBeLessThan(
      sql.indexOf('top_values as ('),
    );
    expect(sql).toContain('join cohort on cohort.session_id = website_event.session_id');
    expect(sql).toContain(
      backend === 'clickhouse' && series === 'property' ? 'group by x_key' : 'group by x',
    );
    expect(sql).toContain(
      backend === 'prisma' ? 'limit {{valueLimit}}' : 'limit {valueLimit:UInt32}',
    );
    expect(sql).toContain(
      backend === 'clickhouse' && series === 'property'
        ? 'top_values.x_key = matched_data.x_key'
        : backend === 'prisma'
          ? 'top_values.x is not distinct from matched_data.x'
          : 'top_values.x = matched_data.x',
    );
    expect(sql).toContain('bucket(matched_data.created_at)');
    expect(params).toMatchObject({ valueLimit: 50, pf_value: 'signup' });
    expect(limits).toEqual(
      backend === 'prisma' ? 10_000 : { maxExecutionTimeSeconds: 10, maxResultRows: 10_000 },
    );

    if (source === 'session') {
      expect(sql).toContain('session_data.created_at between');
      expect(sql).toContain(
        backend === 'prisma' ? 'count(distinct session_id)' : 'uniq(session_id)',
      );
      if (backend === 'clickhouse') {
        expect(sql).toContain('session_data.created_at as created_at');
        expect(sql).toContain('session_data.session_id as session_id');
        expect(sql).toContain('uniq(session_id) as frequency');
        expect(sql).toContain('order by frequency desc');
      }
    } else {
      expect(sql).toContain(backend === 'prisma' ? 'count(*) desc, x' : 'count() desc, x');
    }

    if (series === 'array') {
      expect(sql).toContain(
        backend === 'prisma' ? 'jsonb_array_elements_text' : 'arrayJoin(JSONExtract',
      );
    }
  });

  test.each(['event', 'session'] as const)(
    '%s rejects a zero value budget before SQL',
    async source => {
      const { query, rawQuery } = await loadSeries(backend, source, 'property');
      const oversized = { ...filters, unit: 'minute', endDate: new Date('2026-10-01') };
      const args =
        source === 'event'
          ? ['website-1', 'signup', 'plan', oversized]
          : ['website-1', 'plan', oversized];

      await expect(query(...args)).rejects.toThrow('exceeds the allowed size');
      expect(rawQuery).not.toHaveBeenCalled();
    },
  );
});
