import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getWebsiteSession } from './getWebsiteSession';

const mocks = vi.hoisted(() => ({ backend: 'prisma', rawQuery: vi.fn() }));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => Promise<unknown>>) => queries[mocks.backend](),
}));
vi.mock('@/lib/prisma', () => ({
  default: { rawQuery: mocks.rawQuery, getTimestampDiffSQL: () => 'time_difference' },
}));
vi.mock('@/lib/clickhouse', () => ({
  default: { rawQuery: mocks.rawQuery, getDateStringSQL: (value: string) => value },
}));

describe.each(['prisma', 'clickhouse'])('%s session summary scope', backend => {
  beforeEach(() => {
    mocks.backend = backend;
    mocks.rawQuery.mockReset().mockResolvedValue([{ id: 'session-1', isBot: true }]);
  });

  test('preserves the tenant and session at every referrer lookup', async () => {
    await getWebsiteSession('website-1', 'session-1');
    const [query, parameters] = mocks.rawQuery.mock.calls[0];
    expect(parameters).toEqual({ websiteId: 'website-1', sessionId: 'session-1' });
    expect(query).toContain('first_event.website_id =');
    expect(query).toContain('first_event.session_id =');
    expect(query).toContain('first_event.event_type != 5');
    expect(query).toContain('first_event.event_type != 2');
    expect(query).toContain('first_event.trust_tier = 1');
    expect(query).not.toContain('distinct_id');
  });

  test('selects a deterministic first external referrer', async () => {
    await getWebsiteSession('website-1', 'session-1');
    const [query] = mocks.rawQuery.mock.calls[0];
    expect(query).toContain("first_event.referrer_domain != ''");
    expect(query).toContain('first_event.hostname');
    expect(query).toContain(
      backend === 'prisma'
        ? 'order by first_event.created_at, first_event.event_id'
        : 'argMin(first_event.referrer_domain, (first_event.created_at, first_event.event_id))',
    );
  });

  test('retains bot metadata while executing one scoped summary query', async () => {
    await expect(getWebsiteSession('website-1', 'session-1')).resolves.toMatchObject({
      isBot: true,
    });
    expect(mocks.rawQuery).toHaveBeenCalledTimes(1);
    const [query] = mocks.rawQuery.mock.calls[0];
    expect(query).toContain('botName');
    expect(query).toContain('botCategory');
    expect(query).toContain('trust_tier = 1');
  });
});
