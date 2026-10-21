import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { expect, test, vi } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest('ClickHouse funnels reject invalid step events', async () => {
  const baseUrl = new URL(process.env.CLICKHOUSE_TEST_URL ?? '');
  expect(baseUrl.hostname).toBe('127.0.0.1');

  const databaseName = `funnel_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const originalClickhouseUrl = process.env.CLICKHOUSE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const admin = createClient({ url: baseUrl.toString() });
  const websiteId = randomUUID();
  const validSessionId = randomUUID();
  const performanceSessionId = randomUUID();
  const unverifiedSessionId = randomUUID();
  const startDate = new Date('2026-10-21T00:00:00.000Z');
  const endDate = new Date('2026-10-22T00:00:00.000Z');
  let databaseCreated = false;
  let applicationClient: ReturnType<typeof createClient> | undefined;

  try {
    await admin.command({ query: `CREATE DATABASE ${databaseName}` });
    databaseCreated = true;

    const fixture = createClient({ url: databaseUrl.toString() });
    try {
      await fixture.command({
        query: `CREATE TABLE website_event (
          event_id UUID,
          website_id UUID,
          session_id UUID,
          url_path String,
          referrer_path String,
          event_name String,
          event_type UInt32,
          trust_tier UInt8,
          is_bot UInt8,
          created_at DateTime64(3, 'UTC')
        ) ENGINE = MergeTree ORDER BY (website_id, session_id, created_at, event_id)`,
      });

      const records = [
        [validSessionId, 0, 1, 0, '/start', ''],
        [validSessionId, 1, 2, 1, '/start', 'purchase'],
        [validSessionId, 2, 1, 0, '/finish', ''],
        [performanceSessionId, 0, 5, 0, '/start', ''],
        [performanceSessionId, 1, 2, 1, '/start', 'purchase'],
        [performanceSessionId, 2, 5, 0, '/finish', ''],
        [unverifiedSessionId, 0, 1, 0, '/start', ''],
        [unverifiedSessionId, 1, 2, 0, '/start', 'purchase'],
        [unverifiedSessionId, 2, 5, 0, '/finish', ''],
      ] as const;

      await fixture.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: records.map(([sessionId, minute, eventType, trustTier, urlPath, eventName]) => ({
          event_id: randomUUID(),
          website_id: websiteId,
          session_id: sessionId,
          url_path: urlPath,
          referrer_path: '',
          event_name: eventName,
          event_type: eventType,
          trust_tier: trustTier,
          is_bot: 0,
          created_at: `2026-10-21 12:${String(minute).padStart(2, '0')}:00.000`,
        })),
      });
    } finally {
      await fixture.close();
    }

    process.env.CLICKHOUSE_URL = databaseUrl.toString();
    process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic';
    vi.resetModules();
    const { getFunnel } = await import('./getFunnel');
    const clickhouse = (await import('@/lib/clickhouse')).default;
    applicationClient = await clickhouse.connect();

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
