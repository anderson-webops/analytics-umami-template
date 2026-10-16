import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  buildLegacyClickHouseInventory,
  inspectLegacyClickHouseTables,
} from './inspect-legacy-clickhouse-tables.mjs';

const row = (name, engine, websiteIdType, totalRows, totalBytes) => ({
  name,
  engine,
  websiteIdType,
  totalRows,
  totalBytes,
});

const activeRows = [
  row('event_data', 'MergeTree', 'UUID', 2, 100),
  row('website_event', 'MergeTree', 'UUID', 3, 200),
  row('website_event_stats_hourly', 'AggregatingMergeTree', 'UUID', 1, 50),
];

test('clean active inventory needs no legacy cleanup review', () => {
  const inventory = buildLegacyClickHouseInventory('umami', activeRows);

  assert.equal(inventory.activeTablesPresent, true);
  assert.equal(inventory.legacyTablesPresent, false);
  assert.equal(inventory.reviewRequired, false);
  assert.match(inventory.inventorySha256, /^[a-f0-9]{64}$/);
});

test('historical raw, aggregate, view and unscoped join copies require review', () => {
  const inventory = buildLegacyClickHouseInventory('umami', [
    ...activeRows,
    row('event_data_old', 'MergeTree', 'UUID', 7, 300),
    row('website_event_old', 'MergeTree', 'UUID', 9, 400),
    row('website_event_stats_hourly_old', 'AggregatingMergeTree', 'UUID', 4, 250),
    row('website_event_stats_hourly_mv_old', 'MaterializedView', '', null, null),
    row('website_event_join', 'MergeTree', '', 8, 80),
  ]);

  assert.equal(inventory.reviewRequired, true);
  assert.equal(inventory.tables.length, 8);
  const oldEvents = inventory.tables.find(table => table.name === 'event_data_old');
  const join = inventory.tables.find(table => table.name === 'website_event_join');
  assert.equal(oldEvents.estimatedRows, 7);
  assert.equal(join.schemaMatchesHistory, true);
});

test('inventory digest is independent of row order and excludes connection details', () => {
  const rows = [...activeRows, row('event_data_old', 'MergeTree', 'UUID', 1, 10)];
  const first = buildLegacyClickHouseInventory('umami', rows);
  const second = buildLegacyClickHouseInventory('umami', rows.toReversed());

  assert.equal(first.inventorySha256, second.inventorySha256);
  assert.equal(JSON.stringify(first).includes('CLICKHOUSE_URL'), false);
});

test('missing active tables and schema mismatches fail the review gate', () => {
  const missing = buildLegacyClickHouseInventory('umami', activeRows.slice(1));
  const changed = buildLegacyClickHouseInventory('umami', [
    { ...activeRows[0], websiteIdType: 'String' },
    ...activeRows.slice(1),
  ]);
  const wrongLegacyEngine = buildLegacyClickHouseInventory('umami', [
    ...activeRows,
    row('event_data_old', 'Memory', 'UUID', 0, 0),
  ]);

  assert.equal(missing.reviewRequired, true);
  assert.equal(changed.reviewRequired, true);
  assert.equal(wrongLegacyEngine.reviewRequired, true);
  const eventData = changed.tables.find(table => table.name === 'event_data');
  assert.equal(eventData.schemaMatchesHistory, false);
  const oldData = wrongLegacyEngine.tables.find(table => table.name === 'event_data_old');
  assert.equal(oldData.schemaMatchesHistory, false);
});

test('a different current database cannot clear hard-coded historical umami migrations', () => {
  const inventory = buildLegacyClickHouseInventory('client_analytics', activeRows);

  assert.equal(inventory.historicalDatabaseMatches, false);
  assert.equal(inventory.reviewRequired, true);
});

test('unexpected, duplicate, malformed and oversized metadata is rejected', () => {
  const reject = (rows, database = 'umami') => {
    assert.throws(() => buildLegacyClickHouseInventory(database, rows));
  };

  reject([...activeRows, activeRows[0]]);
  reject([{ ...activeRows[0], name: 'secrets' }]);
  reject([{ ...activeRows[0], totalRows: -1 }]);
  reject([{ ...activeRows[0], totalBytes: '999999999999999999999' }]);
  reject(activeRows, '../umami');
});

test('database inspection only reads bounded metadata', async () => {
  let query;
  const inventory = await inspectLegacyClickHouseTables(
    {
      query: async options => {
        query = options;
        return { json: async () => activeRows };
      },
    },
    'umami',
  );

  assert.equal(inventory.reviewRequired, false);
  assert.match(query.query, /FROM system\.tables/);
  assert.doesNotMatch(query.query, /DROP|DELETE|ALTER|TRUNCATE/i);
  assert.equal(query.query_params.database, 'umami');
  assert.equal(query.clickhouse_settings.max_result_rows, 8);
});

test('command runs a read-only request against a synthetic ClickHouse endpoint', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    requests.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.end(`${activeRows.map(value => JSON.stringify(value)).join('\n')}\n`);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const child = spawn(process.execPath, ['scripts/inspect-legacy-clickhouse-tables.mjs'], {
      env: {
        ...process.env,
        CLICKHOUSE_URL: `http://synthetic-user:synthetic-password@127.0.0.1:${address.port}/umami`,
      },
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const exitCode = await new Promise(resolve => child.on('close', resolve));
    const output = Buffer.concat(stdout).toString();

    assert.equal(exitCode, 0, Buffer.concat(stderr).toString());
    assert.equal(requests.length, 1);
    assert.match(requests[0], /FROM system\.tables/);
    assert.doesNotMatch(requests[0], /DROP|DELETE|ALTER|TRUNCATE/i);
    assert.equal(JSON.parse(output).reviewRequired, false);
    assert.equal(output.includes('synthetic-password'), false);
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});
