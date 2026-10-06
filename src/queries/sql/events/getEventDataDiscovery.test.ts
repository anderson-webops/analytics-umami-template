import { beforeEach, expect, test, vi } from 'vitest';
import { getEventDataEvents } from './getEventDataEvents';
import { getEventDataFields } from './getEventDataFields';

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
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    rawQuery: clickhouseRawQuery,
    parseFilters: clickhouseParseFilters,
  },
}));

beforeEach(() => {
  state.mode = 'prisma';
  prismaRawQuery.mockReset().mockResolvedValue([]);
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
    for (const [query] of rawQuery.mock.calls) {
      expect(query.trim()).toMatch(/\blimit 500$/i);
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
    for (const [query] of rawQuery.mock.calls) {
      expect(query.trim()).toMatch(/\blimit 500$/i);
    }
  },
);
