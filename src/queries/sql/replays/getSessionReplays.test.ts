import { beforeEach, expect, test, vi } from 'vitest';
import type { QueryFilters } from '@/lib/types';
import { getSessionReplays } from './getSessionReplays';

const state = vi.hoisted(() => ({
  backend: 'prisma' as 'prisma' | 'clickhouse',
  prismaPagedRawQuery: vi.fn(),
  clickhousePagedRawQuery: vi.fn(),
  prismaParseFilters: vi.fn(),
  clickhouseParseFilters: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => Promise<unknown>>) => queries[state.backend](),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    pagedRawQuery: state.prismaPagedRawQuery,
    parseFilters: state.prismaParseFilters,
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    pagedRawQuery: state.clickhousePagedRawQuery,
    parseFilters: state.clickhouseParseFilters,
  },
}));

beforeEach(() => {
  state.backend = 'prisma';
  state.prismaPagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
  state.clickhousePagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
  state.prismaParseFilters.mockReset().mockReturnValue({
    filterQuery: '',
    cohortQuery: '',
    joinSessionQuery: '',
    queryParams: {},
  });
  state.clickhouseParseFilters.mockReset().mockReturnValue({
    filterQuery: '',
    cohortQuery: '',
    queryParams: {},
  });
});

test.each([
  ['prisma', 'sr.retention_expires_at is null or sr.retention_expires_at > CURRENT_TIMESTAMP'],
  [
    'clickhouse',
    "session_replay.retention_policy = 0 or session_replay.ingested_at + INTERVAL 30 DAY > now('UTC')",
  ],
] as const)('listing excludes expired new replay payloads on %s', async (backend, predicate) => {
  state.backend = backend;
  const filters = {
    startDate: new Date('2026-10-01T00:00:00Z'),
    endDate: new Date('2026-10-02T00:00:00Z'),
  } as QueryFilters;

  await getSessionReplays('11111111-1111-4111-8111-111111111111', filters);

  const query = backend === 'prisma' ? state.prismaPagedRawQuery : state.clickhousePagedRawQuery;
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0][0]).toContain(predicate);
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s replay filters exclude legacy unverified custom events without excluding pageviews',
  async backend => {
    state.backend = backend;
    const parseFilters =
      backend === 'prisma' ? state.prismaParseFilters : state.clickhouseParseFilters;
    const eventFilter =
      backend === 'prisma'
        ? 'and website_event.event_name = {{eventName}}'
        : 'and event_name = {eventName:String}';
    parseFilters.mockReturnValue({
      filterQuery: eventFilter,
      cohortQuery: '',
      joinSessionQuery: '',
      queryParams: { eventName: 'purchase' },
    });

    await getSessionReplays('11111111-1111-4111-8111-111111111111', {
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-02T00:00:00Z'),
    } as QueryFilters);

    const query = backend === 'prisma' ? state.prismaPagedRawQuery : state.clickhousePagedRawQuery;
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(
      backend === 'prisma'
        ? 'website_event.event_type != 2 or website_event.trust_tier = 1'
        : 'event_type != 2 or trust_tier = 1',
    );
    expect(sql).toContain(eventFilter);
  },
);
