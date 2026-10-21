import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@clickhouse/client';
import { expect, test, vi } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest('ClickHouse collection deletion preserves other sites', async () => {
  const baseUrl = new URL(process.env.CLICKHOUSE_TEST_URL ?? '');
  expect(baseUrl.hostname).toBe('127.0.0.1');
  expect(baseUrl.pathname).toBe('/umami_event_series_test');

  const databaseName = `collection_delete_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const originalClickhouseUrl = process.env.CLICKHOUSE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const admin = createClient({ url: baseUrl.toString() });
  const websiteId = randomUUID();
  const otherWebsiteId = randomUUID();
  const sessionId = randomUUID();
  let databaseCreated = false;
  let fixture: ReturnType<typeof createClient> | undefined;
  let applicationClient: ReturnType<typeof createClient> | undefined;

  try {
    await admin.command({ query: `CREATE DATABASE ${databaseName}` });
    databaseCreated = true;
    fixture = createClient({ url: databaseUrl.toString() });
    process.env.CLICKHOUSE_URL = databaseUrl.toString();
    process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic';
    vi.resetModules();
    const { CLICKHOUSE_COLLECTION_TABLES, deleteClickhouseCollectionSources } = await import(
      './deleteCollectionSources'
    );

    await fixture.command({
      query: `CREATE TABLE event_data (
        website_id UUID, session_id UUID, event_id UUID,
        trust_tier UInt8, url_path String, event_name String, data_key String,
        string_value Nullable(String), number_value Nullable(Decimal(22, 4)),
        date_value Nullable(DateTime('UTC')), data_type UInt32, created_at DateTime('UTC')
      ) ENGINE = MergeTree ORDER BY (website_id, event_id, data_key)`,
    });
    for (const table of CLICKHOUSE_COLLECTION_TABLES) {
      if (table !== 'event_data' && table !== 'event_data_pivot_verified') {
        await fixture.command({
          query: `CREATE TABLE ${table} (website_id UUID, marker UInt8)
            ENGINE = MergeTree ORDER BY website_id`,
        });
      }
    }

    const migration = readFileSync(
      'db/clickhouse/migrations/20_add_verified_event_data_pivot.sql',
      'utf8',
    ).replaceAll('umami.', `${databaseName}.`);
    for (const statement of migration
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)) {
      await fixture.command({ query: statement });
    }

    for (const table of CLICKHOUSE_COLLECTION_TABLES) {
      if (table !== 'event_data' && table !== 'event_data_pivot_verified') {
        await fixture.insert({
          table,
          format: 'JSONEachRow',
          values: [
            { website_id: websiteId, marker: 1 },
            { website_id: otherWebsiteId, marker: 1 },
          ],
        });
      }
    }
    await fixture.insert({
      table: 'event_data',
      format: 'JSONEachRow',
      values: [websiteId, otherWebsiteId].map(sourceId => ({
        website_id: sourceId,
        session_id: sessionId,
        event_id: randomUUID(),
        trust_tier: 1,
        url_path: '/',
        event_name: 'synthetic',
        data_key: 'synthetic',
        string_value: 'value',
        data_type: 1,
        created_at: '2026-10-18 12:00:00',
      })),
    });

    const countRows = async (table: string, sourceId: string) => {
      const result = await fixture.query({
        query: `SELECT count() AS rows FROM ${table} WHERE website_id = {sourceId:UUID}`,
        query_params: { sourceId },
        format: 'JSONEachRow',
      });
      const [row] = await result.json<{ rows: string }>();
      return Number(row?.rows);
    };
    expect(await countRows('event_data_pivot_verified', websiteId)).toBe(1);
    expect(await countRows('event_data_pivot_verified', otherWebsiteId)).toBe(1);

    applicationClient = await (await import('@/lib/clickhouse')).default.connect();
    await deleteClickhouseCollectionSources([websiteId]);
    await deleteClickhouseCollectionSources([websiteId]);

    for (const table of CLICKHOUSE_COLLECTION_TABLES) {
      expect(await countRows(table, websiteId)).toBe(0);
      expect(await countRows(table, otherWebsiteId)).toBe(1);
    }
  } finally {
    await applicationClient?.close();
    await fixture?.close();
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
