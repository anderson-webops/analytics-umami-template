import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { expect, test, vi } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_REVENUE_TEST_URL ? test : test.skip;

integrationTest('ClickHouse revenue sessions retain historical purchases', async () => {
  const baseUrl = new URL(process.env.CLICKHOUSE_REVENUE_TEST_URL ?? '');
  expect(['127.0.0.1', 'localhost']).toContain(baseUrl.hostname);

  const databaseName = `revenue_sessions_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const originalClickhouseUrl = process.env.CLICKHOUSE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const admin = createClient({ url: baseUrl.toString() });
  const websiteId = randomUUID();
  const otherWebsiteId = randomUUID();
  const historicalSessionId = randomUUID();
  const trustedSessionId = randomUUID();
  const unrelatedSessionId = randomUUID();
  const createdAt = '2026-10-01 12:00:00';
  let databaseCreated = false;
  let applicationClient: ReturnType<typeof createClient> | undefined;

  try {
    await admin.command({ query: `CREATE DATABASE ${databaseName}` });
    databaseCreated = true;

    const fixture = createClient({ url: databaseUrl.toString() });
    try {
      await fixture.command({
        query: `CREATE TABLE website_event (
          website_id UUID, session_id UUID, visit_id UUID, event_type UInt32,
          trust_tier UInt8, is_bot UInt8, hostname String, browser String, os String,
          device String, screen String, language String, country String,
          region String, city String, created_at DateTime('UTC')
        ) ENGINE = MergeTree ORDER BY (website_id, session_id, visit_id, created_at)`,
      });
      await fixture.command({
        query: `CREATE TABLE website_revenue (
          website_id UUID, session_id UUID, currency String,
          created_at DateTime('UTC')
        ) ENGINE = MergeTree ORDER BY (website_id, session_id, created_at)`,
      });

      const records = [
        [websiteId, historicalSessionId, 0],
        [websiteId, trustedSessionId, 1],
        [otherWebsiteId, unrelatedSessionId, 0],
      ] as const;
      await fixture.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: records.map(([siteId, sessionId, trustTier]) => ({
          website_id: siteId,
          session_id: sessionId,
          visit_id: randomUUID(),
          event_type: 2,
          trust_tier: trustTier,
          is_bot: 0,
          hostname: 'example.test',
          browser: '',
          os: '',
          device: '',
          screen: '',
          language: '',
          country: '',
          region: '',
          city: '',
          created_at: createdAt,
        })),
      });
      await fixture.insert({
        table: 'website_revenue',
        format: 'JSONEachRow',
        values: records.map(([siteId, sessionId]) => ({
          website_id: siteId,
          session_id: sessionId,
          currency: 'USD',
          created_at: createdAt,
        })),
      });
    } finally {
      await fixture.close();
    }

    process.env.CLICKHOUSE_URL = databaseUrl.toString();
    process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic';
    vi.resetModules();
    const { getRevenueSessions } = await import('./getRevenueSessions');
    const clickhouse = (await import('@/lib/clickhouse')).default;
    applicationClient = await clickhouse.connect();
    const sessions = await getRevenueSessions(websiteId, 'USD', {
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-02T00:00:00Z'),
      pageSize: 100,
    });
    expect(Number(sessions.count)).toBe(2);
    expect(new Set(sessions.data.map(session => session.id))).toEqual(
      new Set([historicalSessionId, trustedSessionId]),
    );
    expect(Number(sessions.data.find(session => session.id === historicalSessionId)?.events)).toBe(
      0,
    );
    expect(Number(sessions.data.find(session => session.id === trustedSessionId)?.events)).toBe(1);
  } finally {
    await applicationClient?.close();
    if (databaseCreated) {
      await admin.command({ query: `DROP DATABASE ${databaseName}` });
    }
    await admin.close();
    if (originalClickhouseUrl === undefined) {
      delete process.env.CLICKHOUSE_URL;
    } else {
      process.env.CLICKHOUSE_URL = originalClickhouseUrl;
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    vi.resetModules();
  }
});
