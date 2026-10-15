import { afterEach, expect, test, vi } from 'vitest';
import { LINKED_QUERY_TIMEOUT_MS, MAX_LINK_READ_ROWS } from '@/lib/share-query-budget';

async function loadQueries(mode: 'prisma' | 'clickhouse') {
  vi.resetModules();
  const rawQuery = vi.fn().mockResolvedValue([]);

  vi.doMock('@/lib/db', () => ({
    CLICKHOUSE: 'clickhouse',
    PRISMA: 'prisma',
    runQuery: (queries: Record<string, () => unknown>) => queries[mode](),
  }));
  vi.doMock('@/lib/prisma', () => ({ default: { rawQuery } }));
  vi.doMock('@/lib/clickhouse', () => ({ default: { rawQuery } }));

  const [{ getLinkedDistinctIds }, { getLinkedSessionIds }, { getSessionData }] = await Promise.all(
    [import('./getLinkedDistinctIds'), import('./getLinkedSessionIds'), import('./getSessionData')],
  );

  return { getLinkedDistinctIds, getLinkedSessionIds, getSessionData, rawQuery };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s requires bounded linked-session reads and retains ordinary property reads',
  async mode => {
    const { getLinkedDistinctIds, getLinkedSessionIds, getSessionData, rawQuery } =
      await loadQueries(mode);
    const queries = [
      () => getLinkedDistinctIds('website', 'session', 501),
      () => getLinkedSessionIds('website', 'visitor', 501),
      () => getSessionData('website', 'session', 501),
    ];

    for (const query of queries) {
      await query();
      const [sql, params] = rawQuery.mock.lastCall as [string, { rowLimit: number }];
      expect(sql).toContain(mode === 'prisma' ? 'limit {{rowLimit}}' : 'limit {rowLimit:UInt32}');
      expect(params.rowLimit).toBe(501);
    }

    rawQuery.mockClear();

    for (const invalidLimit of [0, -1, 2_002, 1.5, Number.NaN, undefined]) {
      const rowLimit = invalidLimit as number;

      await expect(getLinkedDistinctIds('website', 'session', rowLimit)).rejects.toThrow(
        'LINKED_SESSION_ROW_LIMIT_INVALID',
      );
      await expect(getLinkedSessionIds('website', 'visitor', rowLimit)).rejects.toThrow(
        'LINKED_SESSION_ROW_LIMIT_INVALID',
      );
    }

    expect(rawQuery).not.toHaveBeenCalled();

    await getSessionData('website', 'session');
    expect(rawQuery.mock.lastCall?.[0]).not.toContain('limit {{rowLimit}}');
    expect(rawQuery.mock.lastCall?.[0]).not.toContain('limit {rowLimit:UInt32}');
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s bounds identity discovery work without truncating valid linked sessions',
  async mode => {
    const { getLinkedDistinctIds, getLinkedSessionIds, rawQuery } = await loadQueries(mode);

    await getLinkedDistinctIds('website', 'session', 2);
    const [identitySql, , , identityLimits] = rawQuery.mock.lastCall as [
      string,
      unknown,
      unknown,
      number | Record<string, number> | undefined,
    ];
    await getLinkedSessionIds('website', 'visitor', 501);
    const [linksSql, , , linksLimits] = rawQuery.mock.lastCall as [
      string,
      unknown,
      unknown,
      number | Record<string, number> | undefined,
    ];

    if (mode === 'prisma') {
      expect(identitySql).toContain('select distinct_id as "distinctId"');
      expect(identitySql).not.toContain('select distinct distinct_id');
      expect(linksSql).toContain('order by session_id');
      expect(linksSql).not.toContain('group by session_id');
      expect(identityLimits).toBe(LINKED_QUERY_TIMEOUT_MS);
      expect(linksLimits).toBe(LINKED_QUERY_TIMEOUT_MS);
    } else {
      expect(identitySql).toContain('select distinct distinct_id');
      expect(linksSql).toContain('group by session_id');
      expect(identityLimits).toEqual({
        maxExecutionTimeSeconds: LINKED_QUERY_TIMEOUT_MS / 1000,
        maxResultRows: 2,
        maxRowsToRead: MAX_LINK_READ_ROWS,
      });
      expect(linksLimits).toEqual({
        maxExecutionTimeSeconds: LINKED_QUERY_TIMEOUT_MS / 1000,
        maxResultRows: 501,
        maxRowsToRead: MAX_LINK_READ_ROWS,
      });
    }
  },
);

test('limited ClickHouse session-property reads cap backend work without changing owner reads', async () => {
  const { getSessionData, rawQuery } = await loadQueries('clickhouse');

  await getSessionData('website', 'session', 501);
  expect(rawQuery.mock.lastCall?.[3]).toEqual({
    maxExecutionTimeSeconds: 5,
    maxResultRows: 501,
    maxRowsToRead: 262_144,
  });

  await getSessionData('website', 'session');
  expect(rawQuery.mock.lastCall?.[3]).toBeUndefined();
});
