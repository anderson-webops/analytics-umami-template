import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import { getValues } from '../getValues';
import { getSessionExpandedMetrics } from './getSessionExpandedMetrics';
import { getSessionMetrics } from './getSessionMetrics';

vi.hoisted(() => {
  if (process.env.SYNTHETIC_CROSS_STORE_TEST !== '1') {
    process.env.DATABASE_URL ??=
      'postgresql://synthetic:synthetic@127.0.0.1:1/identity_projection_test?schema=public';
  }
});

const integrationTest = process.env.SYNTHETIC_CROSS_STORE_TEST === '1' ? test : test.skip;

integrationTest('ClickHouse identity reports project only verified PostgreSQL links', async () => {
  const postgresUrl = new URL(process.env.DATABASE_URL ?? '');
  const clickhouseUrl = new URL(process.env.CLICKHOUSE_TEST_URL ?? '');

  expect(['127.0.0.1', 'localhost']).toContain(postgresUrl.hostname);
  expect(['127.0.0.1', 'localhost']).toContain(clickhouseUrl.hostname);
  expect(postgresUrl.pathname).toBe('/identity_projection_test');
  expect(clickhouseUrl.pathname).toBe('/identity_projection_test');
  expect(process.env.CLICKHOUSE_URL).toBe(clickhouseUrl.toString());

  const postgres = new Pool({ connectionString: postgresUrl.toString() });
  const clickhouse = createClient({ url: clickhouseUrl.toString() });
  const websiteId = randomUUID();
  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  const firstVisitId = randomUUID();
  const secondVisitId = randomUUID();
  const thirdVisitId = randomUUID();
  let postgresTableCreated = false;
  let clickhouseTableCreated = false;

  try {
    await postgres.query(`create table session_link (
      website_id uuid not null,
      session_id uuid not null,
      distinct_id text not null,
      trust_tier smallint not null
    )`);
    postgresTableCreated = true;
    await clickhouse.command({
      query: `create table website_event (
        website_id UUID,
        session_id UUID,
        visit_id UUID,
        distinct_id String,
        event_type UInt32,
        trust_tier UInt8,
        is_bot UInt8,
        created_at DateTime('UTC')
      ) engine = MergeTree order by (website_id, session_id, visit_id, created_at)`,
    });
    clickhouseTableCreated = true;

    await postgres.query(
      `insert into session_link (website_id, session_id, distinct_id, trust_tier)
       values ($1, $2, 'trusted', 1), ($1, $3, 'trusted', 1),
         ($1, $2, 'another', 1), ($1, $2, 'forged', 0)`,
      [websiteId, firstSessionId, secondSessionId],
    );
    const event = {
      website_id: websiteId,
      distinct_id: 'forged',
      trust_tier: 0,
      is_bot: 0,
      created_at: '2026-10-17 00:00:00',
    };
    await clickhouse.insert({
      table: 'website_event',
      format: 'JSONEachRow',
      values: [
        { ...event, session_id: firstSessionId, visit_id: firstVisitId, event_type: 1 },
        { ...event, session_id: firstSessionId, visit_id: firstVisitId, event_type: 1 },
        { ...event, session_id: firstSessionId, visit_id: secondVisitId, event_type: 1 },
        {
          ...event,
          session_id: firstSessionId,
          visit_id: secondVisitId,
          event_type: 2,
          trust_tier: 1,
        },
        { ...event, session_id: secondSessionId, visit_id: thirdVisitId, event_type: 1 },
      ],
    });

    const filters = {
      startDate: new Date('2026-10-16T00:00:00Z'),
      endDate: new Date('2026-10-18T00:00:00Z'),
      unit: 'day',
    };
    const values = await getValues(websiteId, 'distinct_id', filters);
    const metrics = await getSessionMetrics(websiteId, { type: 'distinctId' }, filters);
    const expanded = await getSessionExpandedMetrics(websiteId, { type: 'distinctId' }, filters);

    expect(values).toEqual([
      { value: 'trusted', count: 5 },
      { value: 'another', count: 4 },
    ]);
    expect(metrics).toEqual([
      { x: 'trusted', y: 2 },
      { x: 'another', y: 1 },
    ]);
    expect(expanded).toEqual([
      { name: 'trusted', pageviews: 4, visitors: 2, visits: 3, bounces: 1, totaltime: 0 },
      { name: 'another', pageviews: 3, visitors: 1, visits: 2, bounces: 0, totaltime: 0 },
    ]);
    expect(JSON.stringify({ values, metrics, expanded })).not.toContain('forged');
    expect(await getValues(websiteId, 'distinct_id', { ...filters, search: 'forged' })).toEqual([]);
    expect(
      await getSessionMetrics(
        websiteId,
        { type: 'distinctId' },
        {
          ...filters,
          distinctId: 'c.forged',
        },
      ),
    ).toEqual([]);
    expect(
      await getSessionExpandedMetrics(
        websiteId,
        { type: 'distinctId' },
        {
          ...filters,
          distinctId: 'c.trusted',
        },
      ),
    ).toEqual([
      { name: 'trusted', pageviews: 4, visitors: 2, visits: 3, bounces: 1, totaltime: 0 },
      { name: 'another', pageviews: 3, visitors: 1, visits: 2, bounces: 0, totaltime: 0 },
    ]);
  } finally {
    if (clickhouseTableCreated) {
      await clickhouse.command({ query: 'drop table website_event' });
    }
    if (postgresTableCreated) {
      await postgres.query('drop table session_link');
    }
    await clickhouse.close();
    await postgres.end();
  }
});
