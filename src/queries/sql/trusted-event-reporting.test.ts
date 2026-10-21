import { beforeEach, expect, test, vi } from 'vitest';
import { getBreakdown } from './breakdown/getBreakdown';
import { getActiveVisitors } from './getActiveVisitors';
import { getRealtimeActivity } from './getRealtimeActivity';
import { getValues } from './getValues';
import { getGoal } from './goals/getGoal';
import { getJourney } from './journeys/getJourney';
import { getRetention } from './retention/getRetention';
import { getRevenueSessions } from './revenue/getRevenueSessions';
import { getSessionActivity } from './sessions/getSessionActivity';
import { getSessionExpandedMetrics } from './sessions/getSessionExpandedMetrics';
import { getWebsiteSession } from './sessions/getWebsiteSession';
import { getWebsiteSessionStats } from './sessions/getWebsiteSessionStats';
import { getWebsiteSessions } from './sessions/getWebsiteSessions';

const { state, rawQuery, pagedRawQuery, queryClient } = vi.hoisted(() => {
  const rawQuery = vi.fn();
  const pagedRawQuery = vi.fn();

  return {
    state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
    rawQuery,
    pagedRawQuery,
    queryClient: {
      rawQuery,
      pagedRawQuery,
      parseFilters: () => ({
        queryParams: {},
        filterQuery: '',
        joinSessionQuery: '',
        cohortQuery: '',
        excludeBounceQuery: '',
        dateQuery: '',
      }),
      getTimestampDiffSQL: () => '1',
      getDateStringSQL: (column: string) => column,
      getDateSQL: (column: string) => column,
      getDayDiffQuery: () => '1',
      getCastColumnQuery: (column: string) => column,
    },
  };
});

vi.mock('@/lib/db', () => ({
  CLICKHOUSE: 'clickhouse',
  PRISMA: 'prisma',
  runQuery: (queries: Record<string, () => unknown>) => queries[state.mode](),
}));

vi.mock('@/lib/prisma', () => ({ default: queryClient }));
vi.mock('@/lib/clickhouse', () => ({ default: queryClient }));

const filters = {
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-02T00:00:00Z'),
};

