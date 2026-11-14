import { beforeEach, expect, test, vi } from 'vitest';
import { ErrorQueryLimitError, MAX_ERROR_STATUS_ISSUES } from '@/lib/errors/query-limits';
import { getErrorEvent, getErrorEvents, getErrorIssues, getErrorValues } from './query';

const mocks = vi.hoisted(() => ({
  enabled: false,
  pg: vi.fn(),
  ch: vi.fn(),
  issues: vi.fn(),
  replica: vi.fn(),
}));
vi.mock('@/lib/clickhouse', () => ({
  default: {
    get enabled() {
      return mocks.enabled;
    },
    rawQuery: mocks.ch,
  },
}));
vi.mock('@/lib/prisma', () => ({
  default: {
    rawQuery: mocks.pg,
    client: {
      $primary: () => ({ errorIssue: { findMany: mocks.issues } }),
      errorIssue: { findMany: mocks.replica },
    },
  },
}));

const WEBSITE = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const scope = { websiteId: WEBSITE, resetAt: new Date('2026-10-01T00:00:00Z') };
const filters = {
  startAt: Date.parse('2026-10-02'),
  endAt: Date.parse('2026-10-03'),
  page: 1,
  pageSize: 25,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled = false;
  mocks.issues.mockResolvedValue([{ id: ISSUE, status: 'unresolved' }]);
});

test('PostgreSQL status filters stay in the scoped database query instead of materializing every issue id', async () => {
  mocks.pg.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);
  await getErrorEvents(scope, ISSUE, { ...filters, status: 'resolved' });
  expect(mocks.issues).not.toHaveBeenCalled();
  for (const [sql, params] of mocks.pg.mock.calls) {
    expect(sql).toContain(
      'issue_id in (select issue_id from error_issue where website_id = {{websiteId::uuid}} and status = {{status}})',
    );
    expect(sql).toContain('created_at > {{resetAt}}');
    expect(params).toMatchObject({
      websiteId: WEBSITE,
      issueId: ISSUE,
      status: 'resolved',
      resetAt: scope.resetAt,
    });
  }
});

test('ClickHouse status filtering looks up only issue ids in the bounded requested range', async () => {
  mocks.enabled = true;
  mocks.ch
    .mockResolvedValueOnce([{ id: ISSUE }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ count: 0 }]);
  await getErrorEvents(scope, ISSUE, { ...filters, status: 'unresolved', search: 'Checkout' });
  const [candidateSql, candidateParams] = mocks.ch.mock.calls[0];
  expect(candidateSql).toContain(`select distinct issue_id as "id"`);
  expect(candidateSql).toContain(`limit ${MAX_ERROR_STATUS_ISSUES + 1}`);
  expect(candidateSql).toContain('issue_id = {issueId:UUID}');
  expect(candidateParams).toMatchObject({ websiteId: WEBSITE, issueId: ISSUE, search: 'checkout' });
  expect(mocks.issues).toHaveBeenCalledWith({
    where: { websiteId: WEBSITE, status: 'unresolved', id: { in: [ISSUE] } },
    select: { id: true },
    take: MAX_ERROR_STATUS_ISSUES,
  });
  expect(mocks.replica).not.toHaveBeenCalled();
  for (const [sql, params] of mocks.ch.mock.calls.slice(1)) {
    expect(sql).toContain('has({issueIds:Array(UUID)}, issue_id)');
    expect(params.issueIds).toEqual([ISSUE]);
  }
});

test('ClickHouse broad status queries fail before metadata growth or partial results', async () => {
  mocks.enabled = true;
  mocks.ch.mockResolvedValue(
    Array.from({ length: MAX_ERROR_STATUS_ISSUES + 1 }, () => ({ id: ISSUE })),
  );
  await expect(
    getErrorEvents(scope, ISSUE, { ...filters, status: 'resolved' }),
  ).rejects.toBeInstanceOf(ErrorQueryLimitError);
  expect(mocks.issues).not.toHaveBeenCalled();
  expect(mocks.ch).toHaveBeenCalledTimes(1);
});

