import { beforeEach, expect, test, vi } from 'vitest';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';
import { getValues } from '../getValues';
import { getSessionExpandedMetrics } from './getSessionExpandedMetrics';
import { getSessionMetrics } from './getSessionMetrics';

const { clickhouseRawQuery, prismaRawQuery, clickhouseParseFilters } = vi.hoisted(() => ({
  clickhouseRawQuery: vi.fn(),
  prismaRawQuery: vi.fn(),
  clickhouseParseFilters: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  CLICKHOUSE: 'clickhouse',
  PRISMA: 'prisma',
  runQuery: (queries: Record<string, () => unknown>) => queries.clickhouse(),
}));

vi.mock('@/lib/clickhouse', () => ({
  default: { rawQuery: clickhouseRawQuery, parseFilters: clickhouseParseFilters },
  isClickHouseDiscoveryLimitError: (error: { code?: string }) => error?.code === '158',
}));

vi.mock('@/lib/prisma', () => ({ default: { rawQuery: prismaRawQuery } }));

const filters = {
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-02T00:00:00Z'),
  unit: 'day',
};

beforeEach(() => {
  clickhouseRawQuery.mockReset();
  prismaRawQuery.mockReset();
  clickhouseParseFilters.mockReset().mockImplementation(input => ({
    filterQuery: '',
    cohortQuery: '',
    excludeBounceQuery: '',
    queryParams: input,
  }));
});

test('ClickHouse identity values use only verified PostgreSQL links', async () => {
  clickhouseRawQuery.mockResolvedValue([
    { sessionId: 'session-a', count: 3 },
    { sessionId: 'session-b', count: 2 },
  ]);
  prismaRawQuery.mockResolvedValue([
    { sessionId: 'session-a', distinctId: 'trusted' },
    { sessionId: 'session-b', distinctId: 'trusted' },
    { sessionId: 'session-a', distinctId: 'another' },
  ]);

  expect(await getValues('website', 'distinct_id', filters)).toEqual([
    { value: 'trusted', count: 5 },
    { value: 'another', count: 3 },
  ]);

  const [eventSql, eventParams, , limits] = clickhouseRawQuery.mock.calls[0];
  const [linkSql, linkParams] = prismaRawQuery.mock.calls[0];
  expect(eventSql).toContain('group by session_id');
  expect(eventSql).not.toContain('distinct_id');
  expect(eventParams).toMatchObject({ websiteId: 'website' });
  expect(limits).toMatchObject({ maxThreads: 1, maxRowsToGroupBy: 2001 });
  expect(linkSql).toContain('trust_tier = 1');
  expect(linkSql).toContain('session_id = any({{sessionIds}}::uuid[])');
  expect(linkParams.sessionIds).toEqual(['session-a', 'session-b']);
});

test('identity search matches only verified labels', async () => {
  clickhouseRawQuery.mockResolvedValue([{ sessionId: 'session-a', count: 2 }]);
  prismaRawQuery.mockResolvedValue([
    { sessionId: 'session-a', distinctId: 'Trusted' },
    { sessionId: 'session-a', distinctId: 'Other' },
  ]);

  expect(await getValues('website', 'distinct_id', { ...filters, search: 'tru' })).toEqual([
    { value: 'Trusted', count: 2 },
  ]);
});

test('an empty event window never queries the identity store', async () => {
  clickhouseRawQuery.mockResolvedValue([]);

  expect(await getValues('website', 'distinct_id', filters)).toEqual([]);
  expect(prismaRawQuery).not.toHaveBeenCalled();
});

test('too many event sessions reject rather than truncate identity discovery', async () => {
  clickhouseRawQuery.mockResolvedValue(
    Array.from({ length: MAX_AUTH_SESSION_ROWS + 1 }, (_, index) => ({
      sessionId: `session-${index}`,
      count: 1,
    })),
  );

  await expect(getValues('website', 'distinct_id', filters)).rejects.toBeInstanceOf(
    IdentitySearchTooBroadError,
  );
  expect(prismaRawQuery).not.toHaveBeenCalled();
});

