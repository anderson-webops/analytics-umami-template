import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { LINKED_QUERY_TIMEOUT_MS, MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';
import { getReplayDistinctIds } from './getReplayDistinctIds';

const state = vi.hoisted(() => ({
  backend: 'prisma',
  prismaRawQuery: vi.fn(),
  clickhouseRawQuery: vi.fn(),
  getWebsite: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ default: { rawQuery: state.prismaRawQuery } }));
vi.mock('@/lib/clickhouse', () => ({
  default: { rawQuery: state.clickhouseRawQuery },
  isClickHouseDiscoveryLimitError: (error: { code?: string }) => error?.code === '158',
}));
vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => unknown>) => queries[state.backend](),
}));
vi.mock('@/queries/prisma/website', () => ({ getWebsite: state.getWebsite }));

const websiteId = randomUUID();
const firstVisit = randomUUID();
const secondVisit = randomUUID();
const firstSession = randomUUID();
const secondSession = randomUUID();
const filters = { startDate: new Date('2026-10-01'), endDate: new Date('2026-11-14') };
const replayRows = [
  { visitId: firstVisit, sessionId: firstSession, distinctId: 'forged' },
  { visitId: secondVisit, sessionId: secondSession, distinctId: 'legacy' },
];
const links = [
  { sessionId: firstSession, distinctId: 'user-b' },
  { sessionId: firstSession, distinctId: 'user-a' },
  { sessionId: firstSession, distinctId: 'user-a' },
];

beforeEach(() => {
  state.backend = 'prisma';
  vi.resetAllMocks();
  state.getWebsite.mockResolvedValue({ id: websiteId, resetAt: new Date('2026-11-01') });
  state.prismaRawQuery.mockImplementation(async (_sql, _params, name) =>
    name === 'getReplayDistinctIds' ? replayRows : links,
  );
  state.clickhouseRawQuery.mockResolvedValue(replayRows);
});

describe.each(['prisma', 'clickhouse'])('%s replay identity projection', backend => {
  test('projects sorted unique verified links without legacy or unverified fallback', async () => {
    state.backend = backend;
    expect(await getReplayDistinctIds(websiteId, [firstVisit, secondVisit], filters)).toEqual({
      [firstVisit]: ['user-a', 'user-b'],
      [secondVisit]: [],
    });
    const identityQuery = state.prismaRawQuery.mock.calls.find(
      call => call[2] === 'getVerifiedIdentityLinks',
    );
    expect(identityQuery[0]).toContain('trust_tier = 1');
    expect(identityQuery[0]).toContain('website_id = {{websiteId::uuid}}');
    expect(identityQuery[1]).toMatchObject({
      websiteId,
      sessionIds: [firstSession, secondSession],
    });
    expect(identityQuery[3]).toBe(LINKED_QUERY_TIMEOUT_MS);
  });

  test('scopes discovery to retained replay rows, requested visits and the current reset', async () => {
    state.backend = backend;
    await getReplayDistinctIds(websiteId, [firstVisit, firstVisit, secondVisit], filters);
    const [sql, params, , limits] =
      backend === 'prisma'
        ? state.prismaRawQuery.mock.calls[0]
        : state.clickhouseRawQuery.mock.calls[0];
    expect(params).toMatchObject({
      websiteId,
      visitIds: [firstVisit, secondVisit],
      startDate: new Date('2026-11-01'),
      endDate: filters.endDate,
      rowLimit: MAX_AUTH_SESSION_ROWS + 1,
    });
    expect(sql).toContain('from session_replay');
    expect(sql).toContain('created_at between');
    expect(sql).not.toContain('distinct_id');
    expect(sql).toContain(
      backend === 'prisma'
        ? 'retention_expires_at is null or retention_expires_at > CURRENT_TIMESTAMP'
        : "retention_policy = 0 or ingested_at + INTERVAL 30 DAY > now('UTC')",
    );
    if (backend === 'prisma') expect(limits).toBe(LINKED_QUERY_TIMEOUT_MS);
    else
      expect(limits).toMatchObject({
        maxThreads: 1,
        maxResultRows: MAX_AUTH_SESSION_ROWS + 1,
        maxRowsToGroupBy: MAX_AUTH_SESSION_ROWS + 1,
      });
  });

  test('rejects over-budget replay rows rather than returning partial identities', async () => {
    state.backend = backend;
    const rows = Array.from({ length: MAX_AUTH_SESSION_ROWS + 1 }, () => replayRows[0]);
    if (backend === 'prisma') state.prismaRawQuery.mockResolvedValue(rows);
    else state.clickhouseRawQuery.mockResolvedValue(rows);
    await expect(getReplayDistinctIds(websiteId, [firstVisit])).rejects.toBeInstanceOf(
      IdentitySearchTooBroadError,
    );
    expect(
      state.prismaRawQuery.mock.calls.filter(call => call[2] === 'getVerifiedIdentityLinks'),
    ).toHaveLength(0);
  });

  test('rejects excessive verified links rather than truncating their labels', async () => {
    state.backend = backend;
    state.prismaRawQuery.mockImplementation(async (_sql, _params, name) =>
      name === 'getReplayDistinctIds'
        ? replayRows
        : Array.from({ length: MAX_AUTH_SESSION_ROWS + 1 }, () => links[0]),
    );
    await expect(getReplayDistinctIds(websiteId, [firstVisit])).rejects.toBeInstanceOf(
      IdentitySearchTooBroadError,
    );
  });
});