test('empty ClickHouse candidate sets skip the relational status lookup', async () => {
  mocks.enabled = true;
  mocks.ch
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ count: 0 }]);
  const result = await getErrorEvents(scope, ISSUE, { ...filters, status: 'resolved' });
  expect(result.count).toBe(0);
  expect(mocks.issues).not.toHaveBeenCalled();
  expect(mocks.ch.mock.calls[1][1].issueIds).toEqual([]);
});

test('issue metadata uses the primary and only the returned page of tenant-scoped ids', async () => {
  mocks.pg
    .mockResolvedValueOnce([{ id: ISSUE, occurrences: 2, visits: 1 }])
    .mockResolvedValueOnce([{ count: 1 }]);
  const result = await getErrorIssues(scope, filters);
  expect(mocks.issues).toHaveBeenCalledWith({ where: { websiteId: WEBSITE, id: { in: [ISSUE] } } });
  expect(result).toMatchObject({ count: 1, data: [{ id: ISSUE, occurrences: 2, visits: 1 }] });
  expect(mocks.replica).not.toHaveBeenCalled();
});

test.each([false, true])(
  'value searches remain parameterized in ClickHouse mode %s',
  async enabled => {
    mocks.enabled = enabled;
    const run = enabled ? mocks.ch : mocks.pg;
    run.mockResolvedValue([]);
    const value = "'; DROP TABLE error_event; --";
    await getErrorValues(scope, {
      startAt: filters.startAt,
      endAt: filters.endAt,
      type: 'browser',
      value,
      browser: 'Chrome',
    });
    const [sql, params] = run.mock.calls[0];
    expect(sql).not.toContain(value);
    expect(sql).toContain('limit 100');
    expect(params.value).toBe(value.toLowerCase());
    expect(params.browser).toBeUndefined();
    expect(params.websiteId).toBe(WEBSITE);
  },
);

test.each([false, true])(
  'error-to-replay links honor website reset and replay retention in ClickHouse mode %s',
  async enabled => {
    mocks.enabled = enabled;
    const run = enabled ? mocks.ch : mocks.pg;
    const event = {
      id: EVENT,
      createdAt: '2026-10-02T12:00:00.000Z',
      sessionId: WEBSITE,
      visitId: ISSUE,
      frames: enabled ? '[]' : [],
      tags: enabled ? '{}' : {},
    };
    run.mockResolvedValueOnce([event]).mockResolvedValueOnce([{ visit_id: ISSUE }]);
    const result = await getErrorEvent(scope, ISSUE, EVENT);
    expect(result.replayId).toBe(ISSUE);
    expect(result.frames).toEqual([]);
    const [eventSql, eventParams] = run.mock.calls[0];
    expect(eventSql).toContain(
      enabled ? 'event_id = {eventId:UUID}' : 'event_id = {{eventId::uuid}}',
    );
    expect(eventParams).toMatchObject({ websiteId: WEBSITE, issueId: ISSUE, eventId: EVENT });
    const [replaySql, replayParams] = run.mock.calls[1];
    expect(replaySql).toContain(
      enabled
        ? "(retention_policy = 0 or ingested_at + INTERVAL 30 DAY > now('UTC'))"
        : '(retention_expires_at is null or retention_expires_at > CURRENT_TIMESTAMP)',
    );
    expect(replaySql).toContain(
      enabled ? 'created_at > {resetAt:DateTime64(3)}' : 'created_at > {{resetAt}}',
    );
    expect(replayParams).toMatchObject({ websiteId: WEBSITE, sessionId: WEBSITE, visitId: ISSUE });
  },
);

test('missing or expired replay lookup results leave no stale link', async () => {
  mocks.pg
    .mockResolvedValueOnce([
      {
        id: EVENT,
        createdAt: '2026-10-02',
        sessionId: WEBSITE,
        visitId: ISSUE,
        frames: [],
        tags: {},
      },
    ])
    .mockResolvedValueOnce([]);
  expect((await getErrorEvent(scope, ISSUE, EVENT)).replayId).toBeNull();
});
