import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { CLICKHOUSE } from './db';

const state = vi.hoisted(() => ({
  lookup: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/queries/sql/sessions/getVerifiedIdentityFilterSessions', () => ({
  getVerifiedIdentityFilterSessions: state.lookup,
}));

const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a50000';
const sessionId = '11111111-1111-4111-8111-111111111111';
const originalUrl = process.env.CLICKHOUSE_URL;
let clickhouse: typeof import('./clickhouse').default;

beforeAll(async () => {
  process.env.CLICKHOUSE_URL = 'http://127.0.0.1:8123/umami';
  (globalThis as Record<string, unknown>)[CLICKHOUSE] = { query: state.query };
  vi.resetModules();
  ({ default: clickhouse } = await import('./clickhouse'));
});

afterAll(() => {
  if (originalUrl === undefined) {
    delete process.env.CLICKHOUSE_URL;
  } else {
    process.env.CLICKHOUSE_URL = originalUrl;
  }
  delete (globalThis as Record<string, unknown>)[CLICKHOUSE];
});

beforeEach(() => {
  state.lookup.mockReset().mockResolvedValue([sessionId]);
  state.query.mockReset().mockImplementation(async ({ query }) => ({
    json: async () => (query.includes('count(*)') ? [{ num: 1 }] : []),
  }));
});

test('ClickHouse resolves numbered and cohort identity filters from verified PostgreSQL links', async () => {
  const filters = {
    websiteId,
    distinctId: 'eq.alice',
    distinctId1: 'neq.bob',
    cohort_distinctId: 'c.alice',
  };
  const { filterQuery, cohortQuery, queryParams } = clickhouse.parseFilters(filters);

  await clickhouse.rawQuery(
    `select 1 from website_event where 1 = 1 ${filterQuery} ${cohortQuery}`,
    queryParams,
  );

  expect(state.lookup.mock.calls).toEqual([
    [websiteId, 'eq', ['alice']],
    [websiteId, 'neq', ['bob']],
    [websiteId, 'c', 'alice'],
  ]);
  const submitted = state.query.mock.lastCall?.[0];
  expect(submitted.query).not.toContain('distinct_id');
  expect(submitted.query_params).toMatchObject({
    verifiedIdentitySessions_distinctId: [sessionId],
    verifiedIdentitySessions_distinctId1: [sessionId],
    verifiedIdentitySessions_cohort_distinctId: [sessionId],
  });
  expect(submitted.query_params).not.toHaveProperty('distinctId');
  expect(submitted.query_params).not.toHaveProperty('distinctId1');
  expect(submitted.query_params).not.toHaveProperty('cohort_distinctId');
});

test('paged ClickHouse reads reuse one verified lookup for count and data', async () => {
  const filters = { websiteId, distinctId: 'eq.alice', startDate: new Date('2026-01-01') };
  const { filterQuery, queryParams } = clickhouse.parseFilters(filters);

  await clickhouse.pagedRawQuery(
    `select 1 from website_event where 1 = 1 ${filterQuery}`,
    queryParams,
    filters,
  );

  expect(state.lookup).toHaveBeenCalledTimes(1);
  expect(state.query).toHaveBeenCalledTimes(2);
});

test('failed identity verification never reaches ClickHouse', async () => {
  state.lookup.mockRejectedValue(new Error('IDENTITY_SEARCH_TOO_BROAD'));
  const { filterQuery, queryParams } = clickhouse.parseFilters({ websiteId, distinctId: 'c.a' });

  await expect(
    clickhouse.rawQuery(`select 1 from website_event where 1 = 1 ${filterQuery}`, queryParams),
  ).rejects.toThrow('IDENTITY_SEARCH_TOO_BROAD');
  expect(state.query).not.toHaveBeenCalled();
});

test('ClickHouse accepts at most eight verified identity predicates', () => {
  const filters = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`distinctId${index || ''}`, 'eq.synthetic-user']),
  );

  expect(() =>
    clickhouse.parseFilters({ websiteId, ...filters, distinctId8: undefined }),
  ).not.toThrow();
  expect(() => clickhouse.parseFilters({ websiteId, ...filters })).toThrow(
    'IDENTITY_FILTER_COUNT_EXCEEDED',
  );
});
