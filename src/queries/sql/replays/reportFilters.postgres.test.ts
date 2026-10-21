import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test, vi } from 'vitest';

const integrationTest = process.env.POSTGRES_REPORT_FILTER_TEST_URL ? test : test.skip;

integrationTest('report filters reject unverified custom events', async () => {
  const testUrl = new URL(process.env.POSTGRES_REPORT_FILTER_TEST_URL ?? '');
  expect(testUrl.protocol).toBe('postgres:');
  expect(['/umami_replay_test', '/umami_event_series_test']).toContain(testUrl.pathname);
  expect(['localhost', '127.0.0.1']).toContain(testUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(testUrl.toString());
  expect(process.env.CLICKHOUSE_URL).toBeFalsy();

  const client = new Client({ connectionString: testUrl.toString() });
  const schema = `report_filter_${randomUUID().replaceAll('-', '')}`;
  const websiteId = randomUUID();
  const createdAt = new Date('2026-10-21T12:00:00Z');
  const filters = {
    startDate: new Date('2026-10-21T00:00:00Z'),
    endDate: new Date('2026-10-22T00:00:00Z'),
    pageSize: 100,
  };
  const recordings = [
    {
      sessionId: randomUUID(),
      visitId: randomUUID(),
      eventType: 2,
      trustTier: 0,
      path: '/purchase',
    },
    {
      sessionId: randomUUID(),
      visitId: randomUUID(),
      eventType: 2,
      trustTier: 1,
      path: '/purchase',
    },
    {
      sessionId: randomUUID(),
      visitId: randomUUID(),
      eventType: 1,
      trustTier: 0,
      path: '/public',
    },
  ];

  await client.connect();
  let schemaCreated = false;

  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE session (
      session_id UUID NOT NULL,
      website_id UUID NOT NULL,
      browser TEXT,
      os TEXT,
      device TEXT,
      country TEXT,
      city TEXT
    )`);
    await client.query(`CREATE TABLE website_event (
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      visit_id UUID NOT NULL,
      event_type INTEGER NOT NULL,
      trust_tier SMALLINT NOT NULL,
      event_name TEXT,
      url_path TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )`);
    await client.query(`CREATE TABLE session_replay (
      replay_id UUID NOT NULL,
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      visit_id UUID NOT NULL,
      event_count INTEGER NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      retention_expires_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE heatmap_event (
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      visit_id UUID NOT NULL,
      event_type INTEGER NOT NULL,
      url_path TEXT NOT NULL,
      x INTEGER,
      y INTEGER,
      page_x INTEGER,
      page_y INTEGER,
      page_w INTEGER,
      page_h INTEGER,
      viewport_w INTEGER,
      viewport_h INTEGER,
      created_at TIMESTAMPTZ NOT NULL,
      retention_expires_at TIMESTAMPTZ
    )`);

    for (const recording of recordings) {
      const { sessionId, visitId, eventType, trustTier, path } = recording;
      await client.query('INSERT INTO session (session_id, website_id) VALUES ($1, $2)', [
        sessionId,
        websiteId,
      ]);
      await client.query(
        `INSERT INTO website_event
          (website_id, session_id, visit_id, event_type, trust_tier, event_name, url_path, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          websiteId,
          sessionId,
          visitId,
          eventType,
          trustTier,
          eventType === 2 ? 'purchase' : null,
          path,
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO session_replay
          (replay_id, website_id, session_id, visit_id, event_count, started_at, ended_at, created_at)
         VALUES ($1, $2, $3, $4, 1, $5, $5, $5)`,
        [randomUUID(), websiteId, sessionId, visitId, createdAt],
      );
      await client.query(
        `INSERT INTO heatmap_event
          (website_id, session_id, visit_id, event_type, url_path, x, y, page_x, page_y,
           page_w, page_h, viewport_w, viewport_h, created_at)
         VALUES ($1, $2, $3, 1, $4, 20, 20, 20, 20, 1000, 1000, 1000, 800, $5)`,
        [websiteId, sessionId, visitId, path, createdAt],
      );
    }

    const scopedUrl = new URL(testUrl);
    scopedUrl.searchParams.set('schema', schema);
    vi.stubEnv('DATABASE_URL', scopedUrl.toString());

    const { getSessionReplays } = await import('./getSessionReplays');
    const { getHeatmap } = await import('../heatmap/getHeatmap');
    const allReplays = await getSessionReplays(websiteId, filters);
    const purchaseReplays = await getSessionReplays(websiteId, { ...filters, event: 'purchase' });
    const publicReplays = await getSessionReplays(websiteId, { ...filters, path: '/public' });
    const purchaseHeatmap = await getHeatmap(websiteId, {
      ...filters,
      event: 'purchase',
      mode: 'click',
    });
    const publicHeatmap = await getHeatmap(websiteId, {
      ...filters,
      path: '/public',
      mode: 'click',
    });

    expect(allReplays.count).toBe(3);
    expect(purchaseReplays.data.map(replay => replay.sessionId)).toEqual([recordings[1].sessionId]);
    expect(publicReplays.data.map(replay => replay.sessionId)).toEqual([recordings[2].sessionId]);
    expect(purchaseHeatmap.pages).toEqual([{ urlPath: '/purchase', count: 1, sessions: 1 }]);
    expect(publicHeatmap.pages).toEqual([{ urlPath: '/public', count: 1, sessions: 1 }]);
  } finally {
    vi.unstubAllEnvs();
    const prisma = await import('@/lib/prisma');
    await prisma.default.client.$disconnect();
    if (schemaCreated) {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await client.end();
  }
});
