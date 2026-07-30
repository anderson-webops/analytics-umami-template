import clickhouse from '@/lib/clickhouse';

export const CLICKHOUSE_COLLECTION_TABLES = [
  'website_event_stats_hourly',
  'website_revenue',
  'event_data_pivot',
  'session_data_pivot',
  'session_replay',
  'heatmap_event',
  'event_data',
  'session_data',
  'website_event',
] as const;

export async function deleteClickhouseCollectionSources(sourceIds: string[]) {
  if (!clickhouse.enabled) {
    return;
  }

  const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];

  if (uniqueSourceIds.length === 0) {
    return;
  }

  for (const table of CLICKHOUSE_COLLECTION_TABLES) {
    await clickhouse.command(
      `ALTER TABLE ${table} DELETE WHERE website_id IN {sourceIds:Array(UUID)}`,
      {
        sourceIds: uniqueSourceIds,
      },
    );
  }
}
