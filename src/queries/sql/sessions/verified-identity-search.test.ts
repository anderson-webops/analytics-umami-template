import { beforeEach, expect, test, vi } from 'vitest';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';
import type { QueryFilters } from '@/lib/types';
import { getSessionReplays } from '../replays/getSessionReplays';
import { getVerifiedIdentitySearchSessions } from './getVerifiedIdentitySearchSessions';
import { getWebsiteSessions } from './getWebsiteSessions';

const state = vi.hoisted(() => ({
  mode: 'prisma' as 'prisma' | 'clickhouse',
  relationalRawQuery: vi.fn(),
  relationalPagedRawQuery: vi.fn(),
  clickhousePagedRawQuery: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => Promise<unknown>>) => queries[state.mode](),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    rawQuery: state.relationalRawQuery,
    pagedRawQuery: state.relationalPagedRawQuery,
    parseFilters: () => ({ filterQuery: '', dateQuery: '', cohortQuery: '', queryParams: {} }),
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    pagedRawQuery: state.clickhousePagedRawQuery,
    parseFilters: () => ({ filterQuery: '', dateQuery: '', cohortQuery: '', queryParams: {} }),
    getDateStringSQL: (column: string) => column,
  },
}));

const websiteId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const filters = {
  search: 'verified-person',
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-02T00:00:00Z'),
} as QueryFilters;

beforeEach(() => {
  state.mode = 'prisma';
  state.relationalRawQuery.mockReset().mockResolvedValue([{ sessionId }]);
  state.relationalPagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
  state.clickhousePagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s session and replay search use only verified identity links',
  async mode => {
    state.mode = mode;
    await getWebsiteSessions(websiteId, filters);
    await getSessionReplays(websiteId, filters);

    const pagedQuery =
      mode === 'prisma' ? state.relationalPagedRawQuery : state.clickhousePagedRawQuery;
    expect(pagedQuery).toHaveBeenCalledTimes(2);

    for (const [sql, params] of pagedQuery.mock.calls) {
      expect(sql).not.toMatch(/(?:session|website_event)\.distinct_id ilike/);
      expect(sql).not.toContain('positionCaseInsensitive(distinct_id');
      if (mode === 'prisma') {
        expect(sql).toContain('from session_link verified_link');
        expect(sql).toContain('verified_link.trust_tier = 1');
      } else {
        expect(sql).toContain('has({verifiedSessionIds:Array(UUID)}');
        expect(params.verifiedSessionIds).toEqual([sessionId]);
      }
      expect(sql).toContain('city');
      expect(sql).toContain('browser');
    }

    if (mode === 'clickhouse') {
      expect(state.relationalRawQuery).toHaveBeenCalledTimes(2);
      for (const [sql, params, , timeout] of state.relationalRawQuery.mock.calls) {
        expect(sql).toContain('from session_link');
        expect(sql).toContain('trust_tier = 1');
        expect(params).toMatchObject({ websiteId, search: '%verified-person%' });
        expect(timeout).toBe(5_000);
      }
    } else {
      expect(state.relationalRawQuery).not.toHaveBeenCalled();
    }
  },
);

test('ClickHouse session-scoped replay search limits identity lookup to that session', async () => {
  state.mode = 'clickhouse';
  await getSessionReplays(websiteId, filters, sessionId);

  const [sql, params] = state.relationalRawQuery.mock.lastCall;
  expect(sql).toContain('and session_id = {{sessionId::uuid}}');
  expect(params.sessionId).toBe(sessionId);
});

test('identity search fails closed rather than truncating a broad verified match', async () => {
  state.relationalRawQuery.mockResolvedValue(
    Array.from({ length: MAX_AUTH_SESSION_ROWS + 1 }, () => ({ sessionId })),
  );

  await expect(getVerifiedIdentitySearchSessions(websiteId, 'person')).rejects.toBeInstanceOf(
    IdentitySearchTooBroadError,
  );
  expect(state.relationalRawQuery.mock.lastCall?.[1].rowLimit).toBe(MAX_AUTH_SESSION_ROWS + 1);
});
