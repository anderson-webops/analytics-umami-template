import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';

const migrationPath = 'db/clickhouse/migrations/18_disable_unverified_revenue_materialization.sql';
const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

test('fresh and upgraded schemas preserve revenue history without automatic materialization', async () => {
  const schema = await readFile('db/clickhouse/schema.sql', 'utf8');
  const migration = await readFile(migrationPath, 'utf8');

  expect(schema).toContain('CREATE TABLE umami.website_revenue');
  expect(schema).not.toContain('CREATE MATERIALIZED VIEW umami.website_revenue_mv');
  expect(migration.trim()).toBe('DROP TABLE IF EXISTS umami.website_revenue_mv;');
});

async function verifyRevenueViewMigration() {
  const client = createClient({ url: process.env.CLICKHOUSE_TEST_URL });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const source = `revenue_source_${suffix}`;
  const target = `revenue_target_${suffix}`;
  const view = `revenue_view_${suffix}`;
  const websiteId = randomUUID();
  const otherWebsiteId = randomUUID();
  const sessionId = randomUUID();
  const legacyEventId = randomUUID();
  const nestedEventId = randomUUID();
  const renamedEventId = randomUUID();
  const crossSiteEventId = randomUUID();
  const validEventId = randomUUID();
  const sameBlockEventId = randomUUID();
  const createdAt = '2026-10-17 00:00:00';

  const insertData = (eventId: string, dataKey: string, website = websiteId) => ({
    website_id: website,
    session_id: sessionId,
    event_id: eventId,
    event_name: 'order',
    data_key: dataKey,
    string_value: /currency$/i.test(dataKey) ? 'USD' : null,
    number_value: /revenue$/i.test(dataKey) ? 12.34 : null,
    created_at: createdAt,
  });
  const revenueIds = async () => {
    const result = await client.query({
      query: `SELECT event_id FROM ${target} ORDER BY event_id`,
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ event_id: string }>();
    return rows.map(row => row.event_id);
  };
  const directRevenueCount = async () => {
    const result = await client.query({
      query: `SELECT count() AS count FROM ${source} ed JOIN (SELECT website_id, event_id FROM ${source} WHERE data_key = 'currency') c ON c.website_id = ed.website_id AND c.event_id = ed.event_id WHERE ed.data_key = 'revenue'`,
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ count: string }>();
    return Number(row?.count);
  };
  const viewCount = async () => {
    const result = await client.query({
      query:
        'SELECT count() AS count FROM system.tables WHERE database = currentDatabase() AND name = {view:String}',
      query_params: { view },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ count: string }>();
    return Number(row?.count);
  };

  try {
    await client.command({
      query: `CREATE TABLE ${source} (website_id UUID, session_id UUID, event_id UUID, event_name String, data_key String, string_value Nullable(String), number_value Nullable(Decimal(22, 4)), created_at DateTime('UTC')) ENGINE = MergeTree ORDER BY (website_id, event_id, data_key)`,
    });
    await client.command({
      query: `CREATE TABLE ${target} (website_id UUID, session_id UUID, event_id UUID, event_name String, currency String, revenue Decimal(18, 4), created_at DateTime('UTC')) ENGINE = MergeTree ORDER BY (website_id, event_id)`,
    });
    await client.command({
      query: `CREATE MATERIALIZED VIEW ${view} TO ${target} AS SELECT website_id, session_id, event_id, event_name, 'USD' AS currency, toDecimal64(1, 2) AS revenue, created_at FROM ${source} WHERE data_key = 'unused'`,
    });
    expect(await viewCount()).toBe(1);
    await client.insert({
      table: target,
      format: 'JSONEachRow',
      values: [
        {
          website_id: websiteId,
          session_id: sessionId,
          event_id: legacyEventId,
          event_name: 'legacy',
          currency: 'USD',
          revenue: 1,
          created_at: createdAt,
        },
      ],
    });

    const migration = await readFile(migrationPath, 'utf8');
    const statement = migration
      .replaceAll('umami.website_revenue_mv', view)
      .trim()
      .replace(/;$/, '');
    await client.command({ query: statement });
    await client.command({ query: statement });
    expect(await viewCount()).toBe(0);

    await client.insert({
      table: source,
      format: 'JSONEachRow',
      values: [
        insertData(nestedEventId, 'order.currency'),
        insertData(nestedEventId, 'order.revenue'),
        insertData(renamedEventId, 'displayCurrency'),
        insertData(renamedEventId, 'totalRevenue'),
        insertData(crossSiteEventId, 'currency', otherWebsiteId),
        insertData(crossSiteEventId, 'revenue'),
      ],
    });
    expect(await revenueIds()).toEqual([legacyEventId]);

    await client.insert({
      table: source,
      format: 'JSONEachRow',
      values: [insertData(validEventId, 'currency')],
    });
    await client.insert({
      table: source,
      format: 'JSONEachRow',
      values: [insertData(validEventId, 'revenue')],
    });
    expect(await directRevenueCount()).toBe(1);
    expect(await revenueIds()).toEqual([legacyEventId]);

    await client.insert({
      table: source,
      format: 'JSONEachRow',
      values: [insertData(sameBlockEventId, 'currency'), insertData(sameBlockEventId, 'revenue')],
    });
    expect(await directRevenueCount()).toBe(2);
    expect(await revenueIds()).toEqual([legacyEventId]);
  } finally {
    await client.command({ query: `DROP TABLE IF EXISTS ${view}` });
    await client.command({ query: `DROP TABLE IF EXISTS ${target}` });
    await client.command({ query: `DROP TABLE IF EXISTS ${source}` });
    await client.close();
  }
}

integrationTest(
  'revenue view migration retains legacy rows but stops unverified materialization',
  verifyRevenueViewMigration,
);
