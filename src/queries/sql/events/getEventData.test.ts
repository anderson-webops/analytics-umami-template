import { beforeEach, expect, test, vi } from 'vitest';
import { EventDataPageTooBroadError, getEventData } from './getEventData';

const { state, rawQuery, parseFilters } = vi.hoisted(() => ({
  state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
  rawQuery: vi.fn(),
  parseFilters: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => unknown>) => queries[state.mode](),
}));

vi.mock('@/lib/prisma', () => ({ default: { rawQuery, parseFilters } }));
vi.mock('@/lib/clickhouse', () => ({ default: { rawQuery, parseFilters } }));

const filters = {
  startDate: new Date('2026-10-15T00:00:00Z'),
  endDate: new Date('2026-10-16T00:00:00Z'),
  path: 'eq./news',
  event: 'eq.purchase',
};

beforeEach(() => {
  rawQuery.mockReset();
  parseFilters.mockReset().mockReturnValue({
    filterQuery: '',
    cohortQuery: '',
    joinSessionQuery: '',
    queryParams: {},
  });
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s bounds event properties without truncating a successful page',
  async mode => {
    state.mode = mode;
    rawQuery.mockResolvedValueOnce([{ num: 1 }]).mockResolvedValueOnce([{ dataKey: 'currency' }]);

    const result = await getEventData('website-1', filters);

    expect(result.data).toEqual([{ dataKey: 'currency' }]);
    expect(rawQuery.mock.calls[1][0]).toContain('limit 10001');
    if (mode === 'clickhouse') {
      expect(parseFilters.mock.calls[0][1]).toEqual({
        columns: {
          path: 'website_event.url_path',
          entry: 'website_event.url_path',
          exit: 'website_event.url_path',
          event: 'website_event.event_name',
        },
      });
    }
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s rejects a property page over the fixed row budget',
  async mode => {
    state.mode = mode;
    rawQuery.mockResolvedValueOnce([{ num: 1 }]).mockResolvedValueOnce(Array(10_001).fill({}));

    await expect(getEventData('website-1', filters)).rejects.toBeInstanceOf(
      EventDataPageTooBroadError,
    );
  },
);

test('ClickHouse event pages match the complete parent identity after filtering', async () => {
  state.mode = 'clickhouse';
  rawQuery.mockResolvedValueOnce([{ num: 1 }]).mockResolvedValueOnce([{ dataKey: 'currency' }]);

  await getEventData('website-1', filters);

  const countQuery = rawQuery.mock.calls[0][0] as string;
  const pageQuery = rawQuery.mock.calls[1][0] as string;
  expect(
    countQuery.match(/event_data\.event_id, event_data\.event_name, event_data\.url_path/g),
  ).toHaveLength(2);
  expect(countQuery).toContain('website_event.url_path = event_data.url_path');
  expect(pageQuery).toContain('paged_events.website_id = event_data.website_id');
  expect(pageQuery).toContain('paged_events.session_id = event_data.session_id');
  expect(pageQuery).toContain('paged_events.event_name = event_data.event_name');
  expect(pageQuery).toContain('paged_events.url_path = event_data.url_path');
});
