import { beforeEach, describe, expect, test, vi } from 'vitest';

const command = vi.fn();
const rawQuery = vi.fn();
const clickhouse = {
  enabled: true,
  command,
  rawQuery,
};

vi.mock('@/lib/clickhouse', () => ({
  default: clickhouse,
}));

const { CLICKHOUSE_COLLECTION_TABLES, deleteClickhouseCollectionSources } = await import(
  './deleteCollectionSources'
);

describe('deleteClickhouseCollectionSources', () => {
  beforeEach(() => {
    command.mockReset();
    rawQuery
      .mockReset()
      .mockResolvedValueOnce([{ name: 'umami' }])
      .mockResolvedValue([]);
    clickhouse.enabled = true;
    delete process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN;
  });

  test('waits for deletion from every raw and derived collection table', async () => {
    await deleteClickhouseCollectionSources(['source-1', 'source-1', 'source-2']);

    expect(rawQuery).toHaveBeenCalledTimes(2);
    expect(CLICKHOUSE_COLLECTION_TABLES).toContain('session_link');
    expect(CLICKHOUSE_COLLECTION_TABLES).toContain('event_data_pivot_verified');
    expect(command).toHaveBeenCalledTimes(CLICKHOUSE_COLLECTION_TABLES.length);

    for (const [index, table] of CLICKHOUSE_COLLECTION_TABLES.entries()) {
      expect(command).toHaveBeenNthCalledWith(
        index + 1,
        `ALTER TABLE ${table} DELETE WHERE website_id IN {sourceIds:Array(UUID)}`,
        {
          sourceIds: ['source-1', 'source-2'],
        },
      );
    }

    expect(command).toHaveBeenCalledWith(
      'ALTER TABLE session_link DELETE WHERE website_id IN {sourceIds:Array(UUID)}',
      { sourceIds: ['source-1', 'source-2'] },
    );
    expect(command).toHaveBeenCalledWith(
      'ALTER TABLE event_data_pivot_verified DELETE WHERE website_id IN {sourceIds:Array(UUID)}',
      { sourceIds: ['source-1', 'source-2'] },
    );
  });

  test('rejects retained legacy row copies before deleting active data', async () => {
    rawQuery.mockResolvedValue([
      { name: 'event_data_old' },
      { name: 'website_event_old' },
      { name: 'website_event_stats_hourly_old' },
    ]);

    await expect(deleteClickhouseCollectionSources(['source-1'])).rejects.toThrow(
      'CLICKHOUSE_LEGACY_CLEANUP_REQUIRED',
    );
    expect(command).not.toHaveBeenCalled();
  });

  test.each([
    { name: 'website_event_join' },
    { name: 'website_event_stats_hourly_mv_old' },
    { name: 'event_data_new' },
    { name: 'unexpected_object' },
  ])('rejects unsafe legacy objects before any deletion (%j)', async row => {
    rawQuery.mockResolvedValue([row]);

    await expect(deleteClickhouseCollectionSources(['source-1'])).rejects.toThrow(
      /CLICKHOUSE_LEGACY_(CLEANUP_REQUIRED|SCHEMA_REVIEW_REQUIRED)/,
    );
    expect(command).not.toHaveBeenCalled();
  });

  test('rejects a non-historical current database before any deletion', async () => {
    rawQuery.mockReset().mockResolvedValueOnce([{ name: 'client_analytics' }]);

    await expect(deleteClickhouseCollectionSources(['source-1'])).rejects.toThrow(
      'CLICKHOUSE_LEGACY_DATABASE_REVIEW_REQUIRED',
    );
    expect(rawQuery).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
  });

  test('rejects a failed inventory before any deletion', async () => {
    rawQuery
      .mockReset()
      .mockResolvedValueOnce([{ name: 'umami' }])
      .mockRejectedValue(new Error('inventory unavailable'));

    await expect(deleteClickhouseCollectionSources(['source-1'])).rejects.toThrow(
      'inventory unavailable',
    );
    expect(command).not.toHaveBeenCalled();
  });

  test('fails closed when identity-link deletion fails', async () => {
    command.mockImplementation(async query => {
      if (query.startsWith('ALTER TABLE session_link DELETE')) {
        throw new Error('identity-link deletion failed');
      }
    });

    await expect(deleteClickhouseCollectionSources(['source-1'])).rejects.toThrow(
      'identity-link deletion failed',
    );
    expect(command).not.toHaveBeenCalledWith(
      'ALTER TABLE website_event DELETE WHERE website_id IN {sourceIds:Array(UUID)}',
      { sourceIds: ['source-1'] },
    );
  });

  test('requires protected history attestation when ClickHouse is disabled', async () => {
    clickhouse.enabled = false;
    await expect(deleteClickhouseCollectionSources(['source-1'])).rejects.toThrow(
      'CLICKHOUSE_HISTORY_REVIEW_REQUIRED',
    );
    expect(command).not.toHaveBeenCalled();
    expect(rawQuery).not.toHaveBeenCalled();
  });

  test('accepts disabled ClickHouse only after protected history attestation', async () => {
    clickhouse.enabled = false;
    process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN = 'true';
    await deleteClickhouseCollectionSources(['source-1']);

    expect(command).not.toHaveBeenCalled();
    expect(rawQuery).not.toHaveBeenCalled();
  });

  test('does nothing when no sources are present', async () => {
    await deleteClickhouseCollectionSources([]);

    expect(command).not.toHaveBeenCalled();
    expect(rawQuery).not.toHaveBeenCalled();
  });
});
