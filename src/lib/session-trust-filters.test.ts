import { beforeAll, expect, test } from 'vitest';
import { DATA_TYPE, OPERATORS } from './constants';

const filter = {
  propertyName: 'plan',
  dataType: DATA_TYPE.string,
  operator: OPERATORS.equals,
  value: 'pro',
};

let prisma: typeof import('./prisma').default;
let clickhouse: typeof import('./clickhouse').default;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic';
  ({ default: prisma } = await import('./prisma'));
  ({ default: clickhouse } = await import('./clickhouse'));
});

test.each(['prisma', 'clickhouse'] as const)(
  '%s property filters use backend-authorized session rows only',
  backend => {
    const client = backend === 'prisma' ? prisma : clickhouse;
    const sessionFilter = client.getPropertyFilterQuery([filter], 'session');
    const eventFilter = client.getPropertyFilterQuery([filter], 'event');
    const parsed = client.parseFilters({
      websiteId: '4a147eee-7e6d-4d73-b4a0-f50d06a50000',
      sessionPropertyFilters: [filter],
    });

    expect(sessionFilter.sql).toContain('trust_tier = 1');
    expect(parsed.filterQuery).toContain('trust_tier = 1');
    expect(eventFilter.sql).toContain('trust_tier = 1');
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s identity filters do not read historical session identity fields',
  backend => {
    const client = backend === 'prisma' ? prisma : clickhouse;
    const parsed = client.parseFilters({
      websiteId: '4a147eee-7e6d-4d73-b4a0-f50d06a50000',
      distinctId: 'eq.verified',
      distinctId1: 'neq.other',
      match: 'any',
      cohort_distinctId: 'c.verified',
      cohort_startDate: new Date('2026-01-01T00:00:00Z'),
      cohort_endDate: new Date('2026-01-02T00:00:00Z'),
    });

    expect(parsed.filterQuery).not.toMatch(/(?:session|website_event)\.distinct_id/);
    expect(parsed.cohortQuery).not.toMatch(/(?:session|website_event)\.distinct_id/);
    if (backend === 'prisma') {
      expect(parsed.filterQuery).toContain('from session_link verified_link');
      expect(parsed.cohortQuery).toContain('from session_link verified_link');
      expect(parsed.filterQuery).toContain('verified_link.trust_tier = 1');
    } else {
      expect(parsed.filterQuery).toContain('verifiedIdentitySessions_distinctId');
      expect(parsed.filterQuery).toContain('verifiedIdentitySessions_distinctId1');
      expect(parsed.cohortQuery).toContain('verifiedIdentitySessions_cohort_distinctId');
    }
  },
);

test.each(['prisma', 'clickhouse'] as const)(
  '%s saved cohorts exclude unverified custom events without dropping pageviews',
  backend => {
    const client = backend === 'prisma' ? prisma : clickhouse;
    const parsed = client.parseFilters({
      websiteId: '4a147eee-7e6d-4d73-b4a0-f50d06a50000',
      cohort_event: 'eq.signup',
      cohort_path: 'eq./welcome',
      cohort_match: 'any',
      cohort_actionName: 'cohort_event',
      cohort_startDate: new Date('2026-01-01T00:00:00Z'),
      cohort_endDate: new Date('2026-01-02T00:00:00Z'),
    });

    const eventType = backend === 'prisma' ? 'website_event.event_type' : 'event_type';
    const trustTier = backend === 'prisma' ? 'website_event.trust_tier' : 'trust_tier';
    expect(parsed.cohortQuery).toContain(`and (${eventType} != 2 or ${trustTier} = 1)`);
    expect(parsed.cohortQuery.indexOf(`and (${eventType} != 2 or ${trustTier} = 1)`)).toBeLessThan(
      parsed.cohortQuery.indexOf('and (\n'),
    );
    expect(parsed.cohortQuery).toContain('cohort_event');
  },
);
