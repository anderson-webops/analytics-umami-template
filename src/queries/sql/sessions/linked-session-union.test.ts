import { afterEach, expect, test, vi } from 'vitest';

async function loadQueries() {
  vi.resetModules();
  const relationalQuery = vi.fn().mockResolvedValue([]);
  const legacyQuery = vi.fn().mockResolvedValue([]);

  vi.doMock('@/lib/db', () => ({
    CLICKHOUSE: 'clickhouse',
    PRISMA: 'prisma',
    runQuery: (queries: Record<string, () => unknown>) => queries.clickhouse(),
  }));
  vi.doMock('@/lib/prisma', () => ({ default: { rawQuery: relationalQuery } }));
  vi.doMock('@/lib/clickhouse', () => ({ default: { rawQuery: legacyQuery } }));

  const [{ getLinkedDistinctIds }, { getLinkedSessionIds }] = await Promise.all([
    import('./getLinkedDistinctIds'),
    import('./getLinkedSessionIds'),
  ]);

  return { getLinkedDistinctIds, getLinkedSessionIds, relationalQuery, legacyQuery };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

test('ClickHouse-mode reads use only links visible to the retained runtime', async () => {
  const { getLinkedDistinctIds, getLinkedSessionIds, relationalQuery, legacyQuery } =
    await loadQueries();

  legacyQuery.mockResolvedValueOnce([{ distinctId: 'legacy' }]);
  expect(await getLinkedDistinctIds('website', 'session', 3)).toEqual(['legacy']);

  legacyQuery.mockResolvedValueOnce([
    { sessionId: 'session-1', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  expect(await getLinkedSessionIds('website', 'visitor', 4)).toEqual([
    { sessionId: 'session-1', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  expect(relationalQuery).not.toHaveBeenCalled();
  expect(legacyQuery.mock.calls.every(([, params]) => params.rowLimit <= 4)).toBe(true);
});

test('ClickHouse reads preserve a sentinel row when history exceeds the caller limit', async () => {
  const { getLinkedSessionIds, legacyQuery } = await loadQueries();
  legacyQuery.mockResolvedValueOnce([
    { sessionId: 'session-1', createdAt: '2026-01-01T00:00:00Z' },
    { sessionId: 'session-2', createdAt: '2026-01-02T00:00:00Z' },
    { sessionId: 'session-3', createdAt: '2026-01-03T00:00:00Z' },
  ]);

  expect(await getLinkedSessionIds('website', 'visitor', 3)).toHaveLength(3);
});

test('a failed legacy read cannot silently return an incomplete linked identity', async () => {
  const { getLinkedSessionIds, legacyQuery } = await loadQueries();
  legacyQuery.mockRejectedValueOnce(new Error('read limit exceeded'));

  await expect(getLinkedSessionIds('website', 'visitor', 3)).rejects.toThrow('read limit exceeded');
});
