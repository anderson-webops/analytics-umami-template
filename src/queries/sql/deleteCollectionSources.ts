import clickhouse from '@/lib/clickhouse';

export const CLICKHOUSE_COLLECTION_TABLES = [
  'website_event_stats_hourly',
  'website_revenue',
  'event_data_pivot',
  'event_data_pivot_verified',
  'session_data_pivot',
  'session_replay',
  'heatmap_event',
  'session_link',
  'event_data',
  'session_data',
  'website_event',
] as const;

const LEGACY_OBJECTS = [
  'event_data_old',
  'website_event_old',
  'website_event_stats_hourly_old',
  'website_event_join',
  'website_event_stats_hourly_mv_old',
  'event_data_new',
  'website_event_new',
  'website_event_stats_hourly_new',
  'website_event_stats_hourly_mv_new',
] as const;

async function assertNoLegacyClickhouseObjects(): Promise<void> {
  const database = await clickhouse.rawQuery<Array<{ name: string }>>(
    'SELECT currentDatabase() AS name',
    {},
    undefined,
    { maxExecutionTimeSeconds: 5, maxResultRows: 1 },
  );

  if (database.length !== 1 || database[0].name !== 'umami') {
    throw new Error('CLICKHOUSE_LEGACY_DATABASE_REVIEW_REQUIRED');
  }

  const rows = await clickhouse.rawQuery<Array<{ name: string }>>(
    `SELECT name FROM system.tables
     WHERE database = currentDatabase()
       AND name IN {tableNames:Array(String)}`,
    { tableNames: LEGACY_OBJECTS },
    undefined,
    { maxExecutionTimeSeconds: 5, maxResultRows: LEGACY_OBJECTS.length },
  );

  for (const row of rows) {
    if (!LEGACY_OBJECTS.includes(row.name as (typeof LEGACY_OBJECTS)[number])) {
      throw new Error('CLICKHOUSE_LEGACY_SCHEMA_REVIEW_REQUIRED');
    }

    throw new Error('CLICKHOUSE_LEGACY_CLEANUP_REQUIRED');
  }
}

export async function deleteClickhouseCollectionSources(sourceIds: string[]) {
  const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];

  if (uniqueSourceIds.length === 0) {
    return;
  }

  if (!clickhouse.enabled) {
    if (process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN !== 'true') {
      throw new Error('CLICKHOUSE_HISTORY_REVIEW_REQUIRED');
    }

    return;
  }

  await assertNoLegacyClickhouseObjects();

  for (const table of CLICKHOUSE_COLLECTION_TABLES) {
    await clickhouse.command(
      `ALTER TABLE ${table} DELETE WHERE website_id IN {sourceIds:Array(UUID)}`,
      {
        sourceIds: uniqueSourceIds,
      },
    );
  }
}
