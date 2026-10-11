import { afterEach, expect, test, vi } from 'vitest';

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