beforeEach(() => {
  rawQuery.mockReset().mockResolvedValue([]);
  pagedRawQuery.mockReset().mockResolvedValue({ data: [], count: 0 });
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s conversion and journey reports reject unverified custom events',
  async mode => {
    state.mode = mode;
    await getGoal('website', { ...filters, type: 'event', value: 'checkout' }, filters);
    const goalQuery = rawQuery.mock.lastCall?.[0] as string;
    expect(goalQuery).toContain(
      mode === 'prisma' ? 'website_event.trust_tier = 1' : 'trust_tier = 1',
    );
    expect(goalQuery).toContain('event_type != 2');
    expect(goalQuery).toContain('event_type != 5');

    rawQuery.mockClear();
    await getGoal('website', { ...filters, type: 'path', value: '/checkout' }, filters);
    const pathQuery = rawQuery.mock.lastCall?.[0] as string;
    expect(pathQuery).toContain('event_type != 2');
    expect(pathQuery).not.toMatch(
      mode === 'prisma'
        ? /and url_path = \{\{value\}\}\s+and website_event\.trust_tier = 1/
        : /and url_path = \{value:String\}\s+and trust_tier = 1/,
    );

    rawQuery.mockClear();
    await getJourney('website', { ...filters, steps: 2 }, filters);
    const journeyQuery = rawQuery.mock.lastCall?.[0] as string;
    expect(journeyQuery).toContain(
      mode === 'prisma'
        ? '(website_event.event_type != 2 or website_event.trust_tier = 1)'
        : '(event_type != 2 or trust_tier = 1)',
    );
    expect(journeyQuery).toContain('event_type != 5');
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s goal results distinguish public path observations from backend-authorized events',
  async mode => {
    state.mode = mode;
    rawQuery.mockResolvedValue([{ num: 2, total: 5 }]);

    expect(
      await getGoal('website', { ...filters, type: 'path', value: '/checkout' }, filters),
    ).toEqual({
      num: 2,
      total: 5,
      numeratorProvenance: 'unverified_pageview',
      denominatorProvenance: 'may_include_unverified_traffic',
    });
    expect(
      await getGoal('website', { ...filters, type: 'event', value: 'checkout' }, filters),
    ).toEqual({
      num: 2,
      total: 5,
      numeratorProvenance: 'backend_authorized_event',
      denominatorProvenance: 'may_include_unverified_traffic',
    });
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s retention excludes unverified custom events from cohorts and returning activity',
  async mode => {
    state.mode = mode;
    await getRetention('website', filters, filters);
    const query = rawQuery.mock.lastCall?.[0] as string;
    const trustPredicate =
      mode === 'prisma'
        ? '(website_event.event_type != 2 or website_event.trust_tier = 1)'
        : '(event_type != 2 or trust_tier = 1)';

    expect(query.split(trustPredicate)).toHaveLength(mode === 'prisma' ? 3 : 2);
    expect(query.split('event_type != 5')).toHaveLength(3);
    if (mode === 'clickhouse') {
      expect(query).toContain('(website_event.event_type != 2 or website_event.trust_tier = 1)');
    }
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s active visitors count pageviews but not unverified custom events',
  async mode => {
    state.mode = mode;
    rawQuery.mockResolvedValue([{ visitors: 2 }]);
    expect(await getActiveVisitors('website')).toEqual({
      visitors: 2,
      trafficProvenance: 'may_include_unverified_public_observations',
    });
    expect(rawQuery.mock.lastCall?.[0]).toContain('(event_type != 2 or trust_tier = 1)');
    expect(rawQuery.mock.lastCall?.[0]).toContain('event_type != 5');
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s active visitors preserve an unavailable result rather than inventing provenance',
  async mode => {
    state.mode = mode;
    expect(await getActiveVisitors('website')).toBeNull();
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s activity and bounce reports preserve public pageviews but not legacy custom claims',
  async mode => {
    state.mode = mode;
    await getBreakdown('website', { ...filters, fields: ['browser'] }, filters);
    expect(rawQuery.mock.lastCall?.[0]).toContain('and trust_tier = 1');

    rawQuery.mockClear();
    await getSessionExpandedMetrics('website', { type: 'browser' }, filters);
    expect(rawQuery.mock.lastCall?.[0]).toContain('and trust_tier = 1');

    rawQuery.mockClear();
    await getRealtimeActivity('website', filters);
    expect(rawQuery.mock.lastCall?.[0]).toContain('event_type != 2');
    expect(rawQuery.mock.lastCall?.[0]).toContain('trust_tier = 1');

    rawQuery.mockClear();
    await getSessionActivity('website', ['session'], filters);
    expect(rawQuery.mock.lastCall?.[0]).toContain('trustTier');
    expect(rawQuery.mock.lastCall?.[0]).toContain('trust_tier = 1');
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s value discovery excludes unverified custom events without hiding pageviews',
  async mode => {
    state.mode = mode;

    await getValues('website', 'event_name', filters);
    const eventNameQuery = rawQuery.mock.lastCall?.[0] as string;
    expect(eventNameQuery).toContain(
      mode === 'prisma'
        ? 'website_event.event_type = 2 and website_event.trust_tier = 1'
        : 'event_type = 2 and trust_tier = 1',
    );

    rawQuery.mockClear();
    await getValues('website', 'url_path', filters);
    expect(rawQuery.mock.lastCall?.[0]).toContain(
      mode === 'prisma'
        ? '(website_event.event_type != 2 or website_event.trust_tier = 1)'
        : '(event_type != 2 or trust_tier = 1)',
    );
    expect(rawQuery.mock.lastCall?.[0]).toContain('event_type != 5');

    rawQuery.mockClear();
    await getValues('website', 'browser', filters);
    expect(rawQuery.mock.lastCall?.[0]).toContain(
      mode === 'prisma' ? 'from session' : '(event_type != 2 or trust_tier = 1)',
    );
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s session summaries count only backend-authorized custom events',
  async mode => {
    state.mode = mode;
    await getWebsiteSession('website', 'session');
    const sessionQuery = rawQuery.mock.lastCall?.[0] as string;
    expect(sessionQuery).toContain('event_type != 2');
    expect(sessionQuery).toContain('trust_tier = 1');
    expect(sessionQuery).not.toContain('distinct_id');
    expect(sessionQuery).not.toContain('distinctId');
    if (mode === 'clickhouse') {
      expect(sessionQuery).not.toContain('website_event_stats_hourly');
    }

    rawQuery.mockClear();
    await getWebsiteSessionStats('website', filters);
    const statsQuery = rawQuery.mock.lastCall?.[0] as string;
    expect(statsQuery).toContain('event_type != 2');
    expect(statsQuery).toContain('trust_tier = 1');
    if (mode === 'clickhouse') {
      expect(statsQuery).not.toContain('website_event_stats_hourly');
    }

    pagedRawQuery.mockClear();
    await getWebsiteSessions('website', filters);
    const sessionsQuery = pagedRawQuery.mock.lastCall?.[0] as string;
    expect(sessionsQuery).toContain('event_type != 2');
    expect(sessionsQuery).toContain('trust_tier = 1');
    if (mode === 'clickhouse') {
      expect(sessionsQuery).not.toContain('website_event_stats_hourly');
    }

    pagedRawQuery.mockClear();
    await getRevenueSessions('website', 'USD', filters);
    const revenueSessionsQuery = pagedRawQuery.mock.lastCall?.[0] as string;
    expect(revenueSessionsQuery).toContain(
      mode === 'prisma'
        ? 'sum(case when website_event.event_type = 2 and website_event.trust_tier = 1 then 1 else 0 end)'
        : 'sumIf(1, event_type = 2 and trust_tier = 1)',
    );
  },
);
