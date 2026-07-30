import { beforeEach, describe, expect, test, vi } from 'vitest';

const command = vi.fn();
const clickhouse = {
  enabled: true,
  command,
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
    clickhouse.enabled = true;
  });

  test('waits for deletion from every raw and derived collection table', async () => {
    await deleteClickhouseCollectionSources(['source-1', 'source-1', 'source-2']);

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
  });

  test('does nothing when ClickHouse is disabled or no sources are present', async () => {
    clickhouse.enabled = false;
    await deleteClickhouseCollectionSources(['source-1']);
    clickhouse.enabled = true;
    await deleteClickhouseCollectionSources([]);

    expect(command).not.toHaveBeenCalled();
  });
});