test('too many verified links reject rather than truncate identity discovery', async () => {
  clickhouseRawQuery.mockResolvedValue([{ sessionId: 'session-a', count: 1 }]);
  prismaRawQuery.mockResolvedValue(
    Array.from({ length: MAX_AUTH_SESSION_ROWS + 1 }, (_, index) => ({
      sessionId: 'session-a',
      distinctId: `identity-${index}`,
    })),
  );

  await expect(getValues('website', 'distinct_id', filters)).rejects.toBeInstanceOf(
    IdentitySearchTooBroadError,
  );
});

test('ClickHouse bounded-read failures reject without exposing partial values', async () => {
  clickhouseRawQuery.mockRejectedValue({ code: '158' });

  await expect(getValues('website', 'distinct_id', filters)).rejects.toBeInstanceOf(
    IdentitySearchTooBroadError,
  );
  expect(prismaRawQuery).not.toHaveBeenCalled();
});

test('ClickHouse identity metrics count verified sessions, not raw identity labels', async () => {
  clickhouseRawQuery.mockResolvedValue([{ sessionId: 'session-a' }, { sessionId: 'session-b' }]);
  prismaRawQuery.mockResolvedValue([
    { sessionId: 'session-a', distinctId: 'trusted' },
    { sessionId: 'session-b', distinctId: 'trusted' },
    { sessionId: 'session-a', distinctId: 'another' },
  ]);

  expect(await getSessionMetrics('website', { type: 'distinctId' }, filters)).toEqual([
    { x: 'trusted', y: 2 },
    { x: 'another', y: 1 },
  ]);

  const [eventSql] = clickhouseRawQuery.mock.calls[0];
  expect(eventSql).not.toContain('distinct_id');
  expect(eventSql).toContain('group by website_event.session_id');
  expect(prismaRawQuery.mock.calls[0][0]).toContain('trust_tier = 1');
});

test('ClickHouse expanded identity metrics retain visits and trusted bounce logic', async () => {
  clickhouseRawQuery
    .mockResolvedValueOnce([
      { sessionId: 'session-a', visitId: 'visit-a', count: 2, totalTime: 30 },
      { sessionId: 'session-a', visitId: 'visit-b', count: 1, totalTime: 0 },
      { sessionId: 'session-b', visitId: 'visit-c', count: 1, totalTime: 0 },
    ])
    .mockResolvedValueOnce([{ sessionId: 'session-a', visitId: 'visit-b' }]);
  prismaRawQuery.mockResolvedValue([
    { sessionId: 'session-a', distinctId: 'trusted' },
    { sessionId: 'session-b', distinctId: 'trusted' },
    { sessionId: 'session-a', distinctId: 'another' },
  ]);

  expect(await getSessionExpandedMetrics('website', { type: 'distinctId' }, filters)).toEqual([
    {
      name: 'trusted',
      pageviews: 4,
      visitors: 2,
      visits: 3,
      bounces: 1,
      totaltime: 30,
    },
    {
      name: 'another',
      pageviews: 3,
      visitors: 1,
      visits: 2,
      bounces: 0,
      totaltime: 30,
    },
  ]);

  const [visitsSql] = clickhouseRawQuery.mock.calls[0];
  const [customSql] = clickhouseRawQuery.mock.calls[1];
  expect(visitsSql).not.toContain('distinct_id');
  expect(customSql).toContain('trust_tier = 1');
  expect(prismaRawQuery.mock.calls[0][0]).toContain('trust_tier = 1');
});

test('unverified-only expanded metrics skip the custom-event lookup', async () => {
  clickhouseRawQuery.mockResolvedValueOnce([
    { sessionId: 'session-a', visitId: 'visit-a', count: 1, totalTime: 0 },
  ]);
  prismaRawQuery.mockResolvedValueOnce([]);

  expect(await getSessionExpandedMetrics('website', { type: 'distinctId' }, filters)).toEqual([]);
  expect(clickhouseRawQuery).toHaveBeenCalledTimes(1);
});

test('broad ClickHouse metric projections reject before looking up identities', async () => {
  clickhouseRawQuery.mockResolvedValue(
    Array.from({ length: MAX_AUTH_SESSION_ROWS + 1 }, (_, index) => ({
      sessionId: `session-${index}`,
    })),
  );

  await expect(
    getSessionMetrics('website', { type: 'distinctId' }, filters),
  ).rejects.toBeInstanceOf(IdentitySearchTooBroadError);
  expect(prismaRawQuery).not.toHaveBeenCalled();
});
