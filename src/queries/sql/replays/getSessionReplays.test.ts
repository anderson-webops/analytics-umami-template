import { beforeEach, expect, test, vi } from 'vitest';
import type { QueryFilters } from '@/lib/types';
import { getSessionReplays } from './getSessionReplays';

const state = vi.hoisted(() => ({
  backend: 'prisma' as 'prisma' | 'clickhouse',
  prismaPagedRawQuery: vi.fn(),
  clickhousePagedRawQuery: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => Promise<unknown>>) => queries[state.backend](),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    pagedRawQuery: state.prismaPagedRawQuery,
    parseFilters: vi.fn(() => ({
      filterQuery: '',
      cohortQuery: '',
      joinSessionQuery: '',
      queryParams: {},
    })),
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    pagedRawQuery: state.clickhousePagedRawQuery,
    parseFilters: vi.fn(() => ({
      filterQuery: '',
      cohortQuery: '',
      queryParams: {},
    })),
  },
}));

beforeEach(() => {
  state.backend = 'prisma';
  state.prismaPagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
  state.clickhousePagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
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
