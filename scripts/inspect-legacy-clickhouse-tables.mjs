import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TABLES = new Map([
  ['event_data', ['MergeTree', 'UUID']],
  ['event_data_old', ['MergeTree', 'UUID']],
  ['website_event', ['MergeTree', 'UUID']],
  ['website_event_old', ['MergeTree', 'UUID']],
  ['website_event_stats_hourly', ['AggregatingMergeTree', 'UUID']],
  ['website_event_stats_hourly_old', ['AggregatingMergeTree', 'UUID']],
  ['website_event_stats_hourly_mv_old', ['MaterializedView', null]],
  ['website_event_join', ['MergeTree', null]],
]);

const ACTIVE_TABLES = new Set(['event_data', 'website_event', 'website_event_stats_hourly']);

function estimatedCount(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const count = Number(value);

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid ClickHouse inventory count');
  }

  return count;
}

export function buildLegacyClickHouseInventory(database, rows) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database) || !Array.isArray(rows)) {
    throw new Error('Invalid ClickHouse inventory');
  }

  const seen = new Set();
  const tables = rows.map(row => {
    if (!row || !TABLES.has(row.name) || seen.has(row.name)) {
      throw new Error('Unexpected ClickHouse inventory table');
    }

    seen.add(row.name);
    const [expectedEngine, expectedWebsiteIdType] = TABLES.get(row.name);

    if (typeof row.engine !== 'string' || typeof row.websiteIdType !== 'string') {
      throw new Error('Invalid ClickHouse inventory schema');
    }

    return {
      name: row.name,
      engine: row.engine,
      websiteIdType: row.websiteIdType,
      schemaMatchesHistory:
        row.engine === expectedEngine &&
        (expectedWebsiteIdType === null || row.websiteIdType === expectedWebsiteIdType),
      estimatedRows: estimatedCount(row.totalRows),
      estimatedBytes: estimatedCount(row.totalBytes),
    };
  });

  tables.sort((left, right) => left.name.localeCompare(right.name));
  const inventory = {
    format: 1,
    database,
    historicalDatabaseMatches: database === 'umami',
    activeTablesPresent: [...ACTIVE_TABLES].every(name => seen.has(name)),
    legacyTablesPresent: tables.some(table => !ACTIVE_TABLES.has(table.name)),
    tables,
  };

  return {
    ...inventory,
    reviewRequired:
      !inventory.historicalDatabaseMatches ||
      inventory.legacyTablesPresent ||
      !inventory.activeTablesPresent ||
      tables.some(table => !table.schemaMatchesHistory),
    inventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
  };
}

export async function inspectLegacyClickHouseTables(client, database) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new Error('Invalid ClickHouse inventory database');
  }

  const result = await client.query({
    query: `SELECT t.name AS name, t.engine AS engine,
                   t.total_rows AS totalRows, t.total_bytes AS totalBytes,
                   c.type AS websiteIdType
            FROM system.tables AS t
            LEFT JOIN system.columns AS c
              ON c.database = t.database AND c.table = t.name AND c.name = 'website_id'
            WHERE t.database = {database:String}
              AND t.name IN {tableNames:Array(String)}`,
    query_params: { database, tableNames: [...TABLES.keys()] },
    format: 'JSONEachRow',
    clickhouse_settings: {
      max_execution_time: 5,
      max_result_rows: TABLES.size,
      result_overflow_mode: 'throw',
    },
    abort_signal: AbortSignal.timeout(5000),
  });

  return buildLegacyClickHouseInventory(database, await result.json());
}

async function main() {
  if (process.argv.length !== 2 || !process.env.CLICKHOUSE_URL) {
    throw new Error('A protected ClickHouse URL and no arguments are required');
  }

  const endpoint = new URL(process.env.CLICKHOUSE_URL);
  const database = decodeURIComponent(endpoint.pathname.slice(1));

  if (!['http:', 'https:'].includes(endpoint.protocol) || !/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new Error('Invalid ClickHouse inventory endpoint');
  }

  const { createClient } = await import('@clickhouse/client');
  const client = createClient({
    url: endpoint.origin,
    database,
    username: decodeURIComponent(endpoint.username) || 'default',
    password: decodeURIComponent(endpoint.password),
  });

  try {
    const inventory = await inspectLegacyClickHouseTables(client, database);
    process.stdout.write(
      `${JSON.stringify({ observedAt: new Date().toISOString(), ...inventory })}\n`,
    );
  } finally {
    await client.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('Legacy ClickHouse inventory could not complete.\n');
    process.exitCode = 1;
  });
}
