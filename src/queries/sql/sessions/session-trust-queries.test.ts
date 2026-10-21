import { beforeEach, expect, test, vi } from 'vitest';
import { getValues } from '../getValues';
import { getSessionDataActivityStats } from './getSessionDataActivityStats';
import { getSessionDataArraySeries } from './getSessionDataArraySeries';
import { getSessionDataDateSeries } from './getSessionDataDateSeries';
import { getSessionDataNumericSeries } from './getSessionDataNumericSeries';
import { getSessionDataNumericStats } from './getSessionDataNumericStats';
import { getSessionDataPivot } from './getSessionDataPivot';
import { getSessionDataProperties } from './getSessionDataProperties';
import { getSessionDataPropertySeries } from './getSessionDataPropertySeries';
import { getSessionDataValues } from './getSessionDataValues';
import { getSessionExpandedMetrics } from './getSessionExpandedMetrics';
import { getSessionMetrics } from './getSessionMetrics';

const { state, rawQuery, pagedRawQuery, queryClient } = vi.hoisted(() => {
  const rawQuery = vi.fn();
  const pagedRawQuery = vi.fn();
  return {
    state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
    rawQuery,
    pagedRawQuery,
    queryClient: {
      rawQuery,
      pagedRawQuery,
      parseFilters: () => ({
        filterQuery: '',
        cohortQuery: '',
        joinSessionQuery: '',
        dateQuery: '',
        queryParams: {},
      }),
      getPropertyFilterQuery: () => ({ sql: '', params: {} }),
      getDateSQL: (column: string) => column,
      getDateStringSQL: (column: string) => column,
      getTimestampDiffSQL: (start: string, end: string) => `${end} - ${start}`,
    },
  };
});

vi.mock('@/lib/db', () => ({
  CLICKHOUSE: 'clickhouse',
  PRISMA: 'prisma',
  runQuery: (queries: Record<string, () => unknown>) => queries[state.mode](),
}));

vi.mock('@/lib/prisma', () => ({ default: queryClient }));
vi.mock('@/lib/clickhouse', () => ({
  default: queryClient,
  isClickHouseDiscoveryLimitError: () => false,
}));

const filters = {
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-02T00:00:00Z'),
  unit: 'day',
};

beforeEach(() => {
  rawQuery.mockReset().mockResolvedValue([{ budgetExceeded: false, rows: [] }]);
  pagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s derived session-property reports exclude unverified legacy rows',
  async mode => {
    state.mode = mode;
    const queries = [
      () => getSessionDataActivityStats('website', 'plan', filters),
      () => getSessionDataArraySeries('website', 'plan', filters),
      () => getSessionDataDateSeries('website', 'plan', filters),
      () => getSessionDataNumericSeries('website', 'plan', 'sum', filters),
      () => getSessionDataNumericStats('website', 'plan', filters),
      () => getSessionDataPivot('website', 'plan', filters),
      () => getSessionDataProperties('website', filters),
      () => getSessionDataProperties('website', filters, [], 'plan'),
      () => getSessionDataPropertySeries('website', 'plan', filters),
      () => getSessionDataValues('website', { ...filters, propertyName: 'plan' }),
      () => getSessionDataValues('website', { ...filters, propertyName: 'plan', dataType: 5 }),
    ];

    for (const query of queries) {
      rawQuery.mockClear();
      pagedRawQuery.mockClear();
      await query();
      const call = rawQuery.mock.lastCall ?? pagedRawQuery.mock.lastCall;
      expect(call).toBeDefined();
      expect(call?.[0]).toContain('session_data.trust_tier = 1');
      expect(call?.[0]).toContain(
        '(website_event.event_type != 2 or website_event.trust_tier = 1)',
      );
    }
  },
);

test('PostgreSQL identity discovery and metrics project only verified links', async () => {
  state.mode = 'prisma';
  const queries = [
    () => getValues('website', 'distinct_id', filters),
    () => getSessionMetrics('website', { type: 'distinctId' }, filters),
    () => getSessionExpandedMetrics('website', { type: 'distinctId' }, filters),
  ];

  for (const query of queries) {
    rawQuery.mockClear();
    await query();
    const sql = rawQuery.mock.lastCall?.[0] as string;
    expect(sql).toContain('session_link');
    expect(sql).toContain('trust_tier = 1');
    expect(sql).not.toMatch(/(?:session|website_event)\.distinct_id/);
  }
});
