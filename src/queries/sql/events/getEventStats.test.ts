import { afterEach, describe, expect, test, vi } from 'vitest';

const startDate = new Date('2026-09-01T00:00:00Z');
const endDate = new Date('2026-09-30T00:00:00Z');

async function loadModule(mode: 'prisma' | 'clickhouse', filtered = true) {
  vi.resetModules();

  const rawQuery = vi.fn().mockResolvedValue([]);
  const parseFilters = vi.fn().mockReturnValue({
    filterQuery: filtered
      ? mode === 'prisma'
        ? 'and website_event.event_name = ANY({{eventName}})'
        : 'and event_name IN {eventName:Array(String)}'
      : '',
    cohortQuery: filtered ? 'join cohort on cohort.session_id = website_event.session_id' : '',
    joinSessionQuery: filtered
      ? 'join session on session.session_id = website_event.session_id'
      : '',
    queryParams: { websiteId: 'website-1', eventName: ['rare-event'] },
  });

  vi.doMock('@/lib/db', () => ({
    CLICKHOUSE: 'clickhouse',
    PRISMA: 'prisma',
    runQuery: (queries: Record<string, () => unknown>) => queries[mode](),
  }));
  vi.doMock('@/lib/prisma', () => ({
    default: { rawQuery, parseFilters, getDateSQL: (field: string) => `bucket(${field})` },
  }));
  vi.doMock('@/lib/clickhouse', () => ({
    default: { rawQuery, parseFilters, getDateSQL: (field: string) => `bucket(${field})` },
  }));

  const module = await import('./getEventStats');

  return { ...module, rawQuery };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('event series bounds', () => {
  test('defaults to 50 names and rejects invalid or oversized limits', async () => {
    const { getEventSeriesLimit } = await loadModule('prisma');

    expect(getEventSeriesLimit()).toBe(50);
    expect(getEventSeriesLimit(1)).toBe(1);
    expect(getEventSeriesLimit(500)).toBe(500);
    expect(getEventSeriesLimit('50')).toBe(50);
    for (const invalid of [0, -1, 501, 1.5, '0', '5; drop table website_event']) {
      expect(() => getEventSeriesLimit(invalid)).toThrow('Invalid event series limit.');
    }
  });

  test('permits the normal chart but rejects large name-by-bucket combinations', async () => {
    const { isEventSeriesWithinBudget } = await loadModule('prisma');
    const filters = { startDate, endDate, unit: 'hour' };

    expect(isEventSeriesWithinBudget(50, filters)).toBe(true);
    expect(isEventSeriesWithinBudget(500, filters)).toBe(false);
    expect(isEventSeriesWithinBudget(500, { ...filters, endDate: startDate })).toBe(true);
    expect(isEventSeriesWithinBudget(50, { ...filters, unit: 'minute' })).toBe(false);
    expect(isEventSeriesWithinBudget(50, { ...filters, endDate: new Date('invalid') })).toBe(false);
  });
});

describe('event series SQL', () => {
  test('PostgreSQL ranks only events matching filters and bounds execution time', async () => {
    const { getEventStats, rawQuery } = await loadModule('prisma');

    await getEventStats('website-1', {}, { startDate, endDate, unit: 'day' });

    const [sql, params, name, timeout] = rawQuery.mock.calls[0];
    expect(sql).toContain('with matched_events as (');
    expect(sql).toContain('join cohort on cohort.session_id = website_event.session_id');
    expect(sql).toContain('join session on session.session_id = website_event.session_id');
    expect(sql).toContain('and website_event.event_name = ANY({{eventName}})');
    expect(sql).toContain('from matched_events\n      group by event_name');
    expect(sql).toContain('order by count(*) desc, event_name');
    expect(sql).toContain('limit {{limit}}');
    expect(sql).toContain('join top_names on top_names.event_name = matched_events.event_name');
    expect(params).toMatchObject({ limit: 50, eventName: ['rare-event'] });
    expect(name).toBe('getEventStats');
    expect(timeout).toBe(10_000);
  });

  test('ClickHouse raw-event path applies the same filters when ranking names', async () => {
    const { getEventStats, rawQuery } = await loadModule('clickhouse');

    await getEventStats('website-1', { limit: 1 }, { startDate, endDate, unit: 'day' });

    const [sql, params, name, limits] = rawQuery.mock.calls[0];
    expect(sql.match(/join cohort on cohort.session_id = website_event.session_id/g)).toHaveLength(
      2,
    );
    expect(sql.match(/and event_name IN \{eventName:Array\(String\)\}/g)).toHaveLength(2);
    expect(sql).toContain('order by count(*) desc, event_name');
    expect(sql).toContain('limit {limit:UInt32}');
    expect(params).toMatchObject({ limit: 1, eventName: ['rare-event'] });
    expect(name).toBe('getEventStats');
    expect(limits).toEqual({ maxExecutionTimeSeconds: 10, maxResultRows: 50_000 });
  });

  test('ClickHouse hourly path expands names before applying the ranked-name filter', async () => {
    const { getEventStats, rawQuery } = await loadModule('clickhouse', false);

    await getEventStats('website-1', {}, { startDate, endDate, unit: 'day' });

    const [sql, params] = rawQuery.mock.calls[0];
    expect(sql).toContain('select arrayJoin(event_name) as event_name');
    expect(sql).toContain('where g.event_name in (');
    expect(sql).toContain('select arrayJoin(event_name) as ranked_name');
    expect(sql).toContain('group by ranked_name');
    expect(sql).toContain('limit {limit:UInt32}');
    expect(params.limit).toBe(50);
  });
});