test('empty pages perform no metadata or storage reads', async () => {
  expect(await getReplayDistinctIds(websiteId, [])).toEqual({});
  expect(state.getWebsite).not.toHaveBeenCalled();
  expect(state.prismaRawQuery).not.toHaveBeenCalled();
  expect(state.clickhouseRawQuery).not.toHaveBeenCalled();
});

test('invalid and over-budget input fails before metadata or database work', async () => {
  await expect(getReplayDistinctIds('invalid', [firstVisit])).rejects.toThrow(
    'INVALID_REPLAY_IDENTIFIER',
  );
  await expect(getReplayDistinctIds(websiteId, ['invalid'])).rejects.toThrow(
    'INVALID_REPLAY_IDENTIFIER',
  );
  await expect(
    getReplayDistinctIds(websiteId, Array(MAX_AUTH_SESSION_ROWS + 1).fill(firstVisit)),
  ).rejects.toBeInstanceOf(IdentitySearchTooBroadError);
  expect(state.getWebsite).not.toHaveBeenCalled();
  expect(state.prismaRawQuery).not.toHaveBeenCalled();
});

test('deleted sources and reset windows after the requested end expose no labels', async () => {
  state.getWebsite
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ resetAt: new Date('2026-11-15') });
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await getReplayDistinctIds(websiteId, [firstVisit], filters)).toEqual({
      [firstVisit]: [],
    });
  }
  expect(state.prismaRawQuery).not.toHaveBeenCalled();
});

test('saved replays retain reset and expiry bounds without a supplied date range', async () => {
  await getReplayDistinctIds(websiteId, [firstVisit]);
  expect(state.prismaRawQuery.mock.calls[0][1]).toMatchObject({
    startDate: new Date('2026-11-01'),
  });
});

test('invalid stored reset dates fail closed', async () => {
  state.getWebsite.mockResolvedValue({ resetAt: 'invalid' });
  await expect(getReplayDistinctIds(websiteId, [firstVisit])).rejects.toThrow(
    'INVALID_REPLAY_DATE_RANGE',
  );
  expect(state.prismaRawQuery).not.toHaveBeenCalled();
});

test('database errors propagate and ClickHouse read limits become bounded-query errors', async () => {
  state.prismaRawQuery.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(getReplayDistinctIds(websiteId, [firstVisit])).rejects.toThrow(
    'database unavailable',
  );
  state.backend = 'clickhouse';
  state.clickhouseRawQuery.mockRejectedValue({ code: '158' });
  await expect(getReplayDistinctIds(websiteId, [firstVisit])).rejects.toBeInstanceOf(
    IdentitySearchTooBroadError,
  );
});
