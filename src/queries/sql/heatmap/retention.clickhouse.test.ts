import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;
const table = 'heatmap_retention_test';

function statements(sql: string) {
  return sql
    .replaceAll('umami.heatmap_event', table)
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

integrationTest('retains legacy heatmaps while expiring only marked new rows', async () => {
  const url = process.env.CLICKHOUSE_TEST_URL;
  expect(process.env.CLICKHOUSE_URL).toBe(url);

  const client = createClient({ url });
  const legacyId = '11111111-1111-4111-8111-111111111111';
  const expiredId = '22222222-2222-4222-8222-222222222222';
  const currentId = '33333333-3333-4333-8333-333333333333';
  const websiteId = '44444444-4444-4444-8444-444444444444';
  const now = new Date();
  const oldAcceptedAt = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
  const clickhouseDate = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');
  const legacyMigration = await readFile(
    new URL('../../../../db/clickhouse/migrations/12_add_heatmap.sql', import.meta.url),
    'utf8',
  );
  const retentionMigration = await readFile(
    new URL(
      '../../../../db/clickhouse/migrations/15_expire_new_heatmap_events.sql',
      import.meta.url,
    ),
    'utf8',
  );

  try {
    for (const query of statements(legacyMigration)) {
      await client.command({ query });
    }
    await client.insert({
      table,
      format: 'JSONEachRow',
      values: [
        {
          heatmap_event_id: legacyId,
          website_id: websiteId,
          session_id: websiteId,
          visit_id: websiteId,
          url_path: '/',
          event_type: 1,
          created_at: clickhouseDate(oldAcceptedAt),
        },
      ],
    });

    for (const query of statements(retentionMigration)) {
      await client.command({ query });
    }
    await client.insert({
      table,
      format: 'JSONEachRow',
      values: [
        {
          heatmap_event_id: expiredId,
          website_id: websiteId,
          session_id: websiteId,
          visit_id: websiteId,
          url_path: '/',
          event_type: 1,
          created_at: clickhouseDate(oldAcceptedAt),
          retention_policy: 1,
          ingested_at: clickhouseDate(oldAcceptedAt),
        },
        {
          heatmap_event_id: currentId,
          website_id: websiteId,
          session_id: websiteId,
          visit_id: websiteId,
          url_path: '/',
          event_type: 1,
          created_at: clickhouseDate(oldAcceptedAt),
          retention_policy: 1,
          ingested_at: clickhouseDate(now),
        },
      ],
    });
    await client.command({ query: `OPTIMIZE TABLE ${table} FINAL` });

    const result = await client.query({
      query: `SELECT heatmap_event_id, retention_policy FROM ${table} ORDER BY heatmap_event_id`,
      format: 'JSONEachRow',
    });
    expect(await result.json()).toEqual([
      { heatmap_event_id: legacyId, retention_policy: 0 },
      { heatmap_event_id: currentId, retention_policy: 1 },
    ]);
  } finally {
    await client.command({ query: `DROP TABLE IF EXISTS ${table}` });
    await client.close();
  }
});
