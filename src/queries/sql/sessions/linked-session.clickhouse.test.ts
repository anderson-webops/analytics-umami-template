import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';
import clickhouse from '@/lib/clickhouse';
import { getLegacyLinkedDistinctIds } from './getLinkedDistinctIds';
import { getLegacyLinkedSessionIds } from './getLinkedSessionIds';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest(
  'linked-session reads retain identity history with a bounded ClickHouse scan',
  async () => {
    const url = process.env.CLICKHOUSE_TEST_URL;
    expect(process.env.CLICKHOUSE_URL).toBe(url);

    const client = createClient({ url });
    const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a50000';
    const sessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a50001';
    const linkedSessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a50002';

    try {
      await client.command({
        query: `CREATE TABLE session_link (
        website_id UUID,
        session_id UUID,
        distinct_id String,
        created_at DateTime('UTC')
      ) ENGINE = ReplacingMergeTree ORDER BY (website_id, distinct_id, session_id)`,
      });
      await client.insert({
        table: 'session_link',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            distinct_id: 'visitor-1',
            created_at: '2025-01-01 00:00:00',
          },
          {
            website_id: websiteId,
            session_id: linkedSessionId,
            distinct_id: 'visitor-1',
            created_at: '2026-01-01 00:00:00',
          },
        ],
      });

      expect(await getLegacyLinkedDistinctIds(websiteId, sessionId, 2)).toEqual(['visitor-1']);
      const links = await getLegacyLinkedSessionIds(websiteId, 'visitor-1', 501);
      expect(new Set(links.map(link => link.sessionId))).toEqual(
        new Set([sessionId, linkedSessionId]),
      );
      expect(links).toHaveLength(2);

      await expect(
        clickhouse.rawQuery(
          'select sum(number) as total from numbers(10000)',
          {},
          'scan-cap-test',
          {
            maxExecutionTimeSeconds: 5,
            maxResultRows: 1,
            maxRowsToRead: 128,
          },
        ),
      ).rejects.toMatchObject({ code: '158', type: 'TOO_MANY_ROWS' });
    } finally {
      await client.command({ query: 'DROP TABLE IF EXISTS session_link' });
      await client.close();
    }
  },
);
