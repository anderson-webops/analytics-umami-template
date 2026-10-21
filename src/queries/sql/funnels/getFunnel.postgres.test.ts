import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test } from 'vitest';

const integrationTest = process.env.POSTGRES_FUNNEL_TEST_URL ? test : test.skip;

integrationTest('funnel steps reject performance and unverified custom events', async () => {
  const url = new URL(process.env.POSTGRES_FUNNEL_TEST_URL ?? '');
  expect(url.hostname).toBe('127.0.0.1');
  expect(url.pathname).toBe('/umami_funnel_test');
  expect(process.env.DATABASE_URL).toBe(url.toString());
  expect(process.env.CLICKHOUSE_URL).toBeFalsy();

  const client = new Client({ connectionString: url.toString() });
  const websiteId = randomUUID();
  const validSessionId = randomUUID();
  const performanceSessionId = randomUUID();
  const unverifiedSessionId = randomUUID();
  const startDate = new Date('2026-10-21T00:00:00.000Z');
  const endDate = new Date('2026-10-22T00:00:00.000Z');

  await client.connect();

  try {
    await client.query(`CREATE TABLE website_event (
      event_id UUID NOT NULL,
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      url_path TEXT,
      event_name TEXT,
      event_type INTEGER NOT NULL,
      trust_tier SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )`);

    const insert = async (
      sessionId: string,
      minute: number,
      eventType: number,
      trustTier: number,
      urlPath: string,
      eventName: string | null = null,
    ) => {
      await client.query(
        `INSERT INTO website_event
          (event_id, website_id, session_id, url_path, event_name, event_type, trust_tier, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          websiteId,
          sessionId,
          urlPath,
          eventName,
          eventType,
          trustTier,
          new Date(`2026-10-21T12:${String(minute).padStart(2, '0')}:00.000Z`),
        ],
      );
    };

    await insert(validSessionId, 0, 1, 0, '/start');
    await insert(validSessionId, 1, 2, 1, '/start', 'purchase');
    await insert(validSessionId, 2, 1, 0, '/finish');
    await insert(performanceSessionId, 0, 5, 0, '/start');
    await insert(performanceSessionId, 1, 2, 1, '/start', 'purchase');
    await insert(performanceSessionId, 2, 5, 0, '/finish');
    await insert(unverifiedSessionId, 0, 1, 0, '/start');
    await insert(unverifiedSessionId, 1, 2, 0, '/start', 'purchase');
    await insert(unverifiedSessionId, 2, 5, 0, '/finish');

    const { getFunnel } = await import('./getFunnel');
    const run = async (steps: Array<{ type: 'path' | 'event'; value: string }>) =>
      getFunnel(websiteId, { startDate, endDate, window: 60, steps }, {});

    const pathToEvent = await run([
      { type: 'path', value: '/start' },
      { type: 'event', value: 'purchase' },
    ]);
    expect(pathToEvent.map(step => step.visitors)).toEqual([2, 1]);
    expect(pathToEvent[1].stepSequenceProvenance).toBe('includes_unverified_pageview_steps');

    const eventToPath = await run([
      { type: 'event', value: 'purchase' },
      { type: 'path', value: '/finish' },
    ]);
    expect(eventToPath.map(step => step.visitors)).toEqual([2, 1]);
    expect(eventToPath[0].stepSequenceProvenance).toBe('backend_authorized_event_steps_only');

    const pathToPath = await run([
      { type: 'path', value: '/start' },
      { type: 'path', value: '/finish' },
    ]);
    expect(pathToPath.map(step => step.visitors)).toEqual([2, 1]);
  } finally {
    await client.query('DROP TABLE IF EXISTS website_event');
    await client.end();
    const prisma = await import('@/lib/prisma');
    await prisma.default.client.$disconnect();
  }
});
