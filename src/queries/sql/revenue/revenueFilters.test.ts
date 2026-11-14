import { beforeEach, expect, test, vi } from 'vitest';
import { getRevenueChart } from './getRevenueChart';
import { getRevenueMetrics } from './getRevenueMetrics';
import { getRevenueSessions } from './getRevenueSessions';
import { getRevenueStats } from './getRevenueStats';

const { rawQueryMock, pagedRawQueryMock, parseFiltersMock, getDateSQLMock, queryState } =
  vi.hoisted(() => ({
    rawQueryMock: vi.fn(),
    pagedRawQueryMock: vi.fn(),
    parseFiltersMock: vi.fn(),
    getDateSQLMock: vi.fn(),
    queryState: { backend: 'prisma' },
  }));

vi.mock('@/lib/db', () => ({
  CLICKHOUSE: 'clickhouse',
  PRISMA: 'prisma',
  runQuery: vi.fn((queries: Record<string, () => unknown>) => queries[queryState.backend]()),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    rawQuery: rawQueryMock,
    pagedRawQuery: pagedRawQueryMock,
    parseFilters: parseFiltersMock,
    getDateSQL: getDateSQLMock,
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    rawQuery: rawQueryMock,
    pagedRawQuery: pagedRawQueryMock,
    parseFilters: parseFiltersMock,
    getDateSQL: getDateSQLMock,
    getDateStringSQL: getDateSQLMock,
  },
}));

const parameters = {
  startDate: new Date('2026-05-18T00:00:00.000Z'),
  endDate: new Date('2026-05-19T00:00:00.000Z'),
  currency: 'EUR',
  unit: 'day',
  timezone: 'utc',
};

beforeEach(() => {
  queryState.backend = 'prisma';
  rawQueryMock.mockReset();
  pagedRawQueryMock.mockReset();
  parseFiltersMock.mockReset();
  getDateSQLMock.mockReset();

  parseFiltersMock.mockReturnValue({
    queryParams: {},
    filterQuery: 'and website_event.utm_source = {{utmSource}}',
    cohortQuery: '',
    joinSessionQuery: '',
    dateQuery: 'and created_at between {{startDate}} and {{endDate}}',
  });

  getDateSQLMock.mockReturnValue('bucketed_date');
});

test.each(['prisma', 'clickhouse'])(
  '%s revenue sessions include historical purchase claims',
  async backend => {
    queryState.backend = backend;
    pagedRawQueryMock.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 100 });
    parseFiltersMock.mockReturnValue({
      queryParams: { event: 'purchase' },
      filterQuery:
        backend === 'prisma'
          ? 'and website_event.event_name = {{event}}'
          : 'and event_name = {event:String}',
      cohortQuery: '',
      dateQuery: '',
    });

    await getRevenueSessions('website-1', 'USD', { event: 'purchase' });

    const [query] = pagedRawQueryMock.mock.calls[0];
    expect(query).toContain(backend === 'prisma' ? 'website_event.event_name' : 'event_name');
    expect(query.slice(query.indexOf('where '), query.indexOf('group by'))).not.toContain(
      'trust_tier',
    );
  },
);

test('getRevenueStats keeps historical claims but does not calculate revenue per user', async () => {
  rawQueryMock.mockResolvedValue([
    {
      sum: 0,
      count: 0,
      unique_count: 0,
    },
  ]);

  const stats = await getRevenueStats('website-1', parameters, {});

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain('filtered_sessions as');
  expect(query).toContain('join filtered_sessions');
  expect(query).not.toContain('total_sessions');
  expect(query).not.toContain('and website_event.event_id = revenue.event_id');
  expect(stats.arpu).toBeNull();
});

test('ClickHouse revenue claims also have no per-user denominator', async () => {
  queryState.backend = 'clickhouse';
  rawQueryMock.mockResolvedValue([{ sum: 125, count: 4, unique_count: 3 }]);

  const stats = await getRevenueStats('website-1', parameters, {});
  const [query] = rawQueryMock.mock.calls[0];

  expect(query).not.toContain('total_sessions');
  expect(stats.arpu).toBeNull();
});

test('getRevenueChart buckets filtered revenue instead of revenue rows joined by event id', async () => {
  rawQueryMock.mockResolvedValue([]);

  await getRevenueChart('website-1', parameters, {});

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain('filtered_sessions as');
  expect(query).toContain('filtered_revenue as');
  expect(query).toContain('from filtered_revenue');
  expect(query).toContain('bucketed_date');
  expect(query).not.toContain('and website_event.event_id = revenue.event_id');
});

test('getRevenueMetrics uses the filtered session set for screen-load breakdowns', async () => {
  rawQueryMock.mockResolvedValue([]);

  await getRevenueMetrics('website-1', parameters, {}, 'country');

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain('filtered_sessions as');
  expect(query).toContain('filtered_revenue as');
  expect(query).toContain('sum(filtered_revenue.revenue) as "value"');
  expect(query).not.toContain('and website_event.event_id = revenue.event_id');
});

test('getRevenueStats counts only positive revenue rows as orders', async () => {
  rawQueryMock.mockResolvedValue([{ sum: 900, count: 10, unique_count: 0, total_sessions: 0 }]);

  const result = await getRevenueStats('website-1', parameters, {});

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain(
    'count(distinct case when filtered_revenue.revenue > 0 then filtered_revenue.event_id end) as count',
  );
  // Net revenue (payments minus refunds) per order.
  expect(result.average).toBe(90);
});

test('ClickHouse revenue stats always keep imported revenue and count only positive orders', async () => {
  queryState.backend = 'clickhouse';
  rawQueryMock.mockResolvedValue([{ sum: 900, count: 10, unique_count: 4, total_sessions: 30 }]);

  const result = await getRevenueStats('website-1', parameters, {});

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain("event_name in ('stripe:payment', 'stripe:refund'");
  expect(query).toContain('or session_id in (select session_id from filtered_sessions)');
  expect(query).not.toContain('inner join filtered_sessions');
  expect(query).toContain(
    'uniqExactIf(filtered_revenue.event_id, filtered_revenue.revenue > 0) as count',
  );
  expect(query).toContain('select event_id, session_id, revenue');
  expect(query).not.toContain('total_sessions');
  expect(result.average).toBe(90);
  expect(result.arpu).toBeNull();
});

test('ClickHouse revenue chart always keeps imported revenue', async () => {
  queryState.backend = 'clickhouse';
  rawQueryMock.mockResolvedValue([]);

  await getRevenueChart('website-1', parameters, {});

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain("event_name in ('stripe:payment'");
  expect(query).toContain('or session_id in (select session_id from filtered_sessions)');
  expect(query).toContain('countIf(filtered_revenue.revenue > 0) count');
});

test('ClickHouse revenue channels put revenue without a tracked visit under unknown, not direct', async () => {
  queryState.backend = 'clickhouse';
  rawQueryMock.mockResolvedValue([]);

  await getRevenueMetrics('website-1', parameters, {}, 'channel');

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain("and not event_name in ('stripe:payment'");
  expect(query).toContain('any left join first_event');
  expect(query).toContain("when tracked = 0 then 'unknown'");
  expect(query).not.toContain("'Unknown'");
});

test('ClickHouse revenue locations keep revenue whose session has no event row', async () => {
  queryState.backend = 'clickhouse';
  rawQueryMock.mockResolvedValue([]);

  await getRevenueMetrics('website-1', parameters, {}, 'country');

  const [query] = rawQueryMock.mock.calls[0];

  expect(query).toContain("event_name in ('stripe:payment'");
  expect(query).toContain('any left join revenue_session');
});
