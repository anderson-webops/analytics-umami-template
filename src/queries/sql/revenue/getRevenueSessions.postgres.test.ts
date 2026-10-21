import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test } from 'vitest';

const integrationTest = process.env.POSTGRES_REVENUE_TEST_URL ? test : test.skip;

integrationTest('PostgreSQL revenue sessions retain unverified historical purchases', async () => {
  const url = new URL(process.env.POSTGRES_REVENUE_TEST_URL ?? '');
  expect(url.hostname).toBe('127.0.0.1');
  expect(url.pathname).toBe('/umami_revenue_test');
  expect(process.env.DATABASE_URL).toBe(url.toString());
  expect(process.env.CLICKHOUSE_URL).toBeFalsy();

  const client = new Client({ connectionString: url.toString() });
  const websiteId = randomUUID();
  const otherWebsiteId = randomUUID();
  const historicalSessionId = randomUUID();
  const trustedSessionId = randomUUID();
  const unrelatedSessionId = randomUUID();
  const createdAt = new Date('2026-10-01T12:00:00.000Z');

  await client.connect();

  try {
    await client.query(`CREATE TABLE session (
      session_id UUID NOT NULL,
      website_id UUID NOT NULL,
      browser TEXT,
      os TEXT,
      device TEXT,
      screen TEXT,
      language TEXT,
      country TEXT,
      region TEXT,
      city TEXT
    )`);
    await client.query(`CREATE TABLE website_event (
      event_id UUID NOT NULL,
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      visit_id UUID NOT NULL,
      event_name TEXT,
      event_type INTEGER NOT NULL,
      trust_tier SMALLINT NOT NULL DEFAULT 0,
      hostname TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )`);
    await client.query(`CREATE TABLE revenue (
      revenue_id UUID NOT NULL,
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      event_id UUID NOT NULL,
      currency TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )`);

    for (const [siteId, sessionId, trustTier] of [
      [websiteId, historicalSessionId, 0],
      [websiteId, trustedSessionId, 1],
      [otherWebsiteId, unrelatedSessionId, 0],
    ] as const) {
      const eventId = randomUUID();
      await client.query('INSERT INTO session (session_id, website_id) VALUES ($1, $2)', [
        sessionId,
        siteId,
      ]);
      await client.query(
        `INSERT INTO website_event
          (event_id, website_id, session_id, visit_id, event_name, event_type, trust_tier, hostname, created_at)
         VALUES ($1, $2, $3, $4, 'purchase', 2, $5, 'example.test', $6)`,
        [eventId, siteId, sessionId, randomUUID(), trustTier, createdAt],
      );
      await client.query(
        `INSERT INTO revenue
          (revenue_id, website_id, session_id, event_id, currency, created_at)
         VALUES ($1, $2, $3, $4, 'USD', $5)`,
        [randomUUID(), siteId, sessionId, eventId, createdAt],
      );
    }

    const { getRevenueSessions } = await import('./getRevenueSessions');
    const sessions = await getRevenueSessions(websiteId, 'USD', {
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-10-02T00:00:00.000Z'),
      event: 'purchase',
      pageSize: 100,
    });

    expect(sessions.count).toBe(2);
    expect(new Set(sessions.data.map(session => session.id))).toEqual(
      new Set([historicalSessionId, trustedSessionId]),
    );
    expect(Number(sessions.data.find(session => session.id === historicalSessionId)?.events)).toBe(
      0,
    );
    expect(Number(sessions.data.find(session => session.id === trustedSessionId)?.events)).toBe(1);
  } finally {
    await client.query('DROP TABLE IF EXISTS revenue, website_event, session');
    await client.end();
    const prisma = await import('@/lib/prisma');
    await prisma.default.client.$disconnect();
  }
});
