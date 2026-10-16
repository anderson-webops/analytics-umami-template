import { beforeEach, expect, test, vi } from 'vitest';
import { getSessionDataProperties } from '../sessions/getSessionDataProperties';
import { getSessionDataValues } from '../sessions/getSessionDataValues';
import { DiscoveryRangeTooBroadError } from './discoveryError';
import { getEventDataEvents } from './getEventDataEvents';
import { getEventDataFields } from './getEventDataFields';
import { getEventDataProperties } from './getEventDataProperties';
import { getEventDataValues } from './getEventDataValues';

const { state, prismaRawQuery, clickhouseRawQuery, prismaParseFilters, clickhouseParseFilters } =
  vi.hoisted(() => ({
    state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
    prismaRawQuery: vi.fn(),
    clickhouseRawQuery: vi.fn(),
    prismaParseFilters: vi.fn(),
    clickhouseParseFilters: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: vi.fn((queries: Record<string, () => unknown>) => queries[state.mode]()),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    rawQuery: prismaRawQuery,
    parseFilters: prismaParseFilters,
    getDateSQL: () => 'date_value',
    getPropertyFilterQuery: () => ({ sql: '', params: {} }),
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  isClickHouseDiscoveryLimitError: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === '158' || error.code === '191'),
  default: {
    rawQuery: clickhouseRawQuery,
    parseFilters: clickhouseParseFilters,
    getPropertyFilterQuery: () => ({ sql: '', params: {} }),
  },
}));

beforeEach(() => {
  state.mode = 'prisma';
  prismaRawQuery.mockReset().mockResolvedValue([{ budgetExceeded: false, rows: [] }]);
  clickhouseRawQuery.mockReset().mockResolvedValue([]);
  prismaParseFilters.mockReset().mockReturnValue({
    queryParams: { websiteId: 'website-1' },
    filterQuery: '',
    cohortQuery: '',
    joinSessionQuery: '',
  });
  clickhouseParseFilters.mockReset().mockReturnValue({
    queryParams: { websiteId: 'website-1' },
    filterQuery: '',
    cohortQuery: '',
  });
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s limits property-value discovery for selected and unselected events',
  async mode => {
    state.mode = mode;
    const rawQuery = mode === 'prisma' ? prismaRawQuery : clickhouseRawQuery;

    await getEventDataEvents('website-1', { event: 'purchase' });
    await getEventDataEvents('website-1', {});

    expect(rawQuery).toHaveBeenCalledTimes(2);
    for (const [query, , , limits] of rawQuery.mock.calls) {
      if (mode === 'prisma') {
        expect(query).toMatch(/with bounded as materialized/i);
        expect(query).toMatch(/limit 50001/i);
        expect(query).toMatch(/row_count > 50000/i);
        expect(query).toMatch(/limit \{\{discoveryResultLimit}}/i);
      } else {
        expect(query.trim()).toMatch(/\blimit 500$/i);
        expect(limits).toMatchObject({
          maxRowsToRead: 262_144,
          maxRowsToGroupBy: 50_000,
          maxRowsInJoin: 50_000,
          maxThreads: 1,
        });
      }
    }
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s limits property-key discovery for selected and unselected events',
  async mode => {
    state.mode = mode;
    const rawQuery = mode === 'prisma' ? prismaRawQuery : clickhouseRawQuery;

    await getEventDataFields('website-1', 'purchase', {});
    await getEventDataFields('website-1', undefined, {});

    expect(rawQuery).toHaveBeenCalledTimes(2);
    for (const [query, , , limits] of rawQuery.mock.calls) {
      if (mode === 'prisma') {
        expect(query).toMatch(/with bounded as materialized/i);
        expect(query).toMatch(/limit 50001/i);
        expect(query).toMatch(/row_count > 50000/i);
        expect(query).toMatch(/limit \{\{discoveryResultLimit}}/i);
      } else {
        expect(query.trim()).toMatch(/\blimit 500$/i);
        expect(limits).toMatchObject({
          maxRowsToRead: 262_144,
          maxRowsToGroupBy: 50_000,
          maxRowsInJoin: 50_000,
          maxThreads: 1,
        });
      }
    }
  },
);

test('rejects PostgreSQL discovery overflow instead of returning partial rankings', async () => {
  prismaRawQuery.mockResolvedValue([{ budgetExceeded: true, rows: [] }]);

  await expect(getEventDataEvents('website-1', { event: 'purchase' })).rejects.toBeInstanceOf(
    DiscoveryRangeTooBroadError,
  );
  await expect(getEventDataFields('website-1', 'purchase', {})).rejects.toBeInstanceOf(
    DiscoveryRangeTooBroadError,
  );
  await expect(getEventDataProperties('website-1', {})).rejects.toBeInstanceOf(
    DiscoveryRangeTooBroadError,
  );
});

test('preserves bounded PostgreSQL discovery rows and selected event values', async () => {
  const rows = [
    { eventName: 'purchase', propertyName: 'amount', dataType: 1, propertyValue: '10', total: 2 },
  ];
  prismaRawQuery.mockResolvedValue([{ budgetExceeded: false, rows }]);

  await expect(getEventDataEvents('website-1', { event: 'purchase' })).resolves.toEqual(rows);
});

test.each([
  { code: '158', type: 'TOO_MANY_ROWS' },
  { code: '191', type: 'SET_SIZE_LIMIT_EXCEEDED' },
])('maps ClickHouse discovery overflow $code to a safe narrow-range error', async failure => {
  state.mode = 'clickhouse';
  clickhouseRawQuery.mockRejectedValue(failure);

  await expect(getEventDataFields('website-1', undefined, {})).rejects.toBeInstanceOf(
    DiscoveryRangeTooBroadError,
  );
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s bounds event values and session discovery before grouping',
  async mode => {
    state.mode = mode;
    const rawQuery = mode === 'prisma' ? prismaRawQuery : clickhouseRawQuery;

    await getEventDataValues('website-1', 'purchase', { propertyName: 'amount' });
    await getEventDataValues('website-1', 'purchase', {
      propertyName: 'tags',
      dataType: 5,
    });
    await getSessionDataProperties('website-1', {}, [], 'category');
    await getSessionDataValues('website-1', { propertyName: 'category' });
    await getSessionDataValues('website-1', { propertyName: 'tags', dataType: 5 });

    expect(rawQuery).toHaveBeenCalledTimes(5);
    for (const [query, , , limits] of rawQuery.mock.calls) {
      if (mode === 'prisma') {
        expect(query).toMatch(/with bounded as materialized/i);
        expect(query).toMatch(/admitted as materialized/i);
        expect(query).toMatch(/from admitted/i);
        expect(query).toMatch(/limit 50001/i);
      } else {
        expect(limits).toMatchObject({
          maxRowsToRead: 262_144,
          maxRowsToGroupBy: 50_000,
          maxRowsInJoin: 50_000,
        });
      }
    }
  },
);

test('rejects session discovery overflow without returning a partial ranking', async () => {
  prismaRawQuery.mockResolvedValue([{ budgetExceeded: true, rows: [] }]);

  await expect(getSessionDataProperties('website-1', {})).rejects.toBeInstanceOf(
    DiscoveryRangeTooBroadError,
  );
  await expect(
    getSessionDataValues('website-1', { propertyName: 'category' }),
  ).rejects.toBeInstanceOf(DiscoveryRangeTooBroadError);
});
