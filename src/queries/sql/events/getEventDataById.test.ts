import { beforeEach, expect, test, vi } from 'vitest';
import { getEventDataById } from './getEventDataById';

const { state, prismaRawQuery, clickhouseRawQuery } = vi.hoisted(() => ({
  state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
  prismaRawQuery: vi.fn(),
  clickhouseRawQuery: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => unknown>) => queries[state.mode](),
}));
vi.mock('@/lib/prisma', () => ({ default: { rawQuery: prismaRawQuery } }));
vi.mock('@/lib/clickhouse', () => ({ default: { rawQuery: clickhouseRawQuery } }));

beforeEach(() => {
  prismaRawQuery.mockReset().mockResolvedValue([]);
  clickhouseRawQuery.mockReset().mockResolvedValue([]);
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s bounds public event-property reads without truncating owner reads',
  async mode => {
    state.mode = mode;
    const rawQuery = mode === 'prisma' ? prismaRawQuery : clickhouseRawQuery;

    await getEventDataById('website-id', 'event-id', 501);
    const [sharedSql, sharedParams] = rawQuery.mock.lastCall as [
      string,
      { websiteId: string; eventId: string; rowLimit: number },
    ];
    expect(sharedSql).toContain(
      mode === 'prisma' ? 'limit {{rowLimit}}' : 'limit {rowLimit:UInt32}',
    );
    expect(sharedParams).toEqual({ websiteId: 'website-id', eventId: 'event-id', rowLimit: 501 });

    await getEventDataById('website-id', 'event-id');
    const [ownerSql] = rawQuery.mock.lastCall as [string];
    expect(ownerSql).not.toContain('limit {{rowLimit}}');
    expect(ownerSql).not.toContain('limit {rowLimit:UInt32}');
  },
);
